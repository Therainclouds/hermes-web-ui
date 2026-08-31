# Upstream Sync Runbook

Use this runbook when syncing new code from `upstream/main` into this
repository's `main` branch.

## Goal

Keep `origin/main` as the only active product baseline. Do not reuse the old
`integration/rebuild-from-upstream` branch for future sync work.

Standard path:

```bash
upstream/main -> merge/upstream-main-YYYYMMDD -> main
```

## Before You Start

1. Fetch both remotes and confirm they are reachable.
2. Start from a clean local `main`.
3. Create a fresh merge branch from `main`.
4. Review whether the upstream diff touches any protected local features.

```bash
git fetch origin --prune
git fetch upstream --prune
git checkout main
git pull origin main
git status
git log --oneline --left-right main...upstream/main
```

## Protected Features

These local features must survive every upstream sync:

- Expert Center
- Experts Marketplace
- Independent update channel
- USB identification

Review related code, config, and resources before resolving conflicts. Do not
allow upstream changes to silently remove or bypass these behaviors.

For the full branded-feature inventory, file protection levels, and conflict
resolution rules, see [upstream-merge-rules.md](./upstream-merge-rules.md).

## Sync Procedure

1. Create a dated merge branch from `main`.

```bash
git checkout -b merge/upstream-main-YYYYMMDD
```

2. Merge `upstream/main` into the merge branch.

```bash
git merge --no-ff upstream/main
```

3. Resolve conflicts with these rules:

- Keep routes thin and preserve controller/service boundaries.
- Preserve Web UI state under `HERMES_WEB_UI_HOME` or
  `HERMES_WEBUI_STATE_DIR`.
- Keep Hermes Agent state separate from Web UI state.
- Preserve local update-channel, USB, and marketplace behavior.
- Handle design copy, changelog, and locale wording manually. Do not bulk-edit
  those files with automated merge tooling.

4. After conflicts are resolved, review the final diff before validation.

```bash
git status
git diff --stat main...HEAD
```

## Validation Checklist

Run the smallest relevant checks first. For a typical upstream sync to `main`,
the minimum expected validation is:

```bash
npm run harness:check
npm run build
```

Escalate when the sync touches shared or risky areas:

```bash
npm run test
npm run test:e2e
```

Pay extra attention to:

- release consistency across version files
- auth and profile flows
- update and deployment paths
- group chat, bridge, and workspace sync behavior
- USB and recovery-related routes and services
- **script `+x` mode bits after upstream sync** — if upstream adds or modifies a `.sh`/`.py` under `scripts/`, Windows contributors must run `git update-index --chmod=+x scripts/<new-file>` before committing. Verify with `git ls-tree HEAD -- scripts/ | grep -v '\._' | grep -E '\.(sh|py)$' | awk '{print $1, $4}'` — every row should start with `100755`. Missing `+x` silently breaks systemd `ExecStartPre` on the device (203/EXEC) with no log trail. See `scripts/_lib/fixup-script-modes.sh` and `AGENTS.md` "Deployed scripts must carry +x".
- **stateful service path resolution** — any new server-side service that stores user data must use `getWebUiHome()` from `packages/server/src/config.ts`, never read `process.env.HERMES_WEB_UI_HOME` directly and never fall back to `process.cwd()`. See `AGENTS.md` "Stateful services must resolve paths through getWebUiHome()".

## Finish The Sync

When validation passes, merge the dated branch back into `main`:

```bash
git checkout main
git merge --no-ff merge/upstream-main-YYYYMMDD
git push origin main
```

Delete the local merge branch only after the merge result is confirmed.

## Forbidden Shortcuts

- Do not sync through `integration/rebuild-from-upstream`.
- Do not merge directly into `main` before conflict review and validation.
- Do not mix unrelated refactors into an upstream sync.
- Do not auto-merge locale or design-text conflicts without manual review.
- Do not treat archived branches as active baselines.

## Archived Branch Policy

The old `integration/rebuild-from-upstream` line is archived for history only.
If an old branch contains something worth keeping, migrate it by explicit
`cherry-pick` or file-level manual restore. Never reintroduce it by branch-wide
merge.
