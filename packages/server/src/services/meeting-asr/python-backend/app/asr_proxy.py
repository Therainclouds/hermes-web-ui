from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, AsyncIterator

import websockets
from websockets.exceptions import ConnectionClosed

from .config import settings

log = logging.getLogger("asr_proxy")


class ParaformerProxy:
    """Bridges a frontend WebSocket and the Aliyun Paraformer real-time WS API.

    The frontend sends a small JSON control message first
    (`{"type": "start", "sample_rate": 16000, ...}`), then streams raw
    Int16 PCM frames as binary messages, and finally sends
    `{"type": "stop"}` to end the task.
    """

    def __init__(self) -> None:
        self.upstream: websockets.WebSocketClientProtocol | None = None
        self.task_id: str = ""
        self._send_lock = asyncio.Lock()

    async def connect(self) -> None:
        if not settings.dashscope_api_key:
            raise RuntimeError("DASHSCOPE_API_KEY is not configured")

        headers = [
            ("Authorization", f"Bearer {settings.dashscope_api_key}"),
            ("User-Agent", "meeting-asr-cloud/0.1"),
        ]

        log.info("connecting to upstream %s", settings.paraformer_ws_url)
        self.upstream = await websockets.connect(
            settings.paraformer_ws_url,
            extra_headers=headers,
            max_size=64 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
        )

        self.task_id = str(uuid.uuid4())
        run_task: dict[str, Any] = {
            "header": {
                "action": "run-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": settings.paraformer_model,
                "parameters": {
                    "format": settings.paraformer_format,
                    "sample_rate": settings.paraformer_sample_rate,
                    "language_hints": settings.language_hints_list(),
                    "semantic_punctuation_enabled": settings.paraformer_semantic_punctuation,
                    "punctuation_prediction_enabled": True,
                    "inverse_text_normalization_enabled": True,
                    "heartbeat": True,
                },
                "input": {},
            },
        }
        await self.upstream.send(json.dumps(run_task))

        started = json.loads(await self.upstream.recv())
        event = started.get("header", {}).get("event")
        if event != "task-started":
            raise RuntimeError(f"upstream did not confirm task-started: {started}")

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if self.upstream is None:
            raise RuntimeError("upstream not connected")
        async with self._send_lock:
            await self.upstream.send(pcm_bytes)

    async def finish(self) -> None:
        if self.upstream is None:
            return
        msg = {
            "header": {
                "action": "finish-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {}},
        }
        try:
            async with self._send_lock:
                await self.upstream.send(json.dumps(msg))
        except ConnectionClosed:
            pass

    async def upstream_events(self) -> AsyncIterator[dict[str, Any]]:
        if self.upstream is None:
            raise RuntimeError("upstream not connected")
        try:
            async for raw in self.upstream:
                if isinstance(raw, (bytes, bytearray)):
                    continue
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("non-json upstream frame: %r", raw[:200])
        except ConnectionClosed:
            log.info("upstream connection closed")

    async def close(self) -> None:
        if self.upstream is not None:
            try:
                await self.upstream.close()
            except Exception:
                pass
            self.upstream = None