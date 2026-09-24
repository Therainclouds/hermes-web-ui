# Task 13 — Hermes Agent update seam (v0.8.10)

> Status: planned. This is the spec for upgrading Hermes Agent from
> the Web UI **as its own seam**, activated out of the separation
> AGENTS.md mandates ("Treat bootstrap, runtime reconcile, Web UI
> update, and Hermes Agent upgrade as separate seams") and the
> `agentManifestSha` slot reserved in
> `docs/harness/source-deploy-refactor.md` (phase (c)).
>
> Goal: when the official Hermes Agent ships a newer wheel, an
> operator (or an auto policy they explicitly enabled) upgrades the
> agent on the device — visibly, transactionally, and never as a
> silent side effect of a Web UI update.

## Why this task exists

Investigation on 2026-09-14 (v0.8.8 promote session) established the
current shape:

- The device's real update path (`source-deploy` →
  `scripts/update-orchestrator.sh`) **never touches Hermes Agent**.
  It swaps the Web UI deploy tree and deliberately preserves
  `hermes_data`.
- `config.update.includeAgentUpgrade` defaults to **true** but is
  only wired into the **npm-package** path
  (`controllers/update.ts` → `upgradeHermesAgentAfterNpmUpdate()`).
  On `source-deploy` devices it is dead configuration. A default
  that lies about behavior is itself a defect; this spec replaces
  the flag with an honest policy (below).
- The agent-distribution plumbing already exists and is healthy:
  `.github/workflows/device-package-release.yml` publishes wheels +
  wheelhouse + `hermes-agent/<channel>/latest.json` to OSS, and
  `deploy-source-armbian.sh` resolves the latest wheel from that
  manifest (fallback: GitHub release metadata, then PyPI).
- Device 6.6.6.73 runs agent `v0.17.0 (2026.6.19)` and will stay
  there forever under the current design, because nothing on the
  update path can move it.

## Hard rules (inherit AGENTS.md verbatim)

- Hermes Agent upgrades must NOT be the default side effect of a
  Web UI update. Default policy is `off`.
- Web UI update and Agent update are **independent transactions**:
  an agent-upgrade failure never rolls back (or blocks) a completed
  Web UI update, and vice versa.
- The agent seam lives in `scripts/update-orchestrator.sh` (new
  `agent_upgrade` stage) + a controller/service pair — never in
  `deploy-source-armbian.sh`, which stays bootstrap/first-install
  only.
- All download verification goes through sha256; disk headroom is
  gated by the orchestrator's existing space guard; refusal is a
  503-class structured error, never a silent degrade.
- `/api/knowledge/*`-style route ordering applies to the new
  `/api/hermes/agent-update/*` routes (register before proxy
  catch-all).

## Decisions

