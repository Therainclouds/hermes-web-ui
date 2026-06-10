# Device Image Workflow

This workflow is for batch duplication of a fully validated device image on the
same hardware model and storage layout.

## Scope

- Applies only to the same board model, CPU architecture, and storage layout.
- Prefer the same eMMC or TF card size across source and target devices.
- Export the image only after `quanthermes`, `quanthermes-kiosk`, and
  `hermes-web-ui` have been verified on the source device.

Important:

- This document covers image export, flashing, and baseline boot verification.
- Passing image verification does not automatically prove the
  `device-package` update chain is ready.
- Update-chain acceptance must be run separately after the basic image checks.

## Export The Golden Image

Run on the source device as `root`:

```bash
cd /opt/hermes-web-ui/scripts
chmod +x export-device-image.sh
OUTPUT_DIR=/mnt/usb/device-images ./export-device-image.sh
```

Optional environment variables:

- `SOURCE_DISK=/dev/mmcblk0`
- `IMAGE_PREFIX=quanthermes-golden`
- `COMPRESS_IMAGE=1`

The script exports:

- `*.img.xz`: compressed raw image
- `*.sha256`: checksum file
- `*.manifest.txt`: hardware and partition metadata

## Flash The Image

Use a Linux workstation or mass-production station:

```bash
xz -dc quanthermes-golden.img.xz | sudo dd of=/dev/sdX bs=16M status=progress conv=fsync
sync
```

Replace `/dev/sdX` with the full target disk, not a partition.

## Verify The Flashed Device

After the target device boots, run:

```bash
cd /opt/hermes-web-ui/scripts
chmod +x verify-device-image.sh
EXPECTED_MODEL="$(tr -d '\0' </proc/device-tree/model)" ./verify-device-image.sh
```

The verification checks:

- hardware model match when `EXPECTED_MODEL` is set
- `quanthermes`, `quanthermes-kiosk`, `hermes-web-ui.service`
- listeners on `80` and `6060`
- `http://127.0.0.1/api/status`
- `http://127.0.0.1:6060/health`
- running `fcitx5` process
- baseline update configuration visibility in `/health`
- presence of update-related environment variables in `/etc/default/hermes-web-ui`

## Baseline Acceptance Checklist

- boots without manual recovery steps
- shows provisioning page on local display when not connected
- switches local display to the business page after network and app readiness
- accepts Chinese input with `Ctrl+Space`
- serves `80` and `6060` correctly
- returns `status=ok` from `/health`
- exposes update-related health fields without crashing

## Update-Chain Readiness Checklist

Run this checklist after the baseline image verification passes.

For a `device-package` target device, confirm:

- `/etc/default/hermes-web-ui` contains the intended `WEBUI_UPDATE_*` values
- `/health` returns update metadata such as strategy, channel, and package type
- `install-device-package.sh` exists in `/opt/hermes-web-ui/scripts`
- the updates directory under `HERMES_WEB_UI_HOME` is present or creatable
- the device can reach the configured manifest source and release asset URLs

Recommended commands:

```bash
grep '^WEBUI_UPDATE_' /etc/default/hermes-web-ui
curl -fsS http://127.0.0.1:6060/health
ls -l /opt/hermes-web-ui/scripts/install-device-package.sh
ls -ld /home/hermesui/.hermes-web-ui /home/hermesui/.hermes-web-ui/updates
```

If the device is already configured for `device-package`, the health response
should expose:

- `webui_update_enabled`
- `webui_update_strategy=device-package`
- `webui_update_channel`
- `webui_update_package_type=device-package`

## Notes

- Re-export the image after any system package upgrade that changes kernel,
  bootloader, or storage layout.
- Keep the exported manifest with the image so production can confirm the
  source disk model and partition identifiers before flashing.
- Keep device image acceptance and update-chain acceptance as separate records.
