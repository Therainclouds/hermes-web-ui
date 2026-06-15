#!/usr/bin/env bash
set -Eeuo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "${BLUE}[STEP]${NC} $*"; }

DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
PACKAGE_ARCHIVE="${HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE:-}"
TARGET_VERSION="${HERMES_WEB_UI_UPDATE_VERSION:-}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${HERMES_HOME:-}}"
HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-${HERMES_WEBUI_STATE_DIR:-}}"
UPLOAD_DIR="${UPLOAD_DIR:-}"
RUNTIME_HOME="${HERMES_WEB_UI_HOME:-${HOME:-/tmp}}"
STAGING_ROOT="${HERMES_WEB_UI_UPDATE_STAGING_DIR:-${RUNTIME_HOME}/updates/staging}"
BACKUP_ROOT="${HERMES_WEB_UI_UPDATE_BACKUP_DIR:-${RUNTIME_HOME}/updates/backups}"
UPDATE_STATE_FILE="${HERMES_WEB_UI_UPDATE_STATE_FILE:-${RUNTIME_HOME}/updates/update-task-state.json}"
UPDATE_LOG_DIR="${HERMES_WEB_UI_UPDATE_LOG_DIR:-${RUNTIME_HOME}/updates/logs}"
TASK_ID="${HERMES_WEB_UI_UPDATE_TASK_ID:-}"
HEALTHCHECK_URL="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL:-}"
HEALTHCHECK_TIMEOUT_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS:-2000}"
HEALTHCHECK_INTERVAL_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS:-2000}"
HEALTHCHECK_RETRIES="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES:-15}"
HEALTHCHECK_INITIAL_DELAY_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS:-5000}"
APP_USER="${APP_USER:-hermesui}"
PORT="${PORT:-8648}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
PRESERVE_NAMES=("hermes_data" ".git" ".runtime-hermes" ".runtime-home")
LOG_PATH=""
WORK_DIR=""
EXTRACT_DIR=""
SOURCE_DIR=""
BACKUP_DIR=""
ROLLBACK_READY=0
ROLLBACK_ATTEMPTED=0
BACKUP_RETENTION_COUNT="${HERMES_WEB_UI_UPDATE_BACKUP_RETENTION_COUNT:-2}"

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    err "This script requires root or sudo."
    exit 1
  fi
  SUDO=(sudo)
fi

run() {
  "${SUDO[@]}" "$@"
}

millis_to_sleep() {
  python3 - "$1" <<'PY'
import sys
milliseconds = max(int(sys.argv[1] or "0"), 0)
print(f"{milliseconds / 1000:.3f}")
PY
}

canonicalize_path() {
  python3 - "$1" <<'PY'
import sys
from pathlib import Path
print(Path(sys.argv[1]).resolve())
PY
}

path_is_same_or_within() {
  python3 - "$1" "$2" <<'PY'
import sys
from pathlib import Path

parent = Path(sys.argv[1]).resolve()
child = Path(sys.argv[2]).resolve()
try:
    child.relative_to(parent)
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
    err "${label} is inside DEPLOY_DIR and device package install is blocked: ${resolved_path}"
    exit 1
  fi

  top_level_name="$(top_level_child_name "${DEPLOY_DIR}" "${resolved_path}")"
  append_preserve_name "${top_level_name}"
  warn "${label} is inside DEPLOY_DIR and will be preserved in compatibility mode: ${resolved_path}"
}

ensure_workdir_outside_deploy() {
  local label="$1"
  local raw_path="$2"
  local resolved_path

  [[ -z "${raw_path}" ]] && return 0
  resolved_path="$(canonicalize_path "${raw_path}")"
  [[ -z "${resolved_path}" ]] && return 0

  if [[ "$(path_is_same_or_within "${DEPLOY_DIR}" "${resolved_path}")" == "true" ]]; then
    err "${label} must be outside DEPLOY_DIR for device package updates: ${resolved_path}"
    exit 1
  fi
}

