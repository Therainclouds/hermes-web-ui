#!/usr/bin/env bash
set -Eeuo pipefail

# start-dev.sh
# One-click development start for Hermes Web UI.
#   - installs dependencies when missing
#   - repairs native modules that failed to build (e.g. sharp)
#   - generates a self-signed TLS cert when missing (enables HTTPS on 8647/6060)
#   - starts `npm run dev` bound to 0.0.0.0 (LAN-accessible)
#
# Usage: ./start-dev.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="${ROOT_DIR}/packages/certs"
CERT_FILE="${CERTS_DIR}/server.crt"
KEY_FILE="${CERTS_DIR}/server.key"

cd "${ROOT_DIR}"

# 默认监听 0.0.0.0，允许局域网设备访问（可用 BIND_HOST 覆盖）
export BIND_HOST="${BIND_HOST:-0.0.0.0}"

has_module() {
  node -e "require.resolve('$1')" >/dev/null 2>&1
}

# 1. Dependencies
if [[ ! -d node_modules ]]; then
  echo "[start-dev] node_modules missing, running npm install..."
  npm install
else
  echo "[start-dev] node_modules present"
fi

# 2. Native modules that silently break when install scripts are skipped
if ! has_module sharp; then
  echo "[start-dev] sharp missing, installing (needs install scripts)..."
  npm install sharp --ignore-scripts=false
else
  echo "[start-dev] sharp present"
fi

# 3. Self-signed TLS cert (enables HTTPS on the dev server and API)
ensure_cert() {
  if [[ -f "${CERT_FILE}" && -f "${KEY_FILE}" ]]; then
    echo "[start-dev] TLS cert up to date (${CERTS_DIR})"
    return
  fi
  echo "[start-dev] generating self-signed TLS cert..."
  mkdir -p "${CERTS_DIR}"

  CURRENT_IP="$(ip -4 route get 1 2>/dev/null | grep -oP 'src\s+\K[^ ]+' | head -n 1)"
  if [[ -z "${CURRENT_IP}" ]]; then
    CURRENT_IP="$(ip -4 addr show scope global 2>/dev/null \
      | grep -oP 'inet\s+\K[^/]+' \
      | head -n 1)"
  fi
  if [[ -z "${CURRENT_IP}" ]]; then
    echo "[start-dev] WARNING: cannot detect LAN IPv4, using 127.0.0.1 only"
    CURRENT_IP="127.0.0.1"
  fi

  openssl req -x509 -newkey rsa:4096 -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
    -days 3650 -nodes \
    -subj "/CN=${CURRENT_IP}" \
    -addext "subjectAltName=IP:${CURRENT_IP},IP:127.0.0.1,DNS:localhost"

  chmod 600 "${KEY_FILE}"
  chmod 644 "${CERT_FILE}"
  echo "[start-dev] TLS cert generated for IP ${CURRENT_IP}"
}
ensure_cert

# 4. Start
echo "[start-dev] starting dev servers bound to ${BIND_HOST} (client :6060, API :8647)..."
npm run dev
