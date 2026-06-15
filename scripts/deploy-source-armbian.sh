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

trap 'err "Source deployment failed at line: $LINENO"' ERR

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

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_safe_env_value() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    err "Environment variable ${name} contains an invalid newline."
    exit 1
  fi
}

run_as_app_user() {
  local command="$1"
  shift || true

  if [[ ${#SUDO[@]} -eq 0 ]]; then
    env HOME="${APP_USER_HOME}" "$@" runuser -u "${APP_USER}" -- bash -lc "$command"
    return
  fi

  sudo -u "${APP_USER}" -H env HOME="${APP_USER_HOME}" "$@" bash -lc "$command"
}

is_clock_synchronized() {
  if ! command_exists timedatectl; then
    return 1
  fi

  local value
  value="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  [[ "$value" == "yes" ]]
}

try_sync_clock() {
  if ! command_exists timedatectl; then
    warn "timedatectl is not available. Skipping clock sync check."
    return 1
  fi

  step "Check clock sync status"
  if is_clock_synchronized; then
    info "System clock is synchronized."
    return 0
  fi

  warn "System clock is not synchronized yet. Enabling NTP and waiting."
  run timedatectl set-ntp true || true
  if command_exists systemctl; then
    run systemctl restart systemd-timesyncd || true
  fi

  local i
  for i in 1 2 3 4 5; do
    sleep 3
    if is_clock_synchronized; then
      info "System clock synchronized successfully."
      return 0
    fi
  done

  warn "System clock is still not synchronized. apt update will retry with date checks disabled."
  return 1
}

apt_update() {
  if run apt-get update -y; then
    return 0
  fi

  warn "apt-get update failed. Retrying after clock synchronization."
  try_sync_clock || true

  if run apt-get update -y; then
    return 0
  fi

  warn "apt-get update still failed after clock sync. Retrying with Acquire::Check-Date=false."
  run apt-get -o Acquire::Check-Date=false update -y
}

require_debian_like() {
  if [[ ! -r /etc/os-release ]]; then
    err "Cannot read /etc/os-release. This system is not supported."
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  local id_like_value="${ID_LIKE:-}"
  local id_value="${ID:-}"
  if [[ "${id_value}" != "ubuntu" && "${id_value}" != "debian" && "${id_like_value}" != *"debian"* ]]; then
    err "This script supports only Debian, Ubuntu, or Armbian-like systems."
    echo "Detected: ID=${id_value:-unknown}, ID_LIKE=${id_like_value:-unknown}"
    exit 1
  fi

  info "Detected supported system: ${PRETTY_NAME:-unknown}"
}

require_supported_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64)
      NODE_ARCH="arm64"
      info "Detected supported architecture: $arch"
      ;;
    x86_64|amd64)
      NODE_ARCH="x64"
      info "Detected supported architecture: $arch"
      ;;
    *)
      err "Unsupported or unverified architecture: $arch"
      err "Use an arm64/aarch64 or amd64/x86_64 device."
      exit 1
      ;;
  esac
}

install_base_packages() {
  step "Install base packages"
  apt_update
  run apt-get install -y \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gnupg \
    lsb-release \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    pkg-config \
    xz-utils \
    fonts-wqy-zenhei \
    fonts-wqy-microhei
}

ensure_app_user() {
  step "Prepare runtime user"
  if id "${APP_USER}" >/dev/null 2>&1; then
    info "Runtime user already exists: ${APP_USER}"
  else
    run useradd --create-home --shell /bin/bash "${APP_USER}"
    info "Created runtime user: ${APP_USER}"
  fi

  APP_USER_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
  if [[ -z "${APP_USER_HOME}" ]]; then
    err "Failed to resolve HOME for runtime user ${APP_USER}."
    exit 1
  fi

  run mkdir -p "${APP_USER_HOME}/.local/bin"
  run chown -R "${APP_USER}:${APP_USER}" "${APP_USER_HOME}/.local"
}

resolve_repo_dir() {
  if [[ "${USE_CONFIGURED_DEPLOY_DIR}" == "true" ]]; then
    info "Using DEPLOY_DIR provided by the caller: ${DEPLOY_DIR}"
    return 0
  fi

  local script_root
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  if [[ -f "${script_root}/package.json" ]]; then
    DEPLOY_DIR="${script_root}"
    info "Using source tree next to the script: ${DEPLOY_DIR}"
    return 0
  fi

  if [[ -f "${DEPLOY_DIR}/package.json" ]]; then
    info "Using extracted source tree from DEPLOY_DIR: ${DEPLOY_DIR}"
    return 0
  fi

  err "No source tree found."
  err "Expected package.json in either:"
  err "  1. the directory next to this script, or"
  err "  2. DEPLOY_DIR=${DEPLOY_DIR}"
  err "Upload and extract the local source package first, then rerun this script."
  exit 1
}

prepare_deploy_dirs() {
  step "Prepare deployment directories"
  run mkdir -p "${DEPLOY_DIR}" "${HERMES_HOME_DIR}" "${NODE_INSTALL_DIR}" "$(dirname "${SERVICE_ENV_FILE}")"
  run chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}" "${HERMES_HOME_DIR}"
  info "Source directory: ${DEPLOY_DIR}"
  info "Hermes data directory: ${HERMES_HOME_DIR}"
}

