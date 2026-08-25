# Update System Overview

This document is the architectural map of how a `hermes-web-ui` device gets
from one version to another. It exists so that an agent reading it can answer
"what is the update system actually doing?" without tracing every file.

For the **operator-level** workflow (how to manually rescue a stuck device),
see `docs/deploy-update-runbook.md`. For the **PR-time** rules about what to
test when touching update code, see `docs/harness/validation.md`. This
document is the layer in between: what the pieces are, where they live, and
where they have already broken in production.

## Why This Document Exists

The update pipeline has produced three independent production incidents:

1. **6.6.6.74** (`v0.7.17` → `v0.7.19`): healthcheck timeout during install,
   silent rollback failure, task marked failed with no clear root cause.
2. **v0.7.0 customer** (operator manual rescue): install script ran fine but
   `webui_version` reported `0.7.0` after the upgrade even though the OSS
   tar was labelled `v0.7.19`.
3. **6.6.6.31** (earlier session): `/opt/hermes-web-ui/` was missing
   entirely, leaving nothing to upgrade.

Each of these looked like a one-off bug. Reading them together they point at
the same shape of weakness: the update system has many moving parts and very
little **end-to-end observability** of "did the device actually receive the
source tree we intended?".

## The Three Update Strategies

`config.ts#normalizeUpdateStrategy` recognises exactly three strategies. They
are not equivalent: each one fetches a different artifact and runs a
different script.

| Strategy | Artifact | Install script | Network needs |
|---|---|---|---|
| `npm-package` | npm tarball via `WEBUI_UPDATE_REGISTRY` | `update-npm-package` path in `update.ts` | npm registry (GitHub-style) |
| `source-deploy` | source tarball (OSS or GitHub release) | `scripts/deploy-source-armbian.sh` via `WEBUI_UPDATE_SCRIPT` | git repo / source archive |
| `device-package` | prebuilt device tarball | `scripts/install-device-package.sh` | one HTTP fetch to OSS |

`device-package` is the recommended default for production devices. It is the
only strategy that ships a prebuilt `dist/`, so the device does not have to
run `npm run build` on ARM64 (which takes 5–15 minutes and is sensitive to
disk / RAM). It is also the only strategy with a manifest fingerprint
mechanism, introduced in commits `afe03b04` and `5ae749dd`.

`source-deploy` is what most existing devices were installed with before
`device-package` became the default. It remains useful for dev and for
escaping `device-package` failures.

`npm-package` is for desktop / npm-distributed installs. It is not normally
the right answer for an ARM device.

## End-to-End Pipeline

The update pipeline has **three independent deployment loops**, each with
its own CI job and its own artifact channel.

```
Source code (git)
   │
   ├── npm-package CI ──────► npm registry (@quanthermes/hermes-web-ui)
   │
   ├── device-package CI ───► OSS tarball + manifest (releases/stable/latest.json)
   │     ├─ hermes-agent wheelhouse ─► OSS wheelhouse
   │     └─ sources/ tarball        ─► OSS source archive (used by source-deploy)
   │
   └── source-deploy CI ─────► OSS source tarball + source manifest
```

On the device side, the controller picks one of the three strategies and
runs the matching script.

### Device-side decision flow

1. Controller reads `WEBUI_UPDATE_STRATEGY` (or auto-detects from config).
2. Controller fetches the manifest:
   - `device-package`: `releases/stable/latest.json` from `WEBUI_UPDATE_MANIFEST_BASE_URL`
   - `source-deploy`: source manifest at the same path
   - `npm-package`: `<registry>/<package>` via npm registry
3. Controller resolves the **artifact URL** from the manifest.
4. Controller runs **preflight checks** (`services/update/preflight.ts`):
   - `assertDevicePackageCompatibility` (version floor)
   - `assertInstallerScriptCompatible` (since `5ae749dd`)
5. Controller spawns `hermes-web-ui-update.service` (the runner) with env vars
   derived from the manifest.
6. Runner executes the strategy-specific script:
   - `device-package`: `install-device-package.sh --package <tar> --version <ver>`
   - `source-deploy`: `deploy-source-armbian.sh`
   - `npm-package`: `update-npm-package` path
7. Script reports stage transitions through `scripts/update-task-state.py`.
8. Controller polls task state and exposes it to the Web UI.

## Where Each Pipeline Stage Lives