init_logging() {
  local version_segment timestamp
  version_segment="${TARGET_VERSION//[^A-Za-z0-9._-]/_}"
  timestamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "${UPDATE_LOG_DIR}"
  if [[ -n "${TASK_ID}" ]]; then
    LOG_PATH="${UPDATE_LOG_DIR}/${TASK_ID}.log"
  else
    LOG_PATH="${UPDATE_LOG_DIR}/device-package-${version_segment}-${timestamp}.log"
  fi
  : > "${LOG_PATH}"
  exec >>"${LOG_PATH}" 2>&1
  info "Device package installer log: ${LOG_PATH}"
}

write_task_state() {
  local action="$1"
  local status="$2"
  local stage="$3"
  local message="$4"
  local error_message="${5:-}"
  local rollback_message="${6:-}"

  env \
    STATE_FILE="${UPDATE_STATE_FILE}" \
    TASK_ID="${TASK_ID}" \
    TARGET_VERSION="${TARGET_VERSION}" \
    LOG_PATH="${LOG_PATH}" \
    HEALTHCHECK_URL="${HEALTHCHECK_URL}" \
    APP_USER="${APP_USER}" \
    TASK_ACTION="${action}" \
    TASK_STATUS="${status}" \
    TASK_STAGE="${stage}" \
    TASK_MESSAGE="${message}" \
    TASK_ERROR="${error_message}" \
    TASK_ROLLBACK_MESSAGE="${rollback_message}" \
    python3 <<'PY'
import json
import os
import pwd
import tempfile
from datetime import datetime, timezone
from pathlib import Path

state_file = os.environ.get("STATE_FILE", "").strip()
task_id = os.environ.get("TASK_ID", "").strip()
if not state_file or not task_id:
    raise SystemExit(0)

path = Path(state_file)
data = {"currentTask": None, "lastTask": None}
if path.exists():
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            data["currentTask"] = payload.get("currentTask")
            data["lastTask"] = payload.get("lastTask")
    except Exception:
        data = {"currentTask": None, "lastTask": None}

record = data.get("currentTask")
if not isinstance(record, dict) or record.get("id") != task_id:
    last = data.get("lastTask")
    if isinstance(last, dict) and last.get("id") == task_id:
      record = dict(last)
    else:
      record = {
          "id": task_id,
          "strategy": "device-package",
          "status": "queued",
          "stage": "queued",
          "message": "",
          "targetVersion": "",
          "warning": "",
          "error": "",
          "logPath": "",
          "rollbackMessage": "",
          "healthcheckUrl": "",
          "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
          "finishedAt": None,
      }
else:
    record = dict(record)

record["strategy"] = "device-package"
record["status"] = os.environ.get("TASK_STATUS", record.get("status", "running"))
record["stage"] = os.environ.get("TASK_STAGE", record.get("stage", "installing"))
record["message"] = os.environ.get("TASK_MESSAGE", record.get("message", ""))
record["targetVersion"] = os.environ.get("TARGET_VERSION", record.get("targetVersion", ""))
record["error"] = os.environ.get("TASK_ERROR", record.get("error", ""))
record["rollbackMessage"] = os.environ.get("TASK_ROLLBACK_MESSAGE", record.get("rollbackMessage", ""))
record["logPath"] = os.environ.get("LOG_PATH", record.get("logPath", ""))
record["healthcheckUrl"] = os.environ.get("HEALTHCHECK_URL", record.get("healthcheckUrl", ""))

action = os.environ.get("TASK_ACTION", "patch")
if action == "finish":
    record["finishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    data["currentTask"] = None
    data["lastTask"] = record
else:
    record["finishedAt"] = None
    data["currentTask"] = record

app_user = os.environ.get("APP_USER", "").strip()
pw_record = None
if app_user:
    try:
        pw_record = pwd.getpwnam(app_user)
    except KeyError:
        pw_record = None

path.parent.mkdir(parents=True, exist_ok=True)
if pw_record is not None:
    os.chown(path.parent, pw_record.pw_uid, pw_record.pw_gid)
os.chmod(path.parent, 0o775)
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
tmp_path = Path(handle.name)
tmp_path.replace(path)

if pw_record is not None:
    os.chown(path, pw_record.pw_uid, pw_record.pw_gid)
os.chmod(path, 0o664)
PY
}

update_task_stage() {
  write_task_state patch running "$1" "$2"
}

finish_task_succeeded() {
  write_task_state finish succeeded succeeded "$1"
}

finish_task_failed() {
  write_task_state finish failed failed "$1" "${2:-$1}"
}

finish_task_rolled_back() {
  write_task_state finish failed rolled_back "$1" "${2:-$1}" "${3:-}"
}

backup_has_entries() {
  [[ -n "${BACKUP_DIR}" ]] && find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

cleanup_workdir() {
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}

prune_old_backups() {
  local retention_count="$1"
  local backup_root="$2"
  local entry
  local -a backups_to_remove

  [[ -d "${backup_root}" ]] || return 0
  if ! [[ "${retention_count}" =~ ^[0-9]+$ ]]; then
    warn "Ignoring invalid backup retention count: ${retention_count}"
    return 0
  fi

  mapfile -t backups_to_remove < <(
    find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -name 'last-known-good-*' -printf '%T@ %p\n' |
      sort -nr |
      awk -v keep="${retention_count}" 'NR > keep { sub(/^[^ ]+ /, "", $0); print }'
  )

  for entry in "${backups_to_remove[@]}"; do
    [[ -n "${entry}" ]] || continue
    run rm -rf "${entry}"
    info "Removed old device package backup: ${entry}"
  done
}

clear_deploy_tree_except_preserved() {
  local -a find_args
  local preserve_name
  find_args=("${DEPLOY_DIR}" -mindepth 1 -maxdepth 1)
  for preserve_name in "${PRESERVE_NAMES[@]}"; do
    find_args+=('!' -name "${preserve_name}")
  done
  find_args+=(-exec rm -rf {} +)
  run find "${find_args[@]}"
}

restore_backup_tree() {
  step "Restore previous deploy tree"
  clear_deploy_tree_except_preserved
  if backup_has_entries; then
    run tar -C "${BACKUP_DIR}" -cf - . | tar -C "${DEPLOY_DIR}" -xf -
  fi
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

rollback_from_backup() {
  local failure_reason="$1"
  local rollback_message

  ROLLBACK_ATTEMPTED=1
  rollback_message="Restored previous deploy from ${BACKUP_DIR} after update failure: ${failure_reason}"
  warn "Starting rollback because update failed: ${failure_reason}"

  update_task_stage "health_checking" "Update failed, rolling back to the previous deploy"
  if ! restore_backup_tree; then
    finish_task_failed "Device package update failed and rollback restore did not complete" "${failure_reason}"
    return 1
  fi

  update_task_stage "restarting" "Restarting services after rollback"
  if ! run_deploy_script; then
    finish_task_failed "Device package update failed and rollback restart did not complete" "${failure_reason}"
    return 1
  fi

  update_task_stage "health_checking" "Verifying restored deploy after rollback"
  if ! run_healthcheck "rollback"; then
    finish_task_failed "Device package update failed and rollback health check did not pass" "${failure_reason}"
    return 1
  fi

  finish_task_rolled_back "Device package update failed and was rolled back" "${failure_reason}" "${rollback_message}"
  warn "Rollback completed: ${rollback_message}"
  return 0
}

on_error() {
  local exit_code="$1"
  local line_no="$2"
  local command="$3"
  local failure_reason

  trap - ERR
  set +e
  failure_reason="Device package install failed at line ${line_no}: ${command}"
  err "${failure_reason}"

  if [[ "${ROLLBACK_READY}" == "1" && "${ROLLBACK_ATTEMPTED}" != "1" ]]; then
    rollback_from_backup "${failure_reason}"
    exit "${exit_code}"
  fi

  finish_task_failed "Device package update failed" "${failure_reason}"
  exit "${exit_code}"
}

build_preserve_names() {
  DEPLOY_DIR="$(canonicalize_path "${DEPLOY_DIR}")"
  [[ -n "${HERMES_WEB_UI_HOME}" ]] && HERMES_WEB_UI_HOME="$(canonicalize_path "${HERMES_WEB_UI_HOME}")"
  [[ -n "${HERMES_HOME_DIR}" ]] && HERMES_HOME_DIR="$(canonicalize_path "${HERMES_HOME_DIR}")"
  if [[ -z "${UPLOAD_DIR}" && -n "${HERMES_WEB_UI_HOME}" ]]; then
    UPLOAD_DIR="${HERMES_WEB_UI_HOME}/upload"
  elif [[ -n "${UPLOAD_DIR}" ]]; then
    UPLOAD_DIR="$(canonicalize_path "${UPLOAD_DIR}")"
  fi
  [[ -n "${STAGING_ROOT}" ]] && STAGING_ROOT="$(canonicalize_path "${STAGING_ROOT}")"
  [[ -n "${BACKUP_ROOT}" ]] && BACKUP_ROOT="$(canonicalize_path "${BACKUP_ROOT}")"

  protect_runtime_path "Web UI data directory" "${HERMES_WEB_UI_HOME}" "block"
  protect_runtime_path "Upload directory" "${UPLOAD_DIR}" "block"
  protect_runtime_path "Hermes data directory" "${HERMES_HOME_DIR}" "warn"
  ensure_workdir_outside_deploy "Device package staging directory" "${STAGING_ROOT}"
  ensure_workdir_outside_deploy "Device package backup directory" "${BACKUP_ROOT}"
  info "Preserving top-level entries during install: ${PRESERVE_NAMES[*]}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --package)
        PACKAGE_ARCHIVE="${2:-}"
        shift 2
        ;;
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

  if [[ -z "${PACKAGE_ARCHIVE}" ]]; then
    err "Missing --package <archive>."
    exit 1
  fi
  if [[ -z "${TARGET_VERSION}" ]]; then
    err "Missing --version <x.y.z>."
    exit 1
  fi
  if [[ ! -f "${PACKAGE_ARCHIVE}" ]]; then
    err "Device package archive does not exist: ${PACKAGE_ARCHIVE}"
    exit 1
  fi
}

prepare_workdirs() {
  local version_segment timestamp
  version_segment="${TARGET_VERSION//[^A-Za-z0-9._-]/_}"
  timestamp="$(date +%Y%m%d-%H%M%S)"

  run mkdir -p "${STAGING_ROOT}" "${BACKUP_ROOT}" "${DEPLOY_DIR}"
  WORK_DIR="$(mktemp -d "${STAGING_ROOT}/device-package-${version_segment}-${timestamp}-XXXXXX")"
  EXTRACT_DIR="${WORK_DIR}/extract"
  BACKUP_DIR="${BACKUP_ROOT}/last-known-good-${version_segment}-${timestamp}"
  run mkdir -p "${EXTRACT_DIR}" "${BACKUP_DIR}"
}

resolve_extracted_root() {
  local direct_root
  direct_root="${EXTRACT_DIR}"
  if [[ -f "${direct_root}/package.json" && -f "${direct_root}/scripts/deploy-source-armbian.sh" ]]; then
    SOURCE_DIR="${direct_root}"
    return 0
  fi

  SOURCE_DIR="$(find "${EXTRACT_DIR}" -mindepth 1 -maxdepth 2 -type f -name package.json -printf '%h\n' | head -n 1)"
  if [[ -z "${SOURCE_DIR}" || ! -f "${SOURCE_DIR}/scripts/deploy-source-armbian.sh" ]]; then
    err "Device package archive is not a valid hermes-web-ui package."
    exit 1
  fi
}

extract_package() {
  step "Extract device package"
  run tar -xzf "${PACKAGE_ARCHIVE}" -C "${EXTRACT_DIR}"
  resolve_extracted_root
  [[ -d "${SOURCE_DIR}/dist" ]] || { err "Device package is missing dist/."; exit 1; }
  [[ -f "${SOURCE_DIR}/package.json" ]] || { err "Device package is missing package.json."; exit 1; }
}

backup_current_deploy() {
  local entry_name
  local entry_path
  step "Backup current deploy tree"
  shopt -s dotglob nullglob
  for entry_path in "${DEPLOY_DIR}"/*; do
    entry_name="$(basename "${entry_path}")"
    if [[ ! -e "${entry_path}" ]]; then
      continue
    fi
    if printf '%s\n' "${PRESERVE_NAMES[@]}" | grep -Fxq "${entry_name}"; then
      continue
    fi
    run cp -a "${entry_path}" "${BACKUP_DIR}/"
  done
  shopt -u dotglob nullglob
  info "Program backup created at ${BACKUP_DIR}"
}

sync_package_tree() {
  local -a find_args
  local preserve_name
  step "Replace deploy tree with extracted package"
  find_args=("${DEPLOY_DIR}" -mindepth 1 -maxdepth 1)
  for preserve_name in "${PRESERVE_NAMES[@]}"; do
    find_args+=('!' -name "${preserve_name}")
  done
  find_args+=(-exec rm -rf {} +)
  run find "${find_args[@]}"
  run tar -C "${SOURCE_DIR}" -cf - . | tar -C "${DEPLOY_DIR}" -xf -
}

run_deploy_script() {
  step "Run deploy-source-armbian.sh update-only"
  env \
    DEPLOY_UPDATE_ONLY=true \
    DEPLOY_DIR="${DEPLOY_DIR}" \
    APP_USER="${APP_USER}" \
    PORT="${PORT}" \
    SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME}" \
    SERVICE_ENV_FILE="${SERVICE_ENV_FILE}" \
    HERMES_HOME_DIR="${HERMES_HOME_DIR}" \
    HERMES_HOME="${HERMES_HOME_DIR}" \
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
    WEBUI_UPDATE_MANIFEST_URL="${WEBUI_UPDATE_MANIFEST_URL:-}" \
    WEBUI_UPDATE_MANIFEST_BASE_URL="${WEBUI_UPDATE_MANIFEST_BASE_URL:-}" \
    WEBUI_UPDATE_CHANNEL="${WEBUI_UPDATE_CHANNEL:-}" \
    WEBUI_UPDATE_PACKAGE_TYPE="${WEBUI_UPDATE_PACKAGE_TYPE:-}" \
    HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-}" \
    HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-}" \
    HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}" \
    bash "${DEPLOY_DIR}/scripts/deploy-source-armbian.sh"
}

run_hermes_agent_update() {
  step "Upgrade Hermes Agent before replacing the Web UI package"
  env \
    DEPLOY_HERMES_AGENT_ONLY=true \
    DEPLOY_USE_CONFIGURED_DIR=true \
    DEPLOY_DIR="${DEPLOY_DIR}" \
    APP_USER="${APP_USER}" \
    PORT="${PORT}" \
    SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME}" \
    SERVICE_ENV_FILE="${SERVICE_ENV_FILE}" \
    HERMES_HOME_DIR="${HERMES_HOME_DIR}" \
    HERMES_HOME="${HERMES_HOME_DIR}" \
    HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-}" \
    HERMES_WEBUI_STATE_DIR="${HERMES_WEB_UI_HOME:-}" \
    UPLOAD_DIR="${UPLOAD_DIR:-}" \
    HERMES_AGENT_UPDATE_LATEST_STABLE=true \
    HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-}" \
    HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-}" \
    HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}" \
    bash "${SOURCE_DIR}/scripts/deploy-source-armbian.sh"
}

main() {
  parse_args "$@"
  init_logging
  trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
  trap cleanup_workdir EXIT
  build_preserve_names
  prepare_workdirs
  extract_package
  update_task_stage "updating_runtime" "Upgrading Hermes Agent before applying ${TARGET_VERSION}"
  run_hermes_agent_update
  update_task_stage "backing_up" "Creating program backup for ${TARGET_VERSION}"
  backup_current_deploy
  prune_old_backups "${BACKUP_RETENTION_COUNT}" "${BACKUP_ROOT}"
  if backup_has_entries; then
    ROLLBACK_READY=1
  else
    warn "Current deploy backup is empty; automatic rollback will be unavailable for this run."
  fi
  update_task_stage "installing" "Replacing deploy tree with device package ${TARGET_VERSION}"
  sync_package_tree
  update_task_stage "restarting" "Rebuilding and restarting services for ${TARGET_VERSION}"
  run_deploy_script
  update_task_stage "health_checking" "Running health check for ${TARGET_VERSION}"
  run_healthcheck "update"
  finish_task_succeeded "Device package update completed for ${TARGET_VERSION}"
  info "Device package install completed: ${TARGET_VERSION}"
}

main "$@"
