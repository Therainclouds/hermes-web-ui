#!/usr/bin/env bash
# Update orchestrator — the single upgrade lifecycle owner on device.
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Architecture,
# § Atomic Swap, § Stage State). Phase (a): the upgrade path never calls
# deploy-source-armbian.sh (bootstrap-only after this phase).
#
# Lifecycle:
#   flock -> journal queued -> preflight (policy / space / node) ->
#   download (curl -C - Range resume) -> extract to staging ->
#   manifest self-check (ship block on version mismatch) ->
#   atomic swap (lastgood capture) -> restart -> healthcheck ->
#   identity stamp -> journal succeeded
#
# Inputs (env, exported by the update runner from the controller request):
#   HERMES_WEB_UI_UPDATE_VERSION            target version (required)
#   HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL(S)  archive mirrors (or
#   HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE    a pre-downloaded archive path)
#   HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256 / HERMES_WEB_UI_UPDATE_EXPECTED_SHA256
#   HERMES_WEB_UI_UPDATE_MANIFEST_SHA256    journal _meta field
#   HERMES_WEB_UI_UPDATE_TASK_ID            task id (generated when absent)
#   HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON  optional {requiredNodeRange...}
#   DEPLOY_DIR                              the deploy tree / deploy symlink
#
# Dry-run (CI + tests): WEBUI_DRY_RUN=1 or WEBUI_UPDATE_SKIP_RESTART=1
# skips only `systemctl restart`; every other step (journal, swap,
# identity) really executes. WEBUI_UPDATE_SKIP_HEALTHCHECK=1 skips the
# post-restart health poll (tests provide their own server when needed).
#
# Exit codes:
#   0 = succeeded or rolled back cleanly (ship block / healthcheck revert)
#   2 = usage error
#   3 = preflight refused (policy / space / configuration)
#   4 = download or archive failure
#   5 = swap failure (no lastgood available)

# -E (errtrace): the ERR trap must fire inside functions — the whole
# lifecycle runs under main(), and without -E in-function failures would
# silently bypass on_task_error.
set -Euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/journal-write.sh
source "${SCRIPT_DIR}/_lib/journal-write.sh"
# shellcheck source=_lib/atomic-swap.sh
source "${SCRIPT_DIR}/_lib/atomic-swap.sh"
# shellcheck source=policy-parse.sh
source "${SCRIPT_DIR}/policy-parse.sh"
# shellcheck source=_lib/identity-stamp.sh
source "${SCRIPT_DIR}/_lib/identity-stamp.sh"

STATE_HOME="$(journal_state_home)"
SWAP_ROOT="${STATE_HOME}/state/swap"
CACHE_DIR="${STATE_HOME}/updates/cache"
LOCK_PATH="${STATE_HOME}/updates/.update.lock"
DEPLOY_DIR="${DEPLOY_DIR:?DEPLOY_DIR is required}"
TARGET_VERSION="${HERMES_WEB_UI_UPDATE_VERSION:-}"
TASK_ID="${HERMES_WEB_UI_UPDATE_TASK_ID:-orchestrator-$(date +%u%H%M%S)-$$}"
MANIFEST_SHA="${HERMES_WEB_UI_UPDATE_MANIFEST_SHA256:-}"
PACKAGE_ARCHIVE="${HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE:-}"
PACKAGE_URLS="${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS:-${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URL:-}}"
PACKAGE_SHA="${HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256:-${HERMES_WEB_UI_UPDATE_EXPECTED_SHA256:-}}"
HEALTHCHECK_URL="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL:-http://127.0.0.1:6060/health}"
HEALTHCHECK_RETRIES="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES:-15}"
HEALTHCHECK_INTERVAL_MS="${HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS:-2000}"
DRY_RUN="${WEBUI_DRY_RUN:-${WEBUI_UPDATE_SKIP_RESTART:-}}"

