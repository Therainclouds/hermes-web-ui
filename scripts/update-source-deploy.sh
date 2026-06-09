#!/usr/bin/env bash
set -Eeuo pipefail

SELF_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
LOG_FILE="${HERMES_WEB_UI_UPDATE_LOG:-/var/log/hermes-web-ui-update.log}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
APP_USER="${APP_USER:-hermesui}"
PORT="${PORT:-6060}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui.service}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"
PRESERVE_NAMES=("hermes_data" ".git" ".runtime-hermes" ".runtime-home")

info() { printf '[update-source-deploy] %s\n' "$*"; }
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
  export DEPLOY_DIR APP_USER PORT SYSTEMD_SERVICE_NAME SERVICE_ENV_FILE HERMES_HOME_DIR
  export WEBUI_UPDATE_ENABLED WEBUI_UPDATE_PACKAGE WEBUI_UPDATE_REGISTRY WEBUI_UPDATE_CLI_BIN
  export WEBUI_UPDATE_SOURCE_LABEL WEBUI_UPDATE_DIST_TAG WEBUI_UPDATE_STRATEGY WEBUI_UPDATE_SCRIPT WEBUI_UPDATE_REPO
  export HERMES_WEB_UI_UPDATE_LOG="${LOG_FILE}"
  exec sudo -n \
    --preserve-env=DEPLOY_DIR,APP_USER,PORT,SYSTEMD_SERVICE_NAME,SERVICE_ENV_FILE,HERMES_HOME_DIR,WEBUI_UPDATE_ENABLED,WEBUI_UPDATE_PACKAGE,WEBUI_UPDATE_REGISTRY,WEBUI_UPDATE_CLI_BIN,WEBUI_UPDATE_SOURCE_LABEL,WEBUI_UPDATE_DIST_TAG,WEBUI_UPDATE_STRATEGY,WEBUI_UPDATE_SCRIPT,WEBUI_UPDATE_REPO,HERMES_WEB_UI_UPDATE_LOG,HERMES_WEB_UI_UPDATE_VERSION \
    /bin/bash "${SELF_PATH}" "$@"
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
  mkdir -p "${DEPLOY_DIR}"
  info "Syncing source tree into ${DEPLOY_DIR}"
  find "${DEPLOY_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name "${PRESERVE_NAMES[0]}" \
    ! -name "${PRESERVE_NAMES[1]}" \
    ! -name "${PRESERVE_NAMES[2]}" \
    ! -name "${PRESERVE_NAMES[3]}" \
    -exec rm -rf {} +
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
    WEBUI_UPDATE_ENABLED="${WEBUI_UPDATE_ENABLED:-}" \
    WEBUI_UPDATE_PACKAGE="${WEBUI_UPDATE_PACKAGE:-}" \
    WEBUI_UPDATE_REGISTRY="${WEBUI_UPDATE_REGISTRY:-}" \
    WEBUI_UPDATE_CLI_BIN="${WEBUI_UPDATE_CLI_BIN:-}" \
    WEBUI_UPDATE_SOURCE_LABEL="${WEBUI_UPDATE_SOURCE_LABEL:-}" \
    WEBUI_UPDATE_DIST_TAG="${WEBUI_UPDATE_DIST_TAG:-}" \
    WEBUI_UPDATE_STRATEGY="${WEBUI_UPDATE_STRATEGY:-}" \
    WEBUI_UPDATE_SCRIPT="${WEBUI_UPDATE_SCRIPT:-}" \
    WEBUI_UPDATE_REPO="${WEBUI_UPDATE_REPO:-}" \
    bash "${DEPLOY_DIR}/scripts/deploy-source-armbian.sh"
}

ensure_root "$@"
mkdir -p "$(dirname "${LOG_FILE}")"
exec >>"${LOG_FILE}" 2>&1

info "Starting source deployment update"
parse_args "$@"
download_source_archive
sync_source_tree
run_deploy_script
info "Source deployment update completed: ${TARGET_TAG}"
