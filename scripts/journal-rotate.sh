#!/usr/bin/env bash
# Rotates per-task update journals, keeping the newest N (default 30).
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Journal → Validator).
#
# Older journal files are MOVED to updates/quarantine/ (never deleted —
# forensics always wins) with a `retained_30_rotation` marker file next
# to them so operators can tell rotation from corruption.
#
# USAGE:
#   scripts/journal-rotate.sh                  # keep 30, default dirs
#   scripts/journal-rotate.sh --keep 10
#   JOURNAL_ROTATE_DIR=/path scripts/journal-rotate.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/journal-write.sh
source "${SCRIPT_DIR}/_lib/journal-write.sh"

KEEP=30
ROTATE_DIR="${JOURNAL_ROTATE_DIR:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="${2:-30}"; shift 2 ;;
    --keep=*) KEEP="${1#--keep=}"; shift ;;
    --dir) ROTATE_DIR="${2:-}"; shift 2 ;;
    --dir=*) ROTATE_DIR="${1#--dir=}"; shift ;;
    *) echo "[journal-rotate] unknown arg: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "${ROTATE_DIR}" ]]; then
  ROTATE_DIR="$(journal_history_dir)"
fi

if [[ ! -d "${ROTATE_DIR}" ]]; then
  echo "[journal-rotate] no history dir at ${ROTATE_DIR}; nothing to rotate"
  exit 0
fi

shopt -s nullglob
journals=("${ROTATE_DIR}"/*.jsonl)
shopt -u nullglob

if [[ ${#journals[@]} -le ${KEEP} ]]; then
  echo "[journal-rotate] ${#journals[@]} journals, keeping ${KEEP}; nothing to rotate"
  exit 0
fi

# Sort by mtime, newest first, and move everything past the keep window.
mapfile -t sorted < <(ls -t "${journals[@]}")
quarantine="$(journal_quarantine_dir)"
mkdir -p "${quarantine}"

moved=0
for file in "${sorted[@]:${KEEP}}"; do
  name="$(basename "${file}")"
  mv "${file}" "${quarantine}/${name}"
  # Marker distinguishes rotation from corruption quarantine.
  : > "${quarantine}/${name}.retained_${KEEP}_rotation"
  moved=$((moved + 1))
done

echo "[journal-rotate] kept ${KEEP}, rotated ${moved} journals to ${quarantine}"
exit 0
