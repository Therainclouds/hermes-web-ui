#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Please run this script as root." >&2
  exit 1
fi

SOURCE_VERSION="0.6.14"
TARGET_VERSION="0.6.15"
BASE_URL="https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_PATH="${PACKAGE_PATH:-${SCRIPT_DIR}/hermes-web-ui-device-v${TARGET_VERSION}.tar.gz}"
INSTALLER_PATH="${INSTALLER_PATH:-${SCRIPT_DIR}/install-device-package.sh}"

CONFIG_FILE="/etc/default/hermes-web-ui"
APP_USER="${APP_USER:-hermesui}"
APP_HOME="${APP_HOME:-/home/${APP_USER}/.hermes-web-ui}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"

for required_path in "${PACKAGE_PATH}" "${INSTALLER_PATH}"; do
  if [[ ! -f "${required_path}" ]]; then
    echo "[ERROR] Missing required file: ${required_path}" >&2
    exit 1
  fi
done

echo "[INFO] Bootstrapping device upgrade path ${SOURCE_VERSION} -> ${TARGET_VERSION}"

mkdir -p "${APP_HOME}/updates/staging" "${APP_HOME}/updates/backups" "${APP_HOME}/updates/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}"
chmod 775 "${APP_HOME}/updates" "${APP_HOME}/updates/staging" "${APP_HOME}/updates/backups" "${APP_HOME}/updates/logs" || true

cp "${CONFIG_FILE}" "${CONFIG_FILE}.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

python3 - <<'PY'
from pathlib import Path

path = Path("/etc/default/hermes-web-ui")
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()

drop_prefixes = (
    "WEBUI_UPDATE_ENABLED=",
    "WEBUI_UPDATE_SOURCE_LABEL=",
    "WEBUI_UPDATE_STRATEGY=",
    "WEBUI_UPDATE_PACKAGE_TYPE=",
    "WEBUI_UPDATE_CHANNEL=",
    "WEBUI_UPDATE_MANIFEST_BASE_URL=",
    "WEBUI_UPDATE_MANIFEST_URLS=",
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
    "WEBUI_UPDATE_MANIFEST_BASE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases",
    "WEBUI_UPDATE_MANIFEST_URLS=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/stable/latest.json,https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/stable/latest.json",
    "WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh",
    "WEBUI_UPDATE_RUNNER_SERVICE=hermes-web-ui-update.service",
    "WEBUI_UPDATE_RUNNER_REQUEST_FILE=/home/hermesui/.hermes-web-ui/updates/update-runner-request.json",
    "WEBUI_UPDATE_VERIFY_SHA256=true",
    "WEBUI_UPDATE_STAGING_DIR=/home/hermesui/.hermes-web-ui/updates/staging",
    "WEBUI_UPDATE_BACKUP_DIR=/home/hermesui/.hermes-web-ui/updates/backups",
    "WEBUI_UPDATE_BACKUP_RETENTION_COUNT=2",
    "WEBUI_UPDATE_HEALTHCHECK_URL=http://127.0.0.1:6060/health",
    "WEBUI_UPDATE_STATE_FILE=/home/hermesui/.hermes-web-ui/updates/update-task-state.json",
    "WEBUI_UPDATE_LOG_DIR=/home/hermesui/.hermes-web-ui/updates/logs",
    "WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=60000",
    "WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=2000",
    "WEBUI_UPDATE_HEALTHCHECK_RETRIES=15",
    "WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=5000",
    "HERMES_AGENT_UPDATE_MANIFEST_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/stable/latest.json",
    "HERMES_AGENT_WHEELHOUSE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/wheelhouse/",
]

output = "\n".join(kept).rstrip()
if output:
    output += "\n\n"
output += "\n".join(append) + "\n"
path.write_text(output, encoding="utf-8")
PY

APP_USER="${APP_USER}" \
PORT="6060" \
SYSTEMD_SERVICE_NAME="hermes-web-ui.service" \
SERVICE_ENV_FILE="${CONFIG_FILE}" \
HERMES_HOME_DIR="${HERMES_HOME_DIR}" \
HERMES_HOME="${HERMES_HOME_DIR}" \
HERMES_WEB_UI_HOME="${APP_HOME}" \
HERMES_WEBUI_STATE_DIR="${APP_HOME}" \
UPLOAD_DIR="${APP_HOME}/uploads" \
WEBUI_UPDATE_ENABLED="true" \
WEBUI_UPDATE_SOURCE_LABEL="Quanthermes Device Releases" \
WEBUI_UPDATE_STRATEGY="device-package" \
WEBUI_UPDATE_PACKAGE_TYPE="device-package" \
WEBUI_UPDATE_CHANNEL="stable" \
WEBUI_UPDATE_MANIFEST_BASE_URL="${BASE_URL}/releases" \
WEBUI_UPDATE_MANIFEST_URLS="${BASE_URL}/releases/stable/latest.json,https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/stable/latest.json" \
WEBUI_UPDATE_INSTALLER_SCRIPT="/opt/hermes-web-ui/scripts/install-device-package.sh" \
WEBUI_UPDATE_RUNNER_SERVICE="hermes-web-ui-update.service" \
WEBUI_UPDATE_RUNNER_REQUEST_FILE="${APP_HOME}/updates/update-runner-request.json" \
WEBUI_UPDATE_VERIFY_SHA256="true" \
WEBUI_UPDATE_STAGING_DIR="${APP_HOME}/updates/staging" \
WEBUI_UPDATE_BACKUP_DIR="${APP_HOME}/updates/backups" \
WEBUI_UPDATE_BACKUP_RETENTION_COUNT="2" \
WEBUI_UPDATE_HEALTHCHECK_URL="http://127.0.0.1:6060/health" \
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
curl -sS --max-time 5 http://127.0.0.1:6060/health
echo
grep '"version"' /opt/hermes-web-ui/package.json
ls -l /home/hermesui/.hermes-web-ui/updates/update-task-state.json || true
