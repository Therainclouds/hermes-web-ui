#!/usr/bin/env bash
# recover-hermes-data.sh — recover hermes_data from old deploy trees
# after a bad update left the live tree with a bare skeleton.
#
# This tool scans:
#   1. dirname(DEPLOY_DIR)/.previous-* (legacy rename captures)
#   2. dirname(DEPLOY_DIR)/lastgood (symlink to last known good tree)
#
# It compares each candidate's hermes_data against the live tree and
# offers interactive recovery (or --dry-run for a report only).
#
# USAGE:
#   scripts/recover-hermes-data.sh [--dry-run] [--deploy-dir /path]
#
# ENVIRONMENT:
#   DEPLOY_DIR    — deploy directory (default: auto-detect via readlink)
#   DRY_RUN       — set to 1 for dry-run mode (same as --dry-run)

set -Euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/data-inventory.sh
source "${SCRIPT_DIR}/_lib/data-inventory.sh"
# shellcheck source=_lib/journal-write.sh
source "${SCRIPT_DIR}/_lib/journal-write.sh"

info() { printf '[recover-hermes-data] %s\n' "$*"; }
warn() { printf '[recover-hermes-data] WARN: %s\n' "$*" >&2; }

DRY_RUN="${DRY_RUN:-0}"
DEPLOY_DIR="${DEPLOY_DIR:-}"

usage() {
  cat <<'EOF'
Usage: recover-hermes-data.sh [OPTIONS]

Recover hermes_data from old deploy trees after a bad update.

Options:
  --dry-run           Report differences without making changes
  --deploy-dir PATH   Override deploy directory (default: auto-detect)
  -h, --help          Show this help

Environment:
  DEPLOY_DIR          Deploy directory (overridden by --deploy-dir)
  DRY_RUN=1           Same as --dry-run
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --deploy-dir) DEPLOY_DIR="${2:?--deploy-dir requires a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) warn "unknown option: $1"; usage; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve DEPLOY_DIR's parent. Convention match with update-orchestrator.sh:
# lastgood lives NEXT TO the deploy LINK (dirname of the link itself), not
# beside its target. Using dirname(readlink(deploy)) resolves into the
# staging cache dir and never finds lastgood on phase-a layouts (6.6.6.73).
# ---------------------------------------------------------------------------
resolve_deploy_parent() {
  dirname "${1:?}"
}

if [[ -z "${DEPLOY_DIR}" ]]; then
  # Try common locations.
  for candidate in /opt/hermes-web-ui /srv/hermes-web-ui /usr/local/hermes-web-ui; do
    if [[ -e "${candidate}" ]]; then
      DEPLOY_DIR="${candidate}"
      break
    fi
  done
  if [[ -z "${DEPLOY_DIR}" ]]; then
    warn "DEPLOY_DIR not set and no common location found"
    echo "Usage: DEPLOY_DIR=/path/to/deploy $0 [--dry-run]" >&2
    exit 1
  fi
  info "auto-detected DEPLOY_DIR=${DEPLOY_DIR}"
fi

LIVE_HERMES="${DEPLOY_DIR%/}/hermes_data"
DEPLOY_PARENT="$(resolve_deploy_parent "${DEPLOY_DIR}")"

# ---------------------------------------------------------------------------
# Collect candidate trees with hermes_data.
# ---------------------------------------------------------------------------
declare -a candidates=()

# lastgood symlink
lastgood_link="${DEPLOY_PARENT}/lastgood"
if [[ -L "${lastgood_link}" ]]; then
  lastgood_target="$(readlink "${lastgood_link}")"
  if [[ -d "${lastgood_target}/hermes_data" ]]; then
    candidates+=("${lastgood_target}")
  fi
fi

# .previous-* directories
for prev in "${DEPLOY_PARENT}"/.previous-* "${DEPLOY_DIR%.previous-*}/.previous-"*; do
  if [[ -d "${prev}/hermes_data" ]]; then
    # Avoid duplicates
    _found=0
    for existing in "${candidates[@]+"${candidates[@]}"}"; do
      if [[ "${existing}" == "${prev}" ]]; then _found=1; break; fi
    done
    if (( !_found )); then
      candidates+=("${prev}")
    fi
  fi
done 2>/dev/null

