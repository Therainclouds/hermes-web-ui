from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
USB_DIR = REPO_ROOT / "hermes_data" / "bots" / "usb"
if str(USB_DIR) not in sys.path:
    sys.path.insert(0, str(USB_DIR))

import config as usb_config
import mounter
import usb_monitor


class FakeDevice:
    def __init__(
        self,
        *,
        device_node: str = "/dev/sdb1",
        device_type: str = "partition",
        action: str = "add",
        subsystem: str = "block",
        properties: dict[str, str] | None = None,
        parent: "FakeDevice | None" = None,
    ) -> None:
        self.device_node = device_node
        self.device_type = device_type
        self.action = action
        self.subsystem = subsystem
        self._properties = properties or {}
        self.parent = parent

    def get(self, key: str) -> str | None:
        return self._properties.get(key)

    def find_parent(self, *_args, **_kwargs):
        raise AssertionError("find_parent() should not be used in USB hot paths")


class USBMonitorPythonTests(unittest.TestCase):
    def test_load_config_parses_usb_runtime_env(self) -> None:
        cfg = usb_config.load_config(
            {
                "HERMES_WEB_UI_HOME": "/tmp/hermes-home",
                "USB_USE_SUDO": "1",
                "USB_MOUNT_TIMEOUT_SECONDS": "12.5",
                "USB_COLD_SCAN_TIMEOUT_SECONDS": "3.5",
            }
        )

        self.assertTrue(cfg.use_sudo)
        self.assertEqual(cfg.mount_timeout_seconds, 12.5)
        self.assertEqual(cfg.cold_scan_timeout_seconds, 3.5)
        self.assertEqual(cfg.sudo_command, "/usr/bin/sudo")

    def test_run_command_applies_sudo_and_timeout(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout="", stderr="")
        with mock.patch.object(mounter.subprocess, "run", return_value=completed) as run:
            result = mounter.run_command(
                ["/usr/bin/mount", "/dev/sdb1", "/mnt/usb"],
                timeout=9.5,
                use_sudo=True,
                sudo_command="/usr/bin/sudo",
            )

        self.assertIs(result, completed)
        self.assertEqual(
            run.call_args.args[0],
            ["/usr/bin/sudo", "-n", "/usr/bin/mount", "/dev/sdb1", "/mnt/usb"],
        )
        self.assertEqual(run.call_args.kwargs["timeout"], 9.5)

    def test_usb_partition_detection_and_metadata_avoid_find_parent(self) -> None:
        usb_parent = FakeDevice(
            subsystem="usb",
            device_type="usb_device",
            properties={
                "ID_BUS": "usb",
                "ID_VENDOR": "SanDisk",
                "ID_MODEL": "Ultra",
                "ID_SERIAL_SHORT": "ABC123",
            },
        )
        block_parent = FakeDevice(
            device_node="/dev/sdb",
            device_type="disk",
            properties={"DEVPATH": "/devices/pci0000:00/usb1/1-3/block/sdb"},
            parent=usb_parent,
        )
        partition = FakeDevice(
            properties={"DEVPATH": "/devices/pci0000:00/usb1/1-3/block/sdb/sdb1"},
            parent=block_parent,
        )

        self.assertTrue(mounter.is_usb_storage_partition(partition))
        metadata = mounter.device_metadata_from_pyudev(partition)
        self.assertEqual(metadata["vendor"], "SanDisk")
        self.assertEqual(metadata["model"], "Ultra")
        self.assertEqual(metadata["serial"], "ABC123")

    def test_cold_scan_timeout_returns_empty_ready_payload_without_waiting_for_hang(self) -> None:
        monitor = object.__new__(usb_monitor.USBMonitor)
        monitor.config = SimpleNamespace(enable_cold_scan=True, cold_scan_timeout_seconds=0.05)
        monitor.cache_by_node = {}
        monitor.stop_event = threading.Event()
        emitted: list[dict[str, object]] = []
        monitor.emit = emitted.append  # type: ignore[assignment]

        def slow_scan():
            time.sleep(0.2)
            return [{"type": "device_event", "device_node": "/dev/sdb1", "uuid": "late-device"}]

        monitor._scan_existing_devices = slow_scan  # type: ignore[attr-defined]
        monitor._remember_device = lambda payload: monitor.cache_by_node.__setitem__(payload["device_node"], payload)  # type: ignore[attr-defined]

        started_at = time.monotonic()
        result = usb_monitor.USBMonitor._collect_cold_scan_existing_devices(monitor)
        elapsed = time.monotonic() - started_at

        self.assertEqual(result, [])
        self.assertLess(elapsed, 0.15)
        self.assertEqual(monitor.cache_by_node, {})
        time.sleep(0.25)
        self.assertEqual(monitor.cache_by_node["/dev/sdb1"]["uuid"], "late-device")
        self.assertEqual(emitted[0]["type"], "ready")

    def test_polled_device_handler_uses_device_action(self) -> None:
        emitted: list[dict[str, str]] = []
        monitor = object.__new__(usb_monitor.USBMonitor)
        monitor.emit = emitted.append  # type: ignore[assignment]
        monitor._is_relevant_event = lambda action, device: action == "add" and device.device_node == "/dev/sdb1"  # type: ignore[attr-defined]
        monitor._build_add_payload = lambda device: {"type": "device_event", "action": "add", "device_node": device.device_node}  # type: ignore[attr-defined]

        usb_monitor.USBMonitor._handle_monitor_device(monitor, FakeDevice())

        self.assertEqual(emitted, [{"type": "device_event", "action": "add", "device_node": "/dev/sdb1"}])


if __name__ == "__main__":
    unittest.main()
