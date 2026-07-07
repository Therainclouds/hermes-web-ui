#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Please run this script as root." >&2
  exit 1
fi

BASE_URL="${BASE_URL:-https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui}"
APP_USER="${APP_USER:-hermesui}"
APP_HOME="${APP_HOME:-/home/${APP_USER}/.hermes-web-ui}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"
CONFIG_FILE="${CONFIG_FILE:-/etc/default/hermes-web-ui}"
INSTALLER_PATH="${INSTALLER_PATH:-${DEPLOY_DIR}/scripts/install-device-package.sh}"
PACKAGE_PATH="${PACKAGE_PATH:-}"
TARGET_VERSION="${TARGET_VERSION:-}"
PORT="${PORT:-6060}"

if [[ -z "${PACKAGE_PATH}" ]]; then
  echo "[ERROR] PACKAGE_PATH is required." >&2
  exit 1
fi

if [[ ! -f "${PACKAGE_PATH}" ]]; then
  echo "[ERROR] Missing package archive: ${PACKAGE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${INSTALLER_PATH}" ]]; then
  echo "[ERROR] Missing installer script: ${INSTALLER_PATH}" >&2
  exit 1
fi

if [[ -z "${TARGET_VERSION}" ]]; then
  package_name="$(basename "${PACKAGE_PATH}")"
  if [[ "${package_name}" =~ ^hermes-web-ui-device-v([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$ ]]; then
    TARGET_VERSION="${BASH_REMATCH[1]}"
  else
    echo "[ERROR] TARGET_VERSION is required when PACKAGE_PATH does not match hermes-web-ui-device-vX.Y.Z.tar.gz." >&2
    exit 1
  fi
fi

echo "[INFO] Bootstrapping device update channel to OSS device-package mode"
echo "[INFO] Target version: ${TARGET_VERSION}"

mkdir -p "${APP_HOME}/updates/staging" "${APP_HOME}/updates/backups" "${APP_HOME}/updates/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}"
chmod 775 "${APP_HOME}/updates" "${APP_HOME}/updates/staging" "${APP_HOME}/updates/backups" "${APP_HOME}/updates/logs" || true

cp "${CONFIG_FILE}" "${CONFIG_FILE}.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

CONFIG_FILE="${CONFIG_FILE}" \
APP_USER="${APP_USER}" \
APP_HOME="${APP_HOME}" \
BASE_URL="${BASE_URL}" \
PORT="${PORT}" \
python3 - <<'PY'
from pathlib import Path
import os

path = Path(os.environ["CONFIG_FILE"])
app_user = os.environ["APP_USER"]
app_home = os.environ["APP_HOME"]
base_url = os.environ["BASE_URL"].rstrip("/")
port = os.environ["PORT"]

text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()

drop_prefixes = (
    "WEBUI_UPDATE_ENABLED=",
    "WEBUI_UPDATE_SOURCE_LABEL=",
    "WEBUI_UPDATE_STRATEGY=",
    "WEBUI_UPDATE_PACKAGE_TYPE=",
    "WEBUI_UPDATE_CHANNEL=",
    "WEBUI_UPDATE_MANIFEST_URL=",
    "WEBUI_UPDATE_MANIFEST_URLS=",
    "WEBUI_UPDATE_MANIFEST_BASE_URL=",
    "WEBUI_UPDATE_MANIFEST_BASE_URLS=",
    "WEBUI_UPDATE_INSTALLER_SCRIPT=",
    "WEBUI_UPDATE_RUNNER_SERVICE=",
    "WEBUI_UPDATE_RUNNER_REQUEST_FILE=",
    "WEBUI_UPDATE_VERIFY_SHA256=",
    "WEBUI_UPDATE_STAGING_DIR=",
    "WEBUI_UPDATE_BACKUP_DIR=",
    "WEBUI_UPDATE_BACKUP_RETENTION_COUNT=",
    "WEBUI_UPDATE_HEALTHCHECK_URL=",
    "WEBUI_UPDATE_STATE_FILE=",
    "WEBUI_UPDATE_LOG_DIR=",
    "WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=",
    "WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=",
    "WEBUI_UPDATE_HEALTHCHECK_RETRIES=",
    "WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=",
    "HERMES_AGENT_UPDATE_MANIFEST_URL=",
    "HERMES_AGENT_WHEELHOUSE_URL=",
)

kept = [line for line in lines if not line.startswith(drop_prefixes)]

append = [
    "WEBUI_UPDATE_ENABLED=true",
    "WEBUI_UPDATE_SOURCE_LABEL=Quanthermes Device Releases",
    "WEBUI_UPDATE_STRATEGY=device-package",
    "WEBUI_UPDATE_PACKAGE_TYPE=device-package",
    "WEBUI_UPDATE_CHANNEL=stable",
    f"WEBUI_UPDATE_MANIFEST_BASE_URL={base_url}/releases",
    f"WEBUI_UPDATE_MANIFEST_URLS={base_url}/releases/stable/latest.json",
    "WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh",
    "WEBUI_UPDATE_RUNNER_SERVICE=hermes-web-ui-update.service",
    f"WEBUI_UPDATE_RUNNER_REQUEST_FILE={app_home}/updates/update-runner-request.json",
    "WEBUI_UPDATE_VERIFY_SHA256=true",
    f"WEBUI_UPDATE_STAGING_DIR={app_home}/updates/staging",
    f"WEBUI_UPDATE_BACKUP_DIR={app_home}/updates/backups",
    "WEBUI_UPDATE_BACKUP_RETENTION_COUNT=2",
    f"WEBUI_UPDATE_HEALTHCHECK_URL=http://127.0.0.1:{port}/health",
    f"WEBUI_UPDATE_STATE_FILE={app_home}/updates/update-task-state.json",
    f"WEBUI_UPDATE_LOG_DIR={app_home}/updates/logs",
    "WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=60000",
    "WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=2000",
    "WEBUI_UPDATE_HEALTHCHECK_RETRIES=15",
    "WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=5000",
    f"HERMES_AGENT_UPDATE_MANIFEST_URL={base_url}/hermes-agent/stable/latest.json",
    f"HERMES_AGENT_WHEELHOUSE_URL={base_url}/hermes-agent/wheelhouse/",
]

output = "\n".join(kept).rstrip()
if output:
    output += "\n\n"
output += "\n".join(append) + "\n"
path.write_text(output, encoding="utf-8")
PY

APP_USER="${APP_USER}" \
PORT="${PORT}" \
SYSTEMD_SERVICE_NAME="hermes-web-ui.service" \
SERVICE_ENV_FILE="${CONFIG_FILE}" \
HERMES_HOME_DIR="${HERMES_HOME_DIR}" \
HERMES_HOME="${HERMES_HOME_DIR}" \
HERMES_WEB_UI_HOME="${APP_HOME}" \
HERMES_WEBUI_STATE_DIR="${APP_HOME}" \
UPLOAD_DIR="${APP_HOME}/upload" \
WEBUI_UPDATE_ENABLED="true" \
WEBUI_UPDATE_SOURCE_LABEL="Quanthermes Device Releases" \
WEBUI_UPDATE_STRATEGY="device-package" \
WEBUI_UPDATE_PACKAGE_TYPE="device-package" \
WEBUI_UPDATE_CHANNEL="stable" \
WEBUI_UPDATE_MANIFEST_BASE_URL="${BASE_URL}/releases" \
WEBUI_UPDATE_MANIFEST_URLS="${BASE_URL}/releases/stable/latest.json" \
WEBUI_UPDATE_INSTALLER_SCRIPT="/opt/hermes-web-ui/scripts/install-device-package.sh" \
WEBUI_UPDATE_RUNNER_SERVICE="hermes-web-ui-update.service" \
WEBUI_UPDATE_RUNNER_REQUEST_FILE="${APP_HOME}/updates/update-runner-request.json" \
WEBUI_UPDATE_VERIFY_SHA256="true" \
WEBUI_UPDATE_STAGING_DIR="${APP_HOME}/updates/staging" \
WEBUI_UPDATE_BACKUP_DIR="${APP_HOME}/updates/backups" \
WEBUI_UPDATE_BACKUP_RETENTION_COUNT="2" \
WEBUI_UPDATE_HEALTHCHECK_URL="http://127.0.0.1:${PORT}/health" \
WEBUI_UPDATE_STATE_FILE="${APP_HOME}/updates/update-task-state.json" \
WEBUI_UPDATE_LOG_DIR="${APP_HOME}/updates/logs" \
WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS="60000" \
WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS="2000" \
WEBUI_UPDATE_HEALTHCHECK_RETRIES="15" \
WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS="5000" \
HERMES_AGENT_UPDATE_MANIFEST_URL="${BASE_URL}/hermes-agent/stable/latest.json" \
HERMES_AGENT_WHEELHOUSE_URL="${BASE_URL}/hermes-agent/wheelhouse/" \
bash "${INSTALLER_PATH}" \
  --package "${PACKAGE_PATH}" \
  --version "${TARGET_VERSION}"

sleep 8
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health"
echo
grep '"version"' "${DEPLOY_DIR}/package.json"
grep -E 'WEBUI_UPDATE_(STRATEGY|PACKAGE_TYPE|MANIFEST|INSTALLER_SCRIPT)' "${CONFIG_FILE}"