download_file() {
  local output="$1"
  shift

  local url
  for url in "$@"; do
    if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$output"; then
      info "Downloaded successfully: $url"
      return 0
    fi
    warn "Download failed, trying next URL: $url"
  done

  return 1
}

resolve_hermes_agent_wheel_url() {
  local latest_flag="${HERMES_AGENT_UPDATE_LATEST_STABLE:-false}"
  case "${latest_flag,,}" in
    1|true|yes|on)
      ;;
    *)
      return 0
      ;;
  esac

  if [[ -n "${HERMES_AGENT_WHEEL_URL}" && "${HERMES_AGENT_WHEEL_URL}" != "${DEFAULT_HERMES_AGENT_WHEEL_URL}" ]]; then
    info "Using caller-provided Hermes Agent wheel URL override: ${HERMES_AGENT_WHEEL_URL}"
    return 0
  fi

  if [[ -n "${HERMES_AGENT_UPDATE_MANIFEST_URL:-}" ]]; then
    step "Resolve latest stable Hermes Agent wheel from update manifest"
    local resolved_manifest_values
    resolved_manifest_values="$(
      python3 - "${HERMES_AGENT_UPDATE_MANIFEST_URL}" <<'PY'
import json
import sys
import urllib.request

manifest_url = sys.argv[1]
request = urllib.request.Request(
    manifest_url,
    headers={
        "Accept": "application/json",
        "User-Agent": "hermes-web-ui-deploy-source-armbian",
    },
)
with urllib.request.urlopen(request, timeout=20) as response:
    payload = json.load(response)

wheel_urls = payload.get("wheelUrls") or []
wheel_url = ""
for candidate in wheel_urls:
    candidate = str(candidate or "").strip()
    if candidate:
        wheel_url = candidate
        break
if not wheel_url:
    wheel_url = str(payload.get("wheelUrl") or "").strip()
if not wheel_url:
    raise SystemExit(f"Manifest {manifest_url} does not contain wheelUrl or wheelUrls")

wheelhouse_url = str(payload.get("wheelhouseUrl") or "").strip()
print(wheel_url)
print(wheelhouse_url)
PY
    )" || true
    if [[ -n "${resolved_manifest_values}" ]]; then
      HERMES_AGENT_WHEEL_URL="$(printf '%s\n' "${resolved_manifest_values}" | sed -n '1p')"
      if [[ -z "${HERMES_AGENT_WHEELHOUSE_URL:-}" ]]; then
        HERMES_AGENT_WHEELHOUSE_URL="$(printf '%s\n' "${resolved_manifest_values}" | sed -n '2p')"
      fi
      info "Resolved latest stable Hermes Agent wheel from manifest: ${HERMES_AGENT_WHEEL_URL}"
      if [[ -n "${HERMES_AGENT_WHEELHOUSE_URL:-}" ]]; then
        info "Using Hermes Agent wheelhouse: ${HERMES_AGENT_WHEELHOUSE_URL}"
      fi
      return 0
    fi
    warn "Failed to resolve Hermes Agent wheel from ${HERMES_AGENT_UPDATE_MANIFEST_URL}. Falling back to GitHub release metadata."
  fi

  step "Resolve latest stable Hermes Agent wheel"
  local resolved_url
  resolved_url="$(
    python3 - "${HERMES_AGENT_RELEASES_API_URL}" <<'PY'
import json
import sys
import urllib.request

api_url = sys.argv[1]
request = urllib.request.Request(
    api_url,
    headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "hermes-web-ui-deploy-source-armbian",
    },
)
with urllib.request.urlopen(request, timeout=20) as response:
    payload = json.load(response)

assets = payload.get("assets") or []
candidates = []
for asset in assets:
    name = str(asset.get("name") or "")
    url = str(asset.get("browser_download_url") or "")
    if not url:
        continue
    if name.startswith("hermes_agent-") and name.endswith("-py3-none-any.whl"):
        candidates.append((name, url))

if not candidates:
    raise SystemExit(
        f"No stable hermes-agent wheel asset found in release payload from {api_url}"
    )

candidates.sort()
print(candidates[0][1])
PY
  )"
  if [[ -z "${resolved_url}" ]]; then
    err "Failed to resolve the latest stable Hermes Agent wheel URL."
    exit 1
  fi
  HERMES_AGENT_WHEEL_URL="${resolved_url}"
  info "Resolved latest stable Hermes Agent wheel: ${HERMES_AGENT_WHEEL_URL}"
}

