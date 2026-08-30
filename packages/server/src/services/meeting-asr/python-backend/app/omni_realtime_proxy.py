"""
DashScope Omni-Realtime WebSocket proxy.

Bridges a frontend WebSocket and the Aliyun DashScope real-time multimodal
endpoint that powers models like `qwen3.5-omni-flash-realtime`. The protocol
is OpenAI-Realtime-API compatible:

  - WebSocket URL is `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`
    with the model selected via the `model` query parameter.
  - Audio format on the wire is raw PCM16 mono. The Omni endpoint standardises
    at 24 kHz, but accepts the OpenAI-Realtime `pcm16` family — we pin input
    and output to 24 kHz / 16-bit / mono to match what `qwen3.5-omni-flash-realtime`
    returns to clients.

Frontend protocol (binary in, JSON events out):

  Frame 1 (text, required): control JSON
      {"type": "start", "voice": "Tina", "instructions": "...", "model": "...",
       "tools": [{"type": "function", "name": "...", "description": "...",
                  "parameters": {...}}, ...]}
    `model` / `voice` / `instructions` / `tools` are optional; the server-side
    config.py defaults apply otherwise. We send `session.update` upstream with
    these values immediately after the upstream handshake so the user can
    switch persona / voice per session without restarting the backend. When
    `tools` is provided, the session is configured with `tool_choice: "auto"`
    and the model may emit function calls that are relayed to the client.

  Subsequent frames (binary): raw PCM16 @ 24 kHz mono little-endian Int16
    samples, exactly what the upstream API expects in `input_audio_buffer.append`
    payloads (which we re-encode to base64 here).

  Text frames (JSON): control frames the frontend can send at any time:
      {"type": "cancel"}   — abort the current in-flight response
      {"type": "ping"}     — heartbeat (echoed back as {"type": "pong"})
      {"type": "tool_result", "call_id": "...", "output": "..."}
                           — client-side function-call result; forwarded
                             upstream as `function_call_output` followed by
                             `response.create` so the model continues.
      {"type": "image", "image": "<base64 JPEG>"}
                           — one camera frame (data URL or raw base64);
                             forwarded upstream as `input_image_buffer.append`.
                             DashScope constraints: JPG/JPEG only, ≤256 KB
                             base64, ~1 fps recommended, and audio must be
                             appended at least once before any image frame.

Server → frontend frames:

  Binary frames: raw PCM16 @ 24 kHz mono (delta chunks from upstream
    `response.audio.delta` events, concatenated and forwarded as soon as
    they arrive).

  Text frames (JSON):
      {"type": "ready",        "session_id": "..."}
      {"type": "listening"}                       — server VAD says user is speaking
      {"type": "speech_stopped"}                  — server VAD says user stopped
      {"type": "user_transcript", "text": "..."}  — final ASR of user's turn
      {"type": "transcript_delta","text": "..."}  — incremental AI text
      {"type": "transcript",      "text": "..."}  — final AI text
      {"type": "response_started"}
      {"type": "response_done"}
      {"type": "error", "message": "..."}
      {"type": "stopped"}
      {"type": "pong"}

Authentication uses the same DASHSCOPE_API_KEY as the rest of the meeting
ASR service — we deliberately *do not* expose a per-session key from the
client. The user pre-configures the key in the meeting wizard and the server
injects it when opening the upstream WS.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Any, AsyncIterator

import websockets
from websockets.exceptions import ConnectionClosed

from .config import settings
from ._log_helper import log_skip

log = logging.getLogger("omni_realtime_proxy")


# Wire format is fixed at 24 kHz / 16-bit / mono for the Omni-Realtime
# endpoint. Documenting it as module constants so client + server stay in
# lock-step without a separate handshake.
SAMPLE_RATE = 24000
BITS_PER_SAMPLE = 16
CHANNELS = 1

DEFAULT_INSTRUCTIONS = (
    "你是一个友好的中文助手，名字叫\"小合\"。请用简洁、自然、口语化的中文回答，"
    "适合通过语音直接朗读。回答控制在两三句话以内，除非用户明确要求详细说明。"
)


class OmniRealtimeProxy:
    """Bridges one frontend WS to one DashScope Omni-Realtime upstream WS.

    Lifecycle:

        proxy = OmniRealtimeProxy(voice="Tina", instructions="...")
        await proxy.connect()                 # opens upstream + sends session.update
        await proxy.send_audio(pcm_bytes)     # binary frame, PCM16@24k mono
        await proxy.commit_audio()            # optional: flush buffer (server VAD also flushes)
        await proxy.cancel()                  # abort current response
        await proxy.close()

    The proxy translates between OpenAI-Realtime events and the small
    frontend protocol documented in the module docstring.
    """

    def __init__(
        self,
        model: str | None = None,
        voice: str | None = None,
        instructions: str | None = None,
        tools: list[dict] | None = None,
    ) -> None:
        self.model = model or settings.omni_realtime_model
        self.voice = voice or settings.omni_realtime_voice
        self.instructions = instructions or settings.omni_realtime_instructions or DEFAULT_INSTRUCTIONS
        # Function-calling tools (OpenAI-Realtime flat format:
        # {"type": "function", "name", "description", "parameters"}). The
        # client owns execution — the proxy only relays calls and results.
        self.tools = [dict(tool) for tool in tools or [] if isinstance(tool, dict)]
        self.session_id = str(uuid.uuid4())
        self.upstream: websockets.WebSocketClientProtocol | None = None
        self._send_lock = asyncio.Lock()
        self._closed = False
        # Response-lifecycle gate: DashScope rejects any attempt to create a
        # new response while one is still in flight with
        # "Conversation already has an active response". The proxy observes
        # `response.created` / `response.done` / `response.cancelled` and gates
        # the actions that can trigger a new response (`commit_audio`,
        # `send_tool_output`) on the previous one fully draining.
        self._response_active = False
        self._response_done_event = asyncio.Event()
        self._response_done_event.set()
        # DashScope requires at least one audio append before any image frame
        # ("You must send audio data at least once before you send image data").
        # We track it so camera frames arriving before the mic feed drop
        # silently instead of surfacing a confusing upstream error.
        self._audio_seen = False
        # Counter for observability: send_image logs the first frame and then
        # every 60th (~1/min at the recommended 1 fps), so operators can see
        # camera frames actually flowing without flooding the log.
        self._image_frames_sent = 0

    # --- upstream lifecycle --------------------------------------------------

    async def connect(self) -> None:
        """Open the upstream WS, send `session.update`, and confirm session.created."""
        if not settings.dashscope_api_key:
            raise RuntimeError("DASHSCOPE_API_KEY is not configured")

        url = f"{settings.omni_realtime_ws_url}?model={self.model}"
        headers = [
            ("Authorization", f"Bearer {settings.dashscope_api_key}"),
            ("User-Agent", "meeting-asr-cloud/omni-realtime/0.1"),
        ]
        log.info("omni-realtime: connecting to %s (session=%s)", url, self.session_id)
        self.upstream = await websockets.connect(
            url,
            extra_headers=headers,
            max_size=32 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
        )

        # Configure the session: text + audio I/O, voice, persona instructions.
        # The Omni endpoint accepts an OpenAI-Realtime-shaped session object.
        session_update: dict[str, Any] = {
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "voice": self.voice,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "instructions": self.instructions,
            },
        }
        if self.tools:
            session_update["session"]["tools"] = self.tools
            session_update["session"]["tool_choice"] = "auto"
        async with self._send_lock:
            await self.upstream.send(json.dumps(session_update))

        # Drain the synchronous session.created / session.updated acknowledgements.
        # We accept either event name as confirmation — some DashScope versions
        # emit only one of them, depending on protocol revision.
        for _ in range(4):
            try:
                raw = await asyncio.wait_for(self.upstream.recv(), timeout=10.0)
            except (asyncio.TimeoutError, ConnectionClosed) as exc:
                raise RuntimeError(f"omni-realtime: handshake failed: {exc}") from exc
            if isinstance(raw, (bytes, bytearray)):
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event = msg.get("type") or msg.get("event")
            if event in ("session.created", "session.updated"):
                log.info("omni-realtime: session ready (model=%s, event=%s)", self.model, event)
                return
            if event == "error":
                raise RuntimeError(
                    "omni-realtime: server rejected session.update: "
                    f"{msg.get('error', {}).get('message') or msg}"
                )
        raise RuntimeError("omni-realtime: did not receive session.created within 4 frames")

    async def send_audio(self, pcm_bytes: bytes) -> None:
        """Append a binary PCM16 chunk to the upstream input_audio_buffer."""
        if self.upstream is None:
            raise RuntimeError("omni-realtime: upstream not connected")
        if not pcm_bytes:
            return
        self._audio_seen = True
        event = {
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(pcm_bytes).decode("ascii"),
        }
        async with self._send_lock:
            await self.upstream.send(json.dumps(event))

    async def send_image(self, image: str) -> None:
        """Append one JPEG camera frame to the upstream input_image_buffer.

        DashScope's Omni-Realtime API accepts frames via
        ``input_image_buffer.append`` with the image as raw base64 (no data
        URL prefix). The browser ``canvas.toDataURL`` payload arrives with a
        ``data:image/jpeg;base64,`` prefix, so we strip it before forwarding.

        Upstream constraints (see official docs): JPG/JPEG only, single image
        ≤ 256 KB base64, ~1 fps recommended, and audio must have been
        appended at least once first — enforced via ``_audio_seen``.
        """
        if self.upstream is None:
            raise RuntimeError("omni-realtime: upstream not connected")
        if not self._audio_seen:
            log.warning("omni-realtime: dropping image frame — no audio appended yet")
            return
        image = (image or "").strip()
        if not image:
            return
        if image.startswith("data:"):
            _, _, image = image.partition(",")
            image = image.strip()
        if not image:
            return
        event = {"type": "input_image_buffer.append", "image": image}
        async with self._send_lock:
            await self.upstream.send(json.dumps(event))
        self._image_frames_sent += 1
        if self._image_frames_sent == 1 or self._image_frames_sent % 60 == 0:
            log.info(
                "omni-realtime: forwarded image frame #%d (base64 %d chars, session=%s)",
                self._image_frames_sent,
                len(image),
                self.session_id,
            )

    async def commit_audio(self) -> None:
        """Commit the buffered audio upstream (server VAD also does this automatically).

        Used by push-to-talk clients that want to force the model to respond
        even before VAD closes the turn. Without this the server waits for
        its own speech-stopped event.

        If a response is still in flight when the commit arrives we wait for
        it to finish before sending — otherwise DashScope's auto-create logic
        collides with the live response and returns
        "Conversation already has an active response".
        """
        if self.upstream is None:
            return
        await self._await_response_done("commit_audio")
        event = {"type": "input_audio_buffer.commit"}
        try:
            async with self._send_lock:
                await self.upstream.send(json.dumps(event))
        except ConnectionClosed:
            pass

    async def cancel(self) -> None:
        """Abort the current in-flight response (used by PTT release)."""
        if self.upstream is None:
            return
        event = {"type": "response.cancel"}
        try:
            async with self._send_lock:
                await self.upstream.send(json.dumps(event))
        except ConnectionClosed:
            pass

    async def send_tool_output(self, call_id: str, output: str) -> None:
        """Return a client-side function-call result and ask for the next turn.

        Follows the OpenAI-Realtime shape: append a `function_call_output`
        conversation item, then trigger `response.create` so the model
        speaks the answer that uses the tool result.

        `response.create` MUST wait for the in-flight response to drain —
        `response.function_call_arguments.done` arrives *before* `response.done`
        for the same turn, so firing `response.create` immediately would
        race with the still-active response and DashScope would reject with
        "Conversation already has an active response".
        """
        if self.upstream is None or not call_id:
            return
        await self._await_response_done("send_tool_output")
        item = {
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output,
            },
        }
        try:
            async with self._send_lock:
                await self.upstream.send(json.dumps(item))
                await self.upstream.send(json.dumps({"type": "response.create"}))
        except ConnectionClosed:
            pass

    async def _await_response_done(self, action: str, timeout: float = 30.0) -> None:
        """Block until no response is in flight, with a safety timeout.

        The upstream can stall in pathological cases (network blip mid-turn,
        model timeout, etc.); we don't want a single stuck response to wedge
        every subsequent client action forever. If the timeout fires we log
        and proceed — the resulting upstream error will be surfaced to the
        client as a normal `error` event.
        """
        if not self._response_active:
            return
        try:
            await asyncio.wait_for(self._response_done_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning(
                "omni-realtime: %s timed out waiting %.1fs for in-flight response to drain; proceeding anyway",
                action,
                timeout,
            )

    # --- upstream event pump -------------------------------------------------

    async def upstream_events(self) -> AsyncIterator[bytes | str]:
        """Yield raw frames (bytes or JSON strings) from the upstream.

        Returning the raw frame (instead of a typed dict) lets the FastAPI
        handler forward them to the browser with minimal latency — decoding
        and re-encoding would round-trip large base64 audio payloads.
        """
        if self.upstream is None:
            raise RuntimeError("omni-realtime: upstream not connected")
        try:
            async for raw in self.upstream:
                if self._closed:
                    return
                # Track response lifecycle so downstream actions that request
                # a new response (`commit_audio`, `send_tool_output`) can
                # wait for the in-flight one to finish — see `_response_active`
                # docstring in __init__.
                if isinstance(raw, str):
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        pass
                    else:
                        evt = msg.get("type") or msg.get("event")
                        if evt == "response.created":
                            self._response_active = True
                            self._response_done_event.clear()
                        elif evt in ("response.done", "response.cancelled"):
                            if self._response_active:
                                self._response_active = False
                                self._response_done_event.set()
                yield raw
        except ConnectionClosed:
            log.info("omni-realtime: upstream connection closed")

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.upstream is not None:
            try:
                await self.upstream.close()
            except Exception as exc:
                log_skip("omni_realtime_close", exc)
            self.upstream = None


def translate_event(raw: str | bytes) -> str | bytes | None:
    """Translate an upstream event into the small frontend protocol.

    Returns ``None`` for events we deliberately drop (heartbeats, usage
    accounting, etc.) — the caller treats ``None`` as "skip this frame".

    Audio delta events are special: the upstream payload includes the audio
    as a base64 string. We decode it and yield the raw PCM16 bytes so the
    browser can write them straight into a Web Audio buffer.
    """
    if isinstance(raw, (bytes, bytearray)):
        # DashScope occasionally emits upstream-level binary pings. Forwarding
        # them as binary would confuse the client, so silently drop.
        return None
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None

    event = msg.get("type") or msg.get("event")

    # Audio delta → raw PCM16 bytes.
    if event == "response.audio.delta":
        delta = (msg.get("delta") or "").strip()
        if not delta:
            return None
        try:
            return base64.b64decode(delta)
        except Exception as exc:
            log.warning("omni-realtime: bad base64 audio delta: %s", exc)
            return None

    if event == "response.audio_transcript.delta":
        text = msg.get("delta") or ""
        if not text:
            return None
        return json.dumps({"type": "transcript_delta", "text": text}, ensure_ascii=False)

    if event == "response.audio_transcript.done":
        text = msg.get("transcript") or ""
        return json.dumps({"type": "transcript", "text": text}, ensure_ascii=False)

    if event == "conversation.item.input_audio_transcription.completed":
        transcript = msg.get("transcript") or ""
        return json.dumps({"type": "user_transcript", "text": transcript}, ensure_ascii=False)

    if event == "input_audio_buffer.speech_started":
        return json.dumps({"type": "listening"}, ensure_ascii=False)

    if event == "input_audio_buffer.speech_stopped":
        return json.dumps({"type": "speech_stopped"}, ensure_ascii=False)

    if event == "response.created":
        return json.dumps({"type": "response_started"}, ensure_ascii=False)

    if event == "response.done":
        return json.dumps({"type": "response_done"}, ensure_ascii=False)

    # DashScope emits `response.cancelled` when the client sends
    # `response.cancel` mid-stream. We translate it to the same
    # `response_done` frame the client already understands — both events
    # mean "the response is fully drained, no more audio / text for it" —
    # so the client can clear its post-cancel audio-drop window without
    # needing a separate event type.
    if event == "response.cancelled":
        return json.dumps({"type": "response_done"}, ensure_ascii=False)

    # Function calling: the canonical payload lives in the `.done` event.
    # `conversation.item.created` repeats the same call for protocol
    # bookkeeping — the caller dedupes by call_id.
    if event == "response.function_call_arguments.done":
        return json.dumps({
            "type": "function_call",
            "call_id": msg.get("call_id") or "",
            "name": msg.get("name") or "",
            "arguments": msg.get("arguments") or "{}",
        }, ensure_ascii=False)

    item = msg.get("item")
    if event == "conversation.item.created" and isinstance(item, dict) and item.get("type") == "function_call":
        return json.dumps({
            "type": "function_call",
            "call_id": item.get("call_id") or "",
            "name": item.get("name") or "",
            "arguments": item.get("arguments") or "{}",
        }, ensure_ascii=False)

    if event == "error":
        err = msg.get("error") or {}
        message = err.get("message") if isinstance(err, dict) else str(err)
        if not message:
            message = "unknown upstream error"
        return json.dumps({"type": "error", "message": message}, ensure_ascii=False)

    # Everything else (session events, response.audio.done, usage, etc.) is
    # either redundant with what we forward or pure protocol bookkeeping.
    return None
