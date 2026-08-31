#!/usr/bin/env bash
set -Eeuo pipefail

SELF_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_STATE_HELPER="${SCRIPT_DIR}/update-task-state.py"
# Defensive: re-apply +x on scripts after tar extraction. See scripts/_lib/fixup-script-modes.sh.
source "${SCRIPT_DIR}/_lib/fixup-script-modes.sh"
LOG_FILE="${HERMES_WEB_UI_UPDATE_LOG:-/var/log/hermes-web-ui-update.log}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
APP_USER="${APP_USER:-hermesui}"
PORT="${PORT:-6060}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui.service}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${HERMES_HOME:-${DEPLOY_DIR}/hermes_data}}"
HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-${HERMES_WEBUI_STATE_DIR:-}}"
UPLOAD_DIR="${UPLOAD_DIR:-}"
RUNTIME_HOME="${HERMES_WEB_UI_HOME:-${HOME:-/tmp}}"
UPDATE_STATE_FILE="${HERMES_WEB_UI_UPDATE_STATE_FILE:-${RUNTIME_HOME}/updates/update-task-state.json}"
UPDATE_LOG_DIR="${HERMES_WEB_UI_UPDATE_LOG_DIR:-${RUNTIME_HOME}/updates/logs}"
TASK_ID="${HERMES_WEB_UI_UPDATE_TASK_ID:-}"
HEALTHCHECK_URL="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL:-}"
HEALTHCHECK_TIMEOUT_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS:-2000}"
HEALTHCHECK_INTERVAL_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS:-2000}"
HEALTHCHECK_RETRIES="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES:-15}"
HEALTHCHECK_INITIAL_DELAY_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS:-5000}"
INCLUDE_AGENT_UPGRADE_RAW="${HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE:-true}"
PRESERVE_NAMES=("hermes_data" ".git" ".runtime-hermes" ".runtime-home")
TASK_FINISHED=0

info() { printf '[update-source-deploy] %s\n' "$*"; }
warn() { printf '[update-source-deploy] WARNING: %s\n' "$*"; }
err() { printf '[update-source-deploy] ERROR: %s\n' "$*" >&2; }

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

millis_to_sleep() {
  python3 - "$1" <<'PY'
import sys
milliseconds = max(int(sys.argv[1] or "0"), 0)
print(f"{milliseconds / 1000:.3f}")
PY
}

