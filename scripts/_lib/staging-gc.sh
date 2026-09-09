#!/usr/bin/env bash
# staging-gc.sh — reclaim disk space from update staging leftovers (R4).
#
# Root cause (6.6.6.73, 2026-09-07/08): nine consecutive failed updates
# each left a 3–4.5 GB staging-update-* tree plus partial-*.part
# downloads in updates/cache, driving the disk to 91%. Nothing ever
# cleaned them up.
#
# Contract (update-fleet-spec.md § R4):
#   - Terminal-state self-collection: the orchestrator reclaims its own
#     task's staging/partial after any outcome (success, failure,
#     rollback), subject to the protection rules below.
#   - Startup sweep: unreferenced cache entries older than N days (7 by
#     default) are removed on every orchestrator start.
#   - Space-pressure sweep: when the preflight space gate fails, an
#     aggressive sweep (age >= 1 day) runs once before the update is
#     refused.
#
# Protection rules — never reclaim:
#   1. the live deploy tree (physical target of DEPLOY_DIR; DEPLOY_DIR
#      itself when it is still a real directory),
#   2. the rollback generation (physical target of the `lastgood`
#      symlink beside the deploy link),
#   3. anything else is fair game once it ages past the threshold —
#     concurrent orchestrators cannot coexist (the update lock is held
#     for the whole run, and staging dirs are only ever created under
#     that lock).
#
# Exposed interface:
#   gc_staging_cache [min_age_days]   sweep cache + deploy-parent leftovers
#   gc_task_artifacts                 reclaim the current task's leftovers
#   gc_protected_paths                debug: print protected physical paths
#
# Callers provide: CACHE_DIR, DEPLOY_DIR, TASK_ID, info/warn (from
# update-orchestrator.sh). All functions are safe when the dirs are
# missing or on read-only mounts (rm failures are reported, never fatal).

# Physical paths that must never be reclaimed. One per line; empty
# entries are skipped by gc_is_protected.
gc_protected_paths() {
  local deploy_parent live lastgood_link lastgood_target
  deploy_parent="$(dirname "${DEPLOY_DIR:-/nonexistent}")"
  # Live tree: DEPLOY_DIR may be a symlink into the cache (phase-a
  # layout) or a real directory (legacy layout). readlink -f resolves
  # the former and returns the path unchanged for the latter.
  live="$(readlink -f "${DEPLOY_DIR:-}" 2>/dev/null || true)"
  [[ -n "${live}" ]] || live="${DEPLOY_DIR:-}"
  [[ -n "${live}" ]] && printf '%s\n' "${live}"
  # Rollback generation beside the deploy link.
  lastgood_link="${deploy_parent}/lastgood"
  if [[ -L "${lastgood_link}" ]]; then
    lastgood_target="$(readlink -f "${lastgood_link}" 2>/dev/null || true)"
    [[ -n "${lastgood_target}" ]] && printf '%s\n' "${lastgood_target}"
  fi
}

gc_is_protected() {
  local candidate="${1:?usage: gc_is_protected <path>}"
  local canonical protected
  canonical="$(readlink -f "${candidate}" 2>/dev/null || printf '%s' "${candidate}")"
  [[ -z "${canonical}" ]] && return 1
  while IFS= read -r protected; do
    [[ -z "${protected}" ]] && continue
    if [[ "${canonical}" == "${protected}" || "${canonical}/" == "${protected}/"* ]]; then
      return 0
    fi
  done < <(gc_protected_paths)
  return 1
}

# Path mtime in epoch seconds; 0 when stat cannot read it (the entry is
# then treated as brand new and kept).
gc_path_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# Reclaim one entry. Echoes the bytes freed on success (du is best
# effort; a vanished entry reports 0).
gc_reclaim_entry() {
  local path="${1:?usage: gc_reclaim_entry <path>}" freed
  if gc_is_protected "${path}"; then
    return 0
  fi
  freed="$(du -sk "${path}" 2>/dev/null | cut -f1 || echo 0)"
  if rm -rf -- "${path}" 2>/dev/null; then
    echo "${freed:-0}"
  else
    warn "staging-gc: cannot remove ${path}"
    echo 0
  fi
}

