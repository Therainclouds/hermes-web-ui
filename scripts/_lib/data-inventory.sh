#!/usr/bin/env bash
# Data inventory helpers for the update orchestrator.
#
# inventory_hermes_data <tree> produces a compact JSON describing the
# hermes_data directory inside a deploy tree. The orchestrator uses it
# before and after swap to verify that preservation did not silently
# discard user data (the class of bug seen in 6.6.6.73).
#
# Output (single line, no trailing newline):
#   {"entry_count":N,"state_db_bytes":N,"profiles_count":N,"total_bytes":N}
#
# When hermes_data does not exist or is empty, returns zeros.

# ---------------------------------------------------------------------------
# inventory_hermes_data <tree>
#   Prints JSON to stdout. Returns 0 always (never aborts on missing dirs).
# ---------------------------------------------------------------------------
inventory_hermes_data() {
  local tree="${1%/}"
  local hermes="${tree}/hermes_data"

  local entry_count=0 state_db_bytes=0 profiles_count=0 total_bytes=0

  if [[ -d "${hermes}" ]]; then
    entry_count="$(find "${hermes}" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"
    entry_count="${entry_count##* }"
    entry_count="${entry_count:-0}"

    if [[ -f "${hermes}/state.db" ]]; then
      state_db_bytes="$(wc -c < "${hermes}/state.db" 2>/dev/null || echo 0)"
      state_db_bytes="${state_db_bytes##* }"
      state_db_bytes="${state_db_bytes:-0}"
    fi

    if [[ -d "${hermes}/profiles" ]]; then
      profiles_count="$(find "${hermes}/profiles" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"
      profiles_count="${profiles_count##* }"
      profiles_count="${profiles_count:-0}"
    fi

    total_bytes="$(du -sb "${hermes}" 2>/dev/null | cut -f1)"
    total_bytes="${total_bytes##* }"
    total_bytes="${total_bytes:-0}"
  fi

  printf '{"entry_count":%d,"state_db_bytes":%d,"profiles_count":%d,"total_bytes":%d}' \
    "${entry_count}" "${state_db_bytes}" "${profiles_count}" "${total_bytes}"
}

# ---------------------------------------------------------------------------
# verify_hermes_data_preserved <pre_json> <post_json>
#   Compares two inventory outputs. Returns 0 when preservation looks
#   healthy, 1 when it failed. Prints a diagnostic to stdout.
#
#   Failure criteria (either triggers rollback):
#   - state.db shrank below 90% of original AND original was >1MB
#   - top-level entry count halved AND original was >2
# ---------------------------------------------------------------------------
verify_hermes_data_preserved() {
  local pre_json="$1" post_json="$2"

  # Extract fields — pure bash, no jq dependency.
  local pre_state_db pre_entries pre_total
  local post_state_db post_entries post_total

  pre_state_db="${pre_json#*\"state_db_bytes\":}"
  pre_state_db="${pre_state_db%%[,\}]*}"
  pre_entries="${pre_json#*\"entry_count\":}"
  pre_entries="${pre_entries%%[,\}]*}"
  pre_total="${pre_json#*\"total_bytes\":}"
  pre_total="${pre_total%%[,\}]*}"

  post_state_db="${post_json#*\"state_db_bytes\":}"
  post_state_db="${post_state_db%%[,\}]*}"
  post_entries="${post_json#*\"entry_count\":}"
  post_entries="${post_entries%%[,\}]*}"
  post_total="${post_json#*\"total_bytes\":}"
  post_total="${post_total%%[,\}]*}"

  # Exemption: old tree had no substantial data → nothing to verify.
  if (( pre_entries <= 2 )); then
    echo "pre-swap hermes_data had ${pre_entries} entries (≤2); skipping verification"
    return 0
  fi

  # Check state.db size: must not shrink below 90% when original >1MB.
  local one_mb=1048576
  if (( pre_state_db > one_mb )); then
    local threshold=$(( pre_state_db * 90 / 100 ))
    if (( post_state_db < threshold )); then
      echo "state.db shrank from ${pre_state_db} to ${post_state_db} bytes (threshold ${threshold}); preservation failed"
      return 1
    fi
  fi

  # Check entry count: must not halve.
  if (( pre_entries > 2 )); then
    local half=$(( pre_entries / 2 ))
    if (( post_entries < half )); then
      echo "hermes_data entries dropped from ${pre_entries} to ${post_entries} (threshold ${half}); preservation failed"
      return 1
    fi
  fi

  echo "hermes_data verified: entries ${pre_entries}→${post_entries}, state.db ${pre_state_db}→${post_state_db} bytes, total ${pre_total}→${post_total} bytes"
  return 0
}