cleanup() {
  if [[ -n "${TMP_DIR:-}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

init_logging() {
  local version_segment timestamp
  version_segment="${TARGET_VERSION//[^A-Za-z0-9._-]/_}"
  timestamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "${UPDATE_LOG_DIR}"
  if [[ -n "${TASK_ID}" ]]; then
    LOG_FILE="${UPDATE_LOG_DIR}/${TASK_ID}.log"
  else
    LOG_FILE="${UPDATE_LOG_DIR}/source-deploy-${version_segment}-${timestamp}.log"
  fi
}

write_task_state() {
  local action="$1"
  local status="$2"
  local stage="$3"
  local message="$4"
  local error_message="${5:-}"

  env \
    STATE_FILE="${UPDATE_STATE_FILE}" \
    TASK_ID="${TASK_ID}" \
    TASK_STRATEGY="source-deploy" \
    TASK_OWNER="runtime" \
    TARGET_VERSION="${TARGET_VERSION}" \
    LOG_PATH="${LOG_FILE}" \
    HEALTHCHECK_URL="${HEALTHCHECK_URL}" \
    APP_USER="${APP_USER}" \
    TASK_ACTION="${action}" \
    TASK_STATUS="${status}" \
    TASK_STAGE="${stage}" \
    TASK_MESSAGE="${message}" \
    TASK_ERROR="${error_message}" \
    python3 "${TASK_STATE_HELPER}"
}

update_task_stage() {
  [[ -n "${TASK_ID}" ]] || return 0
  write_task_state patch running "$1" "$2"
}

finish_task_succeeded() {
  [[ -n "${TASK_ID}" ]] || return 0
  TASK_FINISHED=1
  write_task_state finish succeeded succeeded "$1"
}

finish_task_failed() {
  [[ -n "${TASK_ID}" ]] || return 0
  TASK_FINISHED=1
  write_task_state finish failed failed "$1" "${2:-$1}"
}

handle_failure() {
  local exit_code=$?
  local line_no="${1:-unknown}"
  if [[ "${TASK_FINISHED}" -eq 0 ]]; then
    finish_task_failed "Source deployment update failed for ${TARGET_VERSION:-unknown}." "Source deployment update failed near line ${line_no} with exit code ${exit_code}."
  fi
  exit "${exit_code}"
}
trap 'handle_failure "${LINENO}"' ERR

ensure_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    err "sudo is required for source deployment updates."
    exit 1
  fi
  export DEPLOY_DIR APP_USER PORT SYSTEMD_SERVICE_NAME SERVICE_ENV_FILE HERMES_HOME_DIR HERMES_HOME HERMES_WEB_UI_HOME HERMES_WEBUI_STATE_DIR UPLOAD_DIR
  export HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE
  export WEBUI_UPDATE_ENABLED WEBUI_UPDATE_PACKAGE WEBUI_UPDATE_REGISTRY WEBUI_UPDATE_CLI_BIN
  export WEBUI_UPDATE_SOURCE_LABEL WEBUI_UPDATE_DIST_TAG WEBUI_UPDATE_STRATEGY WEBUI_UPDATE_SCRIPT WEBUI_UPDATE_REPO
  export HERMES_AGENT_WHEEL_URL HERMES_AGENT_WHEELHOUSE_URL HERMES_AGENT_RELEASES_API_URL HERMES_AGENT_UPDATE_MANIFEST_URL HERMES_ANTHROPIC_VERSION
  export HERMES_WEB_UI_UPDATE_LOG="${LOG_FILE}"
  exec sudo -n \
    --preserve-env=DEPLOY_DIR,APP_USER,PORT,SYSTEMD_SERVICE_NAME,SERVICE_ENV_FILE,HERMES_HOME_DIR,HERMES_HOME,HERMES_WEB_UI_HOME,HERMES_WEBUI_STATE_DIR,UPLOAD_DIR,HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE,WEBUI_UPDATE_ENABLED,WEBUI_UPDATE_PACKAGE,WEBUI_UPDATE_REGISTRY,WEBUI_UPDATE_CLI_BIN,WEBUI_UPDATE_SOURCE_LABEL,WEBUI_UPDATE_DIST_TAG,WEBUI_UPDATE_STRATEGY,WEBUI_UPDATE_SCRIPT,WEBUI_UPDATE_REPO,WEBUI_UPDATE_MANIFEST_URL,WEBUI_UPDATE_MANIFEST_URLS,WEBUI_UPDATE_MANIFEST_BASE_URL,WEBUI_UPDATE_MANIFEST_BASE_URLS,HERMES_AGENT_WHEEL_URL,HERMES_AGENT_WHEELHOUSE_URL,HERMES_AGENT_RELEASES_API_URL,HERMES_AGENT_UPDATE_MANIFEST_URL,HERMES_ANTHROPIC_VERSION,HERMES_WEB_UI_UPDATE_LOG,HERMES_WEB_UI_UPDATE_VERSION \
    /bin/bash "${SELF_PATH}" "$@"
}

canonicalize_path() {
  python3 - "$1" <<'PY'
import os
import sys

value = sys.argv[1].strip()
if not value:
    print("")
else:
    print(os.path.realpath(os.path.abspath(value)))
PY
}

path_is_same_or_within() {
  python3 - "$1" "$2" <<'PY'
import os
import sys
from pathlib import Path

parent = sys.argv[1].strip()
child = sys.argv[2].strip()
if not parent or not child:
    print("false")
    raise SystemExit(0)

parent_path = Path(parent).resolve()
child_path = Path(child).resolve()

try:
    child_path.relative_to(parent_path)
    print("true")
except ValueError:
    print("false")
PY
}

top_level_child_name() {
  python3 - "$1" "$2" <<'PY'
import sys
from pathlib import Path

parent = Path(sys.argv[1]).resolve()
child = Path(sys.argv[2]).resolve()
relative = child.relative_to(parent)
print(relative.parts[0] if relative.parts else "")
PY
}

append_preserve_name() {
  local name="$1"
  local existing
  [[ -z "${name}" ]] && return 0
  for existing in "${PRESERVE_NAMES[@]}"; do
    [[ "${existing}" == "${name}" ]] && return 0
  done
  PRESERVE_NAMES+=("${name}")
}

protect_runtime_path() {
  local label="$1"
  local raw_path="$2"
  local mode="$3"
  local resolved_path
  local top_level_name

  [[ -z "${raw_path}" ]] && return 0

  resolved_path="$(canonicalize_path "${raw_path}")"
  [[ -z "${resolved_path}" ]] && return 0

  if [[ "$(path_is_same_or_within "${DEPLOY_DIR}" "${resolved_path}")" != "true" ]]; then
    return 0
  fi

  if [[ "${mode}" == "block" ]]; then
    err "${label} is inside DEPLOY_DIR and update is blocked to avoid overwriting user data: ${resolved_path}"
    exit 1
  fi

  top_level_name="$(top_level_child_name "${DEPLOY_DIR}" "${resolved_path}")"
  append_preserve_name "${top_level_name}"
  warn "${label} is inside DEPLOY_DIR and will be preserved in compatibility mode: ${resolved_path}"
}

build_preserve_names() {
  local resolved_deploy_dir
  local default_upload_dir

  resolved_deploy_dir="$(canonicalize_path "${DEPLOY_DIR}")"
  DEPLOY_DIR="${resolved_deploy_dir}"

  if [[ -n "${HERMES_WEB_UI_HOME}" ]]; then
    HERMES_WEB_UI_HOME="$(canonicalize_path "${HERMES_WEB_UI_HOME}")"
  fi
  if [[ -n "${HERMES_HOME_DIR}" ]]; then
    HERMES_HOME_DIR="$(canonicalize_path "${HERMES_HOME_DIR}")"
    HERMES_HOME="${HERMES_HOME_DIR}"
  fi
  if [[ -z "${UPLOAD_DIR}" && -n "${HERMES_WEB_UI_HOME}" ]]; then
    default_upload_dir="${HERMES_WEB_UI_HOME}/upload"
    UPLOAD_DIR="${default_upload_dir}"
  elif [[ -n "${UPLOAD_DIR}" ]]; then
    UPLOAD_DIR="$(canonicalize_path "${UPLOAD_DIR}")"
  fi

  protect_runtime_path "Web UI data directory" "${HERMES_WEB_UI_HOME}" "block"
  protect_runtime_path "Upload directory" "${UPLOAD_DIR}" "block"
  protect_runtime_path "Hermes data directory" "${HERMES_HOME_DIR}" "warn"

  info "Preserving top-level entries during source sync: ${PRESERVE_NAMES[*]}"
}

parse_args() {
  TARGET_VERSION="${HERMES_WEB_UI_UPDATE_VERSION:-}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        TARGET_VERSION="${2:-}"
        shift 2
        ;;
      *)
        err "Unknown argument: $1"
        exit 1
        ;;
    esac
  done

  if [[ -z "${TARGET_VERSION}" ]]; then
    err "Missing target version. Pass --version <x.y.z>."
    exit 1
  fi
  if [[ "${TARGET_VERSION}" == v* ]]; then
    TARGET_TAG="${TARGET_VERSION}"
  else
    TARGET_TAG="v${TARGET_VERSION}"
  fi
}

resolve_repo_url() {
  if [[ -n "${WEBUI_UPDATE_REPO:-}" ]]; then
    printf '%s\n' "${WEBUI_UPDATE_REPO}"
    return 0
  fi
  if [[ ! -f "${DEPLOY_DIR}/package.json" ]]; then
    return 1
  fi

  python3 - "${DEPLOY_DIR}/package.json" <<'PY'
import json
import sys
from pathlib import Path

package_path = Path(sys.argv[1])
data = json.loads(package_path.read_text(encoding='utf-8'))
repository = data.get('repository', '')
if isinstance(repository, dict):
    repository = repository.get('url', '')
repository = str(repository).strip().removeprefix('git+')
if repository.endswith('.git'):
    repository = repository[:-4]
print(repository)
PY
}

download_file() {
  local output="$1"
  shift
  local url
  for url in "$@"; do
    if [[ -z "${url}" ]]; then
      continue
    fi
    info "Downloading ${url}"
    if curl -fsSL --retry 4 --retry-delay 2 --connect-timeout 15 --max-time 300 "${url}" -o "${output}"; then
      return 0
    fi
  done
  return 1
}

get_codeload_tag_url() {
  local repo_url="$1"
  if [[ "${repo_url}" =~ ^https://github\.com/([^/]+)/([^/]+)$ ]]; then
    printf 'https://codeload.github.com/%s/%s/tar.gz/refs/tags/%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${TARGET_TAG}"
    return 0
  fi
  return 1
}

verify_source_archive_checksum() {
  local archive_path="$1"
  local expected_sha="$2"
  if [[ -z "${expected_sha}" ]]; then
    return 0
  fi
  if [[ ! -f "${archive_path}" ]]; then
    return 1
  fi
  local actual_sha
  actual_sha="$(sha256sum "${archive_path}" | awk '{print $1}')"
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    err "Source archive checksum mismatch: expected ${expected_sha}, got ${actual_sha}"
    return 1
  fi
  info "Source archive checksum verified: ${actual_sha}"
  return 0
}

resolve_source_archive_urls() {
  local urls=()
  local raw="${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS:-}"
  if [[ -n "${raw}" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      while IFS= read -r url; do
        if [[ -n "${url}" ]]; then urls+=("${url}"); fi
      done < <(python3 -c "import json,sys; data=sys.argv[1]; items=json.loads(data) if data else []; [print(str(u)) for u in items if u]" "${raw}")
    fi
  fi
  if [[ ${#urls[@]} -eq 0 && -n "${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL:-}" ]]; then
    urls+=("${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL}")
  fi
  printf '%s\n' "${urls[@]}"
}

download_source_archive() {
  TMP_DIR="$(mktemp -d)"
  ARCHIVE_PATH="${TMP_DIR}/source.tar.gz"
  local expected_sha="${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256:-}"
  local source_repo_fallback="${HERMES_WEB_UI_UPDATE_SOURCE_REPO_URL:-}"

  mapfile -t SOURCE_URLS < <(resolve_source_archive_urls || true)
  if [[ ${#SOURCE_URLS[@]} -gt 0 ]]; then
    info "Resolving source archive from manifest URLs (count=${#SOURCE_URLS[@]})"
    if download_file "${ARCHIVE_PATH}" "${SOURCE_URLS[@]}"; then
      if verify_source_archive_checksum "${ARCHIVE_PATH}" "${expected_sha}"; then
        SOURCE_DIR_FROM_MANIFEST=1
        return 0
      fi
      err "Manifest URL source archive failed checksum verification."
      rm -f "${ARCHIVE_PATH}"
    else
      err "All manifest source URLs failed: ${SOURCE_URLS[*]}"
    fi
  fi

  local repo_url="${source_repo_fallback}"
  if [[ -z "${repo_url}" ]]; then
    repo_url="$(resolve_repo_url || true)"
  fi
  if [[ -z "${repo_url}" ]]; then
    err "Could not resolve source repository. Set HERMES_WEB_UI_UPDATE_SOURCE_REPO_URL or WEBUI_UPDATE_REPO."
    exit 1
  fi

  info "Falling back to git repository source archive: ${repo_url}"
  local archive_url codeload_url
  archive_url="${repo_url%/}/archive/refs/tags/${TARGET_TAG}.tar.gz"
  codeload_url="$(get_codeload_tag_url "${repo_url}" || true)"
  if ! download_file "${ARCHIVE_PATH}" "${archive_url}" "${codeload_url}"; then
    err "Failed to download source archive for ${TARGET_TAG}."
    exit 1
  fi
  if [[ -n "${expected_sha}" ]]; then
    warn "Source SHA256 from manifest cannot be verified against git fallback archive (no manifest bytes)."
  fi
  SOURCE_DIR_FROM_MANIFEST=0
}

extract_source_archive() {
  tar -xzf "${ARCHIVE_PATH}" -C "${TMP_DIR}"
  SOURCE_DIR="$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "${SOURCE_DIR}" || ! -f "${SOURCE_DIR}/package.json" || ! -f "${SOURCE_DIR}/scripts/deploy-source-armbian.sh" ]]; then
    err "Downloaded archive is not a valid hermes-web-ui source tree."
    exit 1
  fi
}

sync_source_tree() {
  local -a find_args
  local preserve_name
  mkdir -p "${DEPLOY_DIR}"
  info "Syncing source tree into ${DEPLOY_DIR}"
  find_args=("${DEPLOY_DIR}" -mindepth 1 -maxdepth 1)
  for preserve_name in "${PRESERVE_NAMES[@]}"; do
    find_args+=('!' -name "${preserve_name}")
  done
  find_args+=(-exec rm -rf {} +)
  find "${find_args[@]}"
  tar -C "${SOURCE_DIR}" -cf - . | tar -C "${DEPLOY_DIR}" -xf -
  # tar|x|tar through a FIFO can lose mode bits; Windows git checkouts often
  # record scripts as 100644. Restore +x on deployed scripts before systemd
  # sees them (ExecStartPre 203/EXEC is the failure this prevents).
  fixup_script_modes "${DEPLOY_DIR}"
}

run_deploy_script() {
  info "Running deploy-source-armbian.sh in update-only mode"
  # Suppress outer ERR trap so that failures inside deploy-source-armbian.sh
  # are reported with their own exit code and message, not with the caller
  # line number (which would be misleading — see Bug 3 in v0.7.5 fix).
  set +e
  trap - ERR
  env \
    DEPLOY_UPDATE_ONLY=true \
    DEPLOY_DIR="${DEPLOY_DIR}" \
    APP_USER="${APP_USER}" \
    PORT="${PORT}" \
    SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME}" \
    SERVICE_ENV_FILE="${SERVICE_ENV_FILE}" \
    HERMES_HOME_DIR="${HERMES_HOME_DIR}" \
    HERMES_HOME="${HERMES_HOME:-${HERMES_HOME_DIR}}" \
    HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-}" \
    HERMES_WEBUI_STATE_DIR="${HERMES_WEB_UI_HOME:-}" \
    UPLOAD_DIR="${UPLOAD_DIR:-}" \
    WEBUI_UPDATE_ENABLED="${WEBUI_UPDATE_ENABLED:-}" \
    WEBUI_UPDATE_PACKAGE="${WEBUI_UPDATE_PACKAGE:-}" \
    WEBUI_UPDATE_REGISTRY="${WEBUI_UPDATE_REGISTRY:-}" \
    WEBUI_UPDATE_CLI_BIN="${WEBUI_UPDATE_CLI_BIN:-}" \
    WEBUI_UPDATE_SOURCE_LABEL="${WEBUI_UPDATE_SOURCE_LABEL:-}" \
    WEBUI_UPDATE_DIST_TAG="${WEBUI_UPDATE_DIST_TAG:-}" \
    WEBUI_UPDATE_STRATEGY="${WEBUI_UPDATE_STRATEGY:-}" \
    WEBUI_UPDATE_SCRIPT="${WEBUI_UPDATE_SCRIPT:-}" \
    WEBUI_UPDATE_REPO="${WEBUI_UPDATE_REPO:-}" \
    WEBUI_UPDATE_MANIFEST_URL="${WEBUI_UPDATE_MANIFEST_URL:-}" \
    WEBUI_UPDATE_MANIFEST_URLS="${WEBUI_UPDATE_MANIFEST_URLS:-}" \
    WEBUI_UPDATE_MANIFEST_BASE_URL="${WEBUI_UPDATE_MANIFEST_BASE_URL:-}" \
    WEBUI_UPDATE_MANIFEST_BASE_URLS="${WEBUI_UPDATE_MANIFEST_BASE_URLS:-}" \
    HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-}" \
    HERMES_AGENT_WHEELHOUSE_URL="${HERMES_AGENT_WHEELHOUSE_URL:-}" \
    HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-}" \
    HERMES_AGENT_UPDATE_MANIFEST_URL="${HERMES_AGENT_UPDATE_MANIFEST_URL:-}" \
    HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}" \
    bash "${DEPLOY_DIR}/scripts/deploy-source-armbian.sh"
  deploy_rc=$?
  set -e
  trap 'handle_failure "${LINENO}"' ERR
  if [[ ${deploy_rc} -ne 0 ]]; then
    err "deploy-source-armbian.sh exited with code ${deploy_rc}"
    handle_failure "${LINENO}"
  fi
}

run_hermes_agent_update() {
  info "Upgrading Hermes Agent to the latest stable release before syncing Web UI"
  env \
    DEPLOY_HERMES_AGENT_ONLY=true \
    DEPLOY_USE_CONFIGURED_DIR=true \
    DEPLOY_DIR="${DEPLOY_DIR}" \
    APP_USER="${APP_USER}" \
    PORT="${PORT}" \
    SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME}" \
    SERVICE_ENV_FILE="${SERVICE_ENV_FILE}" \
    HERMES_HOME_DIR="${HERMES_HOME_DIR}" \
    HERMES_HOME="${HERMES_HOME:-${HERMES_HOME_DIR}}" \
    HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-}" \
    HERMES_WEBUI_STATE_DIR="${HERMES_WEB_UI_HOME:-}" \
    UPLOAD_DIR="${UPLOAD_DIR:-}" \
    HERMES_AGENT_UPDATE_LATEST_STABLE=true \
    HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-}" \
    HERMES_AGENT_WHEELHOUSE_URL="${HERMES_AGENT_WHEELHOUSE_URL:-}" \
    HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-}" \
    HERMES_AGENT_UPDATE_MANIFEST_URL="${HERMES_AGENT_UPDATE_MANIFEST_URL:-}" \
    HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}" \
    bash "${SOURCE_DIR}/scripts/deploy-source-armbian.sh"
}

run_healthcheck() {
  local phase_label="$1"

  if [[ -z "${HEALTHCHECK_URL}" ]]; then
    warn "Skipping ${phase_label} health check because HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL is not configured."
    return 0
  fi

  info "Waiting ${HEALTHCHECK_INITIAL_DELAY_MS}ms before ${phase_label} health checks: ${HEALTHCHECK_URL}"
  sleep "$(millis_to_sleep "${HEALTHCHECK_INITIAL_DELAY_MS}")"

  python3 - "${HEALTHCHECK_URL}" "${HEALTHCHECK_TIMEOUT_MS}" "${HEALTHCHECK_INTERVAL_MS}" "${HEALTHCHECK_RETRIES}" "${phase_label}" <<'PY'
import sys
import time
import urllib.error
import urllib.request

url, timeout_ms, interval_ms, retries, phase = sys.argv[1:6]
timeout = max(int(timeout_ms), 1) / 1000
interval = max(int(interval_ms), 1) / 1000
attempts = max(int(retries), 1)
last_error = ""

for attempt in range(1, attempts + 1):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            if 200 <= status < 400:
                print(f"[INFO] {phase} health check passed on attempt {attempt}: HTTP {status}")
                raise SystemExit(0)
            last_error = f"HTTP {status}"
    except Exception as exc:
        last_error = str(exc)
    print(f"[WARN] {phase} health check attempt {attempt}/{attempts} failed: {last_error}", file=sys.stderr)
    if attempt < attempts:
        time.sleep(interval)

print(f"[ERROR] {phase} health check failed after {attempts} attempts: {last_error}", file=sys.stderr)
raise SystemExit(1)
PY
}

if is_truthy "${INCLUDE_AGENT_UPGRADE_RAW}"; then
  INCLUDE_AGENT_UPGRADE=true
else
  INCLUDE_AGENT_UPGRADE=false
fi

ensure_root "$@"
parse_args "$@"
init_logging
mkdir -p "$(dirname "${LOG_FILE}")"
exec >>"${LOG_FILE}" 2>&1

info "Starting source deployment update"
build_preserve_names
update_task_stage "downloading" "Downloading source deployment archive ${TARGET_TAG}"
download_source_archive
extract_source_archive
update_task_stage "installing" "Syncing source tree for ${TARGET_VERSION}"
sync_source_tree
# Upgrade Hermes Agent only after the Web UI source tree is in place, so a
# failed agent upgrade never blocks the Web UI update itself (best-effort).
if [[ "${INCLUDE_AGENT_UPGRADE}" == "true" ]]; then
  update_task_stage "starting_runtime" "Upgrading Hermes Agent after syncing Web UI"
  if ! run_hermes_agent_update; then
    warn "Hermes Agent upgrade failed; web UI update continues without it"
  fi
else
  info "Skipping Hermes Agent upgrade for this source deployment update"
fi
update_task_stage "restarting" "Rebuilding and restarting services for ${TARGET_VERSION}"
run_deploy_script
update_task_stage "health_checking" "Running health check for ${TARGET_VERSION}"
if ! run_healthcheck "update"; then
  finish_task_failed \
    "Source deployment update failed during health check for ${TARGET_VERSION}" \
    "Health check did not pass after source deployment update: ${HEALTHCHECK_URL:-<unconfigured>}"
  err "Source deployment update aborted due to failed health check."
  exit 1
fi
finish_task_succeeded "Source deployment update completed for ${TARGET_VERSION}"
info "Source deployment update completed: ${TARGET_TAG}"