# Sweep update leftovers. min_age_days defaults to 7; the space-pressure
# path passes 1. Frees:
#   CACHE_DIR/staging-* and inner-* dirs, partial-*.part files,
#   <deploy-parent>/<deploy-basename>.previous-* dirs (legacy rename
#   asides superseded by a newer lastgood).
# The manifest cache (manifest-*.json) is intentionally kept — it is
# tiny and speeds up the next check.
gc_staging_cache() {
  local min_age_days="${1:-7}"
  local min_age_seconds=$(( min_age_days * 86400 ))
  local now candidates entry age total_kb=0 freed
  now="$(date +%s)"
  candidates=()
  if [[ -d "${CACHE_DIR:-}" ]]; then
    while IFS= read -r -d '' entry; do
      candidates+=("${entry}")
    done < <(find "${CACHE_DIR}" -mindepth 1 -maxdepth 1 \
      \( -name 'staging-*' -o -name 'inner-*' -o -name 'partial-*.part' \) -print0 2>/dev/null)
  fi
  # Superseded legacy rename-asides beside the deploy link. The current
  # lastgood target is protected by gc_is_protected; older ones are
  # unreferenced garbage.
  local deploy_parent deploy_base
  if [[ -n "${DEPLOY_DIR:-}" ]]; then
    deploy_parent="$(dirname "${DEPLOY_DIR}")"
    deploy_base="$(basename "${DEPLOY_DIR}")"
    if [[ -d "${deploy_parent}" ]]; then
      while IFS= read -r -d '' entry; do
        candidates+=("${entry}")
      done < <(find "${deploy_parent}" -mindepth 1 -maxdepth 1 \
        -name "${deploy_base}.previous-*" -print0 2>/dev/null)
    fi
  fi
  for entry in "${candidates[@]}"; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    # The current task's own artifacts are gc_task_artifacts' business.
    [[ "${entry}" == "${CACHE_DIR}/staging-${TASK_ID:-}" \
      || "${entry}" == "${CACHE_DIR}/inner-${TASK_ID:-}" \
      || "${entry}" == "${CACHE_DIR}/partial-${TASK_ID:-}.part" ]] && continue
    age=$(( now - $(gc_path_mtime "${entry}") ))
    (( age < min_age_seconds )) && continue
    freed="$(gc_reclaim_entry "${entry}")"
    if [[ "${freed}" != "0" ]]; then
      total_kb=$(( total_kb + freed ))
      info "staging-gc: reclaimed $(du -sh "${entry}" 2>/dev/null | cut -f1 || true) (${entry}, age ${age}s)"
    fi
  done
  if (( total_kb > 0 )); then
    info "staging-gc: freed $(( total_kb / 1024 )) MiB (min age ${min_age_days}d)"
  fi
  return 0
}

# Terminal-state self-collection for the current task. Safe in every
# outcome:
#   - success: staging-${TASK_ID} IS the live tree → protected, skipped;
#     the partial download is stale and removed.
#   - failure before swap: nothing references the staging → removed.
#   - rollback: src points back at the lastgood target → the failed new
#     tree is unreferenced → removed.
gc_task_artifacts() {
  local total_kb=0 freed entry
  for entry in \
    "${CACHE_DIR:-}/partial-${TASK_ID:-}.part" \
    "${CACHE_DIR:-}/inner-${TASK_ID:-}" \
    "${CACHE_DIR:-}/staging-${TASK_ID:-}"; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    if gc_is_protected "${entry}"; then
      continue
    fi
    freed="$(gc_reclaim_entry "${entry}")"
    total_kb=$(( total_kb + ${freed:-0} ))
  done
  if (( total_kb > 0 )); then
    info "staging-gc: reclaimed $(( total_kb / 1024 )) MiB from task ${TASK_ID:-} leftovers"
  fi
  return 0
}
