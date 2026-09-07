# Atomic symlink-swap primitives for the phase (a) update system.
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Atomic Swap).
#
# The deploy tree is reached through a stable symlink (the "deploy
# link"). Updates extract into a staging directory, then point the
# deploy link at the staging dir with a rename(2) — one syscall, atomic
# for every reader. The previous target is recorded in a sibling
# `lastgood` symlink, so rollback is a single symlink swap. No full
# backups, no hardlinks (fragile across mount points — v0.8.0 chown
# incident).
#
# Layout beside the deploy link:
#   <parent>/deploy     -> symlink to the live tree
#   <parent>/lastgood   -> symlink to the previous live tree (after the
#                          first successful swap)
#
# This file is meant to be sourced, NOT executed directly.
#
# USAGE (from update-orchestrator.sh):
#   source "${SCRIPT_DIR}/_lib/atomic-swap.sh"
#   capture_lastgood  "${DEPLOY_LINK}"    # before the swap
#   atomic_swap_dir   "${STAGING_DIR}" "${DEPLOY_LINK}"
#   revert_to_lastgood "${DEPLOY_LINK}"   # on healthcheck failure
#
# Exit codes:
#   2 = usage error
#   3 = revert requested but no lastgood exists
#   4 = deploy link exists but is not a symlink (layout drift — refuse)

# Create <name> as a symlink to <target> and atomically move it over
# <link>. rename(2) over an existing symlink replaces it atomically;
# readers never observe a missing link.
_swap_atomic_symlink() {
  local link="${1:?usage: _swap_atomic_symlink <link> <target>}"
  local target="${2:?usage: _swap_atomic_symlink <link> <target>}"
  local parent tmp
  parent="$(dirname "${link}")"
  tmp="${parent}/.swap-tmp-$$-${RANDOM}"
  mkdir -p "${parent}"
  ln -sfn "${target}" "${tmp}"
  mv -Tf "${tmp}" "${link}"
}

# Read the symlink target of <link>; empty output when not a symlink.
_swap_readlink() {
  local link="${1:-}"
  if [[ -L "${link}" ]]; then
    readlink "${link}"
  fi
}

# capture_lastgood <deploy-link>
# Records the deploy link's current target as the rollback point.
# Called BEFORE atomic_swap_dir. If deploy does not exist yet (first
# run / bootstrap), there is nothing to capture and this is a no-op.
capture_lastgood() {
  local deploy_link="${1:?usage: capture_lastgood <deploy-link>}"
  if [[ ! -L "${deploy_link}" ]]; then
    return 0
  fi
  local prev
  prev="$(_swap_readlink "${deploy_link}")"
  if [[ -z "${prev}" ]]; then
    return 0
  fi
  _swap_atomic_symlink "$(dirname "${deploy_link}")/lastgood" "${prev}"
}

# atomic_swap_dir <staging-path> <deploy-link>
# Points <deploy-link> at <staging-path> atomically.
# Refuses (exit 4) if the deploy link exists but is not a symlink —
# that means a non-phase-a layout and swapping would destroy it.
atomic_swap_dir() {
  local staging="${1:?usage: atomic_swap_dir <staging-path> <deploy-link>}"
  local deploy_link="${2:?usage: atomic_swap_dir <staging-path> <deploy-link>}"
  if [[ -z "${staging}" || -z "${deploy_link}" ]]; then
    echo "[atomic-swap] usage: atomic_swap_dir <staging-path> <deploy-link>" >&2
    return 2
  fi
  if [[ ! -d "${staging}" ]]; then
    echo "[atomic-swap] staging dir does not exist: ${staging}" >&2
    return 2
  fi
  if [[ -e "${deploy_link}" && ! -L "${deploy_link}" ]]; then
    echo "[atomic-swap] deploy link is not a symlink; refusing to overwrite: ${deploy_link}" >&2
    return 4
  fi
  # Resolve to an absolute path so the symlink survives cwd changes.
  local abs_staging
  abs_staging="$(cd "${staging}" && pwd)" || return 2
  _swap_atomic_symlink "${deploy_link}" "${abs_staging}"
}

# revert_to_lastgood <deploy-link>
# Single-symlink rollback. Idempotent: reverting twice points deploy at
# the same lastgood target again. Missing lastgood is a hard error (3):
# a caller that cannot roll back must not silently continue.
revert_to_lastgood() {
  local deploy_link="${1:?usage: revert_to_lastgood <deploy-link>}"
  local lastgood
  lastgood="$(dirname "${deploy_link}")/lastgood"
  local target
  target="$(_swap_readlink "${lastgood}")"
  if [[ -z "${target}" || ! -d "${target}" ]]; then
    echo "[atomic-swap] no usable lastgood for ${deploy_link} (target: '${target}')" >&2
    return 3
  fi
  _swap_atomic_symlink "${deploy_link}" "${target}"
}