if [[ ${#candidates[@]} -eq 0 ]]; then
  info "no candidate trees with hermes_data found near ${DEPLOY_DIR}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Compare each candidate against live.
# ---------------------------------------------------------------------------
live_inv="$(inventory_hermes_data "${DEPLOY_DIR}")"
live_entries="$(echo "${live_inv}" | sed 's/.*"entry_count":\([0-9]*\).*/\1/')"
live_state_db="$(echo "${live_inv}" | sed 's/.*"state_db_bytes":\([0-9]*\).*/\1/')"

info "live hermes_data: entries=${live_entries}, state.db=${live_state_db} bytes"
info ""

best_candidate=""
best_entries=0
best_state_db=0

for candidate in "${candidates[@]}"; do
  cand_inv="$(inventory_hermes_data "${candidate}")"
  cand_entries="$(echo "${cand_inv}" | sed 's/.*"entry_count":\([0-9]*\).*/\1/')"
  cand_state_db="$(echo "${cand_inv}" | sed 's/.*"state_db_bytes":\([0-9]*\).*/\1/')"
  cand_profiles="$(echo "${cand_inv}" | sed 's/.*"profiles_count":\([0-9]*\).*/\1/')"
  cand_total="$(echo "${cand_inv}" | sed 's/.*"total_bytes":\([0-9]*\).*/\1/')"

  info "candidate: ${candidate}"
  info "  entries=${cand_entries}, profiles=${cand_profiles}, state.db=${cand_state_db} bytes, total=${cand_total} bytes"

  # Is this candidate substantially better than live?
  if (( cand_entries > live_entries && cand_entries > best_entries )); then
    best_candidate="${candidate}"
    best_entries="${cand_entries}"
    best_state_db="${cand_state_db}"
  elif (( cand_state_db > live_state_db && cand_state_db > best_state_db )); then
    best_candidate="${candidate}"
    best_entries="${cand_entries}"
    best_state_db="${cand_state_db}"
  fi
  info ""
done

if [[ -z "${best_candidate}" ]]; then
  info "no candidate has more data than the live tree — nothing to recover"
  exit 0
fi

info "best recovery candidate: ${best_candidate}"
info "  (entries: ${live_entries} → ${best_entries}, state.db: ${live_state_db} → ${best_state_db} bytes)"
info ""

if [[ "${DRY_RUN}" == "1" ]]; then
  info "[dry-run] would copy ${best_candidate}/hermes_data → ${LIVE_HERMES}"
  info "[dry-run] re-run without --dry-run to perform the recovery"
  exit 0
fi

# Interactive confirmation.
echo "About to recover hermes_data from:"
echo "  ${best_candidate}/hermes_data"
echo "Into:"
echo "  ${LIVE_HERMES}"
echo ""
read -r -p "Proceed? [y/N] " answer
case "${answer}" in
  [yY]|[yY][eE][sS]) ;;
  *) info "aborted"; exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Perform the recovery.
# ---------------------------------------------------------------------------
backup="${LIVE_HERMES}.pre-recover-$(date +%s)"
if [[ -d "${LIVE_HERMES}" ]]; then
  info "backing up live hermes_data to ${backup}"
  if ! mv -T "${LIVE_HERMES}" "${backup}"; then
    warn "failed to backup live hermes_data"
    exit 1
  fi
fi

if ! cp -a "${best_candidate}/hermes_data" "${LIVE_HERMES}"; then
  warn "recovery copy failed; restoring backup"
  if [[ -d "${backup}" ]]; then
    mv -T "${backup}" "${LIVE_HERMES}" 2>/dev/null || true
  fi
  exit 1
fi

# Clean up the backup on success.
rm -rf "${backup}" 2>/dev/null || true

# Record in journal if possible.
task_id="recover-$(date +%s)-$$"
journal_dir="$(journal_history_dir)"
mkdir -p "${journal_dir}" 2>/dev/null || true
if [[ -d "${journal_dir}" ]]; then
  journal_init "${task_id}" "recover" "" 2>/dev/null || true
  journal_append "${task_id}" "succeeded" "recovered hermes_data from ${best_candidate}" 2>/dev/null || true
fi

post_inv="$(inventory_hermes_data "${DEPLOY_DIR}")"
info "recovery complete. post-recovery inventory: ${post_inv}"