install_node() {
  step "Install Node.js ${NODE_VERSION}"

  local installed_major=""
  if [[ -x "${NODE_BIN}" ]]; then
    installed_major="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  fi
  if [[ "${installed_major}" =~ ^[0-9]+$ ]] && [[ "${installed_major}" -ge "${NODE_REQUIRED_MAJOR}" ]]; then
    info "Node.js already satisfies the requirement: $("${NODE_BIN}" -v)"
    return 0
  fi

  local tmp_dir archive_path
  tmp_dir="$(mktemp -d)"
  archive_path="${tmp_dir}/node.tar.xz"

  download_file "${archive_path}" \
    "${NODE_MIRROR_URL%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    "${NODE_FALLBACK_URL%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"

  run rm -rf "${NODE_INSTALL_DIR}"
  run mkdir -p "${NODE_INSTALL_DIR}"
  run tar -xJf "${archive_path}" --strip-components=1 -C "${NODE_INSTALL_DIR}"

  rm -rf "${tmp_dir}"
  info "Node.js installation completed: $("${NODE_BIN}" -v)"
}

ensure_wheel_anthropic_pin() {
  local venv_dir="${APP_USER_HOME}/.hermes/hermes-agent-venv"
  if [[ -z "${HERMES_ANTHROPIC_VERSION:-}" ]]; then
    info "No HERMES_ANTHROPIC_VERSION override provided. Skipping Anthropic SDK pin."
    return 0
  fi

  if [[ ! -x "${venv_dir}/bin/pip" ]]; then
    warn "Wheel venv not found at ${venv_dir}; skipping Anthropic SDK pin."
    return 0
  fi

  step "Pin Anthropic SDK for Anthropic-compatible providers"
  run_as_app_user "'${venv_dir}/bin/pip' install --force-reinstall 'anthropic==${HERMES_ANTHROPIC_VERSION}'"
  run_as_app_user "'${venv_dir}/bin/python3' -c \"import anthropic; print(anthropic.__version__)\" >/dev/null"
  info "Pinned Anthropic SDK to ${HERMES_ANTHROPIC_VERSION} in ${venv_dir}"
}

install_hermes_agent() {
  local hermes_bin_candidate
  hermes_bin_candidate="${APP_USER_HOME}/.local/bin/hermes"
  resolve_hermes_agent_wheel_url

  # Mode A: Install from Wheel URL (Fast, no git clone)
  if [[ -n "${HERMES_AGENT_WHEEL_URL}" ]]; then
    local venv_dir="${APP_USER_HOME}/.hermes/hermes-agent-venv"
    local bin_dir="${APP_USER_HOME}/.local/bin"

    if run_as_app_user "test -x '${hermes_bin_candidate}'"; then
      step "Update Hermes Agent"
      info "Updating Hermes Agent from wheel: ${HERMES_AGENT_WHEEL_URL}"
    else
      step "Install Hermes Agent"
      info "Installing Hermes Agent from pre-built wheel: ${HERMES_AGENT_WHEEL_URL}"
    fi

    run_as_app_user "mkdir -p '${venv_dir}' '${bin_dir}'"
    if ! run_as_app_user "test -x '${venv_dir}/bin/python3'"; then
      run_as_app_user "python3 -m venv '${venv_dir}'"
    fi
    run_as_app_user "'${venv_dir}/bin/pip' install --upgrade pip"
    if [[ -n "${HERMES_AGENT_WHEELHOUSE_URL:-}" ]]; then
      if ! run_as_app_user "'${venv_dir}/bin/pip' install --upgrade --no-index --find-links '${HERMES_AGENT_WHEELHOUSE_URL}' '${HERMES_AGENT_WHEEL_URL}'"; then
        warn "Hermes Agent wheelhouse install failed. Retrying against the direct wheel URL."
        run_as_app_user "'${venv_dir}/bin/pip' install --upgrade '${HERMES_AGENT_WHEEL_URL}'"
      fi
    else
      run_as_app_user "'${venv_dir}/bin/pip' install --upgrade '${HERMES_AGENT_WHEEL_URL}'"
    fi
    ensure_wheel_anthropic_pin

    # Link the command
    run_as_app_user "ln -sf '${venv_dir}/bin/hermes' '${bin_dir}/hermes'"
    run_as_app_user "'${bin_dir}/hermes' version >/dev/null"
    info "Hermes Agent is ready from wheel at: ${hermes_bin_candidate}"
    return 0
  fi

  # Mode B: Official Installer (Legacy/Source)
  step "Install Hermes Agent"
  local install_command
  install_command=$(cat <<'EOF'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
tmp_installer="$(mktemp)"
cleanup() {
  rm -f "$tmp_installer"
}
trap cleanup EXIT
for url in \
  "${HERMES_INSTALLER_MIRROR}" \
  "${HERMES_INSTALLER_FALLBACK}"
do
  if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$tmp_installer"; then
    bash "$tmp_installer" ${HERMES_INSTALL_FLAGS}
    exit 0
  fi
done
echo "Failed to download the Hermes installer script." >&2
exit 1
EOF
)

  run_as_app_user "${install_command}" \
    HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS}" \
    HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR}" \
    HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK}"

  if ! run_as_app_user "test -x '${hermes_bin_candidate}'"; then
    err "Hermes installation completed, but the binary was not found: ${hermes_bin_candidate}"
    exit 1
  fi

  info "Hermes installed at: ${hermes_bin_candidate}"
}

configure_app_user_shell_path() {
  step "Configure Hermes shell PATH"
  local profile_file
  profile_file="${APP_USER_HOME}/.profile"

  run touch "${profile_file}"
  if ! run grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "${profile_file}"; then
    run tee -a "${profile_file}" >/dev/null <<'EOF'
export PATH="$HOME/.local/bin:$PATH"
EOF
  fi

  run chown "${APP_USER}:${APP_USER}" "${profile_file}"
  info "Ensured ${APP_USER} login shells include ~/.local/bin in PATH."
}

