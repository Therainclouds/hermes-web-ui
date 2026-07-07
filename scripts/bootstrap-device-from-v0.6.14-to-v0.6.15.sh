#!/usr/bin/env bash
set -euo pipefail

SOURCE_VERSION="0.6.14"
TARGET_VERSION="${TARGET_VERSION:-0.6.15}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[INFO] Legacy bootstrap wrapper for ${SOURCE_VERSION} -> ${TARGET_VERSION}"

exec env \
  TARGET_VERSION="${TARGET_VERSION}" \
  PACKAGE_PATH="${PACKAGE_PATH:-${SCRIPT_DIR}/hermes-web-ui-device-v${TARGET_VERSION}.tar.gz}" \
  INSTALLER_PATH="${INSTALLER_PATH:-${SCRIPT_DIR}/install-device-package.sh}" \
  BASE_URL="${BASE_URL:-https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui}" \
  "${SCRIPT_DIR}/bootstrap-device-to-device-package.sh"
