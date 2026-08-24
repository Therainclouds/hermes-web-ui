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

## When The Agent Gets Stuck

Improve the harness instead of repeating the same prompt. Add missing docs,
tests, logs, scripts, or CI checks so the next agent can see and verify the
constraint directly.