install_root_hermes_wrapper() {
  step "Install root Hermes wrapper"
  run tee /usr/local/bin/hermes >/dev/null <<EOF
#!/usr/bin/env bash
exec sudo -u ${APP_USER} -H env \\
  HERMES_HOME=${HERMES_HOME_DIR} \\
  PATH=${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
  ${APP_USER_HOME}/.local/bin/hermes "\$@"
EOF
  run chmod 0755 /usr/local/bin/hermes
  info "Installed /usr/local/bin/hermes wrapper for root and admin shells."
}

write_npmrc() {
  step "Write npm mirror configuration"
  run tee "${APP_USER_HOME}/.npmrc" >/dev/null <<EOF
registry=${NPM_REGISTRY}
disturl=${NODE_MIRROR_URL%/}
electron_mirror=${NPM_BINARY_MIRROR_PREFIX%/}/electron/
puppeteer_download_host=${NPM_BINARY_MIRROR_PREFIX%/}
sharp_binary_host=${NPM_BINARY_MIRROR_PREFIX%/}/sharp
sharp_libvips_binary_host=${NPM_BINARY_MIRROR_PREFIX%/}/sharp-libvips
sqlite3_binary_site=${NPM_BINARY_MIRROR_PREFIX%/}/sqlite3
sass_binary_site=${NPM_BINARY_MIRROR_PREFIX%/}/node-sass
chromedriver_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/chromedriver
operadriver_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/operadriver
phantomjs_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/phantomjs
selenium_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/selenium
EOF
  run chown "${APP_USER}:${APP_USER}" "${APP_USER_HOME}/.npmrc"
  info "Wrote ${APP_USER_HOME}/.npmrc"
}

install_webui_dependencies() {
  if [[ -n "${WEBUI_BUNDLE_URL}" ]]; then
    step "Install hermes-web-ui from bundle"
    local tmp_bundle
    tmp_bundle="$(mktemp)"
    if download_file "${tmp_bundle}" "${WEBUI_BUNDLE_URL}"; then
      run chown "${APP_USER}:${APP_USER}" "${tmp_bundle}"
      run_as_app_user "cd '${DEPLOY_DIR}' && tar -xzf '${tmp_bundle}'"
      rm -f "${tmp_bundle}"
      info "Extracted web-ui bundle to ${DEPLOY_DIR}"
      return 0
    fi
    warn "Failed to download web-ui bundle. Falling back to npm install."
  fi

  step "Install hermes-web-ui dependencies"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  run chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' HERMES_WEB_UI_SKIP_PREPARE=1 npm install --include=dev && PATH='${path_env}' npm ls --depth=0 @vscode/markdown-it-katex naive-ui typescript vite vue-tsc >/dev/null"
}

check_webui_dependencies() {
  step "Check installed Web UI dependencies"

  if [[ -f "${DEPLOY_DIR}/dist/server/index.js" ]]; then
    info "Pre-built artifacts detected. Skipping build-time dependency check."
    return 0
  fi

  run test -f "${DEPLOY_DIR}/node_modules/naive-ui/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/naive-ui/es/index.d.ts"
  run test -f "${DEPLOY_DIR}/node_modules/typescript/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/vue-tsc/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/vite/package.json"
  info "Required build-time dependencies are present."
}

build_webui() {
  if [[ -f "${DEPLOY_DIR}/dist/server/index.js" ]]; then
    info "Found pre-built artifacts in dist/. Skipping build_webui."
    return 0
  fi

  step "Build hermes-web-ui"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm run build"
}

write_service_env() {
  step "Write service environment file"
  local hermes_bin
  local hermes_agent_root
  local webui_home
  local update_runner_request_file
  hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  hermes_agent_root=""
  webui_home="${HERMES_WEB_UI_HOME:-${APP_USER_HOME}/.hermes-web-ui}"
  update_runner_request_file="${WEBUI_UPDATE_RUNNER_REQUEST_FILE:-${webui_home}/updates/update-runner-request.json}"
  if [[ -z "${HERMES_AGENT_WHEEL_URL}" ]]; then
    hermes_agent_root="${APP_USER_HOME}/.hermes/hermes-agent"
  fi

  run tee "${SERVICE_ENV_FILE}" >/dev/null <<EOF
PORT=${PORT}
BIND_HOST=${BIND_HOST}
NODE_ENV=production
HOME=${APP_USER_HOME}
PATH=${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERMES_HOME=${HERMES_HOME_DIR}
HERMES_BIN=${hermes_bin}
${hermes_agent_root:+HERMES_AGENT_ROOT=${hermes_agent_root}}
HERMES_WEB_UI_HOME=${webui_home}
LANG=C.UTF-8
LC_ALL=C.UTF-8
EOF

  run chown root:root "${SERVICE_ENV_FILE}"
  run chmod 0644 "${SERVICE_ENV_FILE}"

  local update_env_name update_env_value
  for update_env_name in \
    UPLOAD_DIR \
    HERMES_AGENT_WHEEL_URL \
    HERMES_AGENT_WHEELHOUSE_URL \
    HERMES_AGENT_RELEASES_API_URL \
    HERMES_AGENT_UPDATE_MANIFEST_URL \
    HERMES_ANTHROPIC_VERSION \
    WEBUI_UPDATE_ENABLED \
    WEBUI_UPDATE_PACKAGE \
    WEBUI_UPDATE_REGISTRY \
    WEBUI_UPDATE_CLI_BIN \
    WEBUI_UPDATE_SOURCE_LABEL \
    WEBUI_UPDATE_DIST_TAG \
    WEBUI_UPDATE_STRATEGY \
    WEBUI_UPDATE_SCRIPT \
    WEBUI_UPDATE_REPO \
    WEBUI_UPDATE_MANIFEST_URL \
    WEBUI_UPDATE_MANIFEST_URLS \
    WEBUI_UPDATE_MANIFEST_BASE_URL \
    WEBUI_UPDATE_MANIFEST_BASE_URLS \
    WEBUI_UPDATE_CHANNEL \
    WEBUI_UPDATE_PACKAGE_TYPE \
    WEBUI_UPDATE_INSTALLER_SCRIPT \
    WEBUI_UPDATE_RUNNER_SERVICE \
    WEBUI_UPDATE_RUNNER_REQUEST_FILE \
    WEBUI_UPDATE_VERIFY_SHA256 \
    WEBUI_UPDATE_STAGING_DIR \
    WEBUI_UPDATE_BACKUP_DIR \
    WEBUI_UPDATE_HEALTHCHECK_URL \
    WEBUI_UPDATE_STATE_FILE \
    WEBUI_UPDATE_LOG_DIR \
    WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS \
    WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS \
    WEBUI_UPDATE_HEALTHCHECK_RETRIES \
    WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS
  do
    update_env_value="${!update_env_name:-}"
    if [[ -z "${update_env_value}" ]]; then
      case "${update_env_name}" in
        WEBUI_UPDATE_RUNNER_SERVICE)
          update_env_value="${UPDATE_RUNNER_SERVICE_NAME}"
          ;;
        WEBUI_UPDATE_RUNNER_REQUEST_FILE)
          update_env_value="${update_runner_request_file}"
          ;;
      esac
    fi
    if [[ -n "${update_env_value}" ]]; then
      run tee -a "${SERVICE_ENV_FILE}" >/dev/null <<EOF
${update_env_name}=${update_env_value}
EOF
    fi
  done

  info "Wrote ${SERVICE_ENV_FILE}"
}