info() { printf '[update-orchestrator] %s\n' "$*"; }
warn() { printf '[update-orchestrator] WARN: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Locking: flock(1) when present (Linux device), otherwise an atomic
# mkdir lock. Stale locks (mtime > 6h) are broken with a journal note.
# ---------------------------------------------------------------------------
acquire_lock() {
  local lock_parent
  lock_parent="$(dirname "${LOCK_PATH}")"
  mkdir -p "${lock_parent}"
  if command -v flock >/dev/null 2>&1; then
    LOCK_FD=9
    eval "exec 9>>${LOCK_PATH}"
    if flock -n 9; then
      LOCK_MODE="flock"
      return 0
    fi
  else
    if mkdir "${LOCK_PATH}" 2>/dev/null; then
      LOCK_MODE="mkdir"
      return 0
    fi
  fi
  # Held by someone: break it when older than 6h.
  local mtime_now age
  mtime_now="$(stat -c %Y "${LOCK_PATH}" 2>/dev/null || stat -f %m "${LOCK_PATH}" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - mtime_now ))
  if (( age > 21600 )); then
    warn "stale lock (age ${age}s) recovered"
    release_lock_files
    if command -v flock >/dev/null 2>&1; then
      eval "exec 9>>${LOCK_PATH}" && flock -n 9 && { LOCK_MODE="flock"; return 0; }
    fi
    mkdir "${LOCK_PATH}" 2>/dev/null && { LOCK_MODE="mkdir"; return 0; }
  fi
  return 1
}

release_lock_files() {
  if [[ "${LOCK_MODE:-}" == "flock" ]]; then
    eval "exec 9>&-" 2>/dev/null || true
    rm -f "${LOCK_PATH}"
  else
    rmdir "${LOCK_PATH}" 2>/dev/null || rm -rf "${LOCK_PATH}"
  fi
}

LOCK_MODE=""
release_lock() {
  release_lock_files
}
# Safety net: no exit path may leak the lock.
trap 'release_lock_files 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# Error handling: swap/healthcheck failures roll back to lastgood.
# ---------------------------------------------------------------------------
ROLLBACK_READY=0
CURRENT_STAGE="queued"

finish_task() {
  local stage="$1" message="${2:-}"
  journal_append "${TASK_ID}" "${stage}" "${message}" || true
  CURRENT_STAGE="${stage}"
}

ship_block_revert() {
  # Master spec § Stage State → ship block: revert the symlink, move the
  # cached manifest aside for forensics, journal rolled_back, exit 0.
  warn "ship block: manifest version mismatch; reverting to lastgood"
  if [[ "${ROLLBACK_READY}" == "1" ]]; then
    revert_to_lastgood "${DEPLOY_DIR}" || true
  fi
  local cache_file="${CACHE_DIR}/manifest-${HERMES_WEB_UI_UPDATE_CHANNEL:-stable}.json"
  if [[ -f "${cache_file}" ]]; then
    local quarantine
    quarantine="$(journal_quarantine_dir)"
    mkdir -p "${quarantine}"
    local sha_prefix="${MANIFEST_SHA:0:12}"
    mv -f "${cache_file}" "${quarantine}/${sha_prefix}-$(date +%s).json" 2>/dev/null || true
  fi
  finish_task "rolled_back" "update_ship_block: manifest claims ${TARGET_VERSION} but dist does not contain it"
}

on_task_error() {
  local exit_code="$1" line="$2" command_str="${3:-}"
  set +e
  if [[ "${CURRENT_STAGE}" == "succeeded" || "${CURRENT_STAGE}" == "rolled_back" || "${CURRENT_STAGE}" == "failed" ]]; then
    exit "${exit_code}"
  fi
  if (( ROLLBACK_READY )); then
    warn "failure at stage ${CURRENT_STAGE} (line ${line}: ${command_str}); reverting to lastgood"
    if revert_to_lastgood "${DEPLOY_DIR}"; then
      if [[ "${DRY_RUN}" != "1" ]]; then
        systemctl restart hermes-web-ui >/dev/null 2>&1 || true
      fi
      finish_task "rolled_back" "reverted to lastgood after failure at ${CURRENT_STAGE}: ${command_str}"
      exit 0
    fi
  fi
  finish_task "failed" "failure at stage ${CURRENT_STAGE} (line ${line}): ${command_str}"
  exit "${exit_code}"
}

trap 'on_task_error $? $LINENO "$BASH_COMMAND"' ERR

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

preflight_policy() {
  journal_append "${TASK_ID}" "preflighting" "policy/space checks"
  policy_load
  if [[ "${POLICY_INVALID}" == "1" ]]; then
    warn "policy.json invalid; continuing without operator override"
  fi
  if policy_is_paused; then
    warn "updates paused by policy until ${POLICY_PAUSE_UNTIL}"
    return 3
  fi
  if [[ -n "${POLICY_PINNED_VERSION}" && "${POLICY_PINNED_VERSION}" != "${TARGET_VERSION}" ]]; then
    warn "version ${TARGET_VERSION} refused: policy pins ${POLICY_PINNED_VERSION}"
    return 3
  fi
  if policy_is_blocked "${TARGET_VERSION}"; then
    warn "version ${TARGET_VERSION} is blocklisted by policy"
    return 3
  fi
  local override
  override="$(policy_channel_override "${HERMES_WEB_UI_UPDATE_CHANNEL:-stable}")"
  if [[ -n "${override}" && "${override}" != "${TARGET_VERSION}" ]]; then
    warn "version ${TARGET_VERSION} refused: channel override pins ${override}"
    return 3
  fi
  return 0
}

deploy_tree_size_bytes() {
  du -sk "${DEPLOY_DIR}" 2>/dev/null | cut -f1 | awk '{ print $1 * 1024 }'
}

preflight_space() {
  local required_bytes floor_bytes available_bytes
  floor_bytes="${HERMES_WEB_UI_UPDATE_MIN_FREE_SPACE_BYTES:-1073741824}"
  local archive_bytes=0
  [[ -f "${PACKAGE_ARCHIVE:-}" ]] && archive_bytes="$(stat -c %s "${PACKAGE_ARCHIVE}" 2>/dev/null || echo 0)"
  required_bytes=$(( $(deploy_tree_size_bytes 2>/dev/null || echo 0) * 3 / 2 + archive_bytes + 104857600 ))
  available_bytes="$(df -B1 "${STATE_HOME}" 2>/dev/null | awk 'NR==2 { print $4 }' || true)"
  if [[ -z "${available_bytes}" ]]; then
    warn "cannot determine free space on ${STATE_HOME}; continuing"
    return 0
  fi
  if (( available_bytes < required_bytes || available_bytes < floor_bytes )); then
    warn "insufficient disk space: ${available_bytes} free, ${required_bytes} required"
    return 3
  fi
  return 0
}

download_package() {
  journal_append "${TASK_ID}" "downloading" "range-resume via curl"
  local partial="${CACHE_DIR}/partial-${TASK_ID}.part"
  mkdir -p "${CACHE_DIR}"
  local urls=()
  # shellcheck disable=SC2206
  urls=(${PACKAGE_URLS//,/ })
  if [[ ${#urls[@]} -eq 0 ]]; then
    warn "no package URL and no pre-downloaded archive"
    return 4
  fi
  # A crash between "download finished" and "extract" leaves a complete
  # partial behind. Re-running curl -C - would get HTTP 416 on every
  # mirror (range beyond EOF) and deadlock the task, so reuse the
  # partial directly when its checksum already matches.
  if [[ -f "${partial}" && -n "${PACKAGE_SHA}" ]]; then
    local existing
    existing="$(sha256sum "${partial}" 2>/dev/null | cut -d' ' -f1 || true)"
    if [[ "${existing}" == "${PACKAGE_SHA}" ]]; then
      info "partial download already complete and verified; skipping download"
      PACKAGE_ARCHIVE="${partial}"
      return 0
    fi
  fi
  local attempt url
  for url in "${urls[@]}"; do
    info "downloading from ${url} (resume supported)"
    if curl -fL --retry "${HERMES_WEB_UI_UPDATE_DOWNLOAD_RETRIES:-3}" \
        --retry-all-errors -C - --connect-timeout 30 \
        -o "${partial}" "${url}"; then
      PACKAGE_ARCHIVE="${partial}"
      break
    fi
    warn "download failed from ${url}; trying next mirror"
  done
  if [[ ! -f "${PACKAGE_ARCHIVE}" ]]; then
    return 4
  fi
  if [[ -n "${PACKAGE_SHA}" ]]; then
    local actual
    actual="$(sha256sum "${PACKAGE_ARCHIVE}" 2>/dev/null | cut -d' ' -f1 || true)"
    if [[ "${actual}" != "${PACKAGE_SHA}" ]]; then
      warn "sha256 mismatch for ${PACKAGE_ARCHIVE}: expected ${PACKAGE_SHA}, got ${actual}"
      return 4
    fi
  fi
  return 0
}

# Extract into <staging>/, unwrapping a single top-level directory
# (flat-archive tolerance, 6.6.6.31 v0.8.0 incident).
extract_staging() {
  journal_append "${TASK_ID}" "verifying" "extract to staging"
  local staging="${CACHE_DIR}/staging-${TASK_ID}"
  local inner="${CACHE_DIR}/inner-${TASK_ID}"
  rm -rf "${staging}" "${inner}"
  mkdir -p "${staging}" "${inner}"
  if ! tar --force-local -xzf "${PACKAGE_ARCHIVE}" -C "${inner}"; then
    warn "archive extraction failed: ${PACKAGE_ARCHIVE}"
    rm -rf "${inner}" "${staging}"
    return 4
  fi
  local entries=("${inner}"/*)
  if (( ${#entries[@]} == 1 )) && [[ -d "${entries[0]}" && ! -L "${entries[0]}" ]]; then
    while IFS= read -r -d '' entry; do
      mv "${entry}" "${staging}/"
    done < <(find "${entries[0]}" -mindepth 1 -maxdepth 1 -print0)
  else
    while IFS= read -r -d '' entry; do
      mv "${entry}" "${staging}/"
    done < <(find "${inner}" -mindepth 1 -maxdepth 1 -print0)
  fi
  rm -rf "${inner}"
  STAGING_DIR="${staging}"
  return 0
}

manifest_self_check() {
  journal_append "${TASK_ID}" "manifest_self_check" "version string probe"
  local claimed
  claimed="$(identity_tree_version "${STAGING_DIR}")" || claimed=""
  if [[ -z "${claimed}" ]]; then
    warn "staging has no package.json version; self-check skipped"
    return 0
  fi
  if [[ "${claimed}" != "${TARGET_VERSION}" ]]; then
    # v0.7.0-customer class: the manifest claims a version the dist does
    # not carry. Ship block (master spec § Stage State).
    ship_block_revert
    exit 0
  fi
  return 0
}

swap_deploy() {
  journal_append "${TASK_ID}" "installing" "atomic swap into ${DEPLOY_DIR}"
  mkdir -p "${SWAP_ROOT}"

  # First phase-a run on a legacy layout: DEPLOY_DIR is still a real
  # directory. Record it as the rollback point, then make it the
  # symlink target chain (rename the old tree aside atomically).
  # lastgood lives NEXT TO the deploy link (atomic-swap.sh contract:
  # revert_to_lastgood reads dirname(deploy)/lastgood) — not in SWAP_ROOT.
  if [[ -e "${DEPLOY_DIR}" && ! -L "${DEPLOY_DIR}" ]]; then
    local previous="${DEPLOY_DIR}.previous-$(date +%s)"
    if ! mv -T "${DEPLOY_DIR}" "${previous}"; then
      warn "cannot move legacy deploy aside to ${previous}"
      return 5
    fi
    if ! ln -sfn "${previous}" "$(dirname "${DEPLOY_DIR}")/lastgood"; then
      # Undo the rename: never leave the live tree unreachable.
      mv -T "${previous}" "${DEPLOY_DIR}" || true
      warn "cannot record lastgood beside ${DEPLOY_DIR}"
      return 5
    fi
    ROLLBACK_READY=1
    info "legacy deploy captured at ${previous}"
  elif [[ -L "${DEPLOY_DIR}" ]]; then
    if capture_lastgood "${DEPLOY_DIR}"; then
      ROLLBACK_READY=1
    fi
  fi

  if ! atomic_swap_dir "${STAGING_DIR}" "${DEPLOY_DIR}"; then
    return 5
  fi
  return 0
}

restart_runtime() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "dry-run: skipping systemctl restart"
    return 0
  fi
  journal_append "${TASK_ID}" "restarting" "systemctl restart"
  systemctl restart hermes-web-ui
}

run_healthcheck() {
  # Master spec § Testing Strategy: WEBUI_DRY_RUN skips ONLY the systemd
  # restart — every other step (journal, swap, identity, healthcheck)
  # really executes, so the skip flag is the sole opt-out here.
  if [[ "${WEBUI_UPDATE_SKIP_HEALTHCHECK:-}" == "1" ]]; then
    info "healthcheck skipped"
    return 0
  fi
  journal_append "${TASK_ID}" "health_checking" "polling ${HEALTHCHECK_URL}"
  local attempt=0
  local max="${HEALTHCHECK_RETRIES}"
  local interval_s=$(( (HEALTHCHECK_INTERVAL_MS + 999) / 1000 ))
  while (( attempt < max )); do
    if curl -fsS --max-time 10 -o /dev/null "${HEALTHCHECK_URL}"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "${interval_s}"
  done
  warn "healthcheck failed after ${max} attempts"
  return 1
}

stamp_identity_record() {
  journal_append "${TASK_ID}" "identity_stamped" "writing identity.json"
  local installer_sha="${HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256:-}"
  if [[ -z "${installer_sha}" && -f "${SCRIPT_DIR}/update-orchestrator.sh" ]]; then
    installer_sha="$(sha256sum "${SCRIPT_DIR}/update-orchestrator.sh" 2>/dev/null | cut -d' ' -f1 || true)"
  fi
  # Non-fatal: a failed stamp after a verified healthcheck must not roll
  # back a good deploy. Recovery re-stamps on the next boot.
  if stamped="$(stamp_identity "${DEPLOY_DIR%/}" "${installer_sha}")"; then
    info "identity stamped: ${stamped}"
  else
    warn "identity stamp failed (non-fatal); recovery will re-stamp"
  fi
}

main() {
  if [[ -z "${TARGET_VERSION}" ]]; then
    err_usage "HERMES_WEB_UI_UPDATE_VERSION is required"
  fi
  journal_init "${TASK_ID}" "${TARGET_VERSION}" "${MANIFEST_SHA}"
  finish_task "queued" "orchestrator start (target ${TARGET_VERSION})"

  if ! acquire_lock; then
    warn "another update holds the lock; refusing to start"
    exit 3
  fi

  if ! preflight_policy; then
    finish_task "failed" "preflight refused by policy"
    release_lock
    exit 3
  fi
  if ! preflight_space; then
    finish_task "failed" "preflight refused: insufficient disk space"
    release_lock
    exit 3
  fi

  if [[ -z "${PACKAGE_ARCHIVE}" ]]; then
    if ! download_package; then
      finish_task "failed" "download failed after all mirrors"
      release_lock
      exit 4
    fi
  fi

  if ! extract_staging; then
    finish_task "failed" "archive extraction failed"
    release_lock
    exit 4
  fi

  manifest_self_check

  if ! swap_deploy; then
    finish_task "failed" "atomic swap failed"
    release_lock
    exit 5
  fi

  if ! restart_runtime; then
    (( ROLLBACK_READY )) && revert_to_lastgood "${DEPLOY_DIR}" || true
    finish_task "failed" "runtime restart failed"
    release_lock
    exit 5
  fi

  if ! run_healthcheck; then
    if (( ROLLBACK_READY )) && revert_to_lastgood "${DEPLOY_DIR}"; then
      restart_runtime || true
      finish_task "rolled_back" "healthcheck failed; reverted to lastgood"
      release_lock
      exit 0
    fi
    finish_task "failed" "healthcheck failed and no lastgood available"
    release_lock
    exit 5
  fi

  stamp_identity_record
  finish_task "succeeded" "updated to ${TARGET_VERSION}"
  release_lock
}

err_usage() {
  warn "$*"
  exit 2
}

main "$@"
