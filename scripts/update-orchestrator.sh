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
#   atomic swap (lastgood capture + preserve hermes_data/node_modules) ->
#   build_deploy (pre-built: npm ci + rebuild | source: full build) ->
#   restart -> healthcheck -> identity stamp -> journal succeeded
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
# shellcheck source=_lib/chown-mount-safe.sh
source "${SCRIPT_DIR}/_lib/chown-mount-safe.sh"

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
# Capability fingerprint — the server preflight reads this line from the
# deployed orchestrator to decide whether the current tree can safely
# preserve data during an update. Grow the list as new capabilities land.
# Required words:
#   hermes_data_preservation — copy old tree's hermes_data across swap
#   prebuilt_dist            — skip npm run build when dist/ ships prebuilt
#   node_modules_preservation — copy old tree's node_modules when lock matches
# ---------------------------------------------------------------------------
ORCHESTRATOR_CAPABILITIES="hermes_data_preservation prebuilt_dist node_modules_preservation"

# Resolve node binary once at startup. The orchestrator runs as root on
# devices but node often lives in /opt/node-*/bin or /usr/local/bin. We
# probe the device PATH, then the app user's home bin, then a few common
# install roots. Falls back to empty if nothing is found; callers MUST
# degrade gracefully (skip version checks, never fail a successful
# update because of a missing node binary).
resolve_node_bin() {
  local bin=""
  bin="$(command -v node 2>/dev/null || true)"
  if [[ -n "${bin}" && -x "${bin}" ]]; then
    NODE_BIN="${bin}"
    return 0
  fi
  local app_user="${HERMES_WEB_UI_UPDATE_APP_USER:-${APP_USER:-}}"
  local app_home=""
  if [[ -n "${app_user}" ]]; then
    app_home="$(getent passwd "${app_user}" 2>/dev/null | cut -d: -f6 || true)"
  fi
  local candidate
  for candidate in \
    "${app_home:+${app_home}/.local/bin/node}" \
    "/opt/node-v23/bin/node" \
    "/opt/node/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      NODE_BIN="${candidate}"
      return 0
    fi
  done
  warn "node binary not found; version checks will be skipped"
  NODE_BIN=""
  return 0
}
NODE_BIN=""

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
  # The controller passes HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS as a
  # JSON array string (["u1","u2"]) while legacy callers may pass a bare
  # space/comma list — strip JSON punctuation, then split.
  # shellcheck disable=SC2206
  urls=($(printf '%s' "${PACKAGE_URLS}" | tr -d '[]()"'"'"'' | tr ',' ' '))
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