wait_for_http_ready() {
  local url="$1"
  local expected_fragment="$2"
  local max_attempts="${3:-20}"
  local i
  for ((i=1; i<=max_attempts; i++)); do
    local body
    if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)" && [[ "$body" == *"$expected_fragment"* ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

require_log_dir_writable() {
  local state_dir="${APP_USER_HOME}/.hermes-web-ui"
  local log_dir="${state_dir}/logs"
  step "Check runtime directory permissions"
  run mkdir -p "${log_dir}"
  run chown -R "${APP_USER}:${APP_USER}" "${state_dir}"
  run_as_app_user "test -w '${state_dir}' && test -w '${log_dir}'"
  info "Runtime directories are writable: ${log_dir}"
}

check_runtime_artifacts() {
  local hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  step "Check runtime artifacts"
  run test -x "${NODE_BIN}"
  run_as_app_user "test -x '${hermes_bin}' && '${hermes_bin}' --version >/dev/null"
  run test -x /usr/local/bin/hermes
  run /usr/local/bin/hermes --version >/dev/null
  run test -f "${DEPLOY_DIR}/dist/server/index.js"
  run test -f "${DEPLOY_DIR}/dist/client/index.html"
  info "Node, Hermes, and build artifacts look good."
}

check_bridge_status() {
  local bridge_log="${APP_USER_HOME}/.hermes-web-ui/logs/bridge.log"
  step "Check agent bridge log"
  if [[ ! -f "${bridge_log}" ]]; then
    warn "bridge.log does not exist yet. Skipping bridge stability check."
    return 0
  fi

  if run bash -lc "tail -n 200 '${bridge_log}' | grep -E 'bridge exited unexpectedly|agent-bridge\\] exited code='" >/dev/null 2>&1; then
    err "Detected an unexpected agent bridge exit. Check ${bridge_log}"
    return 1
  fi

  info "No unexpected agent bridge exits detected."
}

