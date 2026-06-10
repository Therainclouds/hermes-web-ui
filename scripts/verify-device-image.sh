#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[image-verify] %s\n' "$*"
}

fail() {
  printf '[image-verify] ERROR: %s\n' "$*" >&2
  exit 1
}

check_service() {
  local service_name="$1"
  if ! systemctl is-active --quiet "${service_name}"; then
    systemctl status "${service_name}" --no-pager || true
    fail "Service is not active: ${service_name}"
  fi
  log "Service active: ${service_name}"
}

check_http() {
  local url="$1"
  local expected="$2"
  local body
  body="$(curl -fsS --max-time 5 "${url}")" || fail "Request failed: ${url}"
  if [[ "${body}" != *"${expected}"* ]]; then
    fail "Unexpected response from ${url}"
  fi
  log "HTTP check passed: ${url}"
}

check_file_contains() {
  local file_path="$1"
  local expected="$2"
  grep -q "${expected}" "${file_path}" || fail "Expected '${expected}' in ${file_path}"
  log "Config check passed: ${file_path} contains ${expected}"
}

EXPECTED_MODEL="${EXPECTED_MODEL:-}"
ACTUAL_MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo unknown)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:6060/health}"
ENV_FILE="${ENV_FILE:-/etc/default/hermes-web-ui}"
WEBUI_HOME="${WEBUI_HOME:-/home/hermesui/.hermes-web-ui}"

if [[ -n "${EXPECTED_MODEL}" && "${ACTUAL_MODEL}" != "${EXPECTED_MODEL}" ]]; then
  fail "Model mismatch. Expected '${EXPECTED_MODEL}', got '${ACTUAL_MODEL}'"
fi

log "Detected model: ${ACTUAL_MODEL}"
check_service "quanthermes"
check_service "quanthermes-kiosk"
check_service "hermes-web-ui.service"

ss -lntpH '( sport = :80 )' | grep -q ':80' || fail "Port 80 is not listening"
ss -lntpH '( sport = :6060 )' | grep -q ':6060' || fail "Port 6060 is not listening"
log "Ports 80 and 6060 are listening"

check_http "http://127.0.0.1/api/status" "\"displayMode\":"
check_http "${HEALTH_URL}" "\"status\":\"ok\""
check_http "${HEALTH_URL}" "\"webui_update_enabled\":"

test -f "${ENV_FILE}" || fail "Missing environment file: ${ENV_FILE}"
check_file_contains "${ENV_FILE}" '^WEBUI_UPDATE_ENABLED='
check_file_contains "${ENV_FILE}" '^WEBUI_UPDATE_STRATEGY='

if grep -q '^WEBUI_UPDATE_STRATEGY=device-package$' "${ENV_FILE}"; then
  check_file_contains "${ENV_FILE}" '^WEBUI_UPDATE_PACKAGE_TYPE=device-package$'
  if ! grep -q '^WEBUI_UPDATE_MANIFEST_URL=' "${ENV_FILE}" && ! grep -q '^WEBUI_UPDATE_MANIFEST_BASE_URL=' "${ENV_FILE}"; then
    fail "device-package mode requires WEBUI_UPDATE_MANIFEST_URL or WEBUI_UPDATE_MANIFEST_BASE_URL"
  fi
  check_file_contains "${ENV_FILE}" '^WEBUI_UPDATE_INSTALLER_SCRIPT='
  test -x /opt/hermes-web-ui/scripts/install-device-package.sh || fail "install-device-package.sh is missing or not executable"
  log "device-package readiness checks passed"
fi

test -d "${WEBUI_HOME}" || fail "Missing Web UI home directory: ${WEBUI_HOME}"
if [[ -d "${WEBUI_HOME}/updates" && -d "${WEBUI_HOME}/updates/logs" ]]; then
  log "Update directories already exist under ${WEBUI_HOME}"
elif [[ -w "${WEBUI_HOME}" ]]; then
  log "Update directories do not exist yet, but ${WEBUI_HOME} is writable"
else
  fail "Update directories are missing and ${WEBUI_HOME} is not writable"
fi

if pgrep -x fcitx5 >/dev/null 2>&1; then
  log "fcitx5 process detected"
else
  fail "fcitx5 process not found"
fi

log "Image verification passed"
