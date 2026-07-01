from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .config import USBMonitorConfig, is_supported_filesystem
except ImportError:
    from config import USBMonitorConfig, is_supported_filesystem


LOGGER = logging.getLogger("hermes.usb.mounter")
UNKNOWN_UUID_PREFIX = "unknown"
UUID_SEGMENT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")
READ_ONLY_ERROR = "Device is read-only."
FSCK_ERROR = "Filesystem looks damaged. Run fsck on the device."


@dataclass(frozen=True)
class DeviceProbe:
    device_node: str
    uuid: str
    fs_type: str | None
    label: str | None
    part_label: str | None
    part_uuid: str | None
    size_bytes: int | None

    @property
    def mount_dir_name(self) -> str:
        return sanitize_uuid_segment(self.uuid)


@dataclass(frozen=True)
class MountResult:
    device_node: str
    uuid: str
    fs_type: str | None
    label: str | None
    size_bytes: int | None
    mount_point: str
    status: str
    error: str | None = None
    already_mounted: bool = False


def run_command(args: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
    LOGGER.debug("running command: %s", args)
    return subprocess.run(
        args,
        check=check,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def sanitize_uuid_segment(value: str) -> str:
    normalized = UUID_SEGMENT_PATTERN.sub("-", (value or "").strip()).strip(".-")
    return normalized or f"{UNKNOWN_UUID_PREFIX}-device"


def parse_blkid_export(output: str) -> dict[str, str]:
    payload: dict[str, str] = {}
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        payload[key.strip().upper()] = value.strip()
    return payload


def _fallback_uuid(device_node: str) -> str:
    return f"{UNKNOWN_UUID_PREFIX}-{Path(device_node).name}"


def _read_sys_block_size_bytes(device_node: str) -> int | None:
    name = Path(device_node).name
    size_path = Path("/sys/class/block") / name / "size"
    if not size_path.exists():
        return None
    try:
        sectors = int(size_path.read_text(encoding="utf-8").strip() or "0")
    except Exception:
        return None
    if sectors <= 0:
        return None
    return sectors * 512


def probe_device(device_node: str, config: USBMonitorConfig) -> DeviceProbe:
    result = run_command([config.blkid_command, "-o", "export", device_node], check=False)
    payload = parse_blkid_export(result.stdout or "")
    uuid = payload.get("UUID") or payload.get("PARTUUID") or _fallback_uuid(device_node)
    fs_type = payload.get("TYPE")
    label = payload.get("LABEL")
    part_label = payload.get("PARTLABEL")
    part_uuid = payload.get("PARTUUID")
    return DeviceProbe(
        device_node=device_node,
        uuid=uuid,
        fs_type=fs_type,
        label=label,
        part_label=part_label,
        part_uuid=part_uuid,
        size_bytes=_read_sys_block_size_bytes(device_node),
    )


def _parse_proc_mounts() -> list[tuple[str, str, str]]:
    mounts: list[tuple[str, str, str]] = []
    proc_mounts = Path("/proc/mounts")
    if not proc_mounts.exists():
        return mounts
    for raw_line in proc_mounts.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = raw_line.split()
        if len(parts) < 3:
            continue
        mounts.append((parts[0], parts[1], parts[2]))
    return mounts


def find_mount_for_device(device_node: str) -> tuple[str, str] | None:
    for mounted_device, mount_point, fs_type in _parse_proc_mounts():
        if mounted_device == device_node:
            return mount_point, fs_type
    return None


def mount_point_for_uuid(probe: DeviceProbe, config: USBMonitorConfig) -> Path:
    return config.mount_root / probe.mount_dir_name


def _diagnose_mount_error(stderr: str, fs_type: str | None) -> str:
    lower = (stderr or "").strip().lower()
    if "unknown filesystem type 'hfsplus'" in lower:
        return "Unsupported macOS HFS+ filesystem. Reformat to exFAT on macOS."
    if "unknown filesystem type 'apfs'" in lower:
        return "Unsupported macOS APFS filesystem. Reformat to exFAT on macOS."
    if "is write-protected" in lower:
        return READ_ONLY_ERROR
    if "wrong fs type" in lower or "bad superblock" in lower:
        return FSCK_ERROR
    if "permission denied" in lower:
        return "Permission denied while mounting the device."
    if fs_type and not lower:
        return f"Mount failed for filesystem: {fs_type}"
    return (stderr or "").strip() or "Mount failed."


def _ensure_mount_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _cleanup_empty_dir(path: Path) -> None:
    try:
        if not path.exists() or not path.is_dir():
            return
        children = [child for child in path.iterdir()]
        if not children:
            path.rmdir()
            return
        if len(children) == 1 and children[0].name == ".gitkeep":
            children[0].unlink(missing_ok=True)
            path.rmdir()
    except Exception:
        LOGGER.debug("skipped cleanup for mount dir %s", path, exc_info=True)


def ensure_mounted(device_node: str, config: USBMonitorConfig) -> MountResult:
    probe = probe_device(device_node, config)
    existing = find_mount_for_device(device_node)
    target_mount_point = mount_point_for_uuid(probe, config)
    if existing is not None:
        existing_mount_point, existing_fs_type = existing
        return MountResult(
            device_node=device_node,
            uuid=probe.uuid,
            fs_type=probe.fs_type or existing_fs_type,
            label=probe.label or probe.part_label,
            size_bytes=probe.size_bytes,
            mount_point=existing_mount_point,
            status="mounted",
            already_mounted=True,
        )

    if probe.fs_type and not is_supported_filesystem(probe.fs_type, config.supported_filesystems):
        return MountResult(
            device_node=device_node,
            uuid=probe.uuid,
            fs_type=probe.fs_type,
            label=probe.label or probe.part_label,
            size_bytes=probe.size_bytes,
            mount_point=str(target_mount_point),
            status="mount_failed",
            error=f"Unsupported filesystem: {probe.fs_type}",
        )

    _ensure_mount_dir(target_mount_point)
    first_attempt = run_command(
        [
            config.mount_command,
            "-t",
            "auto",
            "-o",
            config.mount_options_arg,
            device_node,
            str(target_mount_point),
        ],
        check=False,
    )
    if first_attempt.returncode == 0:
        return MountResult(
            device_node=device_node,
            uuid=probe.uuid,
            fs_type=probe.fs_type,
            label=probe.label or probe.part_label,
            size_bytes=probe.size_bytes,
            mount_point=str(target_mount_point),
            status="mounted",
        )

    if probe.fs_type:
        retry_attempt = run_command(
            [
                config.mount_command,
                "-t",
                probe.fs_type,
                "-o",
                config.mount_options_arg,
                device_node,
                str(target_mount_point),
            ],
            check=False,
        )
        if retry_attempt.returncode == 0:
            return MountResult(
                device_node=device_node,
                uuid=probe.uuid,
                fs_type=probe.fs_type,
                label=probe.label or probe.part_label,
                size_bytes=probe.size_bytes,
                mount_point=str(target_mount_point),
                status="mounted",
            )
        error_text = retry_attempt.stderr or first_attempt.stderr
    else:
        error_text = first_attempt.stderr

    _cleanup_empty_dir(target_mount_point)
    return MountResult(
        device_node=device_node,
        uuid=probe.uuid,
        fs_type=probe.fs_type,
        label=probe.label or probe.part_label,
        size_bytes=probe.size_bytes,
        mount_point=str(target_mount_point),
        status="mount_failed",
        error=_diagnose_mount_error(error_text, probe.fs_type),
    )


def cleanup_removed_mount(uuid_value: str, config: USBMonitorConfig) -> None:
    _cleanup_empty_dir(config.mount_root / sanitize_uuid_segment(uuid_value))


def device_metadata_from_pyudev(device: Any) -> dict[str, str | None]:
    vendor = None
    model = None
    serial = None
    try:
        usb_parent = device.find_parent("usb", "usb_device")
    except Exception:
        usb_parent = None
    if usb_parent is not None:
        vendor = (usb_parent.get("ID_VENDOR_FROM_DATABASE") or usb_parent.get("ID_VENDOR") or "").strip() or None
        model = (usb_parent.get("ID_MODEL_FROM_DATABASE") or usb_parent.get("ID_MODEL") or "").strip() or None
        serial = (usb_parent.get("ID_SERIAL_SHORT") or usb_parent.get("ID_SERIAL") or "").strip() or None
    return {
        "vendor": vendor,
        "model": model,
        "serial": serial,
    }


def is_usb_storage_partition(device: Any) -> bool:
    try:
        if str(device.device_type or "").strip() != "partition":
            return False
        if not str(device.device_node or "").strip():
            return False
        if device.find_parent("usb", "usb_device") is None:
            return False
    except Exception:
        return False
    return True