This is the file-level map. It is intentionally exhaustive so that an agent
can `grep` against it.

### Controller + service layer

- `packages/server/src/controllers/update.ts` — top-level update endpoints,
  task lifecycle, strategy routing.
- `packages/server/src/services/update/manifest-client.ts` — manifest
  fetch + normalize.
- `packages/server/src/services/update/device-package-contract.ts` —
  schema validation for device-package manifests.
- `packages/server/src/services/update/strategies/device-package.ts` —
  device-package preflight, env builder, error messages. Fingerprint logic
  lives here (`assertInstallerScriptCompatible`).
- `packages/server/src/services/update/strategies/source-deploy.ts` —
  source-deploy env builder.
- `packages/server/src/services/update/strategies/npm-package.ts` —
  npm-package env builder.
- `packages/server/src/services/update/network-client.ts` — HTTP fetch
  abstraction with timeout, used by the manifest client.
- `packages/server/src/services/update/preflight.ts` — cross-strategy
  preflight orchestration.
- `packages/server/src/services/update/runtime-paths.ts` — resolves
  `DEPLOY_DIR`, `HERMES_WEB_UI_HOME`, etc.
- `packages/server/src/services/update/package-info.ts` — reads local
  version (`__APP_VERSION__` first, `package.json` fallback).
- `packages/server/src/services/update/version-compare.ts` — semver
  comparison.

### Shell scripts (run on the device)

- `scripts/install-device-package.sh` — `device-package` install. **This
  script is what gets fingerprinted** (`installerScriptSha256` in the
  manifest).
- `scripts/deploy-source-armbian.sh` — full source deployment from a
  source archive. Used directly by `source-deploy` and indirectly by
  `device-package` (`run_deploy_script` inside `install-device-package.sh`).
- `scripts/hermes-web-ui-update-runner.sh` — the runner that the controller
  spawns. Validates env keys against an allowlist before forwarding them
  to the install script.
- `scripts/hermes-web-ui-update.service` — systemd unit for the runner.
- `scripts/update-task-state.py` — stage-transition reporter shared by
  both `install-device-package.sh` and `deploy-source-armbian.sh`.

### Build + publish (CI side)

- `.github/workflows/device-package-release.yml` — builds the device tar,
  uploads to OSS, writes `releases/stable/latest.json`.
- `scripts/build-device-package.mjs` — produces the device tar from the
  current source tree (allowlist is in `packageAllowlist` in
  `.github/device-package-release.json`).
- `.github/workflows/hermes-agent-oss-mirror.yml` — syncs hermes-agent
  wheels from PyPI into the OSS wheelhouse.

### Local config

- `.github/device-package-release.json` — central config for device-package
  publishing: OSS URL, `packageAllowlist`, channel names, etc.
- `release/hermes-agent-stable.json` — pins the hermes-agent version that
  is mirrored to OSS.

## What Each Pipeline Layer Owns

| Layer | Owns | Does not own |
|---|---|---|
| Controller | Strategy selection, manifest fetch, preflight, task lifecycle | The actual file system changes on the device |
| Update runner | Spawning the install script with safe env, stage reporting | Detecting whether the install actually wrote the new files |
| `install-device-package.sh` | Backing up, syncing the new tree, restarting the service, healthcheck | Whether the OSS tar itself was built from the correct source |
| `deploy-source-armbian.sh` | npm ci, hermes-agent venv install, meeting-asr venv, npm run build | The version label baked into the dist that ships |
| CI build | Producing the dist, computing `installerScriptSha256` | Any knowledge of what is on each device |

The clearest way to summarise this: **no single layer can answer the
question "is the code running on the device actually what we think it is?"**

## Failure Modes That Have Actually Happened

### 1. Healthcheck timeout silently fails upgrades (6.6.6.74)

**Symptom**: `Device package install failed at line 285: ... healthcheck ...
timed out`. The task is marked failed and the device is stuck on the old
version. There is no rollback message that an operator can act on.

**Root cause**: On ARM64, `packages/server/src/services/hermes/hermes-cli.ts#getVersion()`
spawns a Python interpreter and takes 5+ seconds the first time. The install
script's healthcheck (`HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS=15000`)
was historically as low as `2000` on devices installed before
`c24f36a8`. With a 2s budget and a 5s+ cold start, the healthcheck can
never succeed, even though the package is otherwise fine.

