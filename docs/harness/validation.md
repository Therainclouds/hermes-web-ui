# Validation Guide

Run the smallest relevant checks while iterating. Escalate to the broad checks
when touching shared behavior, release automation, auth, persistence, or chat.

## Always Run For PRs

```bash
npm run harness:check
```

For broad or shared changes, also run:

```bash
npm run test:coverage
npm run test:e2e
npm run build
```

## Meeting / ASR Changes

When touching any file under `packages/client/src/views/hermes/MeetingView.vue`,
`packages/client/src/audio/`, `packages/client/public/audio/`,
`packages/server/src/services/meeting-asr/**`, or
`packages/server/src/security.ts`, run:

```bash
npm run build && node scripts/guard-no-inline-data-urls.mjs
npm run test:coverage -- tests/server/security-policy.test.ts
npm run test:e2e -- tests/e2e/meeting-audio-rate.spec.ts
pytest tests/python/test_meeting_asr_fallback.py
```

See [meeting-asr-safety-audit.md](./meeting-asr-safety-audit.md) for the
incident-driven checklist (B-1 worklet, B-3 CSP, R-5 storage, R-7 UI feedback).

## Change-Type Matrix

| Change | Minimum local validation |
| --- | --- |
| Docs only | `npm run harness:check` |
| Client component/store/API | focused `npm run test -- <pattern>`, then `npm run build` |
| User-visible browser flow | focused Vitest plus `npm run test:e2e` |
| Server controller/service/db | focused `npm run test -- tests/server/<file>` |
| Update/deploy/release contract | focused update tests, `npm run harness:check`, then `npm run build` |
| `scripts/install-device-package.sh`, `scripts/hermes-web-ui-update-runner.sh`, or `scripts/deploy-source-armbian.sh` (i.e. any script in `.github/device-package-release.json#packageAllowlist`) | focused update tests + `npm run test:device-package-release`, then locally run `npm run build:device-package` (or `node scripts/build-device-package.mjs --tag <x.y.z>`) and verify the produced `manifest.json` contains `installerScriptPath` and `installerScriptSha256`. Devices will compare the on-disk install script against this fingerprint and refuse the update if they do not match |
| Auth, profile, or credential behavior | focused server tests plus relevant e2e auth tests |
| Chat, Socket.IO, group chat | focused server tests plus relevant e2e chat tests |
| Chat session chain, Agent Bridge, compression, or Group Chat | Add one `docs/chat-chain-changes/*.md` fragment with date, PR/commit, touched feature, and behavior impact; then run `npm run harness:check` plus focused chat/bridge/group-chat tests |
| Desktop packaging | `npm run harness:check`, `npm run build`, and a platform-specific desktop build when practical |
| GitHub workflow | `npm run harness:check` and `actionlint` when available |
| Package manifests | `npm ci --ignore-scripts` and lockfile workflow expectations |

## CI Mapping

- Build workflow: installs dependencies, runs coverage, and builds production
  assets on pushes and pull requests.
- Playwright workflow: runs browser e2e tests.
- NPM lockfile workflow: verifies `package-lock.json` is synchronized.
- Desktop release and manual desktop build workflows build and upload
  platform-specific desktop artifacts.
- Docker workflow: builds and publishes release images.

## Release Workflow Guardrail

Published GitHub Releases should still trigger Web UI artifact packaging and
Docker image publishing, but those workflows must keep the GitHub Release out
of latest.

Full desktop packaging is manually dispatched through
`.github/workflows/desktop-release.yml`; published GitHub Releases must not
automatically start desktop packaging. After a full desktop release finishes,
the workflow must mark the target GitHub Release as latest.

Desktop release jobs must upload only the artifacts that their matrix target can
produce. Keep artifact globs in matrix data and keep `fail_on_unmatched_files:
true` so missing expected files still fail.

Expected desktop release outputs:

| Target | Required release globs |
| --- | --- |
| macOS | `*.dmg`, `*.dmg.blockmap`, `*.zip`, `*.zip.blockmap`, `latest*.yml` |
| Windows | `*.exe`, `*.exe.blockmap`, `latest*.yml` |
| Linux x64 | `*.AppImage`, `*.deb`, `latest*.yml` |
| Linux arm64 | `*.AppImage`, `latest*.yml` |

## Failure Handling

When a command fails:

1. Read the first actionable error, not just the final stack trace.
2. Check whether the failure indicates missing context, missing test coverage,
   or a missing mechanical rule.
3. Fix the product bug when there is one.
4. Update docs or `scripts/harness-check.mjs` when the same class of mistake
   should be prevented next time.

For update/deploy/release work, the focused test set should usually include:

```bash
npm run test -- tests/server/source-deploy-strategy.test.ts
npm run test -- tests/server/device-package-strategy.test.ts
npm run test -- tests/server/update-controller.test.ts
```
