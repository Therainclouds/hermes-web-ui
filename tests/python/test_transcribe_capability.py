"""Contract test for the whole-file transcription capability marker.

A rebuild replaces `python-backend/` on disk but does **not** make an
already-running uvicorn child re-import its modules. That is how a fixed bug
can keep reproducing: the client bundle is new (served from dist), the browser
shows the new UI, but the long-lived Python process still runs the old logic.

To detect that, the Web UI ships `TRANSCRIBE_CAPABILITY` and compares it with
the `transcribe` field on `/healthz`; on mismatch it stops + restarts the
service. This test pins the marker on both sides of the language boundary so a
change to `/api/transcribe` cannot silently desync them.
"""

from __future__ import annotations

import importlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_BACKEND = REPO_ROOT / "packages" / "server" / "src" / "services" / "meeting-asr" / "python-backend"
MEETING_VIEW = REPO_ROOT / "packages" / "client" / "src" / "views" / "hermes" / "MeetingView.vue"
if str(PY_BACKEND) not in sys.path:
    sys.path.insert(0, str(PY_BACKEND))


class TranscribeCapabilityTest(unittest.TestCase):
    def setUp(self) -> None:
        self._data_dir = tempfile.mkdtemp(prefix="meeting-asr-cap-")
        self._env_patcher = mock.patch.dict(
            os.environ,
            {
                "DATA_DIR": self._data_dir,
                "MEETING_ASR_CODE_HASH": "abc123def456",
            },
            clear=False,
        )
        self._env_patcher.start()
        self._main = importlib.import_module("app.main")

    def tearDown(self) -> None:
        self._env_patcher.stop()
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]

    def test_healthz_reports_capability_and_code_hash(self) -> None:
        from fastapi.testclient import TestClient

        response = TestClient(self._main.app).get("/healthz")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["transcribe"], self._main.TRANSCRIBE_CAPABILITY)
        # the Node parent stamps this env var at spawn; the child echoes it so
        # the client can compare it against the on-disk hash
        self.assertEqual(payload["code_hash"], "abc123def456")

    def test_client_constant_matches_the_backend_marker(self) -> None:
        source = MEETING_VIEW.read_text("utf-8")
        match = re.search(r"TRANSCRIBE_CAPABILITY\s*=\s*'([^']+)'", source)
        self.assertIsNotNone(match, "MeetingView.vue must declare TRANSCRIBE_CAPABILITY")
        self.assertEqual(match.group(1), self._main.TRANSCRIBE_CAPABILITY)

    def test_healthz_emits_an_empty_hash_when_the_parent_did_not_stamp_one(self) -> None:
        """Backwards compatibility: an unstamped backend must still answer."""
        from fastapi.testclient import TestClient

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MEETING_ASR_CODE_HASH", None)
            payload = TestClient(self._main.app).get("/healthz").json()
        self.assertEqual(payload["transcribe"], self._main.TRANSCRIBE_CAPABILITY)
        self.assertEqual(payload["code_hash"], "")


if __name__ == "__main__":
    unittest.main()
