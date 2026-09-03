"""
DashScope Omni-Realtime WebSocket proxy.

Bridges a frontend WebSocket and the Aliyun DashScope real-time multimodal
endpoint that powers the Qwen-Omni-Realtime model family:

  * `qwen3.5-omni-plus-realtime`  (latest, smarter, ≤100 audio turns)
  * `qwen3.5-omni-flash-realtime` (latest, fastest, ≤80 audio turns)
  * `qwen3-omni-flash-realtime`   (previous gen, ≤8 turns — hard limit)

The wire protocol is OpenAI-Realtime-API compatible; the upstream URL is
`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<name>` (or the
region-specific `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` variant).

Per the official Bailian docs:

  * `audio.input.format` / `audio.output.format` is the new (qwen3.5-only)
    configuration shape; the legacy `input_audio_format` /
    `output_audio_format` fields are still accepted on the older
    `qwen3-omni-flash-realtime` family. We send the new shape because
    the docs recommend it, and fall back to the legacy shape only when
    the upstream rejects the new one (rare; defensive).
  * `turn_detection.type = "semantic_vad"` is the recommended VAD mode
    for the qwen3.5 family (server_vad is the older fallback). We default
    to semantic_vad for any qwen3.5 model and server_vad otherwise.
  * `session.finish` is the documented close event; we send it before
    tearing the WebSocket down so the server can flush its audio buffer
    and free the context window.
  * Tool calling and `enable_search` are mutually exclusive
    ("联网搜索和工具调用不兼容，不可同时开启"). When `tools` are present
    we explicitly omit `enable_search` even if the parent model panel
    defaults to true.
  * Single session hard limit is 120 minutes; the upstream closes the
    connection when hit.

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

  Subsequent frames (binary): raw PCM16 mono little-endian Int16
    samples, exactly what the upstream API expects in `input_audio_buffer.append`
    payloads (which we re-encode to base64 here). Sample rate is configurable
    per session (16 kHz / 24 kHz / 48 kHz); we ship 16 kHz on input and
    24 kHz on output by default, matching the docs' recommended defaults.

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
                             appended before image data — enforced per commit
                             cycle (DashScope clears the audio + image
                             buffers on every `input_audio_buffer.commit`,
                             which in VAD mode the server does automatically
                             at the end of each utterance), so frames landing
                             in a post-commit window are dropped locally
                             instead of surfacing the upstream "append image
                             before append audio" error.
      {"type": "text", "text": "<prompt>"}
                           — inject a text-only user message (conversation
                             item) and ask the model to reply *within the same
                             session* (reuses the multimodal context it already
                             saw/heard). Forwarded upstream as
                             `conversation.item.create` (role=user,
                             content=input_text) followed by `response.create`.
                             Used by 口语对练's same-session closing review:
                             the coach answers by voice, and its ASR transcript
                             is relayed back as the usual transcript frames —
                             no separate offline window or re-upload needed.
      {"type": "stop"}     — flush audio buffer and close the session
                             (we send `session.finish` upstream before
                             tearing the WS down).

Server → frontend frames:

  Binary frames: raw PCM16 mono (delta chunks from upstream
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


# Output is fixed at 24 kHz / 16-bit / mono — that's the rate DashScope sends
# the audio delta frames at. Input sample rate is configurable per session
# (16 / 24 / 48 kHz per the docs) but the bridge resamples browser mic input
# to 16 kHz upstream before sending. Documenting both as module constants so
# client + server stay in lock-step without a separate handshake.
OUTPUT_SAMPLE_RATE = 24000
INPUT_SAMPLE_RATE = 16000
BITS_PER_SAMPLE = 16
CHANNELS = 1

# JSON object `arguments` == "no arguments were supplied".
EMPTY_ARGUMENTS = ("", "{}")


def _as_arguments_json(value: object) -> str:
    """Normalize an upstream tool-call ``arguments`` payload to a JSON string.

    The OpenAI-Realtime wire shape carries ``arguments`` as a JSON *string*,
    but DashScope's Omni-Realtime implementation has been observed to hand it
    out as an already-parsed JSON object instead. The frontend contract
    (``omni_realtime_proxy`` client in ``useOmniRealtime.ts``) treats any
    non-string ``arguments`` as ``{}`` and would therefore execute a
    perfectly-formed tool call with *empty* arguments — the model then sees
    ``{"error": "question 必填"}`` for a call it believes carried the question
    and retries the same call forever (the ``query_hermes_agent {}`` storm).

    Normalize here so downstream never has to guess:
      * str            → trimmed, ``"{}"`` when blank
      * dict / list    → ``json.dumps`` (ensure_ascii=False keeps CJK intact)
      * anything else  → ``"{}"``
    """
    if isinstance(value, str):
        return value.strip() or "{}"
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return "{}"
    return "{}"


def _has_arguments(arguments: str) -> bool:
    """True when a normalized arguments string actually carries parameters."""
    return arguments.strip() not in EMPTY_ARGUMENTS


class FunctionCallGate:
    """Arbitrate which ``function_call`` announcements reach the client.

    DashScope announces one model tool call up to twice — once via
    ``conversation.item.created`` (protocol bookkeeping) and once via
    ``response.function_call_arguments.done`` (the canonical, arguments-bearing
    copy). The bookkeeping copy can arrive FIRST with empty ``arguments``
    (the model is still filling them in). Forwarding that empty copy and then
    discarding the ``.done`` copy as a "duplicate" makes the client execute the
    tool with ``{}`` — and when the tool requires an argument (``question``),
    the client errors and the model retries the exact same call in a loop.

    Strategy (per call_id):
      * announcement WITH arguments  → forward immediately, remember it sent;
      * announcement WITHOUT args    → park it; a later richer copy for the
        same call_id supersedes and is forwarded; otherwise the response
        boundary (``flush()``) releases it so legitimately argument-less tools
        (e.g. ``list_jobs``, whose schema has no required params) still run.
    """

    def __init__(self) -> None:
        # call_id → raw translated frame (JSON str) waiting for its arguments.
        self._parked: dict[str, str] = {}
        # call_ids whose announcement was already forwarded — later repeats
        # (whichever event order DashScope picks) must not double-fire.
        self._sent: set[str] = set()

    def on_function_call(self, call_id: str, arguments: str, raw_frame: str) -> str | None:
        """Decide whether ``raw_frame`` (a translated ``function_call``) should
        be forwarded now. Returns the frame to send, or ``None`` to hold/drop it.
        """
        if not call_id or call_id in self._sent:
            return None
        if _has_arguments(arguments):
            self._sent.add(call_id)
            self._parked.pop(call_id, None)
            return raw_frame
        self._parked[call_id] = raw_frame
        return None

    def flush(self) -> list[str]:
        """Release every still-parked announcement (response boundary reached
        and no arguments-bearing copy ever arrived). Returns frames to send.
        """
        frames = list(self._parked.values())
        self._parked = {}
        return frames

DEFAULT_INSTRUCTIONS = (
    '你是 Quanta，用户友好的中文语音助手。请用简洁、自然、口语化的中文回答，'
    '适合通过语音直接朗读。回答控制在两三句话以内，除非用户明确要求详细说明。'
)


def _is_qwen35_family(model: str) -> bool:
    """True for any qwen3.5-omni-realtime model. The qwen3.5 family uses the
    new audio.input/output.format shape and prefers semantic_vad; the older
    qwen3-omni-flash-realtime falls back to the legacy fields and server_vad.
    """
    return 'qwen3.5' in (model or '').lower()


def _turn_detection(model: str) -> dict[str, Any]:
    """Pick the VAD config the docs recommend for the model family.

    * qwen3.5 → `semantic_vad` (the docs explicitly recommend it)
    * qwen3   → `server_vad` (the legacy fallback that older accounts are
      already familiar with; the upstream also accepts `null` for manual
      mode, but the browser UX is hands-free so we keep VAD on).
    """
    if _is_qwen35_family(model):
        return {
            "type": "semantic_vad",
            "threshold": 0.5,
            "silence_duration_ms": 800,
        }
    return {
        "type": "server_vad",
        "threshold": 0.5,
        "silence_duration_ms": 800,
    }


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
        # ...and the audio + image buffers are BOTH cleared on every
        # `input_audio_buffer.commit` (in VAD mode the server auto-commits at
        # the end of each utterance), so the "audio before image" rule applies
        # per commit cycle, not just per session. Track whether fresh audio has
        # been appended since the last observed commit so a camera frame that
        # lands in the post-commit window is dropped locally instead of
        # surfacing DashScope's "append image before append audio" error.
        self._audio_appended_since_commit = False
        # Counter for observability: send_image logs the first frame and then
        # every 60th (~1/min at the recommended 1 fps), so operators can see
        # camera frames actually flowing without flooding the log.
        self._image_frames_sent = 0

    # --- upstream lifecycle --------------------------------------------------

    async def connect(self) -> None:
        """Open the upstream WS, send `session.update`, and confirm session.created."""
        if not settings.dashscope_api_key:
            raise RuntimeError("DASHSCOPE_API_KEY is not configured")

        # Region-routed URL: if OMNI_REALTIME_WORKSPACE_ID is set, rewrite the
        # bare international URL into the docs-mandated
        # `wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/realtime`
        # form. Operators that need a non-default region (Singapore: `.sg.`)
        # can override OMNI_REALTIME_WS_URL entirely.
        base = settings.omni_realtime_ws_url
        if settings.omni_realtime_workspace_id and "{WorkspaceId}" not in base:
            # Only auto-fill if the operator left the bare URL — never clobber
            # an explicit region-specific override.
            if base.startswith("wss://dashscope.aliyuncs.com/"):
                base = (
                    f"wss://{settings.omni_realtime_workspace_id}."
                    f"cn-beijing.maas.aliyuncs.com/"
                    f"{base[len('wss://dashscope.aliyuncs.com/'):]}"
                )
        url = f"{base}?model={self.model}"
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
        #
        # Per the Qwen-Omni-Realtime docs:
        #   * qwen3.5 models use `audio.input.format` / `audio.output.format`
        #     with explicit sample_rate. The legacy `input_audio_format` /
        #     `output_audio_format` fields are documented as deprecated for
        #     qwen3.5 and still required by qwen3. We send the new shape —
        #     DashScope accepts both for the qwen3.5 family and it remains
        #     backwards compatible with the older model.
        #   * VAD type defaults to `semantic_vad` for qwen3.5 (docs
        #     recommend it) and `server_vad` for qwen3-omni-flash-realtime.
        #   * Tool calling and `enable_search` are mutually exclusive; when
        #     `tools` are present we deliberately omit enable_search even if
        #     it would otherwise default to true.
        session: dict[str, Any] = {
            "modalities": ["text", "audio"],
            "voice": self.voice,
            "audio": {
                "input": {
                    "format": {
                        "type": "pcm",
                        "sample_rate": settings.omni_realtime_input_sample_rate,
                    },
                },
                "output": {
                    "format": {
                        "type": "pcm",
                        "sample_rate": settings.omni_realtime_output_sample_rate,
                    },
                },
            },
            "instructions": self.instructions,
            "turn_detection": _turn_detection(self.model),
        }
        # `enable_search` is opt-in: when set, the upstream toggles web search
        # on. Note that the docs forbid combining it with tools, so the
        # tool branch above strips it again even if an operator leaves it on.
        if settings.omni_realtime_enable_search and not self.tools:
            session["enable_search"] = True
            session["search_options"] = {"enable_source": True}
        if self.tools:
            session["tools"] = self.tools
            session["tool_choice"] = "auto"
            # Tool calling is incompatible with enable_search. Be explicit so
            # an operator who set `OMNI_REALTIME_ENABLE_SEARCH=true` cannot
            # accidentally break the realtime dialog by turning tools on.
            session.pop("enable_search", None)

        session_update: dict[str, Any] = {
            "type": "session.update",
            "session": session,
        }
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
                log.info(
                    "omni-realtime: session ready (model=%s, family=%s, event=%s)",
                    self.model,
                    "qwen3.5" if _is_qwen35_family(self.model) else "qwen3",
                    event,
                )
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
        self._audio_appended_since_commit = True
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
        appended first. The check is per commit cycle, not just per session:
        DashScope commits (and thereby clears) the audio + image buffers on
        every ``input_audio_buffer.commit`` (in VAD mode the server
        auto-commits at the end of each utterance), so a frame arriving
        after a commit but before the next audio append would be rejected
        with "append image before append audio". ``_audio_seen`` guards the
        session start; ``_audio_appended_since_commit`` guards every
        post-commit window.
        """
        if self.upstream is None:
            raise RuntimeError("omni-realtime: upstream not connected")
        if not self._audio_seen:
            log.warning("omni-realtime: dropping image frame — no audio appended yet")
            return
        if not self._audio_appended_since_commit:
            log.warning(
                "omni-realtime: dropping image frame — no audio appended since the last "
                "input_audio_buffer commit (DashScope clears the image buffer on commit "
                "and requires a fresh audio append before each image frame)",
            )
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

    async def send_text(self, text: str) -> None:
        """Inject a text-only user message and ask for a reply (same session).

        Used by the practice stage's closing review: instead of ending the
        session and opening a fresh full-modal request, the client sends the
        review prompt as plain text so the model answers *within the same
        realtime session*, reusing the audio/video context it already heard
        and saw. The answer comes back as the model's spoken response whose
        ASR transcript is relayed to the client as usual.
        """
        if self.upstream is None:
            raise RuntimeError("omni-realtime: upstream not connected")
        prompt = str(text or "").strip()
        if not prompt:
            return
        await self._await_response_done("send_text")
        item = {
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
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
                        elif evt in (
                            "input_audio_buffer.speech_started",
                            "input_audio_buffer.speech_stopped",
                            "input_audio_buffer.committed",
                            "input_audio_buffer.cleared",
                        ):
                            # DashScope commits (and thereby clears) the
                            # audio + image buffers at the end of each VAD
                            # utterance, and truncates the buffer at speech
                            # onset. Until fresh audio is appended again any
                            # image frame would be rejected with "append
                            # image before append audio" — reset the
                            # freshness flag so `send_image` drops frames
                            # that land in the post-commit window.
                            self._audio_appended_since_commit = False
                yield raw
        except ConnectionClosed:
            log.info("omni-realtime: upstream connection closed")

    async def close(self) -> None:
        """Tear the session down cleanly.

        Per the Bailian docs, each session should be ended with a
        `session.finish` event so the server can flush its audio buffer and
        release the context window — leaving the WS dangling just leaks
        context until the 120-minute hard limit kicks in.
        """
        if self._closed:
            return
        self._closed = True
        if self.upstream is not None:
            try:
                async with self._send_lock:
                    await self.upstream.send(json.dumps({"type": "session.finish"}))
            except (ConnectionClosed, RuntimeError, Exception) as exc:
                # Best-effort: if the upstream is already gone we don't care.
                log_skip("omni_realtime_session_finish", exc)
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
    # bookkeeping — and may arrive FIRST with empty `arguments` while the
    # model is still filling them in. The caller feeds both copies through a
    # `FunctionCallGate` (keyed by call_id) so the client never executes an
    # announcement whose real arguments are still on the wire.
    if event == "response.function_call_arguments.done":
        return json.dumps({
            "type": "function_call",
            "call_id": msg.get("call_id") or "",
            "name": msg.get("name") or "",
            "arguments": _as_arguments_json(msg.get("arguments")),
        }, ensure_ascii=False)

    item = msg.get("item")
    if event == "conversation.item.created" and isinstance(item, dict) and item.get("type") == "function_call":
        return json.dumps({
            "type": "function_call",
            "call_id": item.get("call_id") or "",
            "name": item.get("name") or "",
            "arguments": _as_arguments_json(item.get("arguments")),
        }, ensure_ascii=False)

    if event == "error":
        err = msg.get("error") or {}
        message = err.get("message") if isinstance(err, dict) else str(err)
        if not message:
            message = "unknown upstream error"
        # The proxy enforces "no image without fresh audio" locally via
        # `_audio_appended_since_commit`. If a stale image still slips
        # through and DashScope complains, the user never asked for that
        # frame — drop the error silently. Only the server has the local
        # pre-filter context, so the filter belongs here (not the client).
        if isinstance(message, str) and "append image before append audio" in message.lower():
            return None
        return json.dumps({"type": "error", "message": message}, ensure_ascii=False)

    # Everything else (session events, response.audio.done, usage, etc.) is
    # either redundant with what we forward or pure protocol bookkeeping.
    return None