# Copy the previous deploy's hermes_data into the freshly swapped
# DEPLOY_DIR when the new tree is missing it (source-deploy archives
# carry only a skeleton). Resolves the lastgood symlink set up by
# capture_lastgood / the legacy .previous-* rename. Idempotent: a
# no-op when the new tree already carries a full hermes_data.
preserve_hermes_data_across_swap() {
  local new_hermes="${DEPLOY_DIR%/}/hermes_data"
  # lastgood is the canonical rollback symlink beside the deploy link.
  local lastgood_link="$(dirname "${DEPLOY_DIR}")/lastgood"
  local old_tree=""
  if [[ -L "${lastgood_link}" ]]; then
    old_tree="$(readlink "${lastgood_link}")"
  fi
  # For the legacy-first-run path the old tree was renamed aside;
  # lastgood was just written as a symlink to it, so the readlink
  # above already covers it. No extra branch needed.

  if [[ -z "${old_tree}" || ! -d "${old_tree}" ]]; then
    info "no previous deploy tree; skipping hermes_data preservation"
    return 0
  fi

  local old_hermes="${old_tree%/}/hermes_data"
  if [[ ! -d "${old_hermes}" ]]; then
    info "previous deploy has no hermes_data; nothing to preserve"
    return 0
  fi

  # If the new tree already has a populated hermes_data (e.g. the
  # archive shipped one), leave it alone — the upgrade intentionally
  # carries data.
  if [[ -d "${new_hermes}" ]] && [[ "$(find "${new_hermes}" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)" -gt 2 ]]; then
    info "new deploy already carries hermes_data ($(find "${new_hermes}" -mindepth 1 -maxdepth 1 | wc -l) entries); preserving as-is"
    return 0
  fi

  info "preserving hermes_data from ${old_hermes} into new deploy"
  # Back up the skeleton so a merge failure is recoverable.
  if [[ -e "${new_hermes}" ]]; then
    mv -T "${new_hermes}" "${new_hermes}.skeleton-bak" 2>/dev/null || true
  fi
  if ! cp -a "${old_hermes}" "${new_hermes}"; then
    warn "hermes_data copy failed; restoring skeleton"
    if [[ -d "${new_hermes}.skeleton-bak" ]]; then
      mv -T "${new_hermes}.skeleton-bak" "${new_hermes}" 2>/dev/null || true
    fi
    return 5
  fi
  # Drop the skeleton backup on success.
  rm -rf "${new_hermes}.skeleton-bak" 2>/dev/null || true
  info "hermes_data restored ($(du -sh "${new_hermes}" 2>/dev/null | cut -f1))"
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

  # Preserve hermes_data (agent profiles, state.db, session history,
  # skills, caches…) across upgrades. The source archive carries only
  # a bare skeleton (or nothing at all); the real user data lives in
  # the previous deploy tree. Without this step the first phase-a
  # upgrade on a populated device wipes every profile, session, and
  # cached model — 6.6.6.73 v0.8.1 post-mortem.
  #
  # Strategy: if the old tree has hermes_data and the new tree does
  # not (or has only a skeleton), copy the old tree's hermes_data
  # into the new DEPLOY_DIR. The staging skeleton (if any) is kept
  # as a backup so a truly new file in the skeleton is not lost.
  preserve_hermes_data_across_swap

  # Preserve node_modules from the old tree (optimization). Pre-built
  # archives ship dist/ but not node_modules/; copying from the old
  # tree avoids a redundant `npm ci` (~30s on ARM). If the copy fails,
  # build_deploy() falls through to a fresh npm ci.
  preserve_node_modules_across_swap

  # The staging tree was downloaded and extracted by this root unit, so
  # the swapped-in deploy is root-owned; the service runs as APP_USER and
  # its ExecStartPre cannot even mkdir certs/ (6.6.6.73 v0.8.1). Repair
  # ownership on the live target before restart.
  local app_user="${HERMES_WEB_UI_UPDATE_APP_USER:-${APP_USER:-}}"
  if [[ -n "${app_user}" ]] && id "${app_user}" >/dev/null 2>&1; then
    if ! chown_r_mount_safe_root "${app_user}:$(id -gn "${app_user}")" "${DEPLOY_DIR%/}"; then
      warn "deploy tree ownership repair failed for ${app_user}"
      return 5
    fi
    info "deploy tree ownership repaired: ${app_user}"
  else
    warn "APP_USER unknown; skipping deploy ownership repair"
  fi
  return 0
}

# Run a single shell command as the app user with the correct PATH so
# node/npm are reachable. The orchestrator itself runs as root (systemd
# oneshot), but node_modules and dist/ must be owned by APP_USER because
# the live service runs under that account.
run_build_as_app_user() {
  local command="${1:?usage: run_build_as_app_user <shell-command>}"
  local app_user="${HERMES_WEB_UI_UPDATE_APP_USER:-${APP_USER:-}}"
  if [[ -z "${app_user}" ]]; then
    warn "APP_USER unknown; cannot run build command as app user"
    return 1
  fi
  local app_home
  app_home="$(getent passwd "${app_user}" 2>/dev/null | cut -d: -f6 || echo "/home/${app_user}")"
  # Detect node binary so the PATH covers the device install location
  # (e.g. /opt/node-v23/bin). Falls back to PATH lookup when node is
  # already on the default search path.
  local node_bin node_dir path_env
  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -n "${node_bin}" ]]; then
    node_dir="$(dirname "${node_bin}")"
  else
    node_dir=""
  fi
  path_env="${node_dir:+${node_dir}:}${app_home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  # Pass proxy env vars so devices behind a corporate proxy can reach
  # the npm registry mirror.
  local proxy_env=()
  for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    if [[ -n "${!v:-}" ]]; then proxy_env+=("${v}=${!v}"); fi
  done
  # shellcheck disable=SC2029
  su - "${app_user}" -s /bin/bash -c "HOME='${app_home}' PATH='${path_env}' ${proxy_env[*]} ${command}"
}

