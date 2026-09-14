# Update Reconciliation Plan

A five-phase plan to stop the update pipeline from getting stuck in
recurring, low-signal ways. Companion document to
`update-system-overview.md`: that one describes what the system **is**,
this one describes what we are going to **change** about it.

## Why A Plan And Not A Single PR

We already shipped two structural fixes (`afe03b04` for healthcheck
caching, `5ae749dd` for install-script fingerprinting) that addressed
the two most prominent failure modes on the v0.7.x line. After those
landed, three independent incidents remained visible:

- 6.6.6.31 — `/opt/hermes-web-ui/` was missing entirely; no bootstrap
  path existed.
- v0.7.0 customer — `install-device-package.sh:36` silently changed
  the listening port from 6060 to 8648 after a manual upgrade.
- v0.7.0 customer (same session) — `webui_version` reported the wrong
  version because the on-disk tar's `dist/` had a different version
  baked in than the manifest claimed.

None of these are "the upgrade is broken" in the sense of a single
fixable bug. They are all symptoms of one structural gap:

> The pipeline has no concept of a **device environment** that is
> co-installed with the package. The install script swaps the package
> but never asserts that the environment around the package can run
> the new version, and never leaves a record of what it changed.

The plan below fills that gap in five ordered phases. Each phase
ships a usable improvement on its own; later phases depend on earlier
ones.

## Goals

1. **Stop silent port drift** — `PORT` must never change without the
   operator knowing.
2. **Stop silent environment gaps** — if a new package needs Node 23
   and the device is on Node 22, the operator must learn this before
   the upgrade starts, not at the end of it.
3. **Make upgrades idempotent and inspectable** — repeated upgrades
   must not corrupt the device, and the device's environment must be
   inspectable at any time without running another upgrade.
4. **Add a real bootstrap path** — a device with `/opt/hermes-web-ui/`
   missing must be able to come online from a tar without a
   hand-prepared bootstrap.
5. **Make failure modes self-describing** — when an upgrade fails, the
   device must surface *what* is out of date (env? script? package?)
   rather than just *that* something failed.

## Non-Goals

- **Not a configuration management system.** We are not going to
  declare apt packages, systemd units, firewall rules, or any other
  OS-level state in the manifest. The web-app package updates itself;
  the host OS is the device vendor's responsibility.
- **Not a forced migration to `device-package`.** `source-deploy`
  remains a supported strategy and stays useful for development and
  for network-constrained environments. Both paths will gain
  environment accounting, not one superseding the other.
- **Not a generic rollback framework.** We are not building a
  multi-version rollback store. The single most-recent backup plus the
  env-state journal is enough.

## Architecture

```
+-----------------------------+        +----------------------------+
|        DevicePackage        |  +--- |      DeviceEnvironment     |
|          Manifest           |  |    |         (manifest)         |
+-----------------------------+  |    +----------------------------+
| version                     |  |    | requiredNodeRange          |
| minCurrentVersion           |  |    | requiredHermesAgentRange?  |
| compatibleNodeRange         |  |    | requiredSystemFiles?       |
| installerScriptSha256       |  |    |                            |
| environment?: <-------+     |  |    +----------------------------+
| sha256                   |     |  |
| ...                      |     |  |
+--------------------------+--+--+  |
                            |     |
                            v     |
+--------------------------+------+--------------------------------+
|                    install-device-package.sh                     |
+-----------------------------------------------------------------+
|  --bootstrap (creates DEPLOY_DIR if missing)                     |
|  --reconcile-env-only (does not touch package)                  |
|  snapshot env before -> install -> journal env changes ->       |
|  write /var/lib/hermes-web-ui/env-state.json                    |
+-----------------------------------------------------------------+
                            |
                            v
+-----------------------------------------------------------------+
|        Web UI controller                                        |
|  • preflight uses manifest.environment? as a hard gate          |
|  • background reconciliation reads env-state.json and surfaces  |
|    drift as a banner in the Web UI                              |
+-----------------------------------------------------------------+
```

The shape of the design:

1. The **manifest** declares what environment the new package needs
   (Node range, hermes-agent range, file existence).
2. The **install script** is the **single writer** of the device
   environment state. It snapshots before, journals during, writes
   after.
3. The **controller** reads both the manifest and the on-device
   state and either refuses, runs an upgrade, or surfaces a banner.
4. All three pieces live in different places (manifest, install
   script, controller) and the install script never modifies the
   manifest. This keeps the contract simple and testable.

## The Five Phases

The phases are ordered by **value-per-day**. Phase 2 ships the most
bang for the buck and is the recommended starting point. Phase 1
lays the manifest schema that later phases depend on.

