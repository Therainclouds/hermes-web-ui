from __future__ import annotations

import io
import json
import logging
import time
import uuid
import wave
from dataclasses import dataclass, field
from typing import Any

import oss2
import requests

from .config import settings

log = logging.getLogger("diarize_proxy")


def _build_wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


@dataclass
class Sentence:
    text: str
    begin_ms: int
    end_ms: int
    speaker_id: int
    sentence_id: int


@dataclass
class ChunkResult:
    chunk_index: int
    chunk_offset_sec: float
    sentences: list[Sentence]
    speakers: list[int] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


def _build_oss_client() -> oss2.Bucket:
    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    endpoint = settings.oss_endpoint
    if not endpoint.startswith("http"):
        endpoint = f"https://{endpoint}"
    return oss2.Bucket(auth, endpoint, settings.oss_bucket)


def upload_wav_to_oss(pcm: bytes, sample_rate: int, session_id: str, chunk_index: int) -> str:
    """Upload a WAV blob to OSS and return its public HTTPS URL."""
    if not settings.oss_configured:
        raise RuntimeError(
            "OSS not configured: set OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET"
        )
    bucket = _build_oss_client()
    wav = _build_wav(pcm, sample_rate)
    key = f"{settings.oss_path_prefix.rstrip('/')}/{session_id}/chunk-{chunk_index:04d}.wav"
    bucket.put_object(key, wav)
    endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
    return f"https://{settings.oss_bucket}.{endpoint}/{key}"


class DiarizeClient:
    """Wraps the paraformer-v2 file-based REST API with diarization enabled."""

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {settings.dashscope_api_key}"}
        )

    @property
    def submit_url(self) -> str:
        return f"{settings.base_url}/api/v1/services/audio/asr/transcription"

    def submit_chunk(
        self,
        *,
        file_url: str,
        language_hints: list[str],
        speaker_count: int | None,
        diarization_enabled: bool,
    ) -> str:
        params: dict[str, Any] = {
            "channel_id": [0],
            "language_hints": language_hints,
        }
        if diarization_enabled:
            params["diarization_enabled"] = True
            if speaker_count and speaker_count >= 2:
                params["speaker_count"] = speaker_count

        body = {
            "model": settings.asr_model,
            "input": {"file_urls": [file_url]},
            "parameters": params,
        }
        headers = {
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
        }
        resp = self.session.post(
            self.submit_url, headers=headers, data=json.dumps(body), timeout=30
        )
        if resp.status_code != 200:
            raise RuntimeError(f"submit failed: {resp.status_code} {resp.text[:300]}")
        data = resp.json()
        task_id = (data.get("output") or {}).get("task_id")
        if not task_id:
            raise RuntimeError(f"submit returned no task_id: {data}")
        log.info("submitted chunk as task %s (file=%s)", task_id, file_url)
        return task_id

    def poll(self, task_id: str, deadline_sec: float = 120.0) -> dict[str, Any]:
        url = f"{settings.base_url}/api/v1/tasks/{task_id}"
        # Note: query task endpoint does NOT require X-DashScope-Async header.
        # Sending it triggers a 403 "current user api does not support asynchronous calls".
        headers = {}
        start = time.monotonic()
        while True:
            resp = self.session.post(url, headers=headers, timeout=15)
            if resp.status_code != 200:
                raise RuntimeError(f"poll failed: {resp.status_code} {resp.text[:200]}")
            data = resp.json()
            status = (data.get("output") or {}).get("task_status")
            if status in {"SUCCEEDED", "FAILED"}:
                return data
            if time.monotonic() - start > deadline_sec:
                raise TimeoutError(f"task {task_id} timed out after {deadline_sec}s")
            time.sleep(settings.asr_poll_interval_seconds)

    def fetch_transcript(self, transcription_url: str) -> dict[str, Any]:
        resp = self.session.get(transcription_url, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def best_result_url(self, task_data: dict[str, Any]) -> str | None:
        output = task_data.get("output") or {}
        code = output.get("code", "")
        if code == "SUCCESS_WITH_NO_VALID_FRAGMENT":
            return None
        for r in output.get("results") or []:
            if r.get("subtask_status") == "SUCCEEDED" and r.get("transcription_url"):
                return r["transcription_url"]
        return None


def parse_sentences(payload: dict[str, Any]) -> tuple[list[Sentence], list[int]]:
    sentences: list[Sentence] = []
    speakers: set[int] = set()
    transcripts = payload.get("transcripts") or []
    for tr in transcripts:
        for sent in tr.get("sentences") or []:
            try:
                text = (sent.get("text") or "").strip()
                if not text:
                    continue
                speaker_id = int(sent.get("speaker_id", 0))
                sentences.append(
                    Sentence(
                        text=text,
                        begin_ms=int(sent.get("begin_time", 0)),
                        end_ms=int(sent.get("end_time", 0)),
                        speaker_id=speaker_id,
                        sentence_id=int(sent.get("sentence_id", 0)),
                    )
                )
                speakers.add(speaker_id)
            except (TypeError, ValueError):
                continue
    return sentences, sorted(speakers)


def new_session_id() -> str:
    return uuid.uuid4().hex[:12]