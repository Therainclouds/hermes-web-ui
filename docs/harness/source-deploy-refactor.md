# Source-Deploy Refactor (Phase A — Trustworthy Updates)

This spec ships **phase (a)** of the three-phase update-system rewrite:
the device is upgradeable, restartable, recoverable, and verifiable
without manual operator rescue. It is the follow-up to
`update-system-overview.md` (which describes the system as it is) and
sits next to `update-reconciliation-plan.md` (which covers
environment-accounting phases 1–5).

The three phases, in order:

- **(a) Trustworthy updates** — this document. Identity, atomic swap,
  recovery, manifest self-check. Ships as one feature branch.
- **(b) Operational visibility** — staged rollout, remote telemetry,
  per-device update history UI. Not in scope here.
- **(c) Dependency & service management** — manifest-declared apt
  packages, agent decoupling, `install_webui_dependencies`
  unconditional rebuild removal. Not in scope here.

## Why Phase (a) Is First

Three v0.7.x production incidents and the recurring v0.8.0 upgrade
failures catalogued in `update-system-overview.md` share one shape:

> The pipeline has no concept of what is *actually* on disk after an
> upgrade is "done", and no atomic primitive that survives a SIGKILL
> mid-swap.

Until the device can (1) prove what it just installed, (2) back out
cheaply when the install goes sideways, and (3) resume cleanly after a
crash, every other improvement is built on sand. Phase (b)
dashboards and phase (c) agent decoupling both inherit (a)'s identity
and atomicity primitives.

## Scope

### In scope

- A new `scripts/update-orchestrator.sh` that owns the upgrade lifecycle
  on device. `deploy-source-armbian.sh` becomes bootstrap-only.
- Atomic directory swap (`ln -sfn`) via `scripts/_lib/atomic-swap.sh`.
  Replaces the current `rm + extract` in-place mutation pattern.
- Per-task JSONL journal at
  `${HERMES_WEB_UI_HOME}/updates/history/<taskId>.jsonl`. Replaces
  the single `update-task-state.json` file that loses history beyond
  the last task.
- HTTP `Range:` resume for source archive download, tracked via
  `${HERMES_WEB_UI_HOME}/updates/cache/partial-<taskId>.part`.
- `scripts/recover-interrupted-update.sh` runs as `ExecStartPre=` on
  the runner service. Detects half-swap, partial downloads, stale
  `flock`, and journal corruption; finishes or aborts cleanly.
- `state/identity.json` records the four SHA fields that uniquely
  identify an installed Web UI bundle:
  `version`, `distSha256`, `installerScriptSha256`,
  `agentManifestSha` (sentinel `"0.0.0-noop"` this phase).
- Manifest self-check at build time: distribution tar's
  `dist/` must contain the manifest's `version` string. Failure fails
  the CI build.
- Candidate→promote two-stage release: CI writes
  `candidates/<channel>/<version>.json`; `workflow_dispatch` with
  `promote=true` moves it to `releases/<channel>/latest.json`. Minimum
  24h between candidate publish and promotion.
- A new controller endpoint `GET /api/update/identity` returning the
  installed identity + manifest cache freshness.
- Local-only operator override file `${HERMES_WEB_UI_HOME}/updates/policy.json`,
  schema 1: `pinned_version`, `channel_overrides`, `pause_until`,
  `blocklist`, `notes`. Priority: file > env > default.

### Out of scope this phase

- `device-package` strategy. Existing devices on `device-package` are
  not affected. The orchestrator only sees `source-deploy`.
- `npm-package` strategy. Desktop / npm install path is untouched.
- hermes-agent decoupling or its own channel. `agentManifestSha`
  stays at the sentinel value.
- Remote / fleet telemetry. There is no server-side agent that pushes
  manifests. Policy file is local-only.
- Staged rollout, cohort, percentage gating. All devices on a channel
  receive the same `latest.json`.
- Native apt package reconciliation or `hostDependencies.json` removal.
- Playwright e2e for the upgrade flow. Unit + CI dry-run only.

## Goals

1. **Stop `webui_version` misreport** — the v0.7.0 customer incident.
   The device must know the version it claims to be running, and the
   manifest must know the version it claims to ship.
2. **Stop silent half-swaps** — every upgrade is either fully applied
   to the live deploy, or fully absent from it. No third state.
3. **Stop silent partial-download waste** — a flaky link no longer
   restarts a 30 MB download from byte 0.
4. **Stop unrecoverable crashes** — a SIGKILL at any point during an
   upgrade produces a deterministic state on next boot. Recovery is a
   single command.
5. **Stop silent policy divergence** — when an operator pins a version
   or blocks a manifest, the orchestrator respects it on the next
   check without restart.

## Non-Goals

- **Not** a generic rollback framework. Rollback is "swap back to
  `lastgood`", not "manage a multi-version archive".
- **Not** a configuration management system. OS-level state (apt,
  systemd, firewall) stays out of band.
- **Not** a forced strategy migration. Devices on `device-package` and
  `npm-package` keep running their existing pipelines.
- **Not** a remote-control plane. The device is reachable only from a
  browser on the LAN.

## Trigger Model

Devices update on the existing two channels:

1. **Manual**: sidebar `appStore.doUpdate()` (unchanged).
2. **Server poll**: 5-min `update-check-cache` (unchanged).

No new trigger sources. The orchestrator is invoked from the same
`controllers/update.ts` orchestrator path that today spawns
`hermes-web-ui-update.service`.

### Local override (`policy.json`)

```
${HERMES_WEB_UI_HOME}/updates/policy.json
```

Schema 1:

```jsonc
{
  "schema": 1,
  "pinned_version": "0.8.0",           // exact, or null
  "channel_overrides": {               // optional, per channel
    "stable": "0.7.20"
  },
  "pause_until": "2026-09-15T00:00:00Z", // ISO 8601, optional
  "blocklist": ["0.8.1"],              // rejected versions
  "notes": "internal pilot"            // free text, operator-only
}
```

Resolution order: **`policy.json` > env vars > manifest default**.
File absent means "no operator override". Edits are atomic
(`.tmp` → rename). `schema` mismatch refuses the file and logs
`update_policy_invalid` at WARN. The reconciliation controller reads
the file on every poll; no service restart required.

## Architecture

```
+-----------------------------+
|  candidate/<chan>/v.json    |   CI auto-write on tag push
+-----------------------------+
              |  (min 24h)
              v
+-----------------------------+
|  releases/<chan>/latest.json|   human workflow_dispatch --promote
+-----------------------------+
              |
              v  (HTTP GET, 24h cache, multi-URL failover)
+-----------------------------+
|  manifest-client.ts         |   server-side, Node
|  /api/update/manifest (cache)|
+-----------------------------+
              |
              v
+-----------------------------+
|  update-check-cache.ts      |   5-min TTL, drives the badge
+-----------------------------+
              |
              v
+-----------------------------+
|  controllers/update.ts      |   /api/hermes/update/preview-status
|                             |   /api/hermes/update/execute
|                             |   /api/update/identity (NEW)
+-----------------------------+
              |  (spawn)
              v
+-----------------------------+
|  update-orchestrator.sh     |   systemd one-shot, runs as root
+-----------------------------+
              |
              +----> JSONL journal  ${HERMES_WEB_UI_HOME}/updates/history/<taskId>.jsonl
              |
              +----> staging dir   ${HERMES_WEB_UI_HOME}/updates/cache/partial-<taskId>.part + .new
              |
              +----> atomic swap   ln -sfn deploy.new deploy
              |
              +----> identity.json ${HERMES_WEB_UI_HOME}/state/identity.json
              |
              +----> restart + healthcheck
```

The orchestrator replaces the current `scripts/hermes-web-ui-update-runner.sh`
JSON-via-systemd pattern. The runner becomes a thin wrapper that
delegates straight to the orchestrator with the same env vars.

```
+-----------------------------------------------------------------+
| scripts/update-orchestrator.sh                                  |
|   1. acquire flock(${HERMES_WEB_UI_HOME}/updates/.update.lock)  |
|   2. journal init  ->  append { stage: "queued" }               |
|   3. preflight    ->  space / node / identity / policy          |
|   4. download     ->  Range resume + multi-mirror + sha256       |
|   5. extract      ->  ${HERMES_WEB_UI_HOME}/updates/cache/       |
|                       staging-<taskId>/                         |
|   6. atomic-swap  ->  ln -sfn staging-<taskId> deploy            |
|                       (deploy is a symlink, lastgood is its      |
|                        previous target on first successful swap) |
|   7. restart      ->  systemctl restart hermes-web-ui            |
|   8. healthcheck  ->  GET ${HEALTHCHECK_URL} 200..399            |
|   9. identity     ->  write state/identity.json                  |
|  10. journal      ->  append { stage: "succeeded" }              |
|  11. release flock                                             |
+-----------------------------------------------------------------+
```

Failure paths:

- preflight fail `update_preflight_space` / `update_preflight_permissions`
  / `update_incompatible_node`: 503/409 with `retry_after_seconds`,
  journal stage `failed`, no swap.
- download fail after all mirrors: journal `failed`, staging dir
  preserved for forensics on disk.
- manifest self-check fail (built-in to download step):
  `update_ship_block` + automatic revert to `lastgood` symlink +
  manifest quarantine at `updates/quarantine/<sha>.json`.
- healthcheck fail: same revert-to-`lastgood` path; journal stage
  `rolled_back`.

## Stage State

Stages remain the union of the existing 20 (see
`update-system-overview.md` § Stage vocabulary). The journal adds
two new stages to the existing ones:

- `manifest_self_check` — between `verifying` and `backing_up`.
- `identity_stamped` — between `health_checking` and `succeeded`.

The orchestrator writes the same stage names the controller already
exposes, so the Web UI vocabulary is unchanged.

### Identity drift

The controller exposes `current_identity` and `manifest_claim` on
`/api/update/identity`. When they differ:

1. The existing `EnvironmentDriftBanner` shows red and offers a
   `Repair` button.
2. Repair is **always** "re-stamp identity from current deploy", never
   "force re-install". Reinstall is opt-in from the upgrade screen.
3. Repair succeeds only when `/health` returns 200 for 5 consecutive
   polls. Otherwise the banner stays red and the journal records
   `drift_repair_deferred`.

### Ship block (manifest self-check fails at runtime)

If the manifest's `version` string is not present anywhere in
`dist/` after extraction, the orchestrator triggers this sequence
before atomic swap:

```
1.  ln -sfn lastgood deploy       (atomic, revert to last known good)
2.  mv updates/cache/manifest-<channel>.json \
       updates/quarantine/<sha-prefix>-<timestamp>.json
3.  journal: stage = "rolled_back", message = "update_ship_block"
4.  HEALTHCHECK_URL poll until 200
5.  Exit 0 with task status "rolled_back"
```

This is the failure mode that auto-protects the device when an
operator promotes a bad manifest. The Web UI shows the rollback and
the quarantine path so the operator can inspect the bad artifact.

## Journal

Per-task file:

```
${HERMES_WEB_UI_HOME}/updates/history/<taskId>.jsonl
```

Each line:

```jsonc
{
  "_meta": {
    "taskId": "<uuid>",
    "version": "0.8.1",
    "manifestSha": "<sha256>",
    "startedAt": "2026-09-04T12:34:56.789Z"
  },
  "stage": "verifying",
  "message": "range-resume from byte 4194304 of 28311552",
  "at": "2026-09-04T12:35:02.012Z"
}
```

Writes are append-only via `>>` with `fsync` after each stage. The
shell helper `scripts/journal-write.sh` is the single writer; the
runner, the orchestrator, and the recovery script all use it.

### Validator

`scripts/journal-validator.sh` runs as `ExecStartPre=` on the runner
service. It:

- Walks `updates/history/`.
- Parses JSONL line-by-line. On any parse error or unknown stage,
  moves the offending file to `updates/quarantine/<taskId>-<ts>.jsonl`
  and logs `update_journal_corrupt` at WARN. The next task ignores
  it.
- GC keeps the 30 most recent journal files. Older files are moved to
  `updates/quarantine/` with `retained_30_rotation` marker.

### Lock

A single `flock(LOCK_EX)` on `updates/.update.lock`. The orchestrator
acquires it on entry and releases on exit (clean or fail). Stale
locks (mtime older than 6 h) are auto-cleared by the recovery script
with journal entry `lock_recovered`.

## Atomic Swap

```
deploy/        ->  lastgood/        (symlink)
lastgood/                           (real directory, previous deploy)
```

Update flow:

```
1. extract into updates/cache/staging-<taskId>/
2. atomic_swap_dir staging-<taskId> deploy
   = ln -sfn ${HERMES_WEB_UI_HOME}/updates/cache/staging-<taskId> \
             ${DEPLOY_ROOT}/deploy.new
   = mv ${DEPLOY_ROOT}/deploy       ${DEPLOY_ROOT}/lastgood-<ts>   (rename, atomic)
   = mv ${DEPLOY_ROOT}/deploy.new   ${DEPLOY_ROOT}/deploy          (rename, atomic)
   = ln -sfn lastgood-${ts} ${DEPLOY_ROOT}/deploy.lastgood        (record previous good)
```

Actually, the chosen primitive is simpler:

```
deploy/         is always a symlink.
lastgood/       is the previous target of the deploy symlink, captured on first successful swap.

apply:
  staging-<taskId>/
  → ln -sfn staging-<taskId> deploy       # one syscall, atomic
  → capture previous target → lastgood
  → healthcheck
  → on success:  cp -al deploy/* lastgood/  # hardlink, free
                 OR rename deploy → lastgood-<ts> and recreate symlink
```

Decision: rename-based, because hardlinks across the mount-point are
fragile (audit notes v0.8.0 mount-point chown failures). The
implementation lives in `scripts/_lib/atomic-swap.sh` and exposes:

```bash
atomic_swap_dir <staging-path> <deploy-link>
capture_lastgood <deploy-link>           # called once, after first successful swap
revert_to_lastgood <deploy-link>         # single ln -sfn, idempotent
```

The `lastgood` symlink lives **next to the deploy link** —
`atomic-swap.sh`'s `revert_to_lastgood` reads
`dirname(<deploy-link>)/lastgood`, and the deploy link is `DEPLOY_DIR`
itself (the path systemd already runs), so `lastgood` is
`dirname($DEPLOY_DIR)/lastgood`. `state/swap/` only holds
orchestrator bookkeeping. `DEPLOY_DIR` is stable across reboots
(baked into the service env), keeping the symlink semantics untouched
by `deploy-source-armbian.sh`'s idempotency path. On the first phase-a
update of a legacy layout, the real deploy directory is renamed aside
to `$DEPLOY_DIR.previous-<ts>` and recorded as `lastgood`.

> **Not in this phase**: a multi-version rollback store. Rollback is
> "go back one commit". A multi-step rollback is a phase (b) feature.

### Disk preflight

Before download:

```
assertFreeSpace ${HERMES_WEB_UI_HOME}/updates/cache
  required = (deploy_tree_size * 1.5) + manifest.sourceSize
```

Failure → 503 + `Retry-After: <free-up-bytes / write-rate>` or 409 +
`update_preflight_space` if there is no realistic recovery window.

## Download & Resume

```
${HERMES_WEB_UI_HOME}/updates/cache/partial-<taskId>.part
${HERMES_WEB_UI_HOME}/updates/cache/partial-<taskId>.part.meta
```

`.meta` records the expected SHA256, total size, and last successfully
written byte. `network-client.ts` adds:

```ts
async function downloadWithRangeResume(opts: {
  url: string,
  expectedSize: number,
  expectedSha256: string,
  partialFile: string,
  metaFile: string,
  deadline: Date,
}): Promise<void>
```

Behavior:

- Read meta. If `lastByte < expectedSize - 1`, send
  `Range: bytes=<lastByte+1>-`.
- Server returns 206 + body. Append to `partial-<taskId>.part`,
  update meta on disk (fsync).
- On network error / 5xx / 408 / 425 / 429, retry with backoff
  `min(2^attempt, 60)s × 1000ms` and at most
  `WEBUI_UPDATE_DOWNLOAD_RETRIES` retries per URL.
- After exhausting retries on one URL, fall through to the next
  mirror in `packageUrls[]`. Mirror choice is round-robined across
  attempts to avoid punishing the same CDN.
- On a server that does not honour `Range:` (HTTP 200 with full body),
  truncate the partial file and restart from byte 0 with backoff.
- On success: atomically rename `partial-<taskId>.part` to the staging
  dir, delete `.meta`.

### Verification

After download completes:

1. `sha256sum` over the final part file. Compare against
   `manifest.sha256`. Mismatch → drop mirror, try next, log
   `update_sha256_mismatch` once per URL exhausted.
2. If the upstream returned the manifest's own
   `version`-string-equality check fails (no occurrence in
   `dist/`), raise `update_ship_block` immediately. This is the
   v0.7.0 customer fix.
3. The first 4 KB is also hashed for early-fail detection (mirrors
   that drift partway through the file).

### Manifest cache

`${HERMES_WEB_UI_HOME}/updates/cache/manifest-<channel>.json` is the
server-side cache from `manifest-client.ts`. It caches for 24h.
The freshness check is surfaced in `/api/update/identity`:

- `< 24h`: green
- `< 7d`: yellow ("network may be down; cached manifest in use")
- `≥ 7d` and `< 30d`: orange (UI prompt: "please reconnect to refresh")
- `≥ 30d`: red (UI prompt: "blocked — please confirm settings")

The freshness logic lives in
`packages/server/src/services/update/manifest-cache-freshness.ts`. The
controller does **not** refuse an update purely because the cache is
old; red only changes UI urgency. The operator can still apply.

## Identity Schema

```
${HERMES_WEB_UI_HOME}/state/identity.json
```

```jsonc
{
  "schema": 1,
  "capturedAt": "2026-09-04T13:00:00.000Z",
  "version": "0.8.1",
  "distSha256": "<sha256 of dist/>",
  "installerScriptSha256": "<sha256 of update-orchestrator.sh>",
  "agentManifestSha": "0.0.0-noop",    // sentinel; phase (c) reuses this slot
  "commitSha": "<git head of deploy tree>"
}
```

`distSha256` is computed by the orchestrator after the atomic swap, by
hashing `dist/` directly. The build pipeline writes the same value
into the manifest so device can confirm wire-side.

`installerScriptSha256` is read from the manifest during orchestrator
load. Mismatch logs `update_installer_script_stale` and refuses the
swap.

`agentManifestSha` is the sentinel `"0.0.0-noop"` for this phase.
Phase (c) writes a real SHA here without changing the schema.

## Build Side

### Manifest schema delta

`scripts/build-device-package.mjs` emits the four-field identity block
alongside the existing `environment` block:

```jsonc
{
  "version": "0.8.1",
  // ...existing fields...
  "packageType": "source-deploy",     // unchanged
  "installerScriptPath": "scripts/update-orchestrator.sh",  // changed
  "installerScriptSha256": "<sha>",
  "identity": {
    "distSha256": "<sha of dist/>",
    "versionString": "0.8.1"          // what dist must contain
  }
}
```

### CI self-check

The build emits `distSha256` and the manifest's `versionString`. A new
step in `device-package-release.yml`:

```yaml
- name: manifest-self-check
  run: |
    VERSION_STRING=$(jq -r '.identity.versionString' manifest.json)
    if ! tar -tzf hermes-web-ui-source-v$VERSION.tar.gz \
            | grep -q "^[^/]*/dist/" ; then
      echo "::error::dist/ missing from source tar"
      exit 1
    fi
    DIST_SHA=$(jq -r '.identity.distSha256' manifest.json)
    tar -xzOf hermes-web-ui-source-v$VERSION.tar.gz '*dist' \
      | sha256sum --check <(echo "$DIST_SHA  -")
```

Failure aborts the build before upload.

### CI dry-run

A second new step runs `update-orchestrator.sh` against an extracted
staging copy, with `WEBUI_DRY_RUN=1`. The orchestrator's dry-run mode
skips the systemd restart but performs every other step including the
identity stamp and the journal. The CI worker asserts `identity.json`
matches what the manifest claimed and the journal ends at
`stage: "succeeded"`.

Failure aborts promotion.

### Candidate → promote

Two-stage release:

1. Tag push → CI writes `candidates/<channel>/<version>.json`.
2. After at least 24h, an operator runs
   `gh workflow run device-package-release.yml --field promote=true
    --field channel=stable --field version=0.8.1`.
3. Promotion moves `candidates/.../v.json` to
   `releases/<channel>/latest.json` atomically (`git push` with a
   single commit).
4. Promotion also writes a timestamped `promotions/<channel>/<ts>.json`
   record (who, when, from which candidate).

Devices always read `releases/<channel>/latest.json`. If a device
polls between candidate write and promotion, it sees no change.

## Preflight → HTTP Status

| Failure                                | Status | Body                                          | UI behavior |
|----------------------------------------|--------|-----------------------------------------------|-------------|
| `update_preflight_space`               | 503    | `retry_after_seconds` + free-space required   | banner w/ "free N MB and try again" |
| `update_preflight_permissions`         | 409    | none                                          | prompt user to run `sudo deploy-...` once |
| `update_incompatible_node`             | 409    | installed / required ranges                   | prompt user to upgrade Node |
| `update_manifest_fetch_failed`         | 503    | `retry_after_seconds: 60`                     | auto-retry banner |
| `update_manifest_invalid`              | 409    | reason string                                 | manual review required |
| `update_installer_script_stale`        | 409    | installer required version                    | run `--reconcile-env-only` once |
| `update_ship_block`                    | 409    | quarantine path                               | banner: "blocked — please confirm settings" |
| `update_policy_invalid`                | 409    | schema mismatch                               | log only, no UI block |
| `update_journal_corrupt`               | n/a    | (logged server-side; no API surfacing)        | none |

## File-by-File Change List

### New files

| Path | Purpose |
|---|---|
| `scripts/update-orchestrator.sh` | The upgrade lifecycle shell entry point. |
| `scripts/_lib/atomic-swap.sh` | `atomic_swap_dir`, `capture_lastgood`, `revert_to_lastgood`. |
| `scripts/_lib/journal-write.sh` | Single writer of the JSONL journal. |
| `scripts/journal-validator.sh` | Run by `ExecStartPre=`, validates history and rotates old journals. |
| `scripts/journal-rotate.sh` | GC keeping the 30 most recent journals. |
| `scripts/recover-interrupted-update.sh` | Detects half-swap / partial download / stale lock and recovers deterministically. |
| `scripts/policy-parse.sh` | Reads `${HOME}/updates/policy.json`, exposes `pinned_version`, `channel`, `blocklist`, etc. |
| `tests/server/update-orchestrator/atomic-swap.test.ts` | 100% seam coverage on `atomic-swap.sh`. |
| `tests/server/update-orchestrator/journal-validator.test.ts` | 100% seam coverage on validator + rotation. |
| `tests/server/update-orchestrator/policy-parse.test.ts` | 100% seam coverage on policy parser. |
| `tests/server/update-orchestrator/recover-interrupted.test.ts` | 100% seam coverage on recovery paths. |
| `tests/server/update-orchestrator/identity-drift.test.ts` | 100% seam coverage on identity drift logic. |
| `tests/server/update-orchestrator/manifest-cache-freshness.test.ts` | 100% seam coverage on freshness. |
| `tests/release/source-deploy-dry-run.test.ts` | CI dry-run smoke against a fake deploy root. |
| `docs/harness/source-deploy-refactor.md` | This document. |

### Modified files

| Path | Change |
|---|---|
| `scripts/hermes-web-ui-update-runner.sh` | Becomes a thin wrapper that calls `update-orchestrator.sh` with the existing JSON request. |
| `scripts/hermes-web-ui-update.service` | Adds `ExecStartPre=+/opt/hermes-web-ui/scripts/recover-interrupted-update.sh` and `+/opt/hermes-web-ui/scripts/journal-validator.sh`. |
| `scripts/build-device-package.mjs` | Emits `identity` block + `installerScriptPath = "scripts/update-orchestrator.sh"`. Adds `manifest-self-check` step. |
| `.github/workflows/device-package-release.yml` | Adds dry-run job + candidate→promote two-stage gating. |
| `packages/server/src/services/update/manifest-client.ts` | Reads and writes `${HOME}/updates/cache/manifest-<channel>.json`. |
| `packages/server/src/services/update/manifest-cache-freshness.ts` | (new; replaced inline function in `controllers/health.ts`.) |
| `packages/server/src/services/update/network-client.ts` | Adds `downloadWithRangeResume`. |
| `packages/server/src/controllers/update.ts` | Adds `GET /api/update/identity`; preflight returns `retry_after_seconds` on recoverable failures. |
| `packages/client/src/api/hermes/system.ts` | Adds `Identity`, `IdentityDrift` types. |
| `packages/client/src/stores/hermes/app.ts` | New identity-drift banner state. Replaces `EnvironmentDriftBanner` red variant. |
| `tests/release/device-package-manifest.test.ts` | Asserts the four SHA fields are present and consistent when `packageType = source-deploy`. |

### Untouched this phase (deliberately)

- `scripts/deploy-source-armbian.sh` — remains as the bootstrap / first-install path. Its idempotency and `post_deploy_self_check` are reused, but no upgrade path runs it. The orchestrator does not call it.
- `scripts/install-device-package.sh` — `device-package` strategy is not in scope.
- `packages/server/src/services/update/strategies/npm-package.ts` — `npm-package` strategy is not in scope.
- `packages/server/src/services/hermes/agent-bridge/` — agent decoupling is not in scope.

## Testing Strategy

### Unit (Vitest)

| Seam | Coverage target | Test file |
|---|---|---|
| `atomic_swap_dir` | 100% | `tests/server/update-orchestrator/atomic-swap.test.ts` |
| `journal-validator.sh` (parse + quarantine + rotation) | 100% | `tests/server/update-orchestrator/journal-validator.test.ts` |
| `policy-parse.sh` (schema, priority, idempotency) | 100% | `tests/server/update-orchestrator/policy-parse.test.ts` |
| `recover-interrupted-update.sh` (5 paths: half-swap / partial / stale lock / corrupt journal / clean) | 100% | `tests/server/update-orchestrator/recover-interrupted.test.ts` |
| Identity drift detection + red-banner eligibility | 100% | `tests/server/update-orchestrator/identity-drift.test.ts` |
| `manifest-cache-freshness.ts` (green / yellow / orange / red) | 100% | `tests/server/update-orchestrator/manifest-cache-freshness.test.ts` |

### Orchestrator main path (covered by dry-run)

`tests/server/update-orchestrator/orchestrator-dry-run.test.ts` runs
the orchestrator in a fake chroot (no systemd) by sourcing
`update-orchestrator.sh` with stubbed functions for `systemctl`,
`flock`, `sha256sum`, etc. Asserts the journal end state, identity
stamp, and absence of `deploy/` after stage `succeeded`. Coverage on
orchestrator **mainline**: ≥ 70%.

### CI smoke (release jobs)

`tests/release/source-deploy-dry-run.test.ts` exercises the entire
path:

1. Run `node scripts/build-device-package.mjs --channel=stable --tag=vTEST`.
2. Run the orchestrator with `WEBUI_DRY_RUN=1` against the produced
   staging.
3. Assert `state/identity.json` matches the manifest's `identity`
   block.
4. Assert journal file ends with `stage: "succeeded"`.
5. Assert `scripts/update-orchestrator.sh` SHA matches
   `manifest.installerScriptSha256`.

This is wired into `device-package-release.yml` as a required check
before promotion.

### Skipped

- Playwright e2e for the upgrade flow. The 30-min timing is too long
  for e2e economics; identity + journal seams cover the risk.
- Real ARM64 self-hosted runner for the upgrade. CI dry-run is
  chroot-stubbed. Real-device coverage is acceptance-gate, not CI.

## Acceptance Gate

The (a) phase is "done" when **all** are true for 7 consecutive days
on internal pilot devices:

- ≥ 30 successful upgrades across all internal pilot devices.
- Zero `update_*` returns from the `non-recoverable` set:
  - device crash → identity / symlink drift
  - upgrade failure → cannot reach lastgood by SSH
  - JSONL journal corruption → next task blocked
  - manifest drift (v0.7.0 customer-class)
  - Web UI unhealthy for ≥ 30 minutes after upgrade

If any of those fires, the gate timer restarts.

Secondary issues (policy-not-recognized, staging not auto-pruned) are
shipped as **patch releases** during the gate window. They do not
extend the gate.

## Phase (b) Hand-off

When the gate clears, phase (b) starts. It needs:

- `/api/update/identity` (this phase) — already shipping.
- Append-only journal (this phase) — already shipping.
- `policy.json` (this phase) — already shipping; phase (b) layers a
  remote-controlled "shadow policy" without removing the local file.

Phase (b) should not have to redo the identity work.

## Work Package Breakdown

Implementation is split into five executable specs under
`.zcode/plans/`, in dependency order:

| WP | Spec | Depends on | Delivers |
|---|---|---|---|
| 1 | `source-deploy-refactor-wp1-shell-primitives.md` | — | journal writer/validator/rotation, policy parser, atomic-swap lib (100% seam tests) |
| 2 | `source-deploy-refactor-wp2-server-download-cache-identity.md` | — | Range-resume download, manifest cache + freshness, `/api/update/identity` |
| 3 | `source-deploy-refactor-wp3-orchestrator-recovery.md` | WP1, WP2 | `update-orchestrator.sh`, recovery script, systemd wiring |
| 4 | `source-deploy-refactor-wp4-build-ci-release-gate.md` | WP3 | identity block in build, manifest self-check, CI dry-run, candidate→promote |
| 5 | `source-deploy-refactor-wp5-controller-ui-hardening.md` | WP2, WP3 | preflight 503/409 semantics, drift banner + repair, AGENTS.md hard rules |

WP1 and WP2 run in parallel. WP3 is the critical path. WP4 and WP5 run
in parallel after WP3. Ship order: 1 → 2 → 3 → (4 ∥ 5).

## Notes for Future Agents

- `update-orchestrator.sh` does **not** call `deploy-source-armbian.sh`.
  The deploy script is bootstrap-only after this phase. Any new init
  logic goes in `update-orchestrator.sh` or in `_lib/`, not in the
  deploy script.
- The deploy root becomes a symlink that the bootstrap script
  materialises on first run. After that, the orchestrator owns it.
- `agentManifestSha` is sentinel `"0.0.0-noop"`. Phase (c) writes a
  real SHA here without schema migration. Treat the sentinel as a
  string, never as a version range.
- The `packageType` field in the manifest is no longer controlled by
  the runtime; it is set by the build pipeline. Mismatch with
  `WEBUI_UPDATE_PACKAGE_TYPE` is now a build-side error, not a
  runtime fallback.
- `+x` bit on every shipped shell script remains a hard rule, enforced
  by `assertArchiveScriptModes` (see `AGENTS.md`). The new scripts in
  this phase (`update-orchestrator.sh`, `_lib/atomic-swap.sh`,
  `journal-write.sh`, `journal-validator.sh`, `journal-rotate.sh`,
  `recover-interrupted-update.sh`, `policy-parse.sh`) all join the
  `packageAllowlist` so their `+x` is checked on every build.
