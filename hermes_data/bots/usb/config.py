from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_SUPPORTED_FILESYSTEMS = ("vfat", "ntfs", "exfat", "ext4", "btrfs")
DEFAULT_MOUNT_OPTIONS = ("rw", "noexec", "nodev", "nosuid")


def _split_csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _script_data_root() -> Path:
    return Path(__file__).resolve().parents[2]


def get_webui_home(env: dict[str, str] | None = None) -> Path:
    source = env or os.environ
    configured = (source.get("HERMES_WEB_UI_HOME") or source.get("HERMES_WEBUI_STATE_DIR") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return _script_data_root()


@dataclass(frozen=True)
class USBMonitorConfig:
    webui_home: Path
    mount_root: Path
    log_dir: Path
    heartbeat_interval_seconds: int
    supported_filesystems: tuple[str, ...]
    mount_options: tuple[str, ...]
    mount_command: str
    umount_command: str
    blkid_command: str
    log_level: str
    enable_cold_scan: bool

    @property
    def log_file(self) -> Path:
        return self.log_dir / "usb-monitor.log"

    @property
    def mount_options_arg(self) -> str:
        return ",".join(self.mount_options)


def load_config(env: dict[str, str] | None = None) -> USBMonitorConfig:
    source = env or os.environ
    webui_home = get_webui_home(source)
    mount_root = Path((source.get("USB_MOUNT_ROOT") or "").strip() or (webui_home / "mnt" / "usb"))
    log_dir = Path((source.get("USB_LOG_DIR") or "").strip() or (webui_home / "logs"))
    heartbeat_interval = int((source.get("USB_HEARTBEAT_INTERVAL_SECONDS") or "").strip() or DEFAULT_HEARTBEAT_INTERVAL_SECONDS)
    supported_filesystems = _split_csv(source.get("USB_SUPPORTED_FILESYSTEMS")) or DEFAULT_SUPPORTED_FILESYSTEMS
    mount_options = _split_csv(source.get("USB_MOUNT_OPTIONS")) or DEFAULT_MOUNT_OPTIONS
    log_level = (source.get("USB_LOG_LEVEL") or DEFAULT_LOG_LEVEL).strip().upper() or DEFAULT_LOG_LEVEL
    enable_cold_scan = (source.get("USB_ENABLE_COLD_SCAN") or "1").strip().lower() not in {"0", "false", "off", "no"}
    return USBMonitorConfig(
        webui_home=webui_home,
        mount_root=mount_root.expanduser().resolve(),
        log_dir=log_dir.expanduser().resolve(),
        heartbeat_interval_seconds=max(heartbeat_interval, 5),
        supported_filesystems=tuple(dict.fromkeys(supported_filesystems)),
        mount_options=tuple(dict.fromkeys(mount_options)),
        mount_command=(source.get("USB_MOUNT_COMMAND") or "/usr/bin/mount").strip() or "/usr/bin/mount",
        umount_command=(source.get("USB_UMOUNT_COMMAND") or "/usr/bin/umount").strip() or "/usr/bin/umount",
        blkid_command=(source.get("USB_BLKID_COMMAND") or "/usr/sbin/blkid").strip() or "/usr/sbin/blkid",
        log_level=log_level,
        enable_cold_scan=enable_cold_scan,
    )


def ensure_runtime_dirs(config: USBMonitorConfig) -> None:
    config.mount_root.mkdir(parents=True, exist_ok=True)
    config.log_dir.mkdir(parents=True, exist_ok=True)
    gitkeep = config.mount_root / ".gitkeep"
    if not gitkeep.exists():
        gitkeep.write_text("", encoding="utf-8")


def config_summary(config: USBMonitorConfig) -> dict[str, object]:
    return {
        "webui_home": str(config.webui_home),
        "mount_root": str(config.mount_root),
        "log_dir": str(config.log_dir),
        "heartbeat_interval_seconds": config.heartbeat_interval_seconds,
        "supported_filesystems": list(config.supported_filesystems),
        "mount_options": list(config.mount_options),
        "mount_command": config.mount_command,
        "umount_command": config.umount_command,
        "blkid_command": config.blkid_command,
        "enable_cold_scan": config.enable_cold_scan,
    }


def is_supported_filesystem(fs_type: str | None, supported_filesystems: Iterable[str]) -> bool:
    if not fs_type:
        return False
    return fs_type.strip().lower() in {item.strip().lower() for item in supported_filesystems if item.strip()}
