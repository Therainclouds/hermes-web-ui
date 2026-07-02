from __future__ import annotations

import json
import logging
import signal
import sys
import threading
from datetime import datetime, timezone
from typing import Any

try:
    import pyudev
except ImportError as exc:  # pragma: no cover - import guard for runtime setup
    pyudev = None
    PYUDEV_IMPORT_ERROR = exc
else:
    PYUDEV_IMPORT_ERROR = None

try:
    from .config import config_summary, ensure_runtime_dirs, load_config
    from .mounter import cleanup_removed_mount, device_metadata_from_pyudev, ensure_mounted, is_usb_storage_partition
except ImportError:
    from config import config_summary, ensure_runtime_dirs, load_config
    from mounter import cleanup_removed_mount, device_metadata_from_pyudev, ensure_mounted, is_usb_storage_partition


LOGGER = logging.getLogger("hermes.usb.monitor")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def setup_logging(log_file: str, level_name: str) -> None:
    level = getattr(logging, level_name.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    formatter = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.setLevel(level)
    root.addHandler(file_handler)

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)
    stderr_handler.setLevel(level)
    root.addHandler(stderr_handler)


class USBMonitor:
    def __init__(self) -> None:
        self.config = load_config()
        ensure_runtime_dirs(self.config)
        setup_logging(str(self.config.log_file), self.config.log_level)

        if pyudev is None:
            raise RuntimeError(f"pyudev is required to run usb_monitor.py: {PYUDEV_IMPORT_ERROR}")

        self.context = pyudev.Context()
        self.stop_event = threading.Event()
        self.cache_by_node: dict[str, dict[str, Any]] = {}
        self.monitor: Any | None = None
        self.heartbeat_thread: threading.Thread | None = None

    def emit(self, payload: dict[str, Any]) -> None:
        print(json.dumps(payload, ensure_ascii=False), flush=True)

    def _remember_device(self, payload: dict[str, Any]) -> None:
        device_node = str(payload.get("device_node") or "").strip()
        if device_node:
            self.cache_by_node[device_node] = payload

    def _build_add_payload(self, device: Any, *, remember: bool = True) -> dict[str, Any] | None:
        device_node = str(device.device_node or "").strip()
        if not device_node:
            return None

        mount_result = ensure_mounted(device_node, self.config)
        metadata = device_metadata_from_pyudev(device)
        label = mount_result.label or (device.get("ID_FS_LABEL") or "").strip() or None
        payload: dict[str, Any] = {
            "type": "device_event",
            "action": "add",
            "device_node": device_node,
            "uuid": mount_result.uuid,
            "mount_point": mount_result.mount_point,
            "fs_type": mount_result.fs_type,
            "label": label,
            "vendor": metadata.get("vendor"),
            "model": metadata.get("model"),
            "serial": metadata.get("serial"),
            "size_bytes": mount_result.size_bytes,
            "status": mount_result.status,
            "ts": utc_now_iso(),
        }
        if mount_result.error:
            payload["error"] = mount_result.error
        if remember:
            self._remember_device(payload)
        return payload

    def _build_remove_payload(self, device: Any) -> dict[str, Any] | None:
        device_node = str(device.device_node or "").strip()
        if not device_node:
            return None

        cached = self.cache_by_node.pop(device_node, None)
        uuid_value = str((cached or {}).get("uuid") or (device.get("ID_FS_UUID") or "").strip() or f"unknown-{device_node.rsplit('/', 1)[-1]}")
        cleanup_removed_mount(uuid_value, self.config)
        return {
            "type": "device_event",
            "action": "remove",
            "uuid": uuid_value,
            "device_node": device_node,
            "label": (cached or {}).get("label") or (device.get("ID_FS_LABEL") or "").strip() or None,
            "status": "removed",
            "ts": utc_now_iso(),
        }

    def _is_relevant_event(self, action: str, device: Any) -> bool:
        if action == "remove":
            if str(device.device_type or "").strip() != "partition":
                return False
            device_node = str(device.device_node or "").strip()
            return bool(device_node) and (
                device_node in self.cache_by_node or is_usb_storage_partition(device)
            )
        return is_usb_storage_partition(device)

    def _handle_monitor_device(self, device: Any) -> None:
        action = str(getattr(device, "action", "") or device.get("ACTION") or "").strip().lower()
        if not action:
            LOGGER.debug("skipping usb event without action device=%s", getattr(device, "device_node", None))
            return
        if not self._is_relevant_event(action, device):
            return
        try:
            if action == "add":
                payload = self._build_add_payload(device)
            elif action == "remove":
                payload = self._build_remove_payload(device)
            else:
                return
            if payload:
                self.emit(payload)
        except Exception as exc:  # pragma: no cover - runtime guard
            LOGGER.exception("failed to handle usb event action=%s device=%s", action, getattr(device, "device_node", None))
            self.emit(
                {
                    "type": "device_event",
                    "action": action,
                    "device_node": str(getattr(device, "device_node", "") or ""),
                    "status": "mount_failed" if action == "add" else "error",
                    "error": str(exc),
                    "ts": utc_now_iso(),
                }
            )

    def _collect_cold_scan_existing_devices(self) -> list[dict[str, Any]]:
        if not self.config.enable_cold_scan:
            return []

        results: list[dict[str, Any]] = []
        errors: list[BaseException] = []
        finished = threading.Event()
        state = {"timed_out": False}

        def runner() -> None:
            try:
                scanned = self._scan_existing_devices()
                if state["timed_out"]:
                    for payload in scanned:
                        self._remember_device(payload)
                    if not self.stop_event.is_set():
                        self.emit({"type": "ready", "ts": utc_now_iso(), "existing_devices": scanned})
                    return
                results.extend(scanned)
            except BaseException as exc:  # pragma: no cover - defensive runtime guard
                errors.append(exc)
            finally:
                finished.set()

        thread = threading.Thread(target=runner, name="hermes-usb-cold-scan", daemon=True)
        thread.start()
        if finished.wait(self.config.cold_scan_timeout_seconds):
            if errors:
                raise errors[0]
            for payload in results:
                self._remember_device(payload)
            return results

        state["timed_out"] = True
        LOGGER.warning("cold scan timed out after %.1fs; continuing with empty ready payload", self.config.cold_scan_timeout_seconds)
        return []

    def _scan_existing_devices(self) -> list[dict[str, Any]]:
        existing_devices: list[dict[str, Any]] = []
        for device in self.context.list_devices(subsystem="block", DEVTYPE="partition"):
            if not is_usb_storage_partition(device):
                continue
            payload = self._build_add_payload(device, remember=False)
            if payload is not None:
                existing_devices.append(payload)
        return existing_devices

    def _heartbeat_loop(self) -> None:
        while not self.stop_event.wait(self.config.heartbeat_interval_seconds):
            self.emit(
                {
                    "type": "heartbeat",
                    "ts": utc_now_iso(),
                    "device_count": len(self.cache_by_node),
                }
            )

    def start(self) -> None:
        LOGGER.info("starting usb monitor with config=%s", config_summary(self.config))
        monitor = pyudev.Monitor.from_netlink(self.context)
        monitor.filter_by(subsystem="block")
        try:
            monitor.start()
        except Exception:
            LOGGER.debug("monitor.start() not available or failed; falling back to poll-only mode", exc_info=True)
        self.monitor = monitor

        self.heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True, name="hermes-usb-heartbeat")
        self.heartbeat_thread.start()

        try:
            existing_devices = self._collect_cold_scan_existing_devices()
        except Exception:
            LOGGER.exception("cold scan failed; continuing with empty ready payload")
            existing_devices = []
        self.emit({"type": "ready", "ts": utc_now_iso(), "existing_devices": existing_devices})

        while not self.stop_event.is_set():
            try:
                device = monitor.poll(timeout=0.5)
            except Exception:
                LOGGER.exception("usb monitor poll failed")
                if not self.stop_event.wait(1.0):
                    continue
                break
            if device is None:
                continue
            self._handle_monitor_device(device)

    def stop(self) -> None:
        self.stop_event.set()
        self.monitor = None


def install_signal_handlers(monitor: USBMonitor) -> None:
    def handle_signal(_signum: int, _frame: Any) -> None:
        monitor.stop()

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(signum, handle_signal)
        except Exception:
            LOGGER.debug("failed to install signal handler", exc_info=True)


def main() -> int:
    monitor: USBMonitor | None = None
    try:
        monitor = USBMonitor()
        install_signal_handlers(monitor)
        monitor.start()
    except KeyboardInterrupt:
        if monitor is not None:
            try:
                monitor.stop()
            except Exception:
                pass
    except Exception:
        LOGGER.exception("usb monitor exited with fatal error")
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