**Fix shipped in `afe03b04`**: cached `getVersion()` for 30s with shared
in-flight promise, and prewarm at boot. After this, the cold start only
happens once per process, not once per healthcheck.

### 2. Install script version drift (6.6.6.74 + v0.7.0 customer)

**Symptom**: A device's `install-device-package.sh` was written by an old
release, so it runs with stale `HEALTHCHECK_TIMEOUT_MS`, stale
`PRESERVE_NAMES`, or no `assertInstallerScriptCompatible` integration. When
the controller sends it a new manifest that requires features the old
script does not implement, the upgrade hangs or fails.

**Fix shipped in `5ae749dd`**: build embeds `installerScriptPath` +
`installerScriptSha256` in the manifest. The controller runs
`assertInstallerScriptCompatible` before spawning the runner and refuses
the upgrade with HTTP 409 + `update_installer_script_stale` when the local
script does not match.

### 3. `webui_version` reports the wrong version (v0.7.0 customer)

**Symptom**: After a `device-package` upgrade that succeeded according to
the install script, `/health` reports `webui_version=0.7.0` even though
the manifest claimed `0.7.19`. The OSS tar `sha256` matched. The
installer's stage transitions said "completed successfully".

**Diagnosis path** (what we ran):

```
$ grep -aoE "0\.[0-9]+\.[0-9]+(\+[a-z0-9.]+)?" \
       /opt/hermes-web-ui/dist/server/index.js | sort -u
0.0.0   0.0.1   0.1.0   0.13.0   0.20.0   0.3.1   0.3650.75   0.7.0   0.8.0
```

`0.7.19` is **not in the dist**. The installed tar was compiled from a
source tree whose `package.json` reported `0.7.0`. (The exact upstream
mechanism — whether CI ran a stale build, whether someone hand-uploaded an
older tar to the v0.7.19 OSS path, or whether a release commit reused
dist artifacts from a previous version — is not yet pinned down from
git history alone.)

**Why this is dangerous**: the install script reports success, the OSS
sha256 matches, and `webui_update_available: true` even after the
"upgrade" — but the running code is not what the manifest says it is.
Operators cannot trust the version label.

**Open follow-ups** (no fix yet, deliberately not in the current sprint):

- Add an **identity report** to `/health`: not just `version`, but also
  `installerScriptSha256`, the dist sha256, and a build timestamp. If
  these do not match the manifest that was supposed to be installed, the
  UI can flag "tar identity mismatch" instead of trusting the label.
- Investigate the CI path that produced the bad v0.7.19 tar and add a
  release-time check: after `npm run build`, before packaging into the
  device tar, assert that `dist/server/index.js` contains the version
  string from `package.json`. (See "Open Questions" below.)

### 4. Network-constrained customer upgrades (v0.7.0 customer)

**Symptom**: Customer device could reach OSS but not `registry.npmjs.org`
or `github.com`. The `source-deploy` strategy hard-requires both, so
auto-upgrade is impossible. The customer wanted to upgrade to current.

**Resolution path** (what worked):

1. Pull the device-package tar directly from OSS (works without GitHub).
2. Run `install-device-package.sh --package <tar> --version 0.7.19`
   manually, with `WEBUI_UPDATE_STRATEGY=device-package`.
3. The install script handles hermes-agent upgrade via the OSS wheelhouse,
   and `npm ci` falls back to `registry.npmmirror.com` because
   `deploy-source-armbian.sh` defaults the mirror.

**Open follow-up**: the `install-device-package.sh` script now has a
`PORT="${PORT:-8648}"` default at line 36 that **overrides the
`/etc/default/hermes-web-ui` `PORT` value** when `PORT` is unset in the
shell that invokes it. Operator consoles that have been on `6060` for
years now suddenly bind `8648` after a manual upgrade. This needs to be
fixed: `PORT` should not default to a value that changes the listening
port silently.

### 5. Missing `/opt/hermes-web-ui/` (6.6.6.31)

**Symptom**: An attempted upgrade failed because the deploy directory did
not exist at all. There was nothing to back up and nothing to swap.

**Status**: deferred. The fix is to make `install-device-package.sh`
accept a missing `DEPLOY_DIR` (bootstrap case) and create it, but this is
out of scope for the current sprint.

## Compatibility Matrix

What is and is not forward- and backward-compatible across the update
pipeline. All evidence is grounded in source files referenced by path and
line number so the next agent can re-verify.

