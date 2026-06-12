#!/usr/bin/env bash
set -Eeuo pipefail

SELF_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
LOG_FILE="${HERMES_WEB_UI_UPDATE_LOG:-/var/log/hermes-web-ui-update.log}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
APP_USER="${APP_USER:-hermesui}"
PORT="${PORT:-6060}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui.service}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${HERMES_HOME:-${DEPLOY_DIR}/hermes_data}}"
HERMES_WEB_UI_HOME="${HERMES_WEB_UI_HOME:-${HERMES_WEBUI_STATE_DIR:-}}"
UPLOAD_DIR="${UPLOAD_DIR:-}"
PRESERVE_NAMES=("hermes_data" ".git" ".runtime-hermes" ".runtime-home")

info() { printf '[update-source-deploy] %s\n' "$*"; }
warn() { printf '[update-source-deploy] WARNING: %s\n' "$*"; }
err() { printf '[update-source-deploy] ERROR: %s\n' "$*" >&2; }

cleanup() {
  if [[ -n "${TMP_DIR:-}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

ensure_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    err "sudo is required for source deployment updates."
    exit 1
  fi
  export DEPLOY_DIR APP_USER PORT SYSTEMD_SERVICE_NAME SERVICE_ENV_FILE HERMES_HOME_DIR HERMES_HOME HERMES_WEB_UI_HOME HERMES_WEBUI_STATE_DIR UPLOAD_DIR
  export WEBUI_UPDATE_ENABLED WEBUI_UPDATE_PACKAGE WEBUI_UPDATE_REGISTRY WEBUI_UPDATE_CLI_BIN
  export WEBUI_UPDATE_SOURCE_LABEL WEBUI_UPDATE_DIST_TAG WEBUI_UPDATE_STRATEGY WEBUI_UPDATE_SCRIPT WEBUI_UPDATE_REPO
  export HERMES_AGENT_WHEEL_URL HERMES_AGENT_RELEASES_API_URL HERMES_ANTHROPIC_VERSION
  export HERMES_WEB_UI_UPDATE_LOG="${LOG_FILE}"
  exec sudo -n \
    --preserve-env=DEPLOY_DIR,APP_USER,PORT,SYSTEMD_SERVICE_NAME,SERVICE_ENV_FILE,HERMES_HOME_DIR,HERMES_HOME,HERMES_WEB_UI_HOME,HERMES_WEBUI_STATE_DIR,UPLOAD_DIR,WEBUI_UPDATE_ENABLED,WEBUI_UPDATE_PACKAGE,WEBUI_UPDATE_REGISTRY,WEBUI_UPDATE_CLI_BIN,WEBUI_UPDATE_SOURCE_LABEL,WEBUI_UPDATE_DIST_TAG,WEBUI_UPDATE_STRATEGY,WEBUI_UPDATE_SCRIPT,WEBUI_UPDATE_REPO,HERMES_AGENT_WHEEL_URL,HERMES_AGENT_RELEASES_API_URL,HERMES_ANTHROPIC_VERSION,HERMES_WEB_UI_UPDATE_LOG,HERMES_WEB_UI_UPDATE_VERSION \
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

download_source_archive() {
  REPO_URL="$(resolve_repo_url || true)"
  if [[ -z "${REPO_URL}" ]]; then
    err "Could not resolve WEBUI_UPDATE_REPO. Set WEBUI_UPDATE_REPO in the service environment."
    exit 1
  fi

  TMP_DIR="$(mktemp -d)"
  ARCHIVE_PATH="${TMP_DIR}/source.tar.gz"
  local archive_url codeload_url
  archive_url="${REPO_URL%/}/archive/refs/tags/${TARGET_TAG}.tar.gz"
  codeload_url="$(get_codeload_tag_url "${REPO_URL}" || true)"
  if ! download_file "${ARCHIVE_PATH}" "${archive_url}" "${codeload_url}"; then
    err "Failed to download source archive for ${TARGET_TAG}."
    exit 1
  fi
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
}

run_deploy_script() {
  info "Running deploy-source-armbian.sh in update-only mode"
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
    HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-}" \
    HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-}" \
    HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}" \
    bash "${DEPLOY_DIR}/scripts/deploy-source-armbian.sh"
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
    HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-}" \
    HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}" \
    bash "${SOURCE_DIR}/scripts/deploy-source-armbian.sh"
}

ensure_root "$@"
mkdir -p "$(dirname "${LOG_FILE}")"
exec >>"${LOG_FILE}" 2>&1

info "Starting source deployment update"
parse_args "$@"
build_preserve_names
download_source_archive
run_hermes_agent_update
sync_source_tree
run_deploy_script
info "Source deployment update completed: ${TARGET_TAG}"
