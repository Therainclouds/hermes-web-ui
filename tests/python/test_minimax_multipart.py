"""Regression tests for the MiniMax multipart request encoding.

Both MiniMax call sites used to pass every field through ``httpx``'s
``files=`` argument, including non-file fields as 1-tuples. httpx treats each
``files=`` entry as a file field and unpacks it as
``(filename, fileobj, content_type, headers)``, so a 1-tuple blew up **before
the request was sent**:

    ValueError: not enough values to unpack (expected 4, got 1)

That surfaced to the user as "人声拆分失败：not enough values to unpack
(expected 4, got 1)". These tests point both clients at a real loopback HTTP
server and assert the wire body is proper multipart form data, so a future
refactor cannot silently reintroduce the bug.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_BACKEND = REPO_ROOT / "packages" / "server" / "src" / "services" / "meeting-asr" / "python-backend"
if str(PY_BACKEND) not in sys.path:
    sys.path.insert(0, str(PY_BACKEND))

from app import asr_minimax, file_transcribe  # noqa: E402

CAPTURED: list[dict] = []


class _MultipartHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        length = int(self.headers.get("content-length", 0))
        CAPTURED.append({
            "path": self.path,
            "content_type": self.headers.get("content-type", ""),
            "body": self.rfile.read(length).decode("utf-8", "replace"),
        })
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "text": "你好世界",
            "duration": 1.5,
            "n_speakers": 1,
            "segments": [{"id": 0, "start": 0.0, "end": 1.5, "speaker": "S1", "text": "你好世界"}],
        }).encode("utf-8"))

    def log_message(self, *args) -> None:  # silence the test output
        pass


_server: HTTPServer
_thread: threading.Thread
_base_url = ""


def setUpModule() -> None:  # noqa: N802 - unittest hook
    global _server, _thread, _base_url
    _server = HTTPServer(("127.0.0.1", 0), _MultipartHandler)
    _thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _thread.start()
    _base_url = f"http://127.0.0.1:{_server.server_address[1]}"


def tearDownModule() -> None:  # noqa: N802 - unittest hook
    _server.shutdown()
    # `asyncio.run()` clears the current event loop on exit; older tests in
    # this suite still call the deprecated `asyncio.get_event_loop()`, so put
    # a live loop back for the rest of the session.
    asyncio.set_event_loop(asyncio.new_event_loop())


class MiniMaxBatchPostTest(unittest.TestCase):
    """`file_transcribe._minimax_post` — the whole-file («拆分人声») path."""

    def setUp(self) -> None:
        CAPTURED.clear()
        patcher = mock.patch.multiple(
            file_transcribe.settings,
            minimax_base_url=_base_url,
            minimax_api_key="mm-secret",
            minimax_asr_model="asr-1.0",
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_sends_form_fields_and_file_as_multipart(self) -> None:
        payload = asyncio.run(file_transcribe._minimax_post(
            b"RIFFfakewavbytes", diarize=True, language="zh",
        ))

        self.assertEqual(payload["text"], "你好世界")
        self.assertEqual(len(CAPTURED), 1)
        request = CAPTURED[0]
        self.assertEqual(request["path"], "/v1/speech_to_text")
        self.assertTrue(request["content_type"].startswith("multipart/form-data"))
        body = request["body"]
        # every scalar field must be a form part, not a broken file tuple
        for field in ['name="model"', 'name="response_format"', 'name="timestamp_level"',
                      'name="stream"', 'name="language"', 'name="file"']:
            self.assertIn(field, body, f"{field} missing from multipart body")
        self.assertIn('name="model"\r\n\r\nasr-1.0', body)
        self.assertIn('name="response_format"\r\n\r\nverbose_json', body)
        self.assertIn('name="timestamp_level"\r\n\r\nsentence', body)
        self.assertIn('name="stream"\r\n\r\nfalse', body)
        self.assertIn('name="language"\r\n\r\nzh', body)
        self.assertIn('filename="audio.wav"', body)

    def test_omits_the_language_field_when_unset(self) -> None:
        asyncio.run(file_transcribe._minimax_post(b"wav", diarize=True, language=""))
        self.assertNotIn('name="language"', CAPTURED[0]["body"])


class MiniMaxRealtimePostTest(unittest.TestCase):
    """`asr_minimax.MiniMaxProxy._post_chunk` — the realtime WS path."""

    def setUp(self) -> None:
        CAPTURED.clear()
        patcher = mock.patch.multiple(
            asr_minimax.settings,
            minimax_base_url=_base_url,
            minimax_api_key="mm-secret",
            minimax_asr_model="asr-1.0",
            minimax_audio_format="wav",
            minimax_sample_rate=16000,
            minimax_language="",
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_posts_pcm_as_a_wav_multipart_form(self) -> None:
        proxy = asr_minimax.MiniMaxProxy()
        asyncio.run(proxy._post_chunk(b"\x00\x00" * 1600))

        self.assertEqual(len(CAPTURED), 1)
        request = CAPTURED[0]
        self.assertEqual(request["path"], "/v1/speech_to_text")
        self.assertTrue(request["content_type"].startswith("multipart/form-data"))
        body = request["body"]
        self.assertIn('name="model"\r\n\r\nasr-1.0', body)
        self.assertIn('name="response_format"\r\n\r\njson', body)
        self.assertIn('name="stream"\r\n\r\nfalse', body)
        self.assertIn('filename="chunk.wav"', body)
        # WAV container: RIFF magic must be present in the file part
        self.assertIn("RIFF", body)

    def test_emits_a_final_event_with_the_transcript(self) -> None:
        proxy = asr_minimax.MiniMaxProxy()
        asyncio.run(proxy._post_chunk(b"\x00\x00" * 1600))
        event = proxy._event_queue.get_nowait()
        self.assertEqual(event["type"], "final")
        self.assertEqual(event["text"], "你好世界")


class BatchJobEndToEndTest(unittest.TestCase):
    """The exact path the user hit: whole-file job → ffmpeg decode → MiniMax.

    Exercises decode + multipart post + verbose_json parsing + job registry
    together, so a break anywhere in that chain fails here rather than in
    production as "人声拆分失败".
    """

    @unittest.skipUnless(__import__("shutil").which("ffmpeg"), "ffmpeg not installed")
    def test_minimax_diarized_job_completes(self) -> None:
        CAPTURED.clear()
        file_transcribe._jobs.clear()
        patcher = mock.patch.multiple(
            file_transcribe.settings,
            minimax_base_url=_base_url,
            minimax_api_key="mm-secret",
            minimax_asr_model="asr-1.0",
            minimax_language="",
            minimax_file_chunk_seconds=480.0,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        wav = file_transcribe._pcm_to_wav(b"\x00\x01" * 16000, 16000)  # 1 second

        async def scenario():
            job_id = file_transcribe.start_transcription(
                wav, engine="minimax", diarize=True, speaker_count=1, language="zh",
            )
            job = file_transcribe.get_job(job_id)
            for _ in range(200):
                if job["status"] in ("done", "error"):
                    break
                await asyncio.sleep(0.01)
            return job

        job = asyncio.run(scenario())
        self.assertEqual(job["status"], "done", job.get("error"))
        result = job["result"]
        self.assertEqual(result["engine"], "minimax")
        self.assertTrue(result["diarize"])
        self.assertAlmostEqual(result["duration_sec"], 1.0, places=1)
        self.assertEqual(result["speakers"], [1])
        self.assertEqual(result["sentences"][0]["text"], "你好世界")
        self.assertEqual(result["sentences"][0]["speaker_id"], 1)


if __name__ == "__main__":
    unittest.main()
