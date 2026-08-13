#!/usr/bin/env bash
#
# 方案 D：构建自定义 hermes-agent wheel（上游源码 + CN 本地化补丁）并发布到自家 OSS。
#
# 用法:
#   ./build-release.sh                  # 默认上游 tag v2026.6.19 (== 0.17.0)，只构建
#   ./build-release.sh --tag v2026.8.3  # 指定上游 tag（新版本 rebase 时用）
#   ./build-release.sh --upload         # 构建 + 上传 OSS + 更新 stable/latest.json
#
# 环境变量（覆盖默认）:
#   HERMES_AGENT_UPSTREAM_REPO  上游仓库, 默认 https://github.com/NousResearch/hermes-agent.git
#   OSS_PUBLIC_BASE_URL         你的 OSS 公网前缀, 默认 https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui
#   OSS_PATH                    ossutil 风格路径, 默认 oss://tangledup-ai-staging/quanthermes_pj/quanthermes_web_ui
#
# 发布流程与现有 .github/workflows/hermes-agent-oss-mirror.yml 一致：
#   wheel 传 <OSS>/hermes-agent/releases/<version>/ 与 wheelhouse/，并重写 <OSS>/hermes-agent/stable/latest.json
# 设备端 source-deploy 会优先读取该 manifest（HERMES_AGENT_UPDATE_MANIFEST_URL），
# 天然获得"先验证再翻 manifest"的受控发布。
#
set -euo pipefail

UPSTREAM_REPO="${HERMES_AGENT_UPSTREAM_REPO:-https://github.com/NousResearch/hermes-agent.git}"
OSS_PUBLIC_BASE_URL="${OSS_PUBLIC_BASE_URL:-https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui}"
OSS_PATH="${OSS_PATH:-oss://tangledup-ai-staging/quanthermes_pj/quanthermes_web_ui}"

TAG="${TAG:-v2026.6.19}"          # == hermes-agent 0.17.0（真机当前版本）
AGENT_VERSION="${AGENT_VERSION:-0.17.0}"
DO_UPLOAD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --version) AGENT_VERSION="$2"; shift 2 ;;
    --upload) DO_UPLOAD=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "== [1/5] clone upstream $UPSTREAM_REPO @ $TAG =="
git clone --depth 1 --branch "$TAG" "$UPSTREAM_REPO" "$WORK_DIR/hermes-agent" 2>/dev/null || {
  echo "tag '$TAG' not found; upstream tags are date-based like v2026.6.19 (check https://github.com/NousResearch/hermes-agent/tags)" >&2
  exit 1
}

echo "== [2/5] apply CN localization patch =="
python3 "$SCRIPT_DIR/apply_cn_patch.py" "$WORK_DIR/hermes-agent"

echo "== [3/5] build wheel =="
python3 -m pip wheel "$WORK_DIR/hermes-agent" --no-deps --no-cache-dir -w "$WORK_DIR/dist" >/dev/null
WHEEL="$(find "$WORK_DIR/dist" -maxdepth 1 -name '*.whl' | head -n 1)"
if [[ -z "$WHEEL" ]]; then
  echo "wheel build failed" >&2
  exit 1
fi
WHEEL_NAME="$(basename "$WHEEL")"
echo "built: $WHEEL_NAME"

echo "== [4/5] verify wheel contains patched strings =="
unzip -p "$WHEEL" "gateway/run.py" | grep -q 't("pairing.code_prompt"' || { echo "pairing key missing from wheel!" >&2; exit 1; }
unzip -p "$WHEEL" "gateway/run.py" | grep -q 't("gateway.no_home_channel"' || { echo "home channel key missing from wheel!" >&2; exit 1; }
unzip -p "$WHEEL" "locales/zh.yaml" | grep -q "code_prompt" || { echo "zh.yaml pairing key missing from wheel!" >&2; exit 1; }
echo "verify ok"

# 拷贝产物供 CI 上传
cp "$WHEEL" "$SCRIPT_DIR/../dist-hermes-agent-$WHEEL_NAME" 2>/dev/null || true
echo "artifact ready: $WHEEL"

if [[ "$DO_UPLOAD" == "1" ]]; then
  echo "== [5/5] upload to OSS =="
  command -v ossutil >/dev/null || { echo "ossutil not found; install it or run the hermes-agent-custom-wheel workflow" >&2; exit 1; }
  : "${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
  : "${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"

  ossutil cp -f "$WHEEL" "${OSS_PATH}/hermes-agent/releases/${AGENT_VERSION}/${WHEEL_NAME}"
  ossutil cp -f "$WHEEL" "${OSS_PATH}/hermes-agent/wheelhouse/${WHEEL_NAME}"

  WHEEL_URL="${OSS_PUBLIC_BASE_URL}/hermes-agent/releases/${AGENT_VERSION}/${WHEEL_NAME}"
  cat > "$WORK_DIR/latest.json" <<EOF
{
  "version": "${AGENT_VERSION}",
  "wheelUrl": "${WHEEL_URL}",
  "wheelUrls": [
    "${WHEEL_URL}",
    "${UPSTREAM_REPO}"
  ],
  "wheelhouseUrl": "${OSS_PUBLIC_BASE_URL}/hermes-agent/wheelhouse/",
  "releasedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  ossutil cp -f "$WORK_DIR/latest.json" "${OSS_PATH}/hermes-agent/stable/latest.json"
  echo "published: ${OSS_PUBLIC_BASE_URL}/hermes-agent/stable/latest.json"
fi

echo "== done =="
