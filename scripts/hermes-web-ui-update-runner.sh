#!/usr/bin/env bash
set -euo pipefail

info() { printf '[hermes-web-ui-update-runner] %s\n' "$*"; }
err() { printf '[hermes-web-ui-update-runner] ERROR: %s\n' "$*" >&2; }

if [[ "${EUID}" -ne 0 ]]; then
  err "This runner must execute as root."
  exit 1
fi

request_file="${WEBUI_UPDATE_RUNNER_REQUEST_FILE:-${HERMES_WEB_UI_HOME:-/home/hermesui/.hermes-web-ui}/updates/update-runner-request.json}"
tmp_env="$(mktemp)"

cleanup() {
  rm -f "${tmp_env}"
}
trap cleanup EXIT

if [[ ! -f "${request_file}" ]]; then
  err "Update request file not found: ${request_file}"
  exit 1
fi

python3 - "${request_file}" "${tmp_env}" <<'PY'
from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path

allowed_keys = {
    "APP_USER",
    "DEPLOY_DIR",
    "HERMES_HOME",
    "HERMES_HOME_DIR",
    "HERMES_WEB_UI_HOME",
    "HERMES_WEBUI_STATE_DIR",
    "UPLOAD_DIR",
    "HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES",
    "HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE",
    "HERMES_WEB_UI_UPDATE_VERSION",
    "HERMES_WEB_UI_UPDATE_PACKAGE",
    "HERMES_WEB_UI_UPDATE_REGISTRY",
    "HERMES_WEB_UI_UPDATE_DIST_TAG",
    "HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE",
    "HERMES_WEB_UI_UPDATE_STAGING_DIR",
    "HERMES_WEB_UI_UPDATE_BACKUP_DIR",
    "HERMES_WEB_UI_UPDATE_STATE_FILE",
    "HERMES_WEB_UI_UPDATE_LOG_DIR",
    "HERMES_WEB_UI_UPDATE_TASK_ID",
    "HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL",
    "HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS",
    "HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS",
    "HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES",
    "HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS",
    "HERMES_WEB_UI_UPDATE_EXPECTED_SHA256",
}

request_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
payload = json.loads(request_path.read_text(encoding="utf-8"))
if not isinstance(payload, dict):
    raise SystemExit("Update request must be a JSON object.")

strategy = payload.get("strategy")
if strategy not in {"source-deploy", "device-package"}:
    raise SystemExit(f"Unsupported update strategy: {strategy!r}")

env_payload = payload.get("env")
if not isinstance(env_payload, dict):
    raise SystemExit("Update request env must be a JSON object.")

lines = [f"export HERMES_WEB_UI_UPDATE_REQUEST_STRATEGY={shlex.quote(strategy)}"]
for key, value in env_payload.items():
    if key not in allowed_keys:
      raise SystemExit(f"Unsupported request key: {key}")
    if not isinstance(value, str):
      raise SystemExit(f"Unsupported request value for {key}: expected string.")
    lines.append(f"export {key}={shlex.quote(value)}")

output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

# shellcheck disable=SC1090
source "${tmp_env}"

repair_update_runtime_permissions() {
  local app_user app_group update_root state_file log_dir
  app_user="${APP_USER:-hermesui}"
  if ! id -u "${app_user}" >/dev/null 2>&1; then
    err "Configured app user does not exist: ${app_user}"
    exit 1
  fi

  app_group="$(id -gn "${app_user}")"
  state_file="${HERMES_WEB_UI_UPDATE_STATE_FILE:-${HERMES_WEB_UI_HOME:-/home/hermesui/.hermes-web-ui}/updates/update-task-state.json}"
  log_dir="${HERMES_WEB_UI_UPDATE_LOG_DIR:-${HERMES_WEB_UI_HOME:-/home/hermesui/.hermes-web-ui}/updates/logs}"
  update_root="$(dirname "${state_file}")"

  python3 - "${app_user}" "${app_group}" "${request_file}" "${update_root}" "${state_file}" "${log_dir}" <<'PY'
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

app_user, app_group, request_file, update_root, state_file, log_dir = sys.argv[1:7]


def ensure_directory(path_str: str) -> None:
    path = Path(path_str)
    path.mkdir(parents=True, exist_ok=True)
    repair_path(path, dir_mode=0o775, file_mode=0o664)


def repair_path(path: Path, dir_mode: int, file_mode: int) -> None:
    if not path.exists() and not path.is_symlink():
        return

    os.chown(path, uid, gid, follow_symlinks=False)
    if path.is_symlink():
        return

    if path.is_dir():
        path.chmod(dir_mode)
        for root, dirs, files in os.walk(path):
            root_path = Path(root)
            os.chown(root_path, uid, gid)
            root_path.chmod(dir_mode)
            for entry in dirs:
                dir_path = root_path / entry
                if dir_path.is_symlink():
                    os.chown(dir_path, uid, gid, follow_symlinks=False)
                    continue
                os.chown(dir_path, uid, gid)
                dir_path.chmod(dir_mode)
            for entry in files:
                file_path = root_path / entry
                os.chown(file_path, uid, gid, follow_symlinks=False)
                if file_path.is_symlink():
                    continue
                file_path.chmod(file_mode)
        return

    path.chmod(file_mode)


user_record = __import__("pwd").getpwnam(app_user)
uid = user_record.pw_uid
gid = user_record.pw_gid

ensure_directory(update_root)
ensure_directory(log_dir)
repair_path(Path(request_file), dir_mode=0o775, file_mode=0o664)
repair_path(Path(state_file), dir_mode=0o775, file_mode=0o664)
PY
}

repair_update_runtime_permissions
rm -f "${request_file}"

strategy="${HERMES_WEB_UI_UPDATE_REQUEST_STRATEGY}"
case "${strategy}" in
  source-deploy)
    script="${WEBUI_UPDATE_SCRIPT:-${DEPLOY_DIR}/scripts/update-source-deploy.sh}"
    if [[ -z "${HERMES_WEB_UI_UPDATE_VERSION:-}" ]]; then
      err "Missing HERMES_WEB_UI_UPDATE_VERSION for source deployment."
      exit 1
    fi
    info "Running source deployment update ${HERMES_WEB_UI_UPDATE_VERSION}"
    /bin/bash "${script}" --version "${HERMES_WEB_UI_UPDATE_VERSION}"
    ;;
  device-package)
    script="${WEBUI_UPDATE_INSTALLER_SCRIPT:-${DEPLOY_DIR}/scripts/install-device-package.sh}"
    if [[ -z "${HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE:-}" ]]; then
      err "Missing HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE for device package update."
      exit 1
    fi
    if [[ -z "${HERMES_WEB_UI_UPDATE_VERSION:-}" ]]; then
      err "Missing HERMES_WEB_UI_UPDATE_VERSION for device package update."
      exit 1
    fi
    info "Running device package update ${HERMES_WEB_UI_UPDATE_VERSION}"
    /bin/bash "${script}" --package "${HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE}" --version "${HERMES_WEB_UI_UPDATE_VERSION}"
    ;;
  *)
    err "Unsupported update strategy: ${strategy}"
    exit 1
    ;;
esac
