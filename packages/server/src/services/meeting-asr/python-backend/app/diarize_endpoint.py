"""Speaker-diarization WebSocket endpoint.

Lives in its own module so the realtime WebSocket ASR (`/ws/asr`) and the
file-based speaker-diarization flow (`/ws/diarize`) can coexist.

When OSS is not configured, falls back to the realtime WebSocket API (PCM
direct, no OSS needed). Speaker diarization is best-effort in fallback mode.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import WebSocket, WebSocketDisconnect
import websockets
from websockets.exceptions import ConnectionClosed

from .config import settings
from .diarize_proxy import DiarizeClient, cleanup_session_files, new_session_id, parse_sentences, upload_wav_to_oss
from ._log_helper import log_skip

log = logging.getLogger("diarize_endpoint")

MAX_CONCURRENT_CHUNKS = 3

# Thread executor for outbound WS connections — runs in its own thread with a
# separate event loop so that cancellation of the uvicorn handler task does not
# propagate into the middle of the DashScope websockets.connect call.
_ws_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)


# ── WebSocket fallback (PCM direct, no OSS) ──────────────────────

@dataclass
class _WsTranscript:
    """Accumulated transcription from the WebSocket API."""
    text: str = ""
    sentences: list[dict] = field(default_factory=list)


async def _run_ws_transcribe_impl(
    pcm: bytes,
    sample_rate: int,
    speaker_count: int | None,
    language_hints: list[str],
    on_sentence: Callable[[dict], None] | None = None,
) -> _WsTranscript:
    """Send PCM to the paraformer-realtime WebSocket API and collect results.

    When *on_sentence* is provided, complete sentences received during the PCM
    send phase are forwarded immediately (before ``finish-task``), giving the
    frontend near-real-time feedback even in batch mode.
    """
    if not settings.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured; cannot fallback to WS API")

    result = _WsTranscript()
    headers = [
        ("Authorization", f"Bearer {settings.dashscope_api_key}"),
        ("User-Agent", "meeting-asr-cloud/0.1 (fallback)"),
    ]
    task_id = uuid.uuid4().hex[:12]

    log.info("_run_ws_transcribe: connecting to %s pcm_len=%d sample_rate=%d",
             settings.paraformer_ws_url, len(pcm), sample_rate)

    async with websockets.connect(
        settings.paraformer_ws_url,
        extra_headers=headers,
        max_size=64 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=20,
        open_timeout=30,
        close_timeout=2,
    ) as ws:
        # Start task
        run_task: dict[str, Any] = {
            "header": {
                "action": "run-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": settings.paraformer_model,
                "parameters": {
                    "format": settings.paraformer_format,
                    "sample_rate": sample_rate,
                    "language_hints": language_hints,
                    "semantic_punctuation_enabled": settings.paraformer_semantic_punctuation,
                    "punctuation_prediction_enabled": True,
                    "inverse_text_normalization_enabled": True,
                    "heartbeat": True,
                },
                "input": {},
            },
        }
        # Note: diarization is NOT sent to the realtime WS API — it only works
        # via the REST API mode (OSS required). The realtime WS API rejects
        # unknown parameters, causing the whole transcription to fail.
        await ws.send(json.dumps(run_task))
        started = json.loads(await ws.recv())
        event = started.get("header", {}).get("event")
        log.info("_run_ws_transcribe: task-start response event=%s task_id=%s", event, task_id)
        if event != "task-started":
            raise RuntimeError(f"WS task not started: {started}")

        # Send PCM in 1-second chunks (batch mode — no streaming latency needed)
        frame_bytes = sample_rate * 2  # 1 second per chunk
        log.info("_run_ws_transcribe: sending %d chunks of PCM (%.1fs total)",
                 (len(pcm) + frame_bytes - 1) // frame_bytes if frame_bytes else 0,
                 len(pcm) / (sample_rate * 2))
        offset = 0
        while offset < len(pcm):
            chunk = pcm[offset:offset + frame_bytes]
            if not chunk:
                break
            await ws.send(chunk)
            offset += len(chunk)
            # Drain result-generated events; forward complete sentences immediately
            try:
                while True:
                    partial = await asyncio.wait_for(ws.recv(), timeout=0.01)
                    if isinstance(partial, (bytes, bytearray)):
                        continue
                    try:
                        evt = json.loads(partial)
                    except json.JSONDecodeError:
                        continue
                    _merge_ws_event(result, evt, on_sentence)
            except (asyncio.TimeoutError, ConnectionClosed):
                pass

        # Finish task
        log.info("_run_ws_transcribe: sending finish-task task_id=%s", task_id)
        finish_msg = {
            "header": {
                "action": "finish-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {}},
        }
        await ws.send(json.dumps(finish_msg))

        # Collect final results with timeout
        # The DashScope WS API sends heartbeats periodically — without a timeout
        # the loop may hang indefinitely if task-finished never arrives.
        try:
            deadline = time.monotonic() + 20.0  # max 20s for the API to respond
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    continue
                try:
                    evt = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                log.info("_run_ws_transcribe event=%s", evt.get("header", {}).get("event", "?"))
                _merge_ws_event(result, evt, on_sentence)
                event = evt.get("header", {}).get("event", "")
                if event in ("task-finished", "task-failed"):
                    break
                if time.monotonic() > deadline:
                    log.warning("_run_ws_transcribe deadline exceeded, breaking")
                    break
        except ConnectionClosed:
            pass

    log.info("_run_ws_transcribe: done text_len=%d sentences=%d", len(result.text), len(result.sentences))
    return result


async def _run_ws_transcribe(
    pcm: bytes,
    sample_rate: int,
    speaker_count: int | None,
    language_hints: list[str],
    on_sentence: Callable[[dict], None] | None = None,
) -> _WsTranscript:
    """Run transcription in a standalone thread with its own event loop.

    Uvicorn's Windows event loop can cancel ``run_in_executor`` futures when the
    handler task is cancelled (e.g. client disconnect).  By owning our own thread
    and event loop we avoid cancellation propagation into the DashScope WS API
    connection.
    """
    if not settings.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured; cannot fallback to WS API")

    def _sync_run() -> _WsTranscript:
        new_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(new_loop)
        try:
            return new_loop.run_until_complete(
                _run_ws_transcribe_impl(pcm, sample_rate, speaker_count, language_hints, on_sentence)
            )
        finally:
            new_loop.close()
            asyncio.set_event_loop(None)

    loop = asyncio.get_running_loop()
    c_future = _ws_executor.submit(_sync_run)
    a_future = asyncio.wrap_future(c_future, loop=loop)
    try:
        return await a_future
    except asyncio.CancelledError:
        # The thread continues in the background — the result is discarded.
        # This is acceptable because the outer handler has already ended.
        raise


def _merge_ws_event(
    result: _WsTranscript,
    evt: dict,
    on_sentence: Callable[[dict], None] | None = None,
) -> None:
    """Merge a WS API transcription event into the accumulated result.

    DashScope Paraformer-realtime WS API sends two types of data-bearing events:

    * ``result-generated`` — a single ``sentence`` per event (streaming).
    * ``task-finished`` — the full accumulated transcript in
      ``output.usage.sentences`` array, plus ``output.usage.text``.

    When *on_sentence* is provided and a ``result-generated`` event carries a
    complete sentence (``sentence_end: true``), the callback is invoked with
    a ``{"text", "begin_time", "end_time"}`` dict so the caller can forward
    partial results to the frontend in near-real-time.
    """
    header = evt.get("header", {})
    payload = evt.get("payload", {}) or {}
    event_type = header.get("event", "")
    output = payload.get("output", {}) or {}

    # Always log event type and a truncated view of the payload for diagnosis
    payload_str = json.dumps(payload, ensure_ascii=False)
    if len(payload_str) > 500:
        payload_str = payload_str[:500] + "...(truncated)"
    log.info("_merge_ws_event event=%s output_keys=%s payload=%s", event_type, list(output.keys()), payload_str)

    # ── result-generated / result: single sentence per event ──────────
    if event_type in ("result-generated", "result"):
        sentence = output.get("sentence", payload.get("sentence", {})) or {}
        if not isinstance(sentence, dict):
            log.warning("_merge_ws_event: sentence is not a dict: %s", type(sentence))
            return
        text = (sentence.get("text") or "")
        if not text:
            return
        _append_ws_sentence(result, sentence)
        log.info("_merge_ws_event: added sentence text_len=%d total_sentences=%d", len(text), len(result.sentences))
        # Forward complete sentences to the frontend in near-real-time
        if on_sentence and sentence.get("sentence_end"):
            on_sentence({
                "text": text,
                "begin_time": sentence.get("begin_time") or 0,
                "end_time": sentence.get("end_time") or 0,
            })
        return

    # ── task-finished / task-failed: accumulated result ───────────────
    if event_type in ("task-finished", "task-failed"):
        usage = output.get("usage", payload.get("usage", {})) or {}
        text = (usage.get("text") or "")
        if text:
            result.text = text
        sentences = usage.get("sentences", [])
        if not isinstance(sentences, list):
            log.warning("_merge_ws_event: sentences is not a list: %s", type(sentences))
            return
        for s in sentences:
            _append_ws_sentence(result, s)
        log.info("_merge_ws_event: task-finished total_text=%d total_sentences=%d", len(result.text), len(result.sentences))
        return


def _append_ws_sentence(result: _WsTranscript, s: dict) -> None:
    """Append a single sentence dict to the accumulated transcript."""
    text = (s.get("text", "") or "").strip()
    if not text:
        return
    sid = len(result.sentences)
    # DashScope WS API may return numeric fields as null (None)
    spk = s.get("speaker_id", -1)
    if spk is None:
        spk = -1
    result.sentences.append({
        "sentence_id": sid,
        "text": text,
        "begin_time": s.get("begin_time") or 0,
        "end_time": s.get("end_time") or 0,
        "speaker_id": spk,
    })


def _ws_result_to_chunk_result(
    ws_result: _WsTranscript,
    chunk_index: int,
    offset_sec: float,
) -> dict:
    """Convert WS API transcript to the same output schema as the REST flow."""
    sentences = []
    speakers: set[int] = set()
    for s in ws_result.sentences:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        spk = s.get("speaker_id", -1)
        if spk is None:
            spk = -1
        if spk >= 0:
            speakers.add(spk)
        sid = s.get("sentence_id", len(sentences))
        if sid is None:
            sid = len(sentences)
        sentences.append({
            "text": text,
            "begin_ms": int(s.get("begin_time") or 0),
            "end_ms": int(s.get("end_time") or 0),
            "speaker_id": spk if spk >= 0 else 0,
            "sentence_id": sid,
        })
    return {
        "type": "transcript",
        "chunk_index": chunk_index,
        "offset_sec": offset_sec,
        "sentences": sentences,
        "speakers": sorted(speakers) if speakers else [0],
    }


# ── OSS-based flow (original) ────────────────────────────────────

@dataclass
class SessionConfig:
    sample_rate: int = 16000
    language_hints: list[str] = field(default_factory=lambda: settings.language_hints_list())
    speaker_count: int | None = None
    diarization_enabled: bool = True
    chunk_seconds: float = settings.asr_chunk_seconds
    overlap_seconds: float = settings.asr_chunk_overlap_seconds


@dataclass
class DiarizeSession:
    session_id: str
    config: SessionConfig
    ws: WebSocket
    audio_buffer: bytearray = field(default_factory=bytearray)
    overlap_bytes: int = 0
    chunk_index: int = 0
    submission_offset_sec: float = 0.0
    started_at: float = field(default_factory=time.time)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _processor_task: asyncio.Task | None = None
    _pending_tasks: set = field(default_factory=set)
    _closed: bool = False


def _bytes_per_chunk(cfg: SessionConfig) -> int:
    return int(cfg.sample_rate * 2 * cfg.chunk_seconds)


def _bytes_per_overlap(cfg: SessionConfig) -> int:
    return int(cfg.sample_rate * 2 * cfg.overlap_seconds)


async def _send(ws: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await ws.send_json(payload)
    except (WebSocketDisconnect, RuntimeError):
        pass


async def _process_chunk_async(session: DiarizeSession, chunk_pcm: bytes, offset_sec: float, chunk_idx: int) -> bool:
    """Process a single chunk concurrently: upload, submit, poll, send results."""
    cfg = session.config
    client = DiarizeClient()
    try:
        loop = asyncio.get_running_loop()
        file_url = await loop.run_in_executor(
            None,
            upload_wav_to_oss,
            chunk_pcm,
            cfg.sample_rate,
            session.session_id,
            chunk_idx,
        )
        task_id = await loop.run_in_executor(
            None,
            lambda: client.submit_chunk(
                file_url=file_url,
                language_hints=cfg.language_hints,
                speaker_count=cfg.speaker_count,
                diarization_enabled=cfg.diarization_enabled,
            ),
        )
        await _send(
            session.ws,
            {
                "type": "chunk_submitted",
                "chunk_index": chunk_idx,
                "task_id": task_id,
                "file_url": file_url,
            },
        )
        task_data = await loop.run_in_executor(None, client.poll, task_id)
        result_url = client.best_result_url(task_data)
        if not result_url:
            # SUCCESS_WITH_NO_VALID_FRAGMENT or no result - silent chunk, skip
            log.info("chunk %d: no valid speech, skipping", chunk_idx)
            return True
        transcript = await loop.run_in_executor(None, client.fetch_transcript, result_url)
        sentences, speakers = parse_sentences(transcript)
        await _send(
            session.ws,
            {
                "type": "transcript",
                "chunk_index": chunk_idx,
                "offset_sec": offset_sec,
                "sentences": [
                    {
                        "text": s.text,
                        "begin_ms": s.begin_ms,
                        "end_ms": s.end_ms,
                        "speaker_id": s.speaker_id,
                        "sentence_id": s.sentence_id,
                    }
                    for s in sentences
                ],
                "speakers": speakers,
            },
        )
        return True
    except Exception as exc:
        log.exception("chunk %d failed: %s", chunk_idx, exc)
        await _send(session.ws, {"type": "error", "message": f"chunk {chunk_idx}: {exc}"})
        return False
    finally:
        session._pending_tasks.discard(asyncio.current_task())


def _drain_chunk(session: DiarizeSession) -> tuple[bytes, float, int] | None:
    """Extract one chunk from the buffer. Returns (pcm, offset_sec, chunk_idx) or None."""
    cfg = session.config
    if len(session.audio_buffer) < _bytes_per_chunk(cfg) - session.overlap_bytes:
        return None
    chunk_pcm = bytes(session.audio_buffer[: _bytes_per_chunk(cfg)])
    overlap = (
        bytes(session.audio_buffer[-session.overlap_bytes :])
        if session.overlap_bytes
        else b""
    )
    offset_sec = session.submission_offset_sec
    chunk_idx = session.chunk_index
    if session.overlap_bytes:
        session.audio_buffer = bytearray(overlap)
    else:
        session.audio_buffer.clear()
    session.chunk_index += 1
    session.submission_offset_sec += cfg.chunk_seconds - cfg.overlap_seconds
    return chunk_pcm, offset_sec, chunk_idx


async def _processor_loop(session: DiarizeSession) -> None:
    check_interval = 0.2
    while not session._closed:
        try:
            await asyncio.sleep(check_interval)
            if session._closed:
                break
            while len(session._pending_tasks) < MAX_CONCURRENT_CHUNKS:
                async with session._lock:
                    drained = _drain_chunk(session)
                if drained is None:
                    break
                chunk_pcm, offset_sec, chunk_idx = drained
                await _send(
                    session.ws,
                    {"type": "chunk_queued", "chunk_index": chunk_idx, "offset_sec": offset_sec},
                )
                task = asyncio.create_task(
                    _process_chunk_async(session, chunk_pcm, offset_sec, chunk_idx)
                )
                session._pending_tasks.add(task)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.exception("processor loop error: %s", exc)
            await asyncio.sleep(0.5)


async def diarize_ws_handler(ws: WebSocket) -> None:
    """FastAPI WebSocket endpoint for speaker-diarized transcription.

    Two processing modes, auto-selected at connect time:
    - OSS configured → split PCM into chunks, upload WAV to OSS, submit
      each chunk to paraformer-v2 file-based REST API (original flow).
    - No OSS       → buffer all PCM, then send to paraformer-realtime
      WebSocket API in one streaming session (PCM direct, no OSS needed).
    """
    await ws.accept()

    session: DiarizeSession | None = None
    fallback_mode = not settings.oss_configured
    try:
        first = await ws.receive()
        if "text" not in first:
            await _send(ws, {"type": "error", "message": "expected JSON start frame"})
            await ws.close()
            return
        try:
            start_msg = json.loads(first["text"])
        except json.JSONDecodeError:
            await _send(ws, {"type": "error", "message": "invalid start JSON"})
            await ws.close()
            return
        if start_msg.get("type") != "start":
            await _send(
                ws,
                {"type": "error", "message": 'first frame must be {"type":"start", ...}'},
            )
            await ws.close()
            return

        sample_rate = int(start_msg.get("sample_rate") or settings.asr_sample_rate)
        speaker_count = start_msg.get("speaker_count")
        if speaker_count in (0, None, "", "auto"):
            speaker_count = None
        else:
            try:
                speaker_count = max(2, min(100, int(speaker_count)))
            except (TypeError, ValueError):
                speaker_count = None

        cfg = SessionConfig(
            sample_rate=sample_rate,
            speaker_count=speaker_count,
            language_hints=settings.language_hints_list(),
        )

        if fallback_mode:
            # ── WS fallback: buffer all PCM, process on stop ──
            log.info("diarize fallback mode (no OSS) — buffering PCM for batch WS transcribe")
            session = DiarizeSession(
                session_id=new_session_id(),
                config=cfg,
                ws=ws,
            )
            await _send(
                ws,
                {
                    "type": "ready",
                    "session_id": session.session_id,
                    "sample_rate": cfg.sample_rate,
                    "fallback_mode": True,
                    "note": "OSS not configured; using PCM-direct WebSocket fallback",
                },
            )

            while not session._closed:
                try:
                    frame = await ws.receive()
                except (WebSocketDisconnect, RuntimeError):
                    break
                if "bytes" in frame:
                    data = frame["bytes"]
                    if not data:
                        continue
                    session.audio_buffer.extend(data)
                    max_bytes = cfg.sample_rate * 2 * settings.asr_max_audio_seconds
                    if len(session.audio_buffer) > max_bytes:
                        del session.audio_buffer[: len(session.audio_buffer) - max_bytes]
                elif "text" in frame:
                    try:
                        msg = json.loads(frame["text"])
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "stop":
                        session._closed = True
                        break
                    elif msg.get("type") == "set_speaker_count":
                        try:
                            new_count = msg.get("value")
                            if new_count in (0, None, "", "auto"):
                                session.config.speaker_count = None
                            else:
                                session.config.speaker_count = max(2, min(100, int(new_count)))
                        except (TypeError, ValueError):
                            pass

            # Process the accumulated buffer via WS API
            if session.audio_buffer and len(session.audio_buffer) > cfg.sample_rate * 2:
                audio_dur = len(session.audio_buffer) / (cfg.sample_rate * 2)
                log.info("diarize: processing buffer duration=%.1fs bytes=%d sample_rate=%d",
                         audio_dur, len(session.audio_buffer), cfg.sample_rate)
                await _send(ws, {"type": "processing", "message": "transcribing via WebSocket API (direct PCM)"})
                try:

                    uvicorn_loop = asyncio.get_running_loop()

                    def _forward_sentence(s: dict) -> None:
                        """Forward a complete sentence to the frontend (sync, called from worker thread)."""
                        asyncio.run_coroutine_threadsafe(
                            _send(ws, {
                                "type": "final",
                                "text": s["text"],
                                "begin_time": s.get("begin_time", 0),
                                "end_time": s.get("end_time", 0),
                            }),
                            uvicorn_loop,
                        )

                    ws_result = await _run_ws_transcribe(
                        pcm=bytes(session.audio_buffer),
                        sample_rate=cfg.sample_rate,
                        speaker_count=cfg.speaker_count,
                        language_hints=cfg.language_hints,
                        on_sentence=_forward_sentence,
                    )
                    log.info("diarize: transcription returned sentences=%d text_len=%d",
                             len(ws_result.sentences), len(ws_result.text))
                    if ws_result.sentences:
                        chunk_result = _ws_result_to_chunk_result(
                            ws_result, chunk_index=0, offset_sec=0.0,
                        )
                        log.info("diarize: sending transcript with %d sentences", len(chunk_result.get("sentences", [])))
                        await _send(ws, chunk_result)
                    else:
                        log.info("diarize: no sentences from transcription, sending empty result")
                except Exception as exc:
                    tb = traceback.format_exc()
                    log.error("WS fallback transcribe failed:\n%s", tb)
                    await _send(ws, {"type": "error", "message": f"fallback transcribe failed: {exc}\n{tb}"})

            await _send(ws, {"type": "stopped"})
        else:
            # ── OSS flow: chunk-based with upload → REST API ──
            session = DiarizeSession(
                session_id=new_session_id(),
                config=cfg,
                ws=ws,
                overlap_bytes=_bytes_per_overlap(cfg),
            )
            session._processor_task = asyncio.create_task(_processor_loop(session))

            await _send(
                ws,
                {
                    "type": "ready",
                    "session_id": session.session_id,
                    "chunk_seconds": cfg.chunk_seconds,
                    "overlap_seconds": cfg.overlap_seconds,
                    "sample_rate": cfg.sample_rate,
                    "speaker_count_hint": cfg.speaker_count,
                },
            )

            while not session._closed:
                try:
                    frame = await ws.receive()
                except (WebSocketDisconnect, RuntimeError):
                    break

                if "bytes" in frame:
                    data = frame["bytes"]
                    if not data:
                        continue
                    session.audio_buffer.extend(data)
                    max_bytes = cfg.sample_rate * 2 * settings.asr_max_audio_seconds
                    if len(session.audio_buffer) > max_bytes:
                        del session.audio_buffer[: len(session.audio_buffer) - max_bytes]
                elif "text" in frame:
                    try:
                        msg = json.loads(frame["text"])
                    except json.JSONDecodeError:
                        continue
                    mtype = msg.get("type")
                    if mtype == "stop":
                        session._closed = True
                        # Process any remaining buffer as final chunk.
                        async with session._lock:
                            remaining = bytes(session.audio_buffer)
                            session.audio_buffer.clear()
                        if remaining and len(remaining) > cfg.sample_rate:  # >= 0.5s
                            log.info("diarize: processing final chunk of %.1fs",
                                     len(remaining) / (cfg.sample_rate * 2))
                            await _process_chunk_async(
                                session, remaining,
                                offset_sec=session.submission_offset_sec,
                                chunk_idx=session.chunk_index,
                            )
                        break
                    elif mtype == "set_speaker_count":
                        try:
                            new_count = msg.get("value")
                            if new_count in (0, None, "", "auto"):
                                session.config.speaker_count = None
                            else:
                                session.config.speaker_count = max(2, min(100, int(new_count)))
                            await _send(
                                ws,
                                {
                                    "type": "speaker_count_updated",
                                    "value": session.config.speaker_count,
                                },
                            )
                        except (TypeError, ValueError):
                            pass

    except WebSocketDisconnect:
        log.info("diarize client disconnected")
    except Exception as exc:
        log.exception("ws_diarize error: %s", exc)
        await _send(ws, {"type": "error", "message": str(exc)})
    finally:
        if session is not None:
            session._closed = True
            if session._processor_task is not None:
                session._processor_task.cancel()
                try:
                    await session._processor_task
                except (asyncio.CancelledError, Exception):
                    pass
            if session._pending_tasks:
                for t in list(session._pending_tasks):
                    t.cancel()
                await asyncio.gather(*session._pending_tasks, return_exceptions=True)
                session._pending_tasks.clear()
            # Cleanup OSS files for this session
            try:
                loop = asyncio.get_running_loop()
                deleted_count = await loop.run_in_executor(
                    None, cleanup_session_files, session.session_id
                )
                log.info("Cleaned up %d OSS files for session %s", deleted_count, session.session_id)
            except Exception as cleanup_exc:
                log.error("Failed to cleanup OSS files: %s", cleanup_exc)
        try:
            await _send(ws, {"type": "stopped"})
        except Exception as exc:
            log_skip("diarize_stop_send", exc)