post_deploy_self_check() {
  local probe_url="http://127.0.0.1:${PORT}"
  local deployed_version=""
  step "Run post-deploy self-checks"

  if ! run systemctl is-active --quiet "${SYSTEMD_SERVICE_NAME}"; then
    err "systemd service is not active: ${SYSTEMD_SERVICE_NAME}"
    run systemctl status "${SYSTEMD_SERVICE_NAME}" --no-pager || true
    return 1
  fi
  info "systemd service is active."

  check_runtime_artifacts
  require_log_dir_writable

  if ! wait_for_http_ready "${probe_url}/health" "\"status\":\"ok\""; then
    err "Health check failed: ${probe_url}/health"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "Health check passed."

  deployed_version="$(
    python3 - "${DEPLOY_DIR}/package.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

package_path = Path(sys.argv[1])
payload = json.loads(package_path.read_text(encoding="utf-8"))
version = str(payload.get("version") or "").strip()
if version:
    print(version)
PY
  )"
  if [[ -n "${deployed_version}" ]]; then
    if ! wait_for_http_ready "${probe_url}/health" "\"webui_version\":\"${deployed_version}\""; then
      err "Version cutover check failed: ${probe_url}/health did not report webui_version=${deployed_version}"
      run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
      return 1
    fi
    info "Version cutover check passed: ${deployed_version}"
  fi

  if ! wait_for_http_ready "${probe_url}/api/auth/status" "\"hasPasswordLogin\":true"; then
    err "Auth status check failed: ${probe_url}/api/auth/status"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "Auth status check passed."

  if [[ "${WEBUI_UPDATE_ENABLED,,}" == "true" || "${WEBUI_UPDATE_ENABLED}" == "1" ]]; then
    if ! wait_for_http_ready "${probe_url}/health" "\"webui_update_enabled\":true"; then
      err "Update configuration check failed: ${probe_url}/health did not report webui_update_enabled=true"
      run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
      return 1
    fi
    info "Update configuration check passed."
  fi

  check_bridge_status
}

install_systemd_service() {
  local was_active=false
  step "Install systemd service"

  if systemctl is-active --quiet "${SYSTEMD_SERVICE_NAME}" >/dev/null 2>&1; then
    was_active=true
  fi

  local rendered_service
  rendered_service="$(mktemp)"

  python3 - "${SERVICE_TEMPLATE}" "${rendered_service}" \
    "${APP_USER}" "${APP_USER_HOME}" "${DEPLOY_DIR}" "${SERVICE_ENV_FILE}" \
    "${NODE_BIN}" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
replacements = {
    "{{APP_USER}}": sys.argv[3],
    "{{APP_USER_HOME}}": sys.argv[4],
    "{{DEPLOY_DIR}}": sys.argv[5],
    "{{SERVICE_ENV_FILE}}": sys.argv[6],
    "{{NODE_BIN}}": sys.argv[7],
}

content = template_path.read_text(encoding="utf-8")
for old, new in replacements.items():
    content = content.replace(old, new)
output_path.write_text(content, encoding="utf-8")
PY

  run cp "${rendered_service}" "/etc/systemd/system/${SYSTEMD_SERVICE_NAME}"
  rm -f "${rendered_service}"
  run systemctl daemon-reload
  run systemctl enable "${SYSTEMD_SERVICE_NAME}"
  if [[ "${was_active}" == "true" ]]; then
    run systemctl restart "${SYSTEMD_SERVICE_NAME}"
    info "systemd service restarted: ${SYSTEMD_SERVICE_NAME}"
  else
    run systemctl start "${SYSTEMD_SERVICE_NAME}"
    info "systemd service started: ${SYSTEMD_SERVICE_NAME}"
  fi
}

install_update_runner_script() {
  step "Install managed update runner"
  run install -o root -g root -m 0755 "${UPDATE_RUNNER_SCRIPT_SOURCE}" "${UPDATE_RUNNER_SCRIPT_PATH}"
  info "Managed update runner installed: ${UPDATE_RUNNER_SCRIPT_PATH}"
}

install_update_runner_service() {
  step "Install managed update systemd service"

  local rendered_service
  rendered_service="$(mktemp)"

  python3 - "${UPDATE_RUNNER_TEMPLATE}" "${rendered_service}" \
    "${DEPLOY_DIR}" "${SERVICE_ENV_FILE}" "${UPDATE_RUNNER_SCRIPT_PATH}" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
replacements = {
    "{{DEPLOY_DIR}}": sys.argv[3],
    "{{SERVICE_ENV_FILE}}": sys.argv[4],
    "{{UPDATE_RUNNER_BIN}}": sys.argv[5],
}

content = template_path.read_text(encoding="utf-8")
for old, new in replacements.items():
    content = content.replace(old, new)
output_path.write_text(content, encoding="utf-8")
PY

  run cp "${rendered_service}" "/etc/systemd/system/${UPDATE_RUNNER_SERVICE_NAME}"
  rm -f "${rendered_service}"
  info "Managed update service installed: ${UPDATE_RUNNER_SERVICE_NAME}"
}

install_update_runner_sudoers() {
  step "Install managed update sudoers policy"

  local systemctl_bin
  local journalctl_bin
  local sudoers_tmp

  systemctl_bin="$(command -v systemctl)"
  journalctl_bin="$(command -v journalctl)"
  sudoers_tmp="$(mktemp)"

  cat >"${sudoers_tmp}" <<EOF
Defaults:${APP_USER} env_reset,use_pty,log_output,secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Defaults!${systemctl_bin} !setenv
Defaults!${journalctl_bin} !setenv

Cmnd_Alias HERMES_WEB_UI_UPDATE = ${systemctl_bin} start ${UPDATE_RUNNER_SERVICE_NAME}, ${systemctl_bin} status ${UPDATE_RUNNER_SERVICE_NAME}, ${journalctl_bin} -u ${UPDATE_RUNNER_SERVICE_NAME} -n 200 --no-pager

${APP_USER} ALL=(root) NOPASSWD: HERMES_WEB_UI_UPDATE
EOF

  run install -o root -g root -m 0440 "${sudoers_tmp}" "${UPDATE_RUNNER_SUDOERS_FILE}"
  if command -v visudo >/dev/null 2>&1; then
    run visudo -cf "${UPDATE_RUNNER_SUDOERS_FILE}"
  fi
  rm -f "${sudoers_tmp}"
  info "Managed update sudoers installed: ${UPDATE_RUNNER_SUDOERS_FILE}"
}