### Strategy-By-Strategy Gates

| Strategy | manifest validation | Node range check | Fingerprint check | npm-registry fallback |
|---|---|---|---|---|
| `device-package` | yes (`strategies/device-package.ts:104`) | yes (line 105-111) | yes (`assertInstallerScriptCompatible`) | no |
| `source-deploy` | yes (`strategies/source-package.ts:5`) | no | no | yes (`controllers/update.ts:1611-1616`) |
| `npm-package` | no | no | no | yes (forced) |

The asymmetry is deliberate. `device-package` is **strict**: it uses the
manifest as the single source of truth and refuses mismatches. `npm-package`
and `source-deploy` are **loose**: they have more fallback paths but no
self-verification. The strict mode requires fewer network dependencies
(one HTTPS fetch to the manifest, one to the tar), so it is the right
default for network-constrained ARM devices.

### Fingerprint Compatibility Is One-Way

`assertInstallerScriptCompatible` (`strategies/device-package.ts:50-87`)
short-circuits when the manifest has no `installerScriptSha256`:

```ts
const expected = manifest.installerScriptSha256
if (!expected) return
```

This gives three working combinations:

| Combination | Behaviour |
|---|---|
| New controller + old manifest (no fingerprint field) | passes (no-op) |
| Old controller + new manifest (has fingerprint field) | passes (old controller does not read it) |
| New controller + new manifest + stale on-disk install script | 409 `update_installer_script_stale` |

And one breaking combination that the design intends:

| Combination | Behaviour |
|---|---|
| Old on-disk `install-device-package.sh` (e.g. v0.7.17-era, `HEALTHCHECK_TIMEOUT_MS=2000`) + new manifest with fingerprint | 409 `update_installer_script_stale` (correctly refuses) |

The break is intentional. The fix is bootstrap: upgrade once through an
intermediate manifest that does **not** carry a fingerprint, so the install
script gets refreshed, then upgrade to the latest. This is documented in
"Cross-Version Bootstrap Path" below.

### Runner Allowlist Is Forward-Compatible

`scripts/hermes-web-ui-update-runner.sh:33-65,82-89` keeps an explicit
`allowed_keys` set. Unknown keys from a newer controller are warned-and-
skipped rather than rejected:

```python
if key not in allowed_keys:
    print("[hermes-web-ui-update-runner] WARNING: skipping unsupported request key: {key}", file=sys.stderr)
    continue
```

This is by design (see commit `4c5fb675`): the device must be able to
self-upgrade from an older runner to a newer runner. If the runner
hard-rejected unknown keys, no device could ever reach a new release.
The flip side is that an old runner silently drops new env keys, so
features that depend on those keys will not work in mixed-version
deployments — which is acceptable as long as the controller side does
not rely on a new key being forwarded (it should always fall back to a
default in that case).

### Node Range Compatibility

`assertDevicePackageCompatibility` enforces `manifest.compatibleNodeRange`
(line 105-111) and `manifest.minCurrentVersion` (line 113-126).
`assertSourcePackageCompatibility` (`strategies/source-package.ts:5-23`)
enforces only `minCurrentVersion`, not Node range. Practical consequence:

- A v0.7.0 device running Node 22 can in principle upgrade through
  `source-deploy` to v0.7.19 even though v0.7.19's device-package tar
  would reject it for Node version.
- The Node version floor is enforced **only** on the `device-package`
  path. If a future release tightens Node to 24, devices that go
  through `source-deploy` first will not be warned.

### Version Field Sources (Priority Order)

`getLocalWebUiVersion` (`services/update/package-info.ts:36-42`) reads
from two sources, in priority order:

1. **esbuild `define`-injected `__APP_VERSION__`**, baked into
   `dist/server/index.js` at build time
2. **`/opt/hermes-web-ui/package.json` `version` field**, read from disk

Implications:

- If the on-disk `package.json` is edited but the dist is not rebuilt,
  `/health` still reports the build-time version. Editing `package.json`
  without rebuilding is a lie.
- If `__APP_VERSION__` is missing or empty (older build pipeline that did
  not inject it), `/health` falls back to the on-disk `package.json`.
- This explains the v0.7.0-customer symptom where `webui_version` reports
  `0.7.0` after a `device-package` upgrade whose OSS tar was built from a
  0.7.0-era source: the build-time `__APP_VERSION__` is `0.7.0`, and it
  takes priority over the on-disk `package.json` (which may or may not
  have been updated by the install script).

