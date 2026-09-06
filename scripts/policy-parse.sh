#!/usr/bin/env bash
# Parses the local operator update policy (schema 1).
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Trigger Model →
# Local override). Precedence is settled: policy.json > env vars >
# default (no override). A missing policy file is NOT an error — it
# simply means "no operator override".
#
# File: ${HERMES_WEB_UI_HOME}/updates/policy.json
#
# Schema 1:
# {
#   "schema": 1,
#   "pinned_version": "0.8.0" | null,
#   "channel_overrides": { "stable": "0.7.20" },
#   "pause_until": "2026-09-15T00:00:00Z" | null,
#   "blocklist": ["0.8.1"],
#   "notes": "free text"
# }
#
# Works both sourced and executed:
#   source scripts/policy-parse.sh; policy_load; policy_is_blocked 0.8.1
#   scripts/policy-parse.sh --print          # human-readable dump
#   scripts/policy-parse.sh --pinned         # echo pinned version or nothing
#
# JSON parsing uses node (present on every device: the Web UI is node).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/journal-write.sh
source "${SCRIPT_DIR}/_lib/journal-write.sh"

POLICY_SCHEMA_VERSION=1

policy_file() {
  printf '%s/updates/policy.json' "$(journal_state_home)"
}

# Shell-escape a value for eval-safe assignment.
policy_sh_quote() {
  printf "'%s'" "$(printf '%s' "${1}" | sed "s/'/'\\\\''/g")"
}

# policy_load [policy_path]
# Sets:
#   POLICY_LOADED          0 = file absent/unreadable (no override), 1 = loaded
#   POLICY_INVALID         1 = file present but refused (schema mismatch / bad JSON)
#   POLICY_PATH            the file that was (or would be) loaded
#   POLICY_PINNED_VERSION  version string or empty
#   POLICY_PAUSE_UNTIL     ISO timestamp or empty
#   POLICY_BLOCKLIST       space-separated versions ("1.2.3 4.5.6")
#   POLICY_CHANNEL_OVERRIDES  space-separated "channel=version" pairs
#   POLICY_NOTES           free text or empty
policy_load() {
  POLICY_LOADED=0
  POLICY_INVALID=0
  POLICY_PINNED_VERSION=""
  POLICY_PAUSE_UNTIL=""
  POLICY_BLOCKLIST=""
  POLICY_CHANNEL_OVERRIDES=""
  POLICY_NOTES=""
  POLICY_PATH="${1:-$(policy_file)}"

  if [[ ! -f "${POLICY_PATH}" ]]; then
    # Absent file means "no operator override" — fall back to env.
    POLICY_PINNED_VERSION="${HERMES_WEB_UI_UPDATE_PINNED_VERSION:-}"
    return 0
  fi

  local parsed
  parsed="$(node -e '
    const fs = require("fs");
    const file = process.argv[1];
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.log("INVALID\tbad json: " + err.message.replace(/\t/g, " "));
      process.exit(0);
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      console.log("INVALID\tnot a json object");
      process.exit(0);
    }
    if (doc.schema !== 1) {
      console.log("INVALID\tunsupported schema: " + JSON.stringify(doc.schema));
      process.exit(0);
    }
    const esc = (s) => String(s).replace(/[\t\n\r]/g, " ");
    if (doc.pinned_version != null) {
      console.log("PINNED\t" + esc(doc.pinned_version));
    }
    if (doc.pause_until != null) {
      console.log("PAUSE\t" + esc(doc.pause_until));
    }
    if (doc.notes != null) {
      console.log("NOTES\t" + esc(doc.notes));
    }
    if (Array.isArray(doc.blocklist)) {
      const blocked = doc.blocklist.filter((v) => typeof v === "string" && v !== "")
        .map((v) => esc(v).replace(/ /g, ""));
      if (blocked.length > 0) console.log("BLOCK\t" + blocked.join(" "));
    }
    if (doc.channel_overrides != null && typeof doc.channel_overrides === "object") {
      const pairs = Object.entries(doc.channel_overrides)
        .filter(([c, v]) => typeof c === "string" && c !== "" && typeof v === "string" && v !== "")
        .map(([c, v]) => esc(c) + "=" + esc(v).replace(/ /g, ""));
      if (pairs.length > 0) console.log("OVERRIDE\t" + pairs.join(" "));
    }
  ' "${POLICY_PATH}" 2>/dev/null)"
  local rc=$?

  if [[ ${rc} -ne 0 || -z "${parsed}" ]]; then
    # node itself failed (missing binary, crash) — treat as no override
    # but keep the env fallback so an operator env pin still applies.
    POLICY_PINNED_VERSION="${HERMES_WEB_UI_UPDATE_PINNED_VERSION:-}"
    return 0
  fi

  local line key value
  while IFS=$'\t' read -r key value; do
    if [[ "${key}" == "INVALID" ]]; then
      echo "[policy] WARN update_policy_invalid: ${value}; refusing ${POLICY_PATH}" >&2
      POLICY_INVALID=1
      POLICY_PINNED_VERSION="${HERMES_WEB_UI_UPDATE_PINNED_VERSION:-}"
      return 0
    fi
    case "${key}" in
      PINNED)   POLICY_PINNED_VERSION="${value}" ;;
      PAUSE)    POLICY_PAUSE_UNTIL="${value}" ;;
      NOTES)    POLICY_NOTES="${value}" ;;
      BLOCK)    POLICY_BLOCKLIST="${value}" ;;
      OVERRIDE) POLICY_CHANNEL_OVERRIDES="${value}" ;;
    esac
  done <<< "${parsed}"

  POLICY_LOADED=1
  return 0
}