show_summary() {
  local server_url
  server_url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"

  echo
  info "Source deployment completed"
  echo "----------------------------------------"
  echo "Server URL: ${server_url}"
  echo "Local URL: http://127.0.0.1:${PORT}"
  echo "Source directory: ${DEPLOY_DIR}"
  echo "Hermes data directory: ${HERMES_HOME_DIR}"
  echo "Runtime user: ${APP_USER}"
  echo
  echo "Initial Hermes setup:"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes setup"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes model"
  echo
  echo "CLI usage:"
  echo "  hermes version"
  echo "  su - ${APP_USER}"
  echo "  hermes version"
  echo "  # Avoid: su ${APP_USER}  (non-login shell may miss ~/.local/bin)"
  echo
  echo "Common commands:"
  echo "  sudo systemctl status ${SYSTEMD_SERVICE_NAME}"
  echo "  sudo journalctl -u ${SYSTEMD_SERVICE_NAME} -f"
  echo "  sudo systemctl restart ${SYSTEMD_SERVICE_NAME}"
  echo "  sudo systemctl stop ${SYSTEMD_SERVICE_NAME}"
  echo
}

DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
PORT="${PORT:-6060}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
APP_USER="${APP_USER:-hermesui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"
NODE_REQUIRED_MAJOR="${NODE_REQUIRED_MAJOR:-23}"
NODE_VERSION="${NODE_VERSION:-23.11.1}"
NODE_INSTALL_DIR="${NODE_INSTALL_DIR:-/opt/node-v${NODE_REQUIRED_MAJOR}}"
NODE_BIN="${NODE_INSTALL_DIR}/bin/node"
NODE_MIRROR_URL="${NODE_MIRROR_URL:-https://npmmirror.com/mirrors/node}"
NODE_FALLBACK_URL="${NODE_FALLBACK_URL:-https://nodejs.org/dist}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NPM_BINARY_MIRROR_PREFIX="${NPM_BINARY_MIRROR_PREFIX:-https://cdn.npmmirror.com/binaries}"
HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR:-https://cdn.jsdelivr.net/gh/NousResearch/hermes-agent@main/scripts/install.sh}"
HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK:-https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh}"
OSS_PUBLIC_BASE_URL="${OSS_PUBLIC_BASE_URL:-https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui}"
DEFAULT_HERMES_AGENT_WHEEL_URL="https://github.com/NousResearch/hermes-agent/releases/download/v2026.5.29.2/hermes_agent-0.15.2-py3-none-any.whl"
HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-${DEFAULT_HERMES_AGENT_WHEEL_URL}}"
HERMES_AGENT_WHEELHOUSE_URL="${HERMES_AGENT_WHEELHOUSE_URL:-${OSS_PUBLIC_BASE_URL}/hermes-agent/wheelhouse/}"
HERMES_AGENT_RELEASES_API_URL="${HERMES_AGENT_RELEASES_API_URL:-https://api.github.com/repos/NousResearch/hermes-agent/releases/latest}"
HERMES_AGENT_UPDATE_MANIFEST_URL="${HERMES_AGENT_UPDATE_MANIFEST_URL:-${OSS_PUBLIC_BASE_URL}/hermes-agent/stable/latest.json}"
HERMES_AGENT_UPDATE_LATEST_STABLE="${HERMES_AGENT_UPDATE_LATEST_STABLE:-false}"
HERMES_ANTHROPIC_VERSION="${HERMES_ANTHROPIC_VERSION:-}"
WEBUI_BUNDLE_URL="${WEBUI_BUNDLE_URL:-}"
HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS:---skip-setup --skip-browser}"
SERVICE_TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui.service"
UPDATE_RUNNER_TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui-update.service"
UPDATE_RUNNER_SCRIPT_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui-update-runner.sh"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui.service}"
UPDATE_RUNNER_SERVICE_NAME="${WEBUI_UPDATE_RUNNER_SERVICE:-hermes-web-ui-update.service}"
UPDATE_RUNNER_SCRIPT_PATH="${UPDATE_RUNNER_SCRIPT_PATH:-/usr/local/sbin/hermes-web-ui-update-runner}"
UPDATE_RUNNER_SUDOERS_FILE="${UPDATE_RUNNER_SUDOERS_FILE:-/etc/sudoers.d/hermes-web-ui-update}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
WEBUI_UPDATE_ENABLED="${WEBUI_UPDATE_ENABLED:-true}"
WEBUI_UPDATE_PACKAGE="${WEBUI_UPDATE_PACKAGE:-@quanthermes/hermes-web-ui}"
WEBUI_UPDATE_REGISTRY="${WEBUI_UPDATE_REGISTRY:-https://registry.npmjs.org}"
WEBUI_UPDATE_CLI_BIN="${WEBUI_UPDATE_CLI_BIN:-hermes-web-ui.mjs}"
WEBUI_UPDATE_SOURCE_LABEL="${WEBUI_UPDATE_SOURCE_LABEL:-Quanthermes npm}"
WEBUI_UPDATE_DIST_TAG="${WEBUI_UPDATE_DIST_TAG:-latest}"
WEBUI_UPDATE_STRATEGY="${WEBUI_UPDATE_STRATEGY:-source-deploy}"
WEBUI_UPDATE_SCRIPT="${WEBUI_UPDATE_SCRIPT:-${DEPLOY_DIR}/scripts/update-source-deploy.sh}"
WEBUI_UPDATE_REPO="${WEBUI_UPDATE_REPO:-https://github.com/tangledup-ai/hermes-web-ui}"
WEBUI_UPDATE_MANIFEST_BASE_URL="${WEBUI_UPDATE_MANIFEST_BASE_URL:-${OSS_PUBLIC_BASE_URL}/releases}"
UPDATE_ONLY_RAW="${DEPLOY_UPDATE_ONLY:-false}"
AGENT_ONLY_RAW="${DEPLOY_HERMES_AGENT_ONLY:-false}"
USE_CONFIGURED_DEPLOY_DIR_RAW="${DEPLOY_USE_CONFIGURED_DIR:-false}"
APP_USER_HOME=""
NODE_ARCH=""

