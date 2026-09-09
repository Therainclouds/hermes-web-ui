# Root-context recursive ownership repair with mount-point and
# dangling-symlink safety.
#
# Used by scripts/update-orchestrator.sh, which always runs as root
# (systemd one-shot). scripts/deploy-source-armbian.sh keeps its own
# copy because it supports a non-root caller (run/SUDO indirection);
# keep the two in sync when changing behaviour.
#
# Safety properties (6.6.6.31 v0.8.0 + 6.6.6.73 v0.8.1):
#   - -h on every chown: the tree may contain dangling symlinks
#     (historical update backups); a bare chown dereferences them,
#     fails ("cannot dereference"), and find -exec exits non-zero,
#     aborting the deploy under set -e.
#   - mountpoint -q pruning: exFAT/NTFS USB mounts do not support
#     ownership changes; never recurse into them.

chown_r_mount_safe_root() {
  local owner="$1"
  local target="$2"
  if [[ -z "${owner}" || -z "${target}" || ! -e "${target}" && ! -L "${target}" ]]; then
    echo "[chown-mount-safe] usage: chown_r_mount_safe_root <owner> <existing-target>" >&2
    return 1
  fi
  chown -h "${owner}" "${target}"
  # The orchestrator passes the deploy SYMLINK (e.g. /opt/hermes-web-ui/src).
  # find(1) in default -P mode does not traverse into an argument symlink,
  # so the recursion below only ever saw the link itself and the tree stayed
  # root-owned (6.6.6.73 canary: npm ci EACCES as APP_USER). Resolve the
  # real tree before traversal; -h keeps symlinks inside the tree safe.
  local real_target
  real_target="$(readlink -f "${target}" 2>/dev/null || true)"
  if [[ -n "${real_target}" && -d "${real_target}" ]]; then
    target="${real_target}"
    # The tree root itself: find -mindepth 1 below skips it, and the -h
    # chown above hit the deploy LINK, not the resolved dir. Without this,
    # APP_USER cannot mkdir at the tree root (npm ci EACCES, canary run 6).
    chown "${owner}" "${target}"
  fi
  if ! command -v mountpoint >/dev/null 2>&1; then
    find "${target}" -mindepth 1 -exec chown -h "${owner}" '{}' +
    return
  fi
  find "${target}" -mindepth 1 -xdev \
    \( -type d -exec mountpoint -q '{}' \; \) -prune \
    -o -exec chown -h "${owner}" '{}' +
}