# Copy the previous deploy's node_modules/ into the freshly swapped
# DEPLOY_DIR when the new tree is missing it. This is an optimization:
# when the archive is pre-built (has dist/ but no node_modules), copying
# the old tree's node_modules avoids a redundant `npm ci` that would
# otherwise take 30+ seconds on ARM. Same pattern as preserve_hermes_data.
preserve_node_modules_across_swap() {
  local new_nm="${DEPLOY_DIR%/}/node_modules"
  # Skip if already populated (the archive shipped one, or a prior run)
  if [[ -d "${new_nm}" ]] && [[ "$(find "${new_nm}" -mindepth 1 -maxdepth 1 2>/dev/null | head -1 | wc -l)" -gt 0 ]]; then
    info "node_modules already present; skipping preservation"
    return 0
  fi

  local lastgood_link="$(dirname "${DEPLOY_DIR}")/lastgood"
  local old_tree=""
  if [[ -L "${lastgood_link}" ]]; then
    old_tree="$(readlink "${lastgood_link}")"
  fi

  if [[ -z "${old_tree}" || ! -d "${old_tree}" ]]; then
    info "no previous deploy tree; skipping node_modules preservation"
    return 0
  fi

  local old_nm="${old_tree%/}/node_modules"
  if [[ ! -d "${old_nm}" ]]; then
    info "previous deploy has no node_modules; nothing to preserve"
    return 0
  fi

  # Compare package-lock.json sha of old tree vs new tree. If they differ,
  # preserved node_modules would be STALE (missing new deps or carrying
  # changed versions) — the next build_deploy's idempotency check would
  # skip npm ci entirely (nm_populated && dist_ready) and the service
  # would crash on missing deps. Refusing to copy is the safe choice AND
  # saves hundreds of MB of wasted I/O on ARM.
  local new_lock="${DEPLOY_DIR%/}/package-lock.json"
  local old_lock="${old_tree%/}/package-lock.json"
  local new_lock_sha="" old_lock_sha=""
  if [[ -f "${new_lock}" ]]; then
    new_lock_sha="$(sha256sum "${new_lock}" 2>/dev/null | cut -d' ' -f1 || true)"
  fi
  if [[ -f "${old_lock}" ]]; then
    old_lock_sha="$(sha256sum "${old_lock}" 2>/dev/null | cut -d' ' -f1 || true)"
  fi
  if [[ -n "${new_lock_sha}" && -n "${old_lock_sha}" && "${new_lock_sha}" != "${old_lock_sha}" ]]; then
    info "lockfile changed (old=${old_lock_sha:0:12}, new=${new_lock_sha:0:12}); skipping node_modules preservation (npm ci needed)"
    return 0
  fi

  info "preserving node_modules from ${old_nm} into new deploy"
  if cp -a "${old_nm}" "${new_nm}"; then
    info "node_modules restored ($(du -sh "${new_nm}" 2>/dev/null | cut -f1))"
    return 0
  else
    warn "node_modules copy failed (will run npm ci as fallback)"
    rm -rf "${new_nm}" 2>/dev/null || true
    return 0
  fi
}