| Phase | Title | What it fixes |
|---|---|---|
| 1 | Manifest environment schema | The controller has a structured way to ask "will this device run this package?" |
| 2 | Install script environment accounting | The install script stops silently drifting the port and starts writing a durable env-state journal |
| 3 | Controller reconciliation | The Web UI shows an "environment needs repair" banner with one-click reconcile |
| 4 | Bootstrap path | A device with `/opt/hermes-web-ui/` missing can be recovered from a tar alone |
| 5 | Tests + docs | The pipeline gains end-to-end coverage and the docs stop being a moving target |

Each phase has a dedicated spec under `.zcode/plans/` that an agent
can execute end-to-end. The specs are listed in
[Phase Spec Index](#phase-spec-index).

## What This Plan Does NOT Touch

- CI on GitHub Actions (we ship from local builds for the foreseeable
  future)
- The npm registry mirror (`registry.npmmirror.com` is the default in
  `deploy-source-armbian.sh:1708` and that is correct for our devices)
- The `update-task-state.py` protocol — we keep the existing
  stage names so old consumers continue to parse
- The OSS fingerprint mechanism introduced in `5ae749dd` — that is
  preserved and extended, not replaced

## Phase Spec Index

Each phase has a dedicated spec in `.zcode/plans/`:

- `update-reconciliation-phase1.md` — manifest schema + build wiring
- `update-reconciliation-phase2.md` — install script + env-state journal
- `update-reconciliation-phase3.md` — controller reconciliation + UI banner
- `update-reconciliation-phase4.md` — bootstrap mode
- `update-reconciliation-phase5.md` — tests + docs finalisation

The specs are written so that an agent can pick one up, execute it
without re-deriving the design, and have a working PR at the end.

## Manifest Environment Schema (Phase 1)

Starting in Phase 1, manifests published by `scripts/build-device-package.mjs`
may include an `environment` block:

```jsonc
{
  "version": "0.7.20",
  "environment": {
    "requiredNodeRange": ">=23.0.0",
    "requiredHermesAgentRange": ">=0.16.0",
    "requiredSystemFiles": [
      { "path": "scripts/install-device-package.sh", "kind": "executable" }
    ]
  }
}
```

Field semantics:

- `requiredNodeRange` — semver range. Defaults to `compatibleNodeRange`
  when omitted. Phase 1 carries the value through; Phase 3 wires it into
  preflight gates.
- `requiredHermesAgentRange` — optional semver range checked by the
  install script against the running Hermes Agent. Absent means "no
  constraint".
- `requiredSystemFiles` — array of `{path, kind}` descriptors. `path`
  is relative to the deploy root unless it starts with `/`. `kind` is
  one of `present`, `executable`, `absent`. Phase 1 carries the value
  through; Phase 3 wires it into preflight gates.

The block is optional. Manifests without `environment` keep validating
unchanged. The manifest-client normalises the block — unknown subfields
are dropped silently, malformed entries are coerced to their defaults.

## Manifest Environment Schema (Phase 1)

Starting in Phase 1, manifests published by `scripts/build-device-package.mjs`
may include an `environment` block:

```jsonc
{
  "version": "0.7.20",
  "environment": {
    "requiredNodeRange": ">=23.0.0",
    "requiredHermesAgentRange": ">=0.16.0",
    "requiredSystemFiles": [
      { "path": "scripts/install-device-package.sh", "kind": "executable" }
    ]
  }
}
```

Field semantics:

- `requiredNodeRange` — semver range. Defaults to `compatibleNodeRange`
  when omitted. Phase 1 carries the value through; Phase 3 wires it into
  preflight gates.
- `requiredHermesAgentRange` — optional semver range checked by the
  install script against the running Hermes Agent. Absent means "no
  constraint".
- `requiredSystemFiles` — array of `{path, kind}` descriptors. `path`
  is relative to the deploy root unless it starts with `/`. `kind` is
  one of `present`, `executable`, `absent`. Phase 1 carries the value
  through; Phase 3 wires it into preflight gates.

The block is optional. Manifests without `environment` keep validating
unchanged. The manifest-client normalises the block — unknown subfields
are dropped silently, malformed entries are coerced to their defaults.

## What "Done" Looks Like

At the end of phase 5:

- A device on a v0.7.x line can be upgraded to the latest release with
  no operator intervention beyond clicking "upgrade".
- If the upgrade is blocked (Node too old, missing file, etc.), the
  Web UI tells the operator exactly which gate failed and offers a
  reconcile button.
- A device with `/opt/hermes-web-ui/` missing can be brought up from
  a tar using `install-device-package.sh --bootstrap`.
- After any upgrade, `/var/lib/hermes-web-ui/env-state.json` answers
  the question "what environment does this device claim to have?"
- The same upgrade can be run twice in a row without changing the
  device. (Idempotency.)
- All five production-incident failure modes documented in
  `update-system-overview.md` are either closed or have a documented
  reconcile path.