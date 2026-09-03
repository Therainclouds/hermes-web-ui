"""Tests for the Omni-Realtime proxy event translator.

The translator (`omni_realtime_proxy.translate_event`) is the unit-tested
seam between DashScope's OpenAI-Realtime-compatible wire protocol and the
small frontend protocol our realtime clients (OmniRealtimeStage.vue and
InlineRealtimePanel.vue) speak. Covering it gives us a regression net for
protocol-shape changes without standing up a live DashScope upstream.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import unittest
import asyncio
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

    def test_response_cancelled_is_translated_to_response_done(self) -> None:
        # When the client sends `cancel` mid-stream DashScope emits
        # `response.cancelled`. We surface that as the same `response_done`
        # frame the rest of the client understands, so the composable can
        # clear its post-cancel audio-drop window without a new event type.
        cancelled = json.loads(self.omni.translate_event(
            json.dumps({"type": "response.cancelled"})
        ))
        self.assertEqual(cancelled, {"type": "response_done"})

    def test_error_event_surfaces_message(self) -> None:
        msg = {"type": "error", "error": {"message": "upstream rejected session"}}
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(decoded, {"type": "error", "message": "upstream rejected session"})

    def test_error_event_falls_back_to_string_error(self) -> None:
        # Some DashScope revisions send `error` as a plain string, not a dict.
        msg = {"type": "error", "error": "boom"}
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(decoded, {"type": "error", "message": "boom"})

    # --- function-call argument fidelity -----------------------------------
    #
    # Regression guards for the realtime "query_hermes_agent {} 风暴": DashScope
    # sometimes hands tool-call `arguments` out as an already-parsed JSON object
    # instead of the OpenAI-Realtime JSON string shape. When the object leaks
    # through, the browser client coerces it to `{}` and executes the tool with
    # empty arguments → `{"error": "question 必填"}` → the model retries the
    # identical call forever. The translator must therefore always emit
    # `arguments` as a JSON string.

    def test_function_call_done_arguments_string_is_preserved(self) -> None:
        msg = {
            "type": "response.function_call_arguments.done",
            "call_id": "call_1",
            "name": "query_hermes_agent",
            "arguments": '{"question": "查看这台电脑的内存"}',
        }
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(decoded, {
            "type": "function_call",
            "call_id": "call_1",
            "name": "query_hermes_agent",
            "arguments": '{"question": "查看这台电脑的内存"}',
        })

    def test_function_call_done_object_arguments_are_stringified(self) -> None:
        # DashScope object-shaped arguments must reach the client as a JSON
        # string; otherwise the browser treats them as `{}` and errors on the
        # required `question` parameter.
        msg = {
            "type": "response.function_call_arguments.done",
            "call_id": "call_2",
            "name": "query_hermes_agent",
            "arguments": {"question": "查一下内存"},
        }
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(
            decoded["arguments"],
            '{"question": "查一下内存"}',
        )

    def test_function_call_item_object_arguments_are_stringified(self) -> None:
        msg = {
            "type": "conversation.item.created",
            "item": {
                "type": "function_call",
                "call_id": "call_3",
                "name": "read_skill_detail",
                "arguments": {"category": "dev", "skill": "debug"},
            },
        }
        decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
        self.assertEqual(
            decoded["arguments"],
            '{"category": "dev", "skill": "debug"}',
        )

    def test_function_call_missing_arguments_default_to_empty_object(self) -> None:
        # The bookkeeping copy (conversation.item.created) legitimately arrives
        # with no `arguments` field while the model is still generating them —
        # it must translate to `{}` (parked by FunctionCallGate, not executed).
        for msg in (
            {"type": "response.function_call_arguments.done", "call_id": "c", "name": "n"},
            {"type": "conversation.item.created", "item": {"type": "function_call", "call_id": "c", "name": "n"}},
        ):
            with self.subTest(msg=msg):
                decoded = json.loads(self.omni.translate_event(json.dumps(msg)))
                self.assertEqual(decoded["arguments"], "{}")

    # --- FunctionCallGate ---------------------------------------------------

    def test_gate_forwards_arguments_bearing_call_immediately(self) -> None:
        gate = self.omni.FunctionCallGate()
        frame = json.dumps({"type": "function_call", "call_id": "c1", "name": "n", "arguments": '{"q":"x"}'})
        self.assertEqual(gate.on_function_call("c1", '{"q":"x"}', frame), frame)
        self.assertEqual(gate.flush(), [])

    def test_gate_parks_empty_announcement_then_forward_richer_copy(self) -> None:
        # The exact race that produced the empty-args storm: item.created with
        # empty arguments arrives first; the canonical .done with the real
        # question arrives after. The client must see only the real copy.
        gate = self.omni.FunctionCallGate()
        empty_frame = json.dumps({"type": "function_call", "call_id": "c2", "name": "query_hermes_agent", "arguments": "{}"})
        full_frame = json.dumps({"type": "function_call", "call_id": "c2", "name": "query_hermes_agent", "arguments": '{"question": "查内存"}'})
        # 1st announcement (empty) is parked, nothing forwarded.
        self.assertIsNone(gate.on_function_call("c2", "{}", empty_frame))
        # 2nd announcement (with arguments) supersedes and is forwarded.
        self.assertEqual(gate.on_function_call("c2", '{"question": "查内存"}', full_frame), full_frame)
        # Nothing left parked at the boundary.
        self.assertEqual(gate.flush(), [])

    def test_gate_parks_empty_then_forward_at_response_boundary(self) -> None:
        # Legitimately argument-less tools (list_jobs, required: []) stay parked
        # until the response boundary flush releases them.
        gate = self.omni.FunctionCallGate()
        frame = json.dumps({"type": "function_call", "call_id": "c3", "name": "list_jobs", "arguments": "{}"})
        self.assertIsNone(gate.on_function_call("c3", "{}", frame))
        self.assertEqual(gate.flush(), [frame])
        # A second flush must not repeat the same call.
        self.assertEqual(gate.flush(), [])

    def test_gate_drops_late_duplicates_after_sent(self) -> None:
        # Reverse order: canonical .done (full args) forwards immediately; the
        # later item.created bookkeeping copy must not double-fire the tool.
        gate = self.omni.FunctionCallGate()
        full_frame = json.dumps({"type": "function_call", "call_id": "c4", "name": "n", "arguments": '{"q":"x"}'})
        empty_frame = json.dumps({"type": "function_call", "call_id": "c4", "name": "n", "arguments": "{}"})
        self.assertEqual(gate.on_function_call("c4", '{"q":"x"}', full_frame), full_frame)
        self.assertIsNone(gate.on_function_call("c4", "{}", empty_frame))
        self.assertIsNone(gate.on_function_call("c4", '{"q":"x"}', full_frame))
        self.assertEqual(gate.flush(), [])

    def test_gate_parks_per_call_id_and_flushes_each(self) -> None:
        gate = self.omni.FunctionCallGate()
        a = json.dumps({"type": "function_call", "call_id": "a", "name": "n1", "arguments": "{}"})
        b = json.dumps({"type": "function_call", "call_id": "b", "name": "n2", "arguments": "{}"})
        self.assertIsNone(gate.on_function_call("a", "{}", a))
        self.assertIsNone(gate.on_function_call("b", "{}", b))
        self.assertEqual(set(gate.flush()), {a, b})

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


class OmniProxyResponseGatingTest(unittest.TestCase):
    """Regression guard for the 'Conversation already has an active response'
    upstream rejection.

    DashScope emits ``response.function_call_arguments.done`` (which the
    proxy translates to the client as ``function_call``) BEFORE it emits
    ``response.done`` for the same turn. If the proxy fires
    ``response.create`` immediately on the function-call event, DashScope
    sees the new request while the prior response is still draining and
    rejects with ``Conversation already has an active response``.

    The proxy must therefore observe the response lifecycle and gate
    response-creating actions on the in-flight response finishing first.
    """

    def setUp(self) -> None:
        _import_app()
        self.omni = importlib.import_module("app.omni_realtime_proxy")
        self.sent: list[dict] = []

    def _make_proxy(self, frames: list[str]) -> tuple["self.omni.OmniRealtimeProxy", "_AsyncFrames"]:
        proxy = self.omni.OmniRealtimeProxy()
        proxy.upstream = mock.MagicMock()

        async def _send(payload):
            if isinstance(payload, (bytes, bytearray)):
                self.sent.append({"_bytes": len(payload)})
            else:
                self.sent.append(json.loads(payload))

        proxy.upstream.send = mock.AsyncMock(side_effect=_send)

        # Single stateful async iterator shared by all upstream_events()
        # generators — re-creating it per __aiter__ call would restart
        # playback from the first frame.
        frames_iter = _AsyncFrames(frames)
        proxy.upstream.__aiter__ = lambda self=None: frames_iter
        return proxy, frames_iter

    async def _drain_one(self, proxy, frames_iter) -> None:
        gen = proxy.upstream_events()
        try:
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        except (StopAsyncIteration, asyncio.TimeoutError):
            pass

    def test_response_lifecycle_marks_active_then_idle(self) -> None:
        async def scenario():
            proxy, frames = self._make_proxy([
                json.dumps({"type": "response.created"}),
                json.dumps({"type": "response.done"}),
                json.dumps({"type": "response.created"}),
                json.dumps({"type": "response.cancelled"}),
            ])

            # Initially no response is active.
            self.assertFalse(proxy._response_active)
            self.assertTrue(proxy._response_done_event.is_set())

            # response.created flips the gate closed.
            await self._drain_one(proxy, frames)
            self.assertTrue(proxy._response_active)
            self.assertFalse(proxy._response_done_event.is_set())

            # response.done opens the gate again.
            await self._drain_one(proxy, frames)
            self.assertFalse(proxy._response_active)
            self.assertTrue(proxy._response_done_event.is_set())

            # response.cancelled also opens the gate.
            await self._drain_one(proxy, frames)
            self.assertTrue(proxy._response_active)
            await self._drain_one(proxy, frames)
            self.assertFalse(proxy._response_active)
            self.assertTrue(proxy._response_done_event.is_set())

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_buffer_commit_events_reset_audio_appended_since_commit(self) -> None:
        # Regression guard: DashScope clears the audio + image buffers on
        # input_audio_buffer.commit (VAD auto-commit at end-of-utterance),
        # after which "audio before image" applies again. Observing the
        # upstream commit / speech events must flip the freshness flag off so
        # send_image drops frames in the post-commit window.
        async def scenario():
            for evt in (
                "input_audio_buffer.speech_started",
                "input_audio_buffer.speech_stopped",
                "input_audio_buffer.committed",
                "input_audio_buffer.cleared",
            ):
                with self.subTest(evt=evt):
                    proxy, frames = self._make_proxy([json.dumps({"type": evt})])
                    proxy._audio_appended_since_commit = True
                    await self._drain_one(proxy, frames)
                    self.assertFalse(proxy._audio_appended_since_commit)

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_tool_output_waits_for_response_done(self) -> None:
        """send_tool_output must not send response.create while the prior
        response is still active — that's exactly what causes the upstream
        'Conversation already has an active response' rejection."""

        async def scenario():
            proxy, _ = self._make_proxy([])  # no upstream frames needed
            proxy._response_active = True
            proxy._response_done_event.clear()
            self.sent.clear()

            # Kick off send_tool_output — it MUST NOT immediately send
            # `response.create`. Drain the response a moment later and
            # observe that the queued send then completes.
            task = asyncio.get_event_loop().create_task(
                proxy.send_tool_output("call_1", "ok")
            )
            await asyncio.sleep(0.05)
            self.assertEqual(
                self.sent, [],
                "send_tool_output fired upstream before in-flight response drained",
            )

            proxy._response_done_event.set()
            await asyncio.wait_for(task, timeout=1.0)
            self.assertEqual(
                [s.get("type") for s in self.sent],
                ["conversation.item.create", "response.create"],
            )

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_tool_output_proceeds_immediately_when_no_response_active(self) -> None:
        async def scenario():
            proxy, _ = self._make_proxy([])
            # no response in flight
            await proxy.send_tool_output("call_2", "ok")
            self.assertEqual(
                [s.get("type") for s in self.sent],
                ["conversation.item.create", "response.create"],
            )

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_commit_audio_waits_for_response_done(self) -> None:
        async def scenario():
            proxy, _ = self._make_proxy([])
            proxy._response_active = True
            proxy._response_done_event.clear()
            self.sent.clear()

            task = asyncio.get_event_loop().create_task(proxy.commit_audio())
            await asyncio.sleep(0.05)
            self.assertEqual(self.sent, [], "commit_audio fired before response drained")

            proxy._response_done_event.set()
            await asyncio.wait_for(task, timeout=1.0)
            self.assertEqual(self.sent, [{"type": "input_audio_buffer.commit"}])

        asyncio.get_event_loop().run_until_complete(scenario())


class OmniProxySendImageTest(unittest.TestCase):
    """Camera-frame forwarding: client `{"type": "image", ...}` frames must
    reach DashScope as `input_image_buffer.append` with raw base64 JPEG, with
    the documented audio-first constraint enforced."""

    def setUp(self) -> None:
        _import_app()
        self.omni = importlib.import_module("app.omni_realtime_proxy")
        self.sent: list[dict] = []

    def _make_proxy(self, audio_seen: bool = True, audio_appended_since_commit: bool = True):
        proxy = self.omni.OmniRealtimeProxy()
        proxy.upstream = mock.MagicMock()
        proxy._audio_seen = audio_seen
        proxy._audio_appended_since_commit = audio_appended_since_commit

        async def _send(payload):
            self.sent.append(json.loads(payload))

        proxy.upstream.send = mock.AsyncMock(side_effect=_send)
        return proxy

    def test_send_image_forwards_input_image_buffer_append(self) -> None:
        async def scenario():
            proxy = self._make_proxy()
            await proxy.send_image("aGVsbG8=")
            self.assertEqual(
                self.sent,
                [{"type": "input_image_buffer.append", "image": "aGVsbG8="}],
            )

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_image_strips_data_url_prefix(self) -> None:
        async def scenario():
            proxy = self._make_proxy()
            await proxy.send_image("data:image/jpeg;base64,aGVsbG8=")
            self.assertEqual(
                self.sent,
                [{"type": "input_image_buffer.append", "image": "aGVsbG8="}],
            )

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_image_empty_or_whitespace_is_dropped(self) -> None:
        async def scenario():
            proxy = self._make_proxy()
            await proxy.send_image("")
            await proxy.send_image("   ")
            await proxy.send_image("data:image/jpeg;base64,")
            self.assertEqual(self.sent, [])

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_image_requires_audio_first(self) -> None:
        # DashScope docs: "You must send audio data at least once before you
        # send image data." Frames arriving before the first audio append must
        # be dropped, not forwarded (which would 4xx upstream).
        async def scenario():
            proxy = self._make_proxy(audio_seen=False)
            await proxy.send_image("aGVsbG8=")
            self.assertEqual(self.sent, [])

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_image_dropped_in_post_commit_window(self) -> None:
        # Regression guard for the "append image before append audio" error:
        # DashScope clears the image buffer together with the audio buffer on
        # every input_audio_buffer.commit (in VAD mode the server auto-commits
        # at the end of each utterance) and requires a fresh audio append
        # before the next image frame. A camera frame landing right after a
        # commit — before the next (continuously streaming, but in-flight)
        # audio chunk arrives — must be dropped locally, otherwise DashScope
        # rejects it and the error event kills the client session.
        async def scenario():
            proxy = self._make_proxy(audio_appended_since_commit=False)
            await proxy.send_image("aGVsbG8=")
            self.assertEqual(self.sent, [])

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_image_forwarded_after_fresh_audio_append(self) -> None:
        # After the post-commit drop, one audio append re-arms the gate so
        # the next camera frame is forwarded again.
        async def scenario():
            proxy = self._make_proxy(audio_appended_since_commit=False)
            await proxy.send_image("aGVsbG8=")
            self.assertEqual(self.sent, [])
            await proxy.send_audio(b"\x00\x01")
            await proxy.send_image("aGVsbG8=")
            self.assertEqual(
                self.sent,
                [
                    {
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(b"\x00\x01").decode("ascii"),
                    },
                    {"type": "input_image_buffer.append", "image": "aGVsbG8="},
                ],
            )

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_audio_marks_audio_seen(self) -> None:
        async def scenario():
            proxy = self._make_proxy(audio_seen=False)
            self.assertFalse(proxy._audio_seen)
            await proxy.send_audio(b"\x00\x01")
            self.assertTrue(proxy._audio_seen)

        asyncio.get_event_loop().run_until_complete(scenario())

    def test_send_image_requires_connection(self) -> None:
        proxy = self.omni.OmniRealtimeProxy()
        with self.assertRaises(RuntimeError) as ctx:
            asyncio.get_event_loop().run_until_complete(proxy.send_image("aGVsbG8="))
        self.assertIn("not connected", str(ctx.exception))


class _AsyncFrames:
    """Single-pass async iterator over a list of pre-recorded upstream frames.

    The proxy does ``async for raw in self.upstream`` (which calls
    ``__aiter__`` once per generator instance) and treats each yielded value
    as either ``bytes`` (audio delta / ping) or ``str`` (JSON event). We hand
    the same instance back from every ``__aiter__`` call so successive
    generators see the next frame, not frame 1 again.
    """

    def __init__(self, frames) -> None:
        self._iter = iter(list(frames))

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


if __name__ == "__main__":
    unittest.main()
