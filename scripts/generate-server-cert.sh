#!/usr/bin/env bash
set -Eeuo pipefail

# generate-server-cert.sh
# Generates a self-signed TLS server certificate for the current LAN IP.
# Designed to run as ExecStartPre before the Hermes Web UI service starts.
#
# Usage: generate-server-cert.sh [deploy-dir]
#   Default deploy-dir: /opt/hermes-web-ui

DEPLOY_DIR="${1:-/opt/hermes-web-ui}"
CERTS_DIR="${DEPLOY_DIR}/certs"
CERT_FILE="${CERTS_DIR}/server.crt"
KEY_FILE="${CERTS_DIR}/server.key"
IP_FILE="${CERTS_DIR}/.current_ip"

# Detect the primary non-loopback IPv4 address.
# Prefer interfaces with a default route, fall back to the first global-scope address.
CURRENT_IP="$(ip -4 route get 1 2>/dev/null | grep -oP 'src\s+\K[^ ]+' | head -n 1)"
if [[ -z "${CURRENT_IP}" ]]; then
  CURRENT_IP="$(ip -4 addr show scope global 2>/dev/null \
    | grep -oP 'inet\s+\K[^/]+' \
    | head -n 1)"
fi
if [[ -z "${CURRENT_IP}" ]]; then
  echo "[generate-server-cert] ERROR: cannot determine LAN IPv4 address"
  exit 1
fi

# Skip if IP unchanged and both key+cert exist.
if [[ -f "${IP_FILE}" && "$(cat "${IP_FILE}")" == "${CURRENT_IP}" \
   && -f "${CERT_FILE}" && -f "${KEY_FILE}" ]]; then
  echo "[generate-server-cert] certificate up to date for IP ${CURRENT_IP}"
  exit 0
fi

mkdir -p "${CERTS_DIR}"

openssl req -x509 -newkey rsa:4096 -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
  -days 3650 -nodes \
  -subj "/CN=${CURRENT_IP}" \
  -addext "subjectAltName=IP:${CURRENT_IP},IP:127.0.0.1,DNS:localhost"

chmod 600 "${KEY_FILE}"
chmod 644 "${CERT_FILE}"

echo "${CURRENT_IP}" > "${IP_FILE}"

echo "[generate-server-cert] self-signed certificate generated for IP ${CURRENT_IP}"

# Allow Node.js to bind to privileged ports (< 1024) — one-shot, idempotent.
if command -v setcap &>/dev/null; then
  NODE_BIN="$(command -v node 2>/dev/null || echo '/opt/node-v23/bin/node')"
  if setcap 'cap_net_bind_service=+ep' "${NODE_BIN}" 2>/dev/null; then
    echo "[generate-server-cert] cap_net_bind_service applied to ${NODE_BIN}"
  else
    echo "[generate-server-cert] WARNING: setcap failed — port 443 binding may require root"
  fi
fi
