# Harness Overview

This harness turns recurring project knowledge into files and checks that an
agent can discover without chat history.

## Goals

- Make repository context legible through short maps and deeper docs.
- Keep architecture constraints close to the code they protect.
- Give agents a deterministic validation path before opening or updating a PR.
- Prefer mechanical checks over reminder text when a rule can be verified.

## Entry Points

- `AGENTS.md` is the root map for coding agents.
- `ARCHITECTURE.md` documents package boundaries and state ownership.
- `DEVELOPMENT.md` remains the contributor rules and command reference.
- `docs/harness/validation.md` maps change types to checks.
- `docs/harness/upstream-sync-runbook.md` documents the standard upstream sync path to `main`.
- `docs/harness/worktree-runbook.md` explains isolated worktree development.
- `docs/harness/pr-review.md` provides a PR self-review checklist.
- `docs/harness/update-system-overview.md` maps the device update pipeline and lists real production incidents.
- `docs/harness/update-reconciliation-plan.md` is the five-phase plan for environment reconciliation. Specs per phase live under `.zcode/plans/update-reconciliation-phase*.md`.
- `docs/harness/source-deploy-refactor.md` is the phase (a) spec for trustworthy source-deploy updates (atomic swap, identity, recovery). Companion to the reconciliation plan.
- `scripts/harness-check.mjs` enforces baseline repository invariants.

## Operating Model

1. Read the root map and the specific doc for the task.
2. Make the smallest scoped change.
3. Add or update focused tests when behavior changes.
4. Run `npm run harness:check` and the relevant validation commands.
5. If a failure pattern repeats, improve this harness with docs, tests, scripts,
   or CI instead of relying on a longer prompt.

## What Belongs In The Harness

- Facts that future agents must know to work safely.
- Checklists that prevent repeated PR review comments.
- Scripts that fail fast on repository-wide invariants.
- Runbooks for local, CI, release, and desktop packaging flows.

Do not put long implementation notes in `AGENTS.md`. Add them under `docs/` and
link to them from the map.