# Install dependencies and build the swapped-in deploy tree on device.
#
# Two paths, auto-detected from the archive contents:
#
# PRE-BUILT (archive ships dist/server/index.js):
#   CI built dist/ ahead of time. Only `npm ci --ignore-scripts` (fast)
#   + `npm rebuild node-pty` (native bindings) are needed. No vue-tsc,
#   no full build toolchain required. ~2 minutes on ARM vs ~10 minutes.
#
# SOURCE (archive ships only source code):
#   Legacy path: full `npm ci + npm run build`. Requires complete
#   build toolchain (vue-tsc, build-essential, etc.) on device.
#
# Idempotency: after a successful npm ci, we write a lockfile marker
# `${nm}/.hermes-lock-sha256` containing sha256(package-lock.json). On
# retry or next update, the idempotency check requires the marker to
# match the CURRENT lockfile sha — if dependencies changed between
# versions, the marker mismatches and a fresh npm ci runs. This closes
# the stale-node_modules bug that could bite any release with dep
# changes when preserve_node_modules copied an older tree's deps.
#
# Placement in the lifecycle (master spec § Architecture):
#   swap_deploy -> preserve_hermes_data -> preserve_node_modules -> build_deploy -> restart_runtime
#
# Failure semantics: a build failure after a successful swap means the
# new tree is unusable, so we revert to lastgood (same policy as a
# healthcheck failure).
build_deploy() {
  local app_user="${HERMES_WEB_UI_UPDATE_APP_USER:-${APP_USER:-}}"
  local dist_index="${DEPLOY_DIR%/}/dist/server/index.js"
  local nm="${DEPLOY_DIR%/}/node_modules"
  local lock="${DEPLOY_DIR%/}/package-lock.json"
  local lock_marker="${nm}/.hermes-lock-sha256"
  local current_lock_sha=""
  if [[ -f "${lock}" ]]; then
    current_lock_sha="$(sha256sum "${lock}" 2>/dev/null | cut -d' ' -f1 || true)"
  fi

  # Idempotency: skip when node_modules is populated AND dist/ already
  # carries the expected version AND the lockfile marker matches the
  # current lockfile sha. The marker prevents false positives when
  # preserve_node_modules copied stale dependencies from an older tree
  # whose package-lock.json no longer matches the new archive.
  local nm_populated=0
  if [[ -d "${nm}" ]] && [[ "$(find "${nm}" -mindepth 1 -maxdepth 1 2>/dev/null | head -1 | wc -l)" -gt 0 ]]; then
    nm_populated=1
  fi
  local lock_marker_valid=0
  if (( nm_populated )) && [[ -f "${lock_marker}" && -n "${current_lock_sha}" ]]; then
    local marker_sha
    marker_sha="$(cat "${lock_marker}" 2>/dev/null || true)"
    if [[ "${marker_sha}" == "${current_lock_sha}" ]]; then
      lock_marker_valid=1
    fi
  fi
  local dist_ready=0
  if [[ -f "${dist_index}" ]]; then
    local dist_version=""
    if [[ -n "${NODE_BIN}" ]]; then
      dist_version="$("${NODE_BIN}" -e "try{console.log(require('${DEPLOY_DIR}/package.json').version)}catch(e){}" 2>/dev/null || true)"
    fi
    if [[ "${dist_version}" == "${TARGET_VERSION}" ]]; then
      dist_ready=1
    fi
  fi
  if (( nm_populated && lock_marker_valid && dist_ready )); then
    info "deploy tree already built for ${TARGET_VERSION} (lock marker matches); skipping npm ci + build"
    return 0
  fi

  # Dry-run (CI / tests): no APP_USER exists, no npm registry reachable.
  # Skip the build step — same rationale as restart_runtime() skipping
  # systemctl. The production path always has APP_USER set by systemd.
  if [[ "${DRY_RUN}" == "1" && -z "${app_user}" ]]; then
    info "dry-run: APP_USER unknown; skipping npm ci + build"
    return 0
  fi

  if [[ -z "${app_user}" ]]; then
    warn "APP_USER unknown; cannot build deploy tree"
    return 5
  fi

  # Detect pre-built archive: dist/server/index.js exists in the deployed tree.
  # When present, skip the full build and only reconcile dependencies.
  local prebuilt=0
  if [[ -f "${dist_index}" ]]; then
    prebuilt=1
    info "pre-built archive detected (dist/server/index.js present); skipping full build"
  fi

  # --- Install dependencies -------------------------------------------
  if (( ! nm_populated || ! lock_marker_valid )); then
    journal_append "${TASK_ID}" "installing_dependencies" "npm ci --ignore-scripts as ${app_user}"
    info "installing dependencies into ${DEPLOY_DIR}"
    if ! run_build_as_app_user "cd '${DEPLOY_DIR}' && npm ci --ignore-scripts --registry=https://registry.npmmirror.com"; then
      warn "npm ci failed"
      (( ROLLBACK_READY )) && revert_to_lastgood "${DEPLOY_DIR}" || true
      return 5
    fi
    # Write the lockfile marker so the next invocation knows node_modules
    # matches the current package-lock.json.
    if [[ -n "${current_lock_sha}" ]]; then
      printf '%s\n' "${current_lock_sha}" > "${lock_marker}" 2>/dev/null || true
    fi
  else
    info "node_modules valid (lock marker matches); skipping dependency install"
  fi

  # --- Rebuild optional native bindings --------------------------------
  # node-pty is a native module (binding.gyp) that needs node-gyp +
  # build-essential. --ignore-scripts above skipped it; rebuild here.
  # Failure is non-fatal — terminal feature degrades gracefully.
  info "rebuilding optional native bindings"
  run_build_as_app_user "cd '${DEPLOY_DIR}' && npm rebuild node-pty 2>/dev/null" || \
    warn "node-pty rebuild failed (terminal feature will be disabled)"

  # --- Build (only for source archives) --------------------------------
  if (( ! prebuilt )); then
    journal_append "${TASK_ID}" "building" "rm -rf dist + npm run build"
    info "cleaning dist/ and building ${TARGET_VERSION}"
    if ! run_build_as_app_user "cd '${DEPLOY_DIR}' && rm -rf dist && npm run build"; then
      warn "npm run build failed"
      (( ROLLBACK_READY )) && revert_to_lastgood "${DEPLOY_DIR}" || true
      return 5
    fi
  else
    info "pre-built dist/ already present; skipping npm run build"
  fi

  # --- Post-build ownership repair -------------------------------------
  # npm ci + npm run build run as APP_USER, but some files (e.g. certs/
  # generated by ExecStartPre) may still be root-owned after the swap.
  # Re-run the tree-wide repair to cover any stragglers.
  if id "${app_user}" >/dev/null 2>&1; then
    chown_r_mount_safe_root "${app_user}:$(id -gn "${app_user}")" "${DEPLOY_DIR%/}" || \
      warn "post-build ownership repair failed for ${app_user}"
  fi

  # --- Verify ----------------------------------------------------------
  if [[ ! -f "${dist_index}" ]]; then
    warn "build succeeded but dist/server/index.js is missing"
    (( ROLLBACK_READY )) && revert_to_lastgood "${DEPLOY_DIR}" || true
    return 5
  fi
  # Version verification uses the resolved NODE_BIN (or bare `node` if
  # resolve_node_bin succeeded). When node is entirely absent, we
  # degrade gracefully: version consistency was already enforced by
  # manifest_self_check (the dist/server/index.js file and the
  # package.json version are the SAME archive contents), so a missing
  # node binary is NOT a reason to revert a successful update.
  if [[ -n "${NODE_BIN}" ]]; then
    local actual_version
    actual_version="$("${NODE_BIN}" -e "console.log(require('${DEPLOY_DIR}/package.json').version)" 2>/dev/null || true)"
    if [[ -n "${actual_version}" && "${actual_version}" != "${TARGET_VERSION}" ]]; then
      warn "post-build version mismatch: expected ${TARGET_VERSION}, got ${actual_version}"
      (( ROLLBACK_READY )) && revert_to_lastgood "${DEPLOY_DIR}" || true
      return 5
    fi
    info "deploy tree built and verified: ${actual_version:-unknown}"
  else
    info "deploy tree built (node missing; version check skipped, manifest_self_check covers consistency)"
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

  # Resolve node binary once so version-check call sites use a stable path
  # and degrade gracefully on devices without node on root's PATH.
  resolve_node_bin

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

  if ! build_deploy; then
    finish_task "failed" "dependency install or build failed"
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