# policy_is_blocked <version> → exit 0 when blocked
policy_is_blocked() {
  local version="${1:-}"
  [[ -z "${version}" ]] && return 1
  local v
  for v in ${POLICY_BLOCKLIST}; do
    [[ "${v}" == "${version}" ]] && return 0
  done
  return 1
}

# policy_channel_override <channel> → echoes version or nothing
policy_channel_override() {
  local channel="${1:-}"
  [[ -z "${channel}" ]] && return 0
  local pair
  for pair in ${POLICY_CHANNEL_OVERRIDES}; do
    if [[ "${pair%%=*}" == "${channel}" ]]; then
      printf '%s' "${pair#*=}"
      return 0
    fi
  done
  return 0
}

# policy_is_paused [now_epoch_seconds] → exit 0 when paused
policy_is_paused() {
  [[ -z "${POLICY_PAUSE_UNTIL}" ]] && return 1
  local now="${1:-$(date +%s)}"
  local until_epoch
  until_epoch="$(date -d "${POLICY_PAUSE_UNTIL}" +%s 2>/dev/null || node -e '
    console.log(Math.floor(Date.parse(process.argv[1]) / 1000) || 0);
  ' "${POLICY_PAUSE_UNTIL}" 2>/dev/null || echo 0)"
  [[ "${until_epoch}" -gt "${now}" ]]
}

# CLI entry points (only when executed, not sourced).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  policy_load
  case "${1:-}" in
    --print)
      echo "policy_path=${POLICY_PATH}"
      echo "loaded=${POLICY_LOADED}"
      echo "invalid=${POLICY_INVALID}"
      echo "pinned_version=${POLICY_PINNED_VERSION}"
      echo "pause_until=${POLICY_PAUSE_UNTIL}"
      echo "blocklist=${POLICY_BLOCKLIST}"
      echo "channel_overrides=${POLICY_CHANNEL_OVERRIDES}"
      echo "notes=${POLICY_NOTES}"
      ;;
    --pinned) printf '%s' "${POLICY_PINNED_VERSION}" ;;
    --blocked) policy_is_blocked "${2:-}" ;;
    --paused) policy_is_paused ;;
    --override)
      v="$(policy_channel_override "${2:-}")"
      printf '%s' "${v}"
      ;;
    *) echo "usage: policy-parse.sh [--print|--pinned|--blocked <ver>|--paused|--override <channel>]" >&2; exit 1 ;;
  esac
fi
