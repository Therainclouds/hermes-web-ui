#!/usr/bin/env bash
# Deterministic recovery for interrupted updates (phase a).
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Architecture →
# failure paths). Wired into hermes-web-ui-update.service ExecStartPre=
# and safe to run manually. Five paths, all idempotent:
#
#   1. stale lock (mtime > 6h)            -> broken, journal note
#   2. leftover swap temp symlinks        -> removed
#   3. deploy symlink to a missing target -> revert to lastgood
#   4. deploy tree identity stale         -> re-stamp identity.json
#      (settled: prefer re-stamping identity over re-swapping)
#   5. clean state                        -> no-op
#
# Partial downloads are left in place for resume (WP2 layout); they are
# not recovery blockers.
#
# Exit 0 in every detected-or-clean case; only a usage error exits 2.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/journal-write.sh
source "${SCRIPT_DIR}/_lib/journal-write.sh"
# shellcheck source=_lib/atomic-swap.sh
source "${SCRIPT_DIR}/_lib/atomic-swap.sh"
# shellcheck source=_lib/identity-stamp.sh
source "${SCRIPT_DIR}/_lib/identity-stamp.sh"

STATE_HOME="$(journal_state_home)"
SWAP_ROOT="${STATE_HOME}/state/swap"
CACHE_DIR="${STATE_HOME}/updates/cache"
LOCK_PATH="${STATE_HOME}/updates/.update.lock"
DEPLOY_DIR="${DEPLOY_DIR:?DEPLOY_DIR is required}"
STALE_LOCK_SECONDS="${HERMES_WEB_UI_UPDATE_STALE_LOCK_SECONDS:-21600}" # 6h

info() { printf '[update-recovery] %s\n' "$*"; }
warn() { printf '[update-recovery] WARN: %s\n' "$*" >&2; }

recovery_note() {
  local message="$1"
  local task_id="recovery-$(date +%u%H%M%S)-$$"
  journal_init "${task_id}" "$(identity_tree_version "${DEPLOY_DIR%/}" 2>/dev/null || echo unknown)" ""
  journal_append "${task_id}" "checking" "${message}" || true
}

clean_stale_lock() {
  if [[ ! -e "${LOCK_PATH}" ]]; then
    return 1
  fi
  # A live flock fd keeps mtime irrelevant only if flock is in use; the
  # orchestrator removes its own lock on exit, so any lock older than
  # the stale window here belonged to a crashed run.
  local mtime age
  mtime="$(stat -c %Y "${LOCK_PATH}" 2>/dev/null || stat -f %m "${LOCK_PATH}" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - mtime ))
  if (( age <= STALE_LOCK_SECONDS )); then
    return 1
  fi
  rm -rf "${LOCK_PATH}"
  recovery_note "lock_recovered: stale update lock (age ${age}s) removed"
  info "stale lock removed (age ${age}s)"
  return 0
}

clean_leftover_swap_temps() {
  local parent found=1
  parent="$(dirname "${DEPLOY_DIR}")"
  for leftover in "${parent}"/.swap-tmp-*; do
    if [[ -e "${leftover}" || -L "${leftover}" ]]; then
      rm -rf "${leftover}"
      found=0
    fi
  done
  # Legacy half-swap marker: deploy.new prepared but never swapped in.
  if [[ -L "${parent}/deploy.new" ]]; then
    local target
    target="$(readlink "${parent}/deploy.new")"
    if [[ -d "${target}" && ! -e "${DEPLOY_DIR}" ]]; then
      mv -T "${parent}/deploy.new" "${DEPLOY_DIR}"
      recovery_note "half_swap_finished: deploy.new was pending; swap completed"
      info "finished half-swap from ${target}"
      return 0
    fi
    rm -f "${parent}/deploy.new"
    found=0
  fi
  return "${found}"
}

revert_broken_deploy() {
  if [[ ! -L "${DEPLOY_DIR}" ]]; then
    return 1
  fi
  local target
  target="$(readlink "${DEPLOY_DIR}")"
  if [[ -d "${target}" ]]; then
    return 1
  fi
  warn "deploy symlink points at missing target: ${target}"
  if revert_to_lastgood "${DEPLOY_DIR}"; then
    recovery_note "broken_deploy_reverted: deploy pointed at missing ${target}; reverted to lastgood"
    info "reverted deploy to lastgood"
    return 0
  fi
  recovery_note "broken_deploy_unresolved: deploy pointed at missing ${target} and no lastgood exists"
  return 0
}

restamp_stale_identity() {
  local file
  file="$(identity_state_file)"
  [[ -f "${file}" ]] || return 1
  local recorded current
  recorded="$(node -e '
    try {
      const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (doc && typeof doc.version === "string") { console.log(doc.version); }
    } catch { /* unknown */ }
  ' "${file}" 2>/dev/null)"
  current="$(identity_tree_version "${DEPLOY_DIR%/}" 2>/dev/null)" || current=""
  if [[ -z "${recorded}" || -z "${current}" || "${recorded}" == "${current}" ]]; then
    return 1
  fi
  # Settled decision: identity drift with a healthy tree is repaired by
  # re-stamping, never by re-swapping or reinstalling.
  if stamp_identity "${DEPLOY_DIR%/}" "${HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256:-}" >/dev/null 2>&1; then
    recovery_note "identity_restamped: recorded ${recorded} but tree serves ${current}; identity.json updated"
    info "identity re-stamped: ${recorded} -> ${current}"
    return 0
  fi
  warn "identity drift detected (${recorded} vs ${current}) but re-stamp failed"
  return 1
}

main() {
  clean_stale_lock || true
  clean_leftover_swap_temps || true
  revert_broken_deploy || true
  restamp_stale_identity || true
  info "recovery sweep complete"
  exit 0
}

main "$@"
