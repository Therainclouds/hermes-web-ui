"""Tests for the Omni-Realtime proxy event translator.

The translator (`omni_realtime_proxy.translate_event`) is the unit-tested
seam between DashScope's OpenAI-Realtime-compatible wire protocol and the
small frontend protocol our `RealtimeDialogPanel.vue` speaks. Covering it
gives us a regression net for protocol-shape changes without standing up a
live DashScope upstream.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_BACKEND = REPO_ROOT / "packages" / "server" / "src" / "services" / "meeting-asr" / "python-backend"
if str(PY_BACKEND) not in sys.path:
    sys.path.insert(0, str(PY_BACKEND))


def _import_app():
    """Import the python backend package under a controlled env.

    Mirrors the test pattern used by `test_meeting_asr_config_sync.py`:
    a fresh module import per test guarantees module-level state (Settings
    defaults, env lookups) reflects the patched environment.
    """
    return importlib.import_module("app")


class TranslateEventTest(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.setdefault("DASHSCOPE_API_KEY", "test-key")
        _import_app()
        self.omni = importlib.import_module("app.omni_realtime_proxy")

    def test_audio_delta_decoded_to_raw_pcm_bytes(self) -> None:
        pcm = b"\x01\x02\x03\x04"
        msg = {
            "type": "response.audio.delta",
            "delta": base64.b64encode(pcm).decode("ascii"),
        }
        out = self.omni.translate_event(json.dumps(msg))
        self.assertEqual(out, pcm)
        self.assertIsInstance(out, bytes)

    def test_audio_delta_with_empty_value_is_dropped(self) -> None:
        msg = {"type": "response.audio.delta", "delta": ""}
        self.assertIsNone(self.omni.translate_event(json.dumps(msg)))

    def test_audio_delta_with_bad_base64_is_dropped(self) -> None:
        msg = {"type": "response.audio.delta", "delta": "@@@not-base64@@@"}
        # bad base64 should be logged + dropped, not raised
        self.assertIsNone(self.omni.translate_event(json.dumps(msg)))

    def test_transcript_delta_becomes_typed_event(self) -> None:
        msg = {"type": "response.audio_transcript.delta", "delta": "你好"}
        out = self.omni.translate_event(json.dumps(msg))
        self.assertIsNotNone(out)
        self.assertIsInstance(out, str)
        decoded = json.loads(out)
        self.assertEqual(decoded["type"], "transcript_delta")
        self.assertEqual(decoded["text"], "你好")

    def test_transcript_done_uses_transcript_field(self) -> None:
        msg = {"type": "response.audio_transcript.done", "transcript": "回答完毕"}
        out = self.omni.translate_event(json.dumps(msg))
        decoded = json.loads(out)
        self.assertEqual(decoded, {"type": "transcript", "text": "回答完毕"})

    def test_user_transcript_event_is_forwarded(self) -> None:
        msg = {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "请帮我总结一下",
        }
        out = self.omni.translate_event(json.dumps(msg))
        decoded = json.loads(out)
        self.assertEqual(decoded, {"type": "user_transcript", "text": "请帮我总结一下"})

    def test_vad_events_become_listening_and_speech_stopped(self) -> None:
        started = json.loads(self.omni.translate_event(
            json.dumps({"type": "input_audio_buffer.speech_started"})
        ))
        stopped = json.loads(self.omni.translate_event(
            json.dumps({"type": "input_audio_buffer.speech_stopped"})
        ))
        self.assertEqual(started, {"type": "listening"})
        self.assertEqual(stopped, {"type": "speech_stopped"})

    def test_response_lifecycle_events_emit_typed_messages(self) -> None:
        created = json.loads(self.omni.translate_event(
            json.dumps({"type": "response.created"})
        ))
        done = json.loads(self.omni.translate_event(
            json.dumps({"type": "response.done"})
        ))
        self.assertEqual(created, {"type": "response_started"})
        self.assertEqual(done, {"type": "response_done"})

    def test_error_event_surfaces_message(self) -> None:
        msg = {"type": "error", "error": {"message": "upstream rejected session"}}
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(decoded, {"type": "error", "message": "upstream rejected session"})

    def test_error_event_falls_back_to_string_error(self) -> None:
        # Some DashScope revisions send `error` as a plain string, not a dict.
        msg = {"type": "error", "error": "boom"}
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(decoded, {"type": "error", "message": "boom"})

    def test_unknown_events_are_dropped(self) -> None:
        # response.audio.done and bookkeeping events should not leak to client
        for event_type in (
            "response.audio.done",
            "rate_limits.updated",
            "conversation.created",
            "session.created",
            "session.updated",
        ):
            with self.subTest(event_type=event_type):
                self.assertIsNone(self.omni.translate_event(
                    json.dumps({"type": event_type})
                ))

    def test_non_json_text_is_dropped(self) -> None:
        self.assertIsNone(self.omni.translate_event("not a json frame"))

    def test_binary_frame_is_dropped(self) -> None:
        # Binary frames upstream are protocol pings — never forward to client
        self.assertIsNone(self.omni.translate_event(b"\x00\x01"))


class OmniProxyDefaultsTest(unittest.TestCase):
    def setUp(self) -> None:
        _import_app()
        self.omni = importlib.import_module("app.omni_realtime_proxy")
        self.config = importlib.import_module("app.config")

    def test_proxy_uses_settings_defaults_when_no_args(self) -> None:
        proxy = self.omni.OmniRealtimeProxy()
        self.assertEqual(proxy.model, self.config.settings.omni_realtime_model)
        self.assertEqual(proxy.voice, self.config.settings.omni_realtime_voice)
        # instructions may be empty in settings — proxy falls back to a Chinese default
        self.assertTrue(proxy.instructions)

    def test_proxy_overrides_settings_with_constructor_args(self) -> None:
        proxy = self.omni.OmniRealtimeProxy(
            model="custom-model",
            voice="CustomVoice",
            instructions="always answer in English",
        )
        self.assertEqual(proxy.model, "custom-model")
        self.assertEqual(proxy.voice, "CustomVoice")
        self.assertEqual(proxy.instructions, "always answer in English")

    def test_settings_expose_omni_realtime_keys(self) -> None:
        # Belt-and-braces: make sure all the env-backed fields exist on Settings
        # so the proxy can read them without AttributeError.
        s = self.config.settings
        self.assertTrue(hasattr(s, "omni_realtime_ws_url"))
        self.assertTrue(hasattr(s, "omni_realtime_model"))
        self.assertTrue(hasattr(s, "omni_realtime_voice"))
        self.assertTrue(hasattr(s, "omni_realtime_instructions"))
        self.assertIn("realtime", s.omni_realtime_ws_url.lower())


class OmniProxyConnectTest(unittest.TestCase):
    def setUp(self) -> None:
        _import_app()
        self.omni = importlib.import_module("app.omni_realtime_proxy")

    def test_connect_requires_api_key(self) -> None:
        with mock.patch.object(self.omni.settings, "dashscope_api_key", ""):
            proxy = self.omni.OmniRealtimeProxy()
            import asyncio
            with self.assertRaises(RuntimeError) as ctx:
                asyncio.get_event_loop().run_until_complete(proxy.connect())
            self.assertIn("DASHSCOPE_API_KEY", str(ctx.exception))

    def test_send_audio_requires_connection(self) -> None:
        proxy = self.omni.OmniRealtimeProxy()
        import asyncio
        with self.assertRaises(RuntimeError) as ctx:
            asyncio.get_event_loop().run_until_complete(proxy.send_audio(b"\x00\x01"))
        self.assertIn("not connected", str(ctx.exception))

    def test_cancel_is_safe_without_upstream(self) -> None:
        proxy = self.omni.OmniRealtimeProxy()
        # Should be a no-op, not raise
        import asyncio
        asyncio.get_event_loop().run_until_complete(proxy.cancel())


if __name__ == "__main__":
    unittest.main()
