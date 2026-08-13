#!/usr/bin/env bash
# Device-side deployment v2: root-cause fixes + discussion this-binding fix +
# 10-minute agent speech timeout. Downloads from jsDelivr CDN temp branch.
set -euo pipefail

BUNDLE_URL="https://cdn.jsdelivr.net/gh/Therainclouds/hermes-web-ui@a12a290faddc497b301825f6f5f0042a89937657/.deploy/index.js"
EXPECTED=8757955
DEPLOY_PATH=/opt/hermes-web-ui/dist/server/index.js

echo "== [1/4] download bundle =="
curl -sL --retry 4 --retry-delay 2 --connect-timeout 15 --max-time 300 "$BUNDLE_URL" -o /tmp/idx.new
SZ=$(wc -c < /tmp/idx.new)
echo "size=$SZ (expected $EXPECTED)"
if [ "$SZ" != "$EXPECTED" ]; then echo "SIZE MISMATCH — aborting"; exit 1; fi

echo "== [2/4] stop + backup =="
systemctl stop hermes-web-ui
cp -f "$DEPLOY_PATH" "$DEPLOY_PATH.bak-root-v2"
echo "backed up to $DEPLOY_PATH.bak-root-v2"

echo "== [3/4] install =="
cp /tmp/idx.new "$DEPLOY_PATH"
chown hermesui:hermesui "$DEPLOY_PATH"
rm -f /tmp/idx.new
echo "installed"

echo "== [4/4] start + health =="
systemctl start hermes-web-ui
sleep 10
echo "health=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6060/health)"
echo "new bundle markers: $(grep -c 'HERMES_GROUP_CHAT_SPEECH_TIMEOUT_MS' "$DEPLOY_PATH" || true)"
echo "DONE"