case "${UPDATE_ONLY_RAW,,}" in
  1|true|yes|on)
    UPDATE_ONLY=true
    ;;
  *)
    UPDATE_ONLY=false
    ;;
esac

case "${AGENT_ONLY_RAW,,}" in
  1|true|yes|on)
    AGENT_ONLY=true
    ;;
  *)
    AGENT_ONLY=false
    ;;
esac

case "${USE_CONFIGURED_DEPLOY_DIR_RAW,,}" in
  1|true|yes|on)
    USE_CONFIGURED_DEPLOY_DIR=true
    ;;
  *)
    USE_CONFIGURED_DEPLOY_DIR=false
    ;;
esac

require_safe_env_value "PORT" "${PORT}"
require_safe_env_value "BIND_HOST" "${BIND_HOST}"
require_safe_env_value "APP_USER" "${APP_USER}"
require_safe_env_value "DEPLOY_DIR" "${DEPLOY_DIR}"
require_safe_env_value "HERMES_HOME_DIR" "${HERMES_HOME_DIR}"
require_safe_env_value "SERVICE_ENV_FILE" "${SERVICE_ENV_FILE}"
require_safe_env_value "UPDATE_RUNNER_SERVICE_NAME" "${UPDATE_RUNNER_SERVICE_NAME}"
require_safe_env_value "WEBUI_UPDATE_ENABLED" "${WEBUI_UPDATE_ENABLED}"
require_safe_env_value "WEBUI_UPDATE_PACKAGE" "${WEBUI_UPDATE_PACKAGE}"
require_safe_env_value "WEBUI_UPDATE_REGISTRY" "${WEBUI_UPDATE_REGISTRY}"
require_safe_env_value "WEBUI_UPDATE_CLI_BIN" "${WEBUI_UPDATE_CLI_BIN}"
require_safe_env_value "WEBUI_UPDATE_SOURCE_LABEL" "${WEBUI_UPDATE_SOURCE_LABEL}"
require_safe_env_value "WEBUI_UPDATE_DIST_TAG" "${WEBUI_UPDATE_DIST_TAG}"
require_safe_env_value "WEBUI_UPDATE_STRATEGY" "${WEBUI_UPDATE_STRATEGY}"
require_safe_env_value "WEBUI_UPDATE_SCRIPT" "${WEBUI_UPDATE_SCRIPT}"
require_safe_env_value "WEBUI_UPDATE_REPO" "${WEBUI_UPDATE_REPO}"

echo
echo "hermes / hermes-web-ui source deployment"
echo "=================================="
echo

require_debian_like
require_supported_arch
if [[ "${UPDATE_ONLY}" != "true" && "${AGENT_ONLY}" != "true" ]]; then
  install_base_packages
elif [[ "${AGENT_ONLY}" == "true" ]]; then
  info "Running source deployment in hermes-agent-only mode."
else
  info "Running source deployment in update-only mode."
fi
ensure_app_user
resolve_repo_dir
prepare_deploy_dirs
if [[ "${AGENT_ONLY}" == "true" ]]; then
  install_hermes_agent
  echo
  info "Hermes Agent update completed"
  exit 0
fi

install_node
if [[ "${UPDATE_ONLY}" != "true" ]]; then
  install_hermes_agent
  configure_app_user_shell_path
  install_root_hermes_wrapper
fi
write_npmrc
install_webui_dependencies
check_webui_dependencies
build_webui
write_service_env
install_update_runner_script
install_update_runner_service
install_update_runner_sudoers
install_systemd_service
post_deploy_self_check
show_summary
