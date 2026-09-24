"""Tests for whole-file (batch) transcription + diarization.

Covers the two engines' response parsing and the async job lifecycle:
  - MiniMax `verbose_json` → sentence list with global speaker numbering
    across chunk boundaries (the 500 s per-request cap forces chunking).
  - `diarize=False` must strip speaker labels instead of surfacing
    `speaker_id: -1` as a "speaker".
  - Qwen's synchronous endpoint rejects audio longer than 5 minutes with an
    actionable message (the no-OSS path).
  - The job registry transitions pending → running → done / error and the
    status endpoint contract stays stable.
"""

from __future__ import annotations

import asyncio
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_BACKEND = REPO_ROOT / "packages" / "server" / "src" / "services" / "meeting-asr" / "python-backend"
if str(PY_BACKEND) not in sys.path:
    sys.path.insert(0, str(PY_BACKEND))

from app import file_transcribe  # noqa: E402

SECOND = file_transcribe.BYTES_PER_SECOND


def pcm(seconds: float) -> bytes:
    return b"\x00\x01" * int(SECOND / 2 * seconds)


def teardown_module(module) -> None:  # noqa: ARG001 - pytest hook signature
    """Restore a live event loop after this module finishes.

    ``IsolatedAsyncioTestCase`` closes its loop and calls
    ``asyncio.set_event_loop(None)`` on teardown. Older tests in this suite
    (``test_omni_realtime_proxy.py``) still call the deprecated
    ``asyncio.get_event_loop()``, which raises "There is no current event
    loop" once the loop has been cleared. Restore one so the session state
    matches what the other modules expect.
    """
    asyncio.set_event_loop(asyncio.new_event_loop())


def minimax_payload(segments, text="", n_speakers=None):
    return {
        "text": text or " ".join(s["text"] for s in segments),
        "duration": 1.0,
        "n_speakers": n_speakers,
        "segments": segments,
    }


class DecodeAudioTest(unittest.TestCase):
    """ffmpeg is a declared device/Docker dependency; skip where absent."""

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_decodes_a_wav_container_to_16k_mono_pcm(self):
        source = file_transcribe._pcm_to_wav(pcm(1), file_transcribe.SAMPLE_RATE)
        decoded = asyncio.run(file_transcribe.decode_audio_to_pcm(source))
        self.assertEqual(len(decoded), SECOND)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_undecodable_input_raises_a_readable_error(self):
        with self.assertRaises(RuntimeError) as ctx:
            asyncio.run(file_transcribe.decode_audio_to_pcm(b"definitely-not-audio"))
        self.assertIn("ffmpeg failed to decode", str(ctx.exception))


class SplitPcmTest(unittest.TestCase):
    def test_splits_into_fixed_windows(self):
        chunks = file_transcribe._split_pcm(pcm(25), max_seconds=10)
        self.assertEqual(len(chunks), 3)
        self.assertEqual(len(chunks[0]), 10 * SECOND)
        self.assertEqual(len(chunks[2]), 5 * SECOND)

    def test_short_audio_is_a_single_chunk(self):
        chunks = file_transcribe._split_pcm(pcm(3), max_seconds=480)
        self.assertEqual(len(chunks), 1)


class MiniMaxRunTest(unittest.IsolatedAsyncioTestCase):
    async def test_diarized_segments_map_to_global_speaker_ids(self):
        payload = minimax_payload(
            [
                {"id": 0, "start": 0.1, "end": 1.6, "speaker": "S1", "text": "你好"},
                {"id": 1, "start": 2.0, "end": 6.1, "speaker": "S2", "text": "开始吧"},
                {"id": 2, "start": 6.5, "end": 8.0, "speaker": "S1", "text": "好的"},
            ],
            n_speakers=2,
        )
        with mock.patch.object(file_transcribe, "_minimax_post", new=mock.AsyncMock(return_value=payload)):
            result = await file_transcribe._run_minimax(
                pcm(10), diarize=True, speaker_count=0, language="", progress=lambda *_: None,
            )
        self.assertEqual(len(result["sentences"]), 3)
        self.assertEqual([s["speaker_id"] for s in result["sentences"]], [1, 2, 1])
        self.assertEqual(result["speakers"], [1, 2])
        self.assertEqual(result["sentences"][0]["begin_ms"], 100)
        self.assertEqual(result["sentences"][1]["end_ms"], 6100)
        self.assertEqual(result["warnings"], [])

    async def test_second_chunk_continues_speaker_numbering(self):
        calls = []

        async def fake_post(wav, *, diarize, language):
            calls.append(len(wav))
            if len(calls) == 1:
                return minimax_payload([{"start": 0, "end": 1, "speaker": "S1", "text": "甲"}])
            return minimax_payload([{"start": 0, "end": 1, "speaker": "S1", "text": "乙"}])

        with mock.patch.object(file_transcribe, "_minimax_post", new=fake_post), \
             mock.patch.object(file_transcribe.settings, "minimax_file_chunk_seconds", 10.0):
            result = await file_transcribe._run_minimax(
                pcm(15), diarize=True, speaker_count=0, language="", progress=lambda *_: None,
            )

        self.assertEqual(len(calls), 2)
        # S1 of the second chunk must not collide with S1 of the first
        self.assertEqual([s["speaker_id"] for s in result["sentences"]], [1, 2])
        self.assertIn("minimax_chunked", result["warnings"])
        # the second chunk's timestamps are shifted onto the global timeline
        self.assertEqual(result["sentences"][1]["begin_ms"], 10_000)

    async def test_no_diarization_strips_speaker_labels(self):
        payload = minimax_payload([
            {"start": 0, "end": 1, "speaker": "S1", "text": "一句"},
        ])
        with mock.patch.object(file_transcribe, "_minimax_post", new=mock.AsyncMock(return_value=payload)):
            result = await file_transcribe._run_minimax(
                pcm(5), diarize=False, speaker_count=0, language="", progress=lambda *_: None,
            )
        self.assertEqual(result["speakers"], [])
        self.assertEqual([s["speaker_id"] for s in result["sentences"]], [-1])

    async def test_flat_text_kept_when_no_segments(self):
        with mock.patch.object(
            file_transcribe, "_minimax_post",
            new=mock.AsyncMock(return_value={"text": "只有文本"}),
        ):
            result = await file_transcribe._run_minimax(
                pcm(4), diarize=True, speaker_count=0, language="", progress=lambda *_: None,
            )
        self.assertEqual(len(result["sentences"]), 1)
        self.assertEqual(result["sentences"][0]["text"], "只有文本")
        self.assertEqual(result["sentences"][0]["end_ms"], 4000)


class QwenSyncGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_audio_longer_than_the_sync_limit(self):
        with mock.patch.object(file_transcribe.settings, "dashscope_api_key", "sk-test"):
            with self.assertRaises(RuntimeError) as ctx:
                await file_transcribe._run_qwen_sync(
                    pcm(file_transcribe.QWEN_SYNC_MAX_SECONDS + 1),
                    language="",
                    progress=lambda *_: None,
                )
        self.assertIn("qwen_sync_too_long", str(ctx.exception))

    async def test_parses_the_documented_nested_response_shape(self):
        captured = {}

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return {"output": {"output": {"sentence": {"text": "识别文本"}}, "text": "识别文本"}}

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, headers=None, json=None):
                captured["url"] = url
                captured["body"] = json
                return FakeResponse()

        with mock.patch.object(file_transcribe.settings, "dashscope_api_key", "sk-test"), \
             mock.patch.object(file_transcribe.httpx, "AsyncClient", lambda **_: FakeClient()):
            result = await file_transcribe._run_qwen_sync(
                pcm(3), language="zh", progress=lambda *_: None,
            )

        self.assertEqual(result["text"], "识别文本")
        self.assertEqual(result["speakers"], [])
        self.assertEqual(result["sentences"][0]["end_ms"], 3000)
        self.assertIn("qwen_sync_no_diarization", result["warnings"])
        self.assertIn("multimodal-generation", captured["url"])
        self.assertTrue(captured["body"]["input"]["messages"][0]["content"][0]["input_audio"]["data"].startswith("data:audio/wav;base64,"))


class QwenDiarizeGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_requires_oss(self):
        with mock.patch.object(file_transcribe.settings, "dashscope_api_key", "sk-test"), \
             mock.patch.object(file_transcribe.settings, "oss_bucket", ""), \
             mock.patch.object(file_transcribe.settings, "oss_access_key_id", ""), \
             mock.patch.object(file_transcribe.settings, "oss_access_key_secret", ""):
            with self.assertRaises(RuntimeError) as ctx:
                await file_transcribe._run_qwen_diarized(
                    pcm(5), speaker_count=0, session_id="s1", progress=lambda *_: None,
                )
        self.assertIn("qwen_diarization_requires_oss", str(ctx.exception))


class JobRegistryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        file_transcribe._jobs.clear()

    async def test_background_job_reaches_done(self):
        async def fake_minimax(pcm_bytes, *, diarize, speaker_count, language, progress):
            return {"text": "ok", "sentences": [{"text": "ok", "begin_ms": 0, "end_ms": 1, "speaker_id": 1, "sentence_id": 0}], "speakers": [1], "warnings": []}

        with mock.patch.object(file_transcribe, "decode_audio_to_pcm", new=mock.AsyncMock(return_value=pcm(2))), \
             mock.patch.object(file_transcribe, "_run_minimax", new=fake_minimax):
            job_id = file_transcribe.start_transcription(
                b"raw-audio", engine="minimax", diarize=True, speaker_count=2,
            )
            job = file_transcribe.get_job(job_id)
            self.assertIsNotNone(job)
            for _ in range(50):
                if job["status"] in ("done", "error"):
                    break
                await asyncio.sleep(0.01)

        self.assertEqual(job["status"], "done")
        self.assertEqual(job["progress"], 1.0)
        self.assertEqual(job["result"]["engine"], "minimax")
        self.assertEqual(job["result"]["diarize"], True)
        self.assertEqual(job["result"]["duration_sec"], 2.0)

    async def test_background_job_surfaces_errors(self):
        with mock.patch.object(
            file_transcribe, "decode_audio_to_pcm",
            new=mock.AsyncMock(side_effect=RuntimeError("ffmpeg boom")),
        ):
            job_id = file_transcribe.start_transcription(b"x", engine="minimax", diarize=False)
            job = file_transcribe.get_job(job_id)
            for _ in range(50):
                if job["status"] in ("done", "error"):
                    break
                await asyncio.sleep(0.01)

        self.assertEqual(job["status"], "error")
        self.assertIn("ffmpeg boom", job["error"])

    def test_rejects_unknown_engine_and_empty_payload(self):
        with self.assertRaises(ValueError):
            file_transcribe.start_transcription(b"x", engine="whisper", diarize=False)
        with self.assertRaises(ValueError):
            file_transcribe.start_transcription(b"", engine="minimax", diarize=False)

    def test_unknown_job_returns_none(self):
        self.assertIsNone(file_transcribe.get_job("does-not-exist"))


if __name__ == "__main__":
    unittest.main()
