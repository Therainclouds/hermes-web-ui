# JSONL journal writer for the phase (a) update system.
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Journal).
#
# One journal file per update task:
#   ${HERMES_WEB_UI_HOME}/updates/history/<taskId>.jsonl
#
# First line is the `_meta` record; every later line is one stage
# transition. Writes are append-only with a best-effort fsync per
# append. This file is meant to be sourced, NOT executed directly.
#
# USAGE (from update-orchestrator.sh, recover-interrupted-update.sh, or
# any update-adjacent script):
#
#   source "${SCRIPT_DIR}/_lib/journal-write.sh"
#   journal_init   "<taskId>" "0.8.1" "<manifestSha>"
#   journal_append "<taskId>" "downloading" "range-resume from byte 4096"
#
# JSON parsing for the validator is done with node (guaranteed on
# device: the Web UI itself is a node app). Writing stays pure bash so
# the hot path costs no process spawn.

# Resolve the Web UI state home the same way the deploy scripts do.
# shellcheck disable=SC2123
journal_state_home() {
  printf '%s' "${HERMES_WEB_UI_HOME:-${HERMES_WEBUI_STATE_DIR:-${HOME:-/tmp}/.hermes-web-ui}}"
}

journal_history_dir() {
  printf '%s/updates/history' "$(journal_state_home)"
}

journal_quarantine_dir() {
  printf '%s/updates/quarantine' "$(journal_state_home)"
}

# The stage vocabulary. update-system-overview.md § Stage vocabulary
# lists the original 20; phase (a) adds manifest_self_check and
# identity_stamped. journal-validator.sh sources this list — keep it
# the single source of truth.
JOURNAL_STAGES=(
  idle
  queued
  preflighting
  checking
  resolving_version
  manifest_self_check
  downloading
  verifying
  backing_up
  reconciling_env
  starting
  installing_dependencies
  installing
  stopping_runtime
  restarting
  starting_runtime
  health_checking
  identity_stamped
  succeeded
  failed
  rolled_back
)

journal_stage_valid() {
  local stage="${1:-}"
  local s
  for s in "${JOURNAL_STAGES[@]}"; do
    [[ "${s}" == "${stage}" ]] && return 0
  done
  return 1
}

# Minimal JSON string escaping for controlled inputs (task ids, stage
# names, orchestrator messages). Handles backslash, double quote, and
# the control characters bash can carry in variables.
journal_json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "${s}"
}

journal_fsync() {
  # GNU coreutils `sync -f` fsyncs a single file; not all platforms
  # support it, and journal durability must never fail the update.
  sync -f "$1" 2>/dev/null || true
}

journal_file_for() {
  local task_id="${1:-}"
  if [[ -z "${task_id}" ]]; then
    echo "[journal] usage: journal_* <taskId>" >&2
    return 1
  fi
  printf '%s/%s.jsonl' "$(journal_history_dir)" "${task_id}"
}

# journal_init <taskId> <version> <manifestSha>
journal_init() {
  local task_id="${1:-}"
  local version="${2:-}"
  local manifest_sha="${3:-}"
  if [[ -z "${task_id}" || -z "${version}" ]]; then
    echo "[journal] usage: journal_init <taskId> <version> <manifestSha>" >&2
    return 1
  fi
  local dir file
  dir="$(journal_history_dir)"
  file="${dir}/${task_id}.jsonl"
  mkdir -p "${dir}"
  if [[ -f "${file}" ]]; then
    # Re-initialising an existing task must not rewind its history.
    echo "[journal] task ${task_id} already has a journal; keeping it" >&2
    return 0
  fi
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"_meta":{"taskId":"%s","version":"%s","manifestSha":"%s","startedAt":"%s"}}\n' \
    "$(journal_json_escape "${task_id}")" \
    "$(journal_json_escape "${version}")" \
    "$(journal_json_escape "${manifest_sha}")" \
    "${now}" > "${file}"
  journal_fsync "${file}"
}

# journal_append <taskId> <stage> [message]
journal_append() {
  local task_id="${1:-}"
  local stage="${2:-}"
  local message="${3:-}"
  if [[ -z "${task_id}" ]]; then
    echo "[journal] usage: journal_append <taskId> <stage> [message]" >&2
    return 1
  fi
  if ! journal_stage_valid "${stage}"; then
    # Unknown stage names are a hard error: a typo must never silently
    # corrupt the journal vocabulary the validator depends on.
    echo "[journal] unknown stage '${stage}' (task ${task_id})" >&2
    return 2
  fi
  local file
  file="$(journal_file_for "${task_id}")" || return 1
  if [[ ! -f "${file}" ]]; then
    echo "[journal] journal for task ${task_id} not initialised" >&2
    return 1
  fi
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"stage":"%s","message":"%s","at":"%s"}\n' \
    "${stage}" \
    "$(journal_json_escape "${message}")" \
    "${now}" >> "${file}"
  journal_fsync "${file}"
}
