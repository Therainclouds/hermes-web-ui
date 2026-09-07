#!/usr/bin/env bash
# Validates per-task JSONL update journals and quarantines corrupt ones.
#
# Master spec: docs/harness/source-deploy-refactor.md (§ Journal → Validator).
#
# Runs standalone (wired into hermes-web-ui-update.service ExecStartPre=
# by the orchestrator work package). Contract:
#   - Every file in updates/history/*.jsonl must parse as JSONL whose
#     first line is the _meta record and whose stages are all in the
#     vocabulary.
#   - A file that fails any check is MOVED to updates/quarantine/ with a
#     timestamp suffix and a WARN is printed. Corruption never blocks
#     the next update task, so this script exits 0 after quarantining.
#   - Only a usage error or a missing/unreadable history dir the caller
#     was told to scan exits non-zero.
#
# JSON parsing uses node (present on every device: the Web UI is node).
#
# USAGE:
#   scripts/journal-validator.sh              # scan the default history dir
#   JOURNAL_VALIDATE_DIR=/path scripts/journal-validator.sh
#   scripts/journal-validator.sh --dir /path  # explicit scan target

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/journal-write.sh
source "${SCRIPT_DIR}/_lib/journal-write.sh"

SCAN_DIR="${JOURNAL_VALIDATE_DIR:-}"
case "${1:-}" in
  --dir) SCAN_DIR="${2:-}"; shift 2 ;;
  --dir=*) SCAN_DIR="${1#--dir=}"; shift ;;
esac
if [[ -z "${SCAN_DIR}" ]]; then
  SCAN_DIR="$(journal_history_dir)"
fi

if [[ ! -d "${SCAN_DIR}" ]]; then
  # Nothing to scan is a clean no-op: first boot has no history yet.
  echo "[journal-validator] no history dir at ${SCAN_DIR}; nothing to validate"
  exit 0
fi

QUARANTINE_DIR="$(journal_quarantine_dir)"

shopt -s nullglob
journals=("${SCAN_DIR}"/*.jsonl)
shopt -u nullglob

if [[ ${#journals[@]} -eq 0 ]]; then
  echo "[journal-validator] no journals in ${SCAN_DIR}; nothing to validate"
  exit 0
fi

node - "${SCAN_DIR}" "${QUARANTINE_DIR}" <<'NODE'
const fs = require('fs');
const path = require('path');

const [scanDir, quarantineDir] = process.argv.slice(2);
// Keep in sync with JOURNAL_STAGES in _lib/journal-write.sh.
const STAGES = new Set([
  'idle', 'queued', 'preflighting', 'checking', 'resolving_version',
  'manifest_self_check', 'downloading', 'verifying', 'backing_up',
  'reconciling_env', 'starting', 'installing_dependencies', 'installing',
  'stopping_runtime', 'restarting', 'starting_runtime', 'health_checking',
  'identity_stamped', 'succeeded', 'failed', 'rolled_back',
]);

function validateFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return 'empty journal';
  let meta;
  try {
    meta = JSON.parse(lines[0]);
  } catch {
    return 'first line is not valid JSON';
  }
  if (!meta || meta._meta === undefined) return 'first line missing _meta record';
  const m = meta._meta;
  if (typeof m.taskId !== 'string' || m.taskId === '') return '_meta.taskId missing';
  if (typeof m.version !== 'string' || m.version === '') return '_meta.version missing';
  if (typeof m.startedAt !== 'string' || m.startedAt === '') return '_meta.startedAt missing';

  const base = path.basename(file, '.jsonl');
  if (m.taskId !== base) return `_meta.taskId '${m.taskId}' does not match file name '${base}'`;

  for (let i = 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return `line ${i + 1} is not valid JSON`;
    }
    if (entry._meta !== undefined) return `line ${i + 1} repeats _meta record`;
    if (typeof entry.stage !== 'string' || !STAGES.has(entry.stage)) {
      return `line ${i + 1} has unknown stage '${entry.stage}'`;
    }
    if (entry.message !== undefined && typeof entry.message !== 'string') {
      return `line ${i + 1} message is not a string`;
    }
    if (typeof entry.at !== 'string' || entry.at === '') return `line ${i + 1} missing timestamp`;
  }
  return null;
}

const journals = fs.readdirSync(scanDir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort();
if (journals.length === 0) {
  console.log(`[journal-validator] no journals in ${scanDir}; nothing to validate`);
  process.exit(0);
}

let bad = 0;
for (const name of journals) {
  const file = path.join(scanDir, name);
  const reason = validateFile(file);
  if (reason === null) continue;
  bad += 1;
  fs.mkdirSync(quarantineDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(quarantineDir, `${name.replace(/\.jsonl$/, '')}-${stamp}.jsonl`);
  fs.renameSync(file, dest);
  console.warn(`[journal-validator] WARN update_journal_corrupt: ${name} (${reason}); quarantined to ${dest}`);
}
console.log(`[journal-validator] ${journals.length - bad}/${journals.length} journals valid`);
process.exit(0);
NODE
