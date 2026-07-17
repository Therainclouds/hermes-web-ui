"""Speaker-diarization WebSocket endpoint.

Lives in its own module so the realtime WebSocket ASR (`/ws/asr`) and the
file-based speaker-diarization flow (`/ws/diarize`) can coexist.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .config import settings
from .diarize_proxy import DiarizeClient, new_session_id, parse_sentences, upload_wav_to_oss

log = logging.getLogger("diarize_endpoint")

MAX_CONCURRENT_CHUNKS = 3


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
    """FastAPI WebSocket endpoint for speaker-diarized transcription."""
    await ws.accept()
    if not settings.oss_configured:
        await _send(
            ws,
            {
                "type": "error",
                "message": "OSS not configured on backend; cannot host audio for paraformer-v2",
            },
        )
        await ws.close()
        return

    session: DiarizeSession | None = None
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
                    if session.audio_buffer and len(session.audio_buffer) > cfg.sample_rate * 2:
                        await _process_chunk(session)
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
        try:
            await _send(ws, {"type": "stopped"})
        except Exception:
            pass