### Cross-Version Bootstrap Path

When a device is too old for the latest manifest, the upgrade must be
staged:

```
v0.7.0 (device, Node 22, no fingerprint awareness)
   │
   ├─► upgrade through an intermediate manifest that:
   │   • has compatibleNodeRange that admits Node 22
   │   • has minCurrentVersion ≤ v0.7.0
   │   • does NOT carry installerScriptSha256 (so old install script is accepted)
   │
   │  e.g. v0.7.17 device-package manifest published before the fingerprint
   │  commit. After this step, the on-disk install script is replaced with
   │  the v0.7.17-era script.
   │
   ├─► upgrade through v0.7.19 (still no fingerprint, NODE range widened)
   │  After this step, install script is at v0.7.19 and Node has been
   │  raised to 23 by the upgrade.
   │
   └─► upgrade through v0.7.20+ (fingerprint present, install script matches)
```

This is the same approach `docs/deploy-update-runbook.md` already takes
for manual rescues, formalised here so the next agent does not have to
rediscover the staging requirement.

### What Is NOT Forward-Compatible

These are the failure modes that the current pipeline will not gracefully
handle:

| Case | Result |
|---|---|
| `compatibleNodeRange` tightened beyond the device's Node version | 409 `update_incompatible_node`. No automatic upgrade of Node. |
| `minCurrentVersion` raised past the device's version | 409 `update_incompatible_current_version`. No automatic bootstrap. |
| New fingerprint on a manifest whose install script is older than the device's | 409 `update_installer_script_stale`. The operator must run an intermediate install. |
| Source-deploy manifest URL unreachable | Falls back to npm registry (`controllers/update.ts:1611-1616`). If both fail, upgrade is stuck. |
| Device-package manifest URL unreachable | Hard fail. No fallback. The operator must use `source-deploy` or a manual install. |
| `PORT` env var unset when `install-device-package.sh` runs | `install-device-package.sh:36` defaults `PORT` to `8648`, silently changing the listening port. This is a footgun that has been observed in production (v0.7.0-customer incident). |

The last row is the most surprising one and is tracked as an open
question below.

The single most important observation about the current pipeline:

> **No layer is currently responsible for verifying that the code running
> on the device is the code that the manifest claimed would run.**

- `install-device-package.sh` trusts that the OSS tar contains what the
  manifest says it contains (only `sha256` of the whole tar is verified).
- The controller trusts the install script to report success.
- The UI trusts `webui_version` from `package-info.ts` to mean "this is
  the running version".

There is no step that says "the version string inside
`dist/server/index.js` matches the version string in the manifest that
was used to fetch this tar". That is the gap that the v0.7.0 customer
incident exposed.

## Open Questions

These are intentionally not answered yet — they are listed so that the
next agent does not have to rediscover them.

1. **Where exactly did the v0.7.19 OSS tar get its `0.7.0`-labelled
   dist?** Git history shows commit `165e4626` updating `package.json`
   to `0.7.19`; CI checkout `v0.7.19`, `npm ci`, `npm run build` should
   produce a `0.7.19`-labelled dist. Yet the tar at the
   `v0.7.19` OSS path contains a `0.7.0`-labelled dist. We need to read
   the actual `device-package-release.yml` run for that tag and check
   whether the build step succeeded.

2. **Why does `install-device-package.sh` line 36 default `PORT=8648`?**
   This silently changes the listening port for any operator who runs
   the install script without first exporting `PORT`. The fix is
   straightforward (do not default to a value that changes the public
   surface) but the question of "why was this added in the first place"
   needs a git blame.

3. **Should `device-package` and `source-deploy` ever share the same
   install script?** Currently
   `install-device-package.sh#run_deploy_script` shells out to
   `deploy-source-armbian.sh`. The two have different purposes (one
   ships a prebuilt dist, the other builds on-device) and sharing the
   shell entry point makes the failure surface confusing.

## What To Read Next

- `docs/deploy-update-runbook.md` — operator workflow, how to manually
  rescue a device.
- `docs/harness/validation.md` — what tests to run when changing any of
  the files listed above.
- `docs/harness/meeting-asr-safety-audit.md` — the related incident where
  process-management assumptions went wrong during a v0.7.7 upgrade.
- `AGENTS.md` — hard rule on `packageAllowlist` script changes.