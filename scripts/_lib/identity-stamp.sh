# Identity stamping for the phase (a) update system.
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Identity Schema).
# Writes ${HERMES_WEB_UI_HOME}/state/identity.json — the device's record
# of what it actually runs:
#   { schema, capturedAt, version, distSha256, installerScriptSha256,
#     agentManifestSha, commitSha }
#
# `agentManifestSha` is the settled sentinel "0.0.0-noop" until phase (c)
# ships a real agent channel. Treat it as an opaque string.
#
# This file is meant to be sourced, NOT executed directly.
#
# USAGE (from update-orchestrator.sh and recover-interrupted-update.sh):
#   source "${SCRIPT_DIR}/_lib/identity-stamp.sh"
#   stamp_identity <deploy-tree-root>   # reads <root>/dist + package.json

IDENTITY_SCHEMA_VERSION=1
IDENTITY_AGENT_MANIFEST_SHA_SENTINEL="0.0.0-noop"

identity_state_file() {
  printf '%s/state/identity.json' "$(journal_state_home)"
}

# Resolve the node binary. Callers may pre-set NODE_BIN (update-orchestrator
# does at source time); otherwise fall back to PATH and the known device
# install locations. Root's PATH frequently lacks node on ARM devices
# (6.6.6.73 canary: /opt/node-v23/bin only), which silently disabled the
# manifest self-check version probe before this resolver existed.
identity_node_bin() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    printf '%s' "${NODE_BIN}"
    return 0
  fi
  local bin
  bin="$(command -v node 2>/dev/null || true)"
  if [[ -n "${bin}" && -x "${bin}" ]]; then
    printf '%s' "${bin}"
    return 0
  fi
  local candidate
  for candidate in /opt/node-v23/bin/node /opt/node/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

# Read the installed version from a deploy tree's package.json.
identity_tree_version() {
  local tree_root="${1:?usage: identity_tree_version <deploy-tree>}"
  local node_bin
  node_bin="$(identity_node_bin)" || return 1
  "${node_bin}" -e '
    try {
      const pkg = require(String(process.argv[1]));
      if (pkg && typeof pkg.version === "string") { console.log(pkg.version); process.exit(0); }
    } catch { /* fall through */ }
    process.exit(1);
  ' "${tree_root}/package.json" 2>/dev/null
}

# Deterministic hash over a tree's dist/: sha256 of the sorted
# "sha256  relative-path" lines of every file. Stable across machines,
# so the build pipeline can compute the same value (WP4).
identity_dist_sha256() {
  local tree_root="${1:?usage: identity_dist_sha256 <deploy-tree>}"
  local node_bin
  node_bin="$(identity_node_bin)" || return 1
  "${node_bin}" -e '
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const root = String(process.argv[1]);
    const distDir = path.join(root, "dist");
    const lines = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        const sha = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        lines.push(`${sha}  ${path.relative(root, full).split(path.sep).join("/")}`);
      }
    };
    if (!fs.existsSync(distDir)) { process.exit(2); }
    walk(distDir);
    const treeHash = crypto.createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
    console.log(treeHash);
  ' "${tree_root}" 2>/dev/null
}

# stamp_identity <deploy-tree-root> [installer_script_sha256] [commit_sha]
# Emits the written version on stdout; non-zero when the tree has no
# readable version (refusing to stamp garbage).
stamp_identity() {
  local tree_root="${1:?usage: stamp_identity <deploy-tree> [installerSha] [commitSha]}"
  local installer_sha="${2:-}"
  local commit_sha="${3:-${HERMES_WEB_UI_UPDATE_COMMIT_SHA:-}}"

  local version dist_sha
  version="$(identity_tree_version "${tree_root}")" || {
    echo "[identity] deploy tree has no readable package.json version: ${tree_root}" >&2
    return 1
  }
  dist_sha="$(identity_dist_sha256 "${tree_root}")" || {
    echo "[identity] deploy tree has no dist/ directory: ${tree_root}" >&2
    return 1
  }
  if [[ -z "${installer_sha}" ]]; then
    installer_sha="${HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256:-}"
  fi
  if [[ -z "${commit_sha}" && -f "${tree_root}/.git-commit" ]]; then
    commit_sha="$(head -c 64 "${tree_root}/.git-commit" | tr -d '[:space:]')"
  fi

  local file
  file="$(identity_state_file)"
  mkdir -p "$(dirname "${file}")"
  local tmp="${file}.tmp"
  local captured_at
  captured_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "${tmp}" <<EOF
{
  "schema": ${IDENTITY_SCHEMA_VERSION},
  "capturedAt": "${captured_at}",
  "version": "${version}",
  "distSha256": "${dist_sha}",
  "installerScriptSha256": "${installer_sha}",
  "agentManifestSha": "${IDENTITY_AGENT_MANIFEST_SHA_SENTINEL}",
  "commitSha": "${commit_sha}"
}
EOF
  mv -f "${tmp}" "${file}"
  printf '%s' "${version}"
}