- (a) **Policy first.** New file `updates/policy.json` gains an
  `agentUpdate` key (precedence follows the existing operator-policy
  chain: `policy.json` > env > default):

  ```json
  { "agentUpdate": "off" | "prompt" | "auto" }
  ```

  - `off` (default): detection still runs; UI shows the available
    version; no action is ever taken automatically.
  - `prompt`: after a Web UI update completes, if an agent update is
    available, the UI offers it as a separate one-click step ("Web
    UI 已更新 → 是否同时升级 Agent?"). Never auto-executes.
  - `auto`: the orchestrator may chain the agent upgrade after a
    successful Web UI swap, as a distinct stage with its own
    journal entry and rollback. This is the only value that makes
    the two upgrades happen in one operation, and it must be
    explicitly written by an operator.
  - The dead `WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE` env is kept as a
    hidden alias for the npm-package path (no behavior change) but
    is documented as legacy; new code reads `agentUpdate` policy.

- (b) **Detection.** `update-check-cache` gains a second, parallel
  snapshot for the agent channel manifest (`hermes-agent/<channel>/
  latest.json`). It shares the manifest-pinned-stale defense from
  task-12 § Update-source hardening (same three-shape awareness:
  any `WEBUI`/`HERMES` manifest URL env may pin to a frozen
  artifact). `/health` gains:

  ```json
  {
    "agent_version": "v0.17.0",
    "agent_latest": "v0.19.1",
    "agent_update_available": true,
    "agent_update_policy": "off"
  }
  ```

  (field names are final; device health consumers only add, never
  rename.)

- (c) **Execution — orchestrator stage `agent_upgrade`.** Triggered
  by `scripts/update-orchestrator.sh agent-upgrade <target-version>`
  (called from the server controller, mirroring how the Web UI
  update is invoked):

  1. journal open (task-store, same state file, new task type
     `agent`)
  2. preflight: policy allows (`prompt` → user-confirmed flag
     required; `off` → refuse `403 agent_update_disabled_by_policy`);
     space guard (`pip` wheel + venv delta); agent bridge health
     baseline
  3. resolve wheel URL + sha256 from the channel manifest
     (wheelhouse as offline fallback)
  4. download to staging, verify sha256, refuse on mismatch
  5. snapshot current agent: `pip freeze` + installed wheel name
     under `updates/backups/agent/<ts>/`
  6. `pip install` into the agent venv (as the runtime user), then
     restart the agent bridge (existing supervisor path)
  7. healthcheck: bridge `ready` within timeout AND a version echo
     equals target; on any failure, restore the snapshot (pip
     uninstall/install previous wheel), restart bridge again, fail
     the task — Web UI untouched
  8. stamp `state/identity.json` → `agentManifestSha` = sha256 of
     the installed wheel metadata (activates the phase-(c) reserved
     slot; pre-existing `"0.0.0-noop"` values are overwritten only
     by a successful agent_upgrade)
  9. journal close; socket event `agent-update:done` for the UI.

- (d) **UI.** Settings → update section becomes two rows:
  `Hermes Web UI` (existing flow) and `Hermes Agent` (new). Each
  row shows current/latest and its own action button; the Agent row
  is disabled (with the policy name in the tooltip) under `off`.
  `prompt` renders the offer card after a Web UI update. The
  Agent row carries its own progress toast (stage names from the
  orchestrator journal).

- (e) **API surface.** All under `/api/hermes/agent-update`,
  registered before the proxy catch-all:

  ```
  GET  /api/hermes/agent-update/status    -> { current, latest, available, policy, task? }
  POST /api/hermes/agent-update/apply     -> start task (403 under off;
                                            requires {confirm:true} under prompt)
  GET  /api/hermes/agent-update/tasks/:id -> journal view for the UI
  ```

## Files

### Create
- `packages/server/src/services/agent/update-seam.ts` — policy
  resolution, status, apply orchestration (invokes orchestrator).
- `packages/server/src/controllers/agent-update.ts`,
  `packages/server/src/routes/agent-update.ts`.
- `scripts/_lib/agent-wheel.sh` — download/verify/snapshot/restore
  helpers (sourced by the orchestrator; no standalone executable).
- `tests/server/agent-update-seam.test.ts`,
  `tests/release/agent-update-e2e.test.ts` (opt-in via env).

### Modify
- `scripts/update-orchestrator.sh` — `agent_upgrade` stage.
- `packages/server/src/services/update/update-check-cache.ts` —
  agent channel snapshot.
- `packages/server/src/controllers/health.ts` — `agent_*` fields.
- `packages/client/src/.../settings` update card — two-row layout.
- `AGENTS.md` — append the `agentUpdate` policy line to the
  device-update-strategy rule (keep the "not a default side
  effect" wording intact).
- 11 locales: `settings.agentUpdate.*` strings.

## Acceptance criteria

1. Fresh device, policy absent: agent detection visible in
   `/health`; no path exists that moves the agent without an
   explicit apply + `confirm`.
2. `off` + direct `POST apply` → `403 agent_update_disabled_by_policy`.
3. `prompt` + completed Web UI update + newer agent available: offer
   card appears; clicking it with `confirm:true` runs the stage and
   the UI reports success; bridge reconnects; `identity.json`
   `agentManifestSha` is a 64-hex value.
4. Wheel sha mismatch → task fails before touching venv; agent
   version unchanged.
5. venv install or healthcheck fails → previous wheel restored,
   bridge back to baseline, task marked failed, and the Web UI
   version is exactly what it was before the attempt (independence).
6. `auto` + Web UI update: agent stage chains; each stage has its
   own journal line; killing the process mid-agent-stage leaves the
   previous wheel intact (snapshot-first invariant).
7. `manifest_pinned_stale` detection applies to the agent channel
   manifest too: a frozen `HERMES_AGENT_UPDATE_MANIFEST_URL` with a
   reachable newer channel tip surfaces the warning and prefers the
   tip.
8. `npm run harness:check`, `npm run build`, and both new test
   files green; all task-12/v0.8.8 criteria stay green.

## Out of scope (future)

- Multi-version agent rollback store (one snapshot back is enough
  for 0.8.10; aligns with Web UI's lastgood semantics).
- Agent channel switching (`stable`/`beta`) from the UI.
- Per-session agent pinning (device runs one agent version globally).

## References

- `docs/harness/source-deploy-refactor.md` — phase (a) invariants,
  identity schema, `agentManifestSha` reserved slot (phase (c)).
- task-12 spec § Update-source hardening — pinned-manifest
  detection reused here.
- AGENTS.md — "Do not make Hermes Agent upgrades the default side
  effect of Web UI updates"; seam separation rule.
