# Agent Map

This file is a short map for coding agents. Keep detailed guidance in `docs/`
and keep this file small enough to fit into every task context.

## First Reads

- `DEVELOPMENT.md` - project commands, coding rules, test rules, and PR shape.
- `ARCHITECTURE.md` - package boundaries, data ownership, and runtime flow.
- `docs/harness/README.md` - how this repository is prepared for agent work.
- `docs/harness/validation.md` - which checks to run for each change type.
- `docs/harness/upstream-sync-runbook.md` - how to sync `upstream/main` into local `main` safely.
- `docs/harness/worktree-runbook.md` - isolated local dev and test setup.
- `docs/harness/pr-review.md` - self-review checklist before pushing.

## Common Commands

```bash
npm ci --ignore-scripts
npm run harness:check
npm run test
npm run test:e2e
npm run build
```

Use the smallest relevant check while iterating. Before a broad PR, run
`npm run harness:check`, `npm run test:coverage`, `npm run test:e2e`, and
`npm run build`.

## Code Ownership Map

- `packages/client/src` - Vue 3 client, stores, routes, i18n, API helpers.
- `packages/server/src` - Koa API, Socket.IO, persistence, Hermes integration.
- `packages/desktop` - Electron wrapper, bundled Python/Hermes runtime, release artifacts.
- `tests/client`, `tests/server`, `tests/shared` - Vitest coverage.
- `tests/e2e` - Playwright browser coverage with mocked backend services.
- `.github/workflows` - CI, release, Docker, and desktop packaging automation.

## Hard Rules

- Keep routes thin: put request handling in controllers and reusable behavior in services.
- Keep Web UI state under `HERMES_WEB_UI_HOME` or `HERMES_WEBUI_STATE_DIR`.
- Keep Hermes Agent state separate from Web UI state.
- Keep in-app updates orchestration-only unless a release plan explicitly enables a wider scope.
- Do not make Hermes Agent upgrades the default side effect of Web UI updates.
- Treat bootstrap, runtime reconcile, Web UI update, and Hermes Agent upgrade as separate seams.
- **Modifying a script in `.github/device-package-release.json#packageAllowlist`** (e.g. `scripts/install-device-package.sh`, `scripts/hermes-web-ui-update-runner.sh`, `scripts/deploy-source-armbian.sh`) means devices will compare their on-disk install script against the manifest's `installerScriptSha256` on the next update. After such a change, verify `npm run build:device-package` re-emits a manifest whose `installerScriptPath` and `installerScriptSha256` are present, and ensure the change ships in the next device-package release (0.7.x tag). Without that, devices will refuse the update with `update_installer_script_stale` until the next release that includes the fix.
- Register local API routes before proxy catch-all routes.
- Use structured APIs and argument arrays instead of shell string construction.
- Add user-facing strings to every locale file.
- Do not mix unrelated refactors into a bug fix.
- **Building/CSP/Storage/Process**: see [meeting-asr-safety-audit.md](./docs/harness/meeting-asr-safety-audit.md) for hard rules derived from the v0.7.7 speaker-diarization incident.
- **Device update strategy**: `WEBUI_UPDATE_STRATEGY` and `WEBUI_UPDATE_PACKAGE_TYPE` default to `source-deploy`. New device installations, must not change this default — `device-package` is opt-in only. The default is set in `scripts/deploy-source-armbian.sh` (function-level `WEBUI_UPDATE_STRATEGY="${...:-source-deploy}"`) and the build manifest is generated with matching `packageType` by `scripts/build-device-package.mjs`.
- **Manifest `packageType` ↔ device `WEBUI_UPDATE_PACKAGE_TYPE` must match**: the manifest's `packageType` field, validated by `packages/server/src/services/update/manifest-client.ts` (one of the two `update_manifest_invalid` throw sites), must equal the device's `WEBUI_UPDATE_PACKAGE_TYPE`. Mismatch makes the device log `[update] source-deploy manifest lookup failed, falling back to npm registry` and silently fall through to a different update path — leaving stale `staging/` files and triggering `409 update_in_progress` on subsequent updates. The CI guard test `tests/release/device-package-manifest.test.ts` enforces this contract.
- **Source-deploy manifest requires sourceUrl/sourceSha256**: when `packageType=source-deploy`, `manifest.sourceUrl` and `manifest.sourceSha256` must be present (devices download from `sourceUrl` and verify against `sourceSha256`). When `packageType=device-package`, `manifest.installerScriptSha256` must be present (devices compare on-disk script against this SHA on every update). These are emitted by `scripts/build-device-package.mjs` based on the `packageType` config; `scripts/update-source-deploy.sh` must be in `.github/device-package-release.json#packageAllowlist` for the source-deploy installer SHA to be captured.
- **Deployed scripts must carry `+x` (git index, tarball, and device all agree)**: every `.sh` and `.py`-with-shebang under `scripts/` must be tracked as `100755` in git (`git ls-tree HEAD -- scripts/` to verify), built into a tarball with `+x` preserved, and re-applied by `fixup_script_modes` in `scripts/_lib/fixup-script-modes.sh` after any `tar | tar` pipeline. Missing `+x` is the root cause of systemd `203/EXEC` on `ExecStartPre`. Three defences are required: (1) repo-level `git update-index --chmod=+x scripts/*.sh scripts/*.py`, (2) `build-device-package.mjs`'s `assertArchiveScriptModes` post-build assertion which refuses to publish a broken tarball, (3) `deploy-source-armbian.sh`'s end-of-script self-check which iterates all scripts and exits non-zero if any is missing `+x`. Windows contributors: set `core.filemode=true` or always run `git update-index --chmod=+x` after touching scripts, otherwise git silently records `100644` and the whole chain breaks downstream. See `tests/release/device-package-executable-bits.test.ts` and `scripts/_lib/fixup-script-modes.sh`.
- **Stateful services must resolve paths through `getWebUiHome()`**: server-side services that store user data (uploads, meetings, profiles, transcripts) must read their base dir via `getWebUiHome()` from `packages/server/src/config.ts` — never via `process.env.HERMES_WEB_UI_HOME` directly, and never via `process.cwd()`. `getWebUiHome()` honours both `HERMES_WEB_UI_HOME` and `HERMES_WEBUI_STATE_DIR` (per `AGENTS.md` rule on state dirs) and falls back to `~/.hermes-web-ui`. A direct `process.env` read silently ignores one of the two vars when the other is unset, which in practice meant `MeetingStorageService` wrote audio into `cwd` instead of the real home, producing 404s on `/api/meeting-storage/:id/audio` with no log trail. See `tests/server/meeting-storage-path-resolution.test.ts`.

## When The Agent Gets Stuck

Improve the harness instead of repeating the same prompt. Add missing docs,
tests, logs, scripts, or CI checks so the next agent can see and verify the
constraint directly.
