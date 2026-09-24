# Task 12 — auto vaults, upload checkbox, USB on-demand, quotas (v0.8.9)

> Status: builds on Task 11 (metadata_only + vault.kind). This is the
> feature set that gives users a working knowledge library on first
> boot without any configuration, while keeping disk usage bounded on
> the 40 GB user-area budget of the device.
>
> Goal: a brand-new device with `KNOWLEDGE_ENABLED=true` and a valid
> embedding API key has **four usable vaults** within the first
> service start, the user can opt any single upload into full-text
> indexing, USB mounts expose a one-click "scan this drive" entry,
> and the service refuses to blow past 4 GB of total knowledge data.

## Why this task exists

Task 11 separates "record this file" from "make it searchable" but
doesn't tell the user **where to put files** or **when to promote
them**. Without auto-vaults, every new user must:

1. Open the knowledge page.
2. Click "add vault".
3. Type a filesystem path that they cannot easily discover.
4. Repeat for every folder they care about.

That's the wrong shape for our users (lawyers, learning maniacs, task
maniacs, AI enthusiasts, repetitive-file laborers). They expect the
knowledge library to be **on by default**, with **sane defaults**,
and a **clear affordance to promote** anything that matters.

USB is even worse: today the user would have to know the
mount-path-scheme (`mnt/usb/<uuid>/`) and add a vault manually.
On-demand mounting from the knowledge UI is the natural entry.

Quotas exist because the device's emmc is 64 GB but the user area
is 40 GB. Current SQLite is 540 MB. vec0 + FTS5 + chunks grow
linearly with content; without a guard, the knowledge library can
saturate the disk and brick updates.

## Decisions captured in this spec

- (c) USB vaults are **on-demand, FTS5-only, reference-based**. The
  service reads from the mount but does not copy content into
  vec0.
- (d) Storage budget: 40 GB user area total, ≤ 4 GB knowledge
  data total, ≤ 5 GB per vault, ≤ 8 vaults.
- (e) v0.8.9 ships (1) auto 4 vaults, (2) upload checkbox,
  (3) USB on-demand, (4) quota monitor — all four together because
  none of them is useful in isolation.
- (f) Confirmed 2026-09-14 by the operator, binding for the vault
  drawer:
  1. **Drawer, not modal** — the 720-px right-side `NDrawer`
     (matches `KnowledgeSettingsCard`'s drawer pattern).
  2. **`kind='auto'` is hidden from non-power users** — the radio
     option only renders behind `KNOWLEDGE_POWER_USER_UI=true`;
     normal users see `手动` / `U盘` only. Rationale: an `auto`
     vault created by hand overlaps the four bootstrap vaults and
     confuses the metadata-only contract.
  3. **Allowlist includes `/tmp`, `/data`, `/sdcard`, `/mnt`** in
     addition to `$HERMES_WEB_UI_HOME` and mounted USB roots —
     each probed with `existsSync` and silently skipped when
     absent. Expanding this list is a spec change, not a code
     change.
  4. **Vault ceiling is a flat total of 8** across all kinds
     (auto + manual + usb counted together), not per-kind
     buckets. Simple to explain, simple to enforce in one
     `COUNT(*)` against `knowledge_vaults`.
- (g) v0.8.9 also ships the update-source hardening from the
  2026-09-14 v0.8.8 pin incident (§ "Update-source hardening").
  The incident: device 6.6.6.73 carried a hand-edited
  `WEBUI_UPDATE_MANIFEST_URL` pin to
  `releases/v0.8.6/manifest.json` from the v0.8.6-era manual
  deploys. The pin was always-fetchable, so every 30-min check
  "succeeded" with version 0.8.6 — freshness green, empty
  `remoteError` — and the device rendered no update button with
  no error anywhere. It surfaced only because v0.8.8 was the
  first release to depend on the channel `latest.json`.

## Hard rules (must not regress)

- All Task 11 acceptance criteria stay green.
- All v0.8.7 acceptance criteria for manually-created vaults stay
  green.
- The single-writer queue (knowledge.service.ts) remains the only
  ingest path; auto-vault, manual-vault, promote, USB-scan, and
  semi-auto task-finalize archive **all** go through it.
- The router rule (AGENTS.md): register `/api/knowledge/*` before
  any proxy catch-all. New endpoints follow the existing
  `/api/knowledge/documents/:id/...` namespace.
- Service code never calls `process.env.HERMES_WEB_UI_HOME`
  directly; it goes through `getWebUiHome()` (AGENTS.md rule).
- `deploy-source-armbian.sh` is bootstrap-only and is **not** the
  update path. All update logic stays in `update-orchestrator.sh`
  (AGENTS.md rule).

## Summary

1. Bootstrap four auto vaults when the service starts and
   `KNOWLEDGE_DEFAULT_VAULTS=auto` (default).
2. Watcher: auto vault → metadata_only, manual vault → full,
   usb vault → FTS5-only.
3. Upload endpoint: accept `archive_to_knowledge` form field;
   when true, queue the saved path for full indexing.
4. USB mounts: scan `/mnt/usb/<uuid>/`, expose to the knowledge
   sidebar as "Scan this drive".
5. Quota monitor: live byte counts, 80/90/100% thresholds, refuse
   new ingest at 100%, downgrade to metadata_only at 90%.
6. Semi-auto archive: hook task finalize, write the produced
   files into the `auto_tasks` vault with `auto:task:<id>` tags,
   toast with undo.
7. UI: knowledge sidebar gains entries for the four auto vaults;
   file uploads in chat/notes have an "归档到知识库" checkbox;
   USB volumes appear in the sidebar when mounted; quota meter
   in the status bar.
8. Tests: per-section server + e2e + storage-quota boundary.

## The four default vaults (binding contract)

| name (zh / en)              | path                                              | kind   | scope                       |
|-----------------------------|---------------------------------------------------|--------|-----------------------------|
| 我的上传 / User Uploads     | `$HERMES_WEB_UI_HOME/upload/<profile>/*`          | auto   | per-profile                 |
| Agent 工作区 / Agent Workspace | `$HERMES_WEB_UI_HOME/hermes_data/<profile>/workspace` | auto | per-profile               |
| 会议记录 / Meeting Archive  | `$HERMES_WEB_UI_HOME/meetings/*`                  | auto   | global                      |
| 用户笔记 / User Notes       | `$HERMES_WEB_UI_HOME/hermes_data/<profile>/notes` | auto   | per-profile (auto-mkdir)    |

Bootstrap behavior on first start with `KNOWLEDGE_DEFAULT_VAULTS=auto`:

- For each vault above, check by `kind='auto' AND root_path=?`.
- If missing, insert with `kind='auto'`, `watch=1`, idempotent on
  the unique constraint `root_path`.
- The "我的上传" and "用户笔记" paths may not exist yet; `mkdir -p`
  before insert.
- Bootstrap failure must not abort the rest of the service
  startup — log a warning and continue. Bootstrap is
  best-effort, observable, retryable via `POST /api/knowledge/
  vaults/bootstrap-defaults` (admin endpoint).

`KNOWLEDGE_DEFAULT_VAULTS=off` skips bootstrap entirely. Users can
still create `kind='auto'` vaults manually.

## Upload checkbox

Frontend: in every upload widget (chat attachment, note editor,
profile avatar helper), add a `n-checkbox` "归档到知识库"
(archive to knowledge base), default **unchecked**.

Wire format: `multipart/form-data` field `archive_to_knowledge`
(`"true"` | `"false"`).

Backend (`POST /api/upload`):

```text
1. Save the file to uploadDir as today.
2. If archive_to_knowledge=true:
   a. If KNOWLEDGE_ENABLED=true AND keyConfigured=true:
      queue a metadata_only ingest (kind='auto' vault).  Return
      archived=true, documentId, queuePosition.
   b. Otherwise:
      Return archived=false, reason='plugin_disabled' |
      'no_api_key' | 'plugin_uninitialized'.
```

Important: **never copy the file**. metadata_only writes only the
documents row; chunks are not produced. Disk cost is ~300 bytes per
file regardless of file size. vec0 cost is **zero** until the user
promotes.

The user can promote from the knowledge UI detail drawer as in
Task 11. After promote, the file becomes fully searchable.

## USB on-demand

Background process: a polling watcher that runs every 5 s on
`$HERMES_WEB_UI_HOME/mnt/usb`. When a new `<uuid>/` appears, log it
as a discoverable volume; when one disappears, mark related
documents as `status='unmounted'` (extend the status enum;
existing search filter already excludes non-indexed statuses).

UI surface: in the knowledge sidebar, a "可扫描的 U 盘" section
appears below the auto vaults, listing currently mounted volumes
with their labels. Click "扫描" to:

1. Create a `kind='usb'` vault with `root_path=mountPath`.
2. Run an **FTS5-only** ingest pass: extract text, write to
   `knowledge_chunks_fts` directly, but do **not** write
   `knowledge_chunks_vec`. The document status is a new value
   `'fts_only'`.
3. Show a progress toast. Cancellation via the watcher is allowed.

When the volume is unmounted:

- Documents become `status='unmounted'` (search-invisible).
- The vault row stays; when the volume comes back, the watcher
  re-scans and re-applies `'fts_only'`.
- `knowledge_chunks` content remains (chunks table does not
  depend on the source file); only the `documents` row's status
  changes. Re-mount does not require re-extraction.

Disk budget for USB vaults: each FTS5 row is ~80 bytes of
extracted text (per 512-token chunk), so 100k chunks ≈ 8 MB.
Quotas apply across all vault kinds.

## Quota monitor

```ts
const QUOTA = {
  totalBytes: 4 * 1024 * 1024 * 1024,    // 4 GB
  warnThreshold: 0.8,                     // 3.2 GB
  downgradeThreshold: 0.9,                // 3.6 GB
  hardLimit: 1.0,                        // 4 GB
  perVaultBytes: 5 * 1024 * 1024 * 1024, // 5 GB
  maxVaults: 8,
}
```

`KnowledgeService.quota()` returns a snapshot used by the UI:

```ts
interface KnowledgeQuota {
  totalBytes: number
  warn: boolean                  // >= 80%
  downgrade: boolean             // >= 90%
  hardLimitReached: boolean      // >= 100%
  vaultCount: number
  perVaultBytes: number
}
```

Watcher behavior at each threshold:

- **<80%**: no change.
- **80% ≤ x < 90%**: log warning, UI shows yellow toast
  "knowledge library nearing 4 GB".
- **90% ≤ x < 100%**: auto-vaults ingest as `metadata_only`
  regardless of user intent (full ingest explicitly downgraded).
  Manual vaults still ingest fully but log a warning.
- **≥ 100%**: refuse new ingest (`Error('quota_exceeded')`),
  emit socket event `knowledge:quota:exceeded`, UI shows a
  blocking modal until the user deletes documents.

Byte counts include `knowledge_documents` + `knowledge_chunks` +
`knowledge_chunks_fts.content` + `knowledge_chunks_vec` (vec0
on-disk size is read via `pragma page_count * page_size`).
`knowledge_references` is excluded from quota (it's a log, not a
content index).

## Semi-auto archive (task finalize hook)

Trigger: a Hermes task transition to `status='done'` where
`run.outputs.files` is non-empty. Each file in `outputs.files`
must be a real file path under
`$HERMES_WEB_UI_HOME/hermes_data/<profile>/`.

Action:

1. Create or reuse a `kind='auto'` vault named
   `auto_tasks` rooted at
   `$HERMES_WEB_UI_HOME/hermes_data/<profile>/workspace` (same
   root as the Agent Workspace auto vault, but indexed
   differently — see below).
2. For each file in `outputs.files`, call `metadataIngest()` —
   not full ingest. Reason: the user has not yet read the result.
3. UI toast: "已归档 N 个产物到「自动归档」" with [撤销] [打开]
   buttons. [撤销] issues a batch delete via the existing
   `DELETE /api/knowledge/documents/:id`. [打开] navigates to the
   `auto_tasks` vault in the knowledge page.

Promotion to full ingest: the user clicks "全文索引" on each
document as with any other metadata_only row.

Differentiation from Agent Workspace: same root path, but tagged
differently in the documents row via a new `source` enum:
`'agent-workspace'` vs `'task-finalize'`. The `source` column is
new and added by ALTER TABLE in the same migration as `vault.kind`.

De-dup: same source path inside the same `sessionId` within
7 days is skipped (silently, with a debug log line).

## Files

### Create

- `packages/server/src/services/knowledge/bootstrap.ts` — auto
  vault bootstrap, idempotent.
- `packages/server/src/services/knowledge/quota.ts` — quota
  monitor with thresholds.
- `packages/server/src/services/knowledge/usb-scanner.ts` —
  mount detection, vault creation, FTS5-only ingest.
- `packages/server/src/services/knowledge/task-archive.ts` —
  semi-auto task finalize hook.
- `tests/server/knowledge-bootstrap.test.ts`
- `tests/server/knowledge-quota.test.ts`
- `tests/server/knowledge-usb-scanner.test.ts`
- `tests/server/knowledge-task-archive.test.ts`
- `tests/release/knowledge-default-vaults.e2e.test.ts` (opt-in
  via env var so CI doesn't need real upload paths).

### Modify

- `packages/server/src/db/knowledge-schema.ts` —
  ALTER TABLE `knowledge_documents` ADD `source` TEXT
  (default `'unknown'`). Status enum extended to include
  `'fts_only'` and `'unmounted'` (service-layer enum, DB CHECK
  constraint added via trigger).
- `packages/server/src/services/knowledge/knowledge.service.ts` —
  `bootstrapDefaults()`, `quota()`, `getVaultByKind()`, ingest
  path branches on quota threshold.
- `packages/server/src/services/knowledge/watcher.ts` —
  branches on `vault.kind` ('auto' → metadata_only, 'usb' →
  FTS5-only, 'manual' → unchanged).
- `packages/server/src/controllers/upload.ts` — accept
  `archive_to_knowledge` field, return
  `{ files, archive: { archived, documentId?, reason? } }`.
- `packages/server/src/controllers/knowledge.ts` — new
  endpoints: `bootstrapDefaults`, `listUsbVolumes`,
  `scanUsbVolume`, `quota`.
- `packages/server/src/routes/knowledge.ts` — register all new
  routes **before** the settings routes, following AGENTS.md
  ordering.
- `packages/server/src/services/hermes/run-chat/finalize.ts` (or
  equivalent) — call `taskArchive.onTaskFinalize(sessionId,
  profile, files)` after the run is committed to the run log.
- `packages/client/src/plugins/knowledge/components/KnowledgeSidebar.vue`
  — render the four auto vaults + USB volumes.
- `packages/client/src/plugins/knowledge/api.ts` — new client
  helpers: `bootstrapDefaults()`, `quota()`, `listUsbVolumes()`,
  `scanUsbVolume(uuid)`.
- `packages/client/src/plugins/knowledge/composables/useKnowledgeData.ts`
  — surface quota + USB volumes via the existing reactive state.
- `packages/client/src/plugins/knowledge/components/KnowledgeStatusBar.vue`
  — show quota meter.
- `packages/client/src/components/hermes/chat/MessageItem.vue` (and
  any other upload widget) — checkbox "归档到知识库".
- `packages/client/src/plugins/knowledge/locales/*.ts` — every
  new string in zh and en; other 9 locales fall back to en.

## Schema migration

Run inside `ensureKnowledgeSchema`:

```sql
-- Idempotent: ALTER TABLE ADD COLUMN throws on duplicate;
-- catch and continue.
ALTER TABLE knowledge_documents ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown';

-- Index for the new "by vault kind" bootstrap path.
CREATE INDEX IF NOT EXISTS knowledge_vaults_kind
  ON knowledge_vaults(kind);
```

The CHECK constraint for the document status enum is moved into a
trigger so we can extend it without DDL drift:

```sql
CREATE TRIGGER IF NOT EXISTS knowledge_documents_status_check
BEFORE INSERT ON knowledge_documents
FOR EACH ROW
WHEN NEW.status NOT IN (
  'pending','indexing','indexed','failed','metadata_only','fts_only','unmounted'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid document status');
END;
```

The trigger is created inside `ensureKnowledgeSchema` after the
table DDL. Existing rows pass through unaffected.

## API surface (new endpoints)

All under `/api/knowledge`, registered before settings routes:

```
POST /api/knowledge/vaults/bootstrap-defaults
  -> { created: string[], skipped: string[] }

GET  /api/knowledge/quota
  -> KnowledgeQuota

GET  /api/knowledge/usb-volumes
  -> { volumes: Array<{ uuid, label, mountPath, sizeBytes }> }

POST /api/knowledge/usb-volumes/:uuid/scan
  -> { vaultId, status: 'scanning', documentsQueued: number }

POST /api/knowledge/task-archive/:sessionId
  -> { archived: Array<{ path, documentId }>, skipped: Array<{ path, reason }> }
```

`POST /api/knowledge/vaults` extends its body with an optional
`kind` field. Default `'manual'`. Validated against the enum.

`POST /api/upload` extends its response shape to include the
archive status of each uploaded file (see "Upload checkbox"
section).

## Acceptance criteria

1. Bootstrap on a fresh device with `KNOWLEDGE_DEFAULT_VAULTS=auto`:
   four vaults exist with `kind='auto'`; their `root_path`s
   resolve to real directories; `watch=1`; double-start is
   idempotent.
2. Bootstrap with `KNOWLEDGE_DEFAULT_VAULTS=off`: zero new
   vaults, manual vaults are untouched, no errors.
3. A file dropped into `upload/<profile>/` lands as a
   `metadata_only` row within 5 s of creation; `chunks`,
   `knowledge_chunks_fts`, `knowledge_chunks_vec` rows are
   **zero**.
4. The user checks "归档到知识库" on a chat upload; the file's
   document row transitions through `pending → indexing →
   indexed` and becomes searchable.
5. Plug in a USB drive; "可扫描的 U 盘" section in the sidebar
   lists it within 5 s; clicking "扫描" creates a
   `kind='usb'` vault, runs FTS5-only ingest, reports progress.
6. Unplug the USB; documents become `unmounted`; search no
   longer returns them; re-plug re-applies `fts_only` without
   re-extraction.
7. Quota at 80% shows the yellow toast; at 90%, auto-vault new
   files downgraded to `metadata_only`; at 100%, ingest
   rejected with `quota_exceeded` and a blocking modal in the
   UI.
8. Task finalize with `outputs.files = [a.md, b.md]` produces
   two `metadata_only` rows in the `auto_tasks` vault with
   `source='task-finalize'`, both surfaced in a toast with
   undo and open actions. Re-running the same task within 7
   days does not produce duplicate rows.
9. UI: sidebar lists the four auto vaults with their tags;
   status bar shows the quota meter; upload widget has the
   checkbox; task finalize shows the toast.
10. `npm run harness:check`, `npm run build`, all v0.8.8 tests
    stay green, new tests pass.

## Suggested commit message

```
feat(knowledge): auto-vaults, upload opt-in, USB scan, quotas

On first start with KNOWLEDGE_DEFAULT_VAULTS=auto (default), four
vaults bootstrap automatically — user uploads, agent workspace,
meeting archive, user notes — each kind='auto' so the watcher
ingests as metadata_only. Upload widget gains a checkbox to
promote a single file to full indexing. USB volumes expose a
"scan this drive" entry that creates a kind='usb' FTS5-only
vault; unmount demotes documents to 'unmounted', re-mount
re-applies without re-extraction. Quota monitor guards the
40 GB user-area budget: 80% warn, 90% auto-downgrade, 100%
refuse. Semi-auto archive on Hermes task finalize writes
deliverables to the auto_tasks vault with task-archive toast
and undo. Knowledge sidebar reflects the new layout.

Refs: docs/knowledge/specs/task-12-auto-vaults-and-quotas.md
Refs: AGENTS.md (getWebUiHome, route order, deploy-script
bootstrap-only).
```

## Update-source hardening — the v0.8.6 pin incident (2026-09-14)

Lesson: **a config override that always answers successfully is
indistinguishable from a healthy update source.** The device's
highest-priority env pin pointed at a versioned manifest that
never changes, every check succeeded, no surface ever complained,
and the device missed the first channel release of its lifetime.
It surfaced only because v0.8.8 was the first release to depend
on the channel `latest.json`.

Second lesson from the same incident: **a versioned manifest that a
device can pin to exists on four hosts / in four shapes**, and a
given device's env may point at any one of them:

1. OSS object: `…/quanthermes_pj/quanthermes_web_ui/releases/vX.Y.Z/manifest.json`
2. GitHub Release asset: `…/releases/download/vX.Y.Z/manifest.json`
3. `release-manifests` branch archive:
   `raw.githubusercontent.com/.../release-manifests/releases/vX.Y.Z/manifest.json`
4. **Candidate pin** (the one that actually bit device 6.6.6.73):
   `WEBUI_UPDATE_MANIFEST_URLS=…/release-manifests/candidates/<channel>/<version>.json`
   — a candidates file is a one-shot artifact that never changes,
   and `manifestUrls` ranks explicit env URLs ahead of the
   `BASE_URL + channel` fallback, so the device froze on that
   candidate's version forever.

Any compat mirroring must cover all shapes or it silently fixes
nothing (this incident required three consecutive "final" fixes
before the fourth, real one was found by reading
`/etc/default/hermes-web-ui` on-device). Note also
raw.githubusercontent.com CDN serves up to ~5 min stale after a
commit, so verification must expect that lag. This is why the
code-level detection below is preferred over host-by-host
mirroring: the detection is shape-agnostic — and the deploy-side
guard must reject BOTH `WEBUI_UPDATE_MANIFEST_URL` and
`WEBUI_UPDATE_MANIFEST_URLS` values that contain version paths
(`v[0-9]`, `/candidates/`).

### Detection rule

A new check runs inside `resolveManifestCheckResult()`'s caller
(`update-check-cache.doRefresh()`), after the primary manifest
resolves:

```
pinned_stale := config.update.manifestUrl is set          // exact-URL pin, not base+channel
             && pinned.version <= localVersion            // pinned tip is not newer than what runs
             && channelManifest.version > pinned.version  // the channel knows a newer release
```

When true, the system **prefers the channel result for the update
check** (the pin only made sense at install time; after install it
is a liability) and records a warning:

```ts
interface UpdateCheckResult {
  // existing fields…
  warnings?: Array<'manifest_pinned_stale'>
  pinnedManifestUrl?: string     // for the UI to display
  effectiveManifestUrl?: string  // which URL actually won
}
```

The channel fetch must not break the primary path: if the channel
`latest.json` is unreachable, the pinned result stands and no
warning is emitted (a pinned source is legitimate offline
behavior).

### Surfacing

- `GET /health` → new optional field `webui_update_warnings: ['manifest_pinned_stale']`.
- `GET /api/hermes/update/capabilities` → same array plus
  `pinnedManifestUrl` / `effectiveManifestUrl`.
- `GET /api/update/identity` → the manifestCache block gains
  `pinned: boolean` and `stale: boolean` (staleness keeps its
  existing freshness semantics).
- Client (`KnowledgeStatusBar` is knowledge-specific; the update
  UI lives in the settings page): the update section renders a
  yellow inline warning banner —
  "更新源被钉死在 {pinnedVersion}（{url}），已自动改用频道最新版
  {latestVersion}。请清理设备 env 中的 WEBUI_UPDATE_MANIFEST_URL。"
  The banner is non-blocking; the update button stays usable.
- Server log: one `console.warn('[update] manifest pinned to
  {url} at version {v}; channel tip {v2} wins')` per refresh
  cycle, not per request (the 5-min cache naturally dedupes).

### Deploy-side rules (regression guard)

- `deploy-source-armbian.sh` and `update-orchestrator.sh` MUST
  NOT write `WEBUI_UPDATE_MANIFEST_URL` with a versioned path into
  `/etc/default/hermes-web-ui`. The deploy script already passes
  operator env through; add a `deploy_sanity_check` that **fails
  the deploy** when the resulting env would pin a versioned
  `manifest.json` unless `ALLOW_PINNED_MANIFEST=1` is explicitly
  set (escape hatch for rollback drills).
- A device-package release test asserts the deploy script's env
  block contains no `releases/v*/manifest.json` literal
  (`tests/release/device-package-manifest.test.ts` or a sibling).

### Removal of the one-off mirror shim

`tmp-mirror-pinned-manifests.yml` exists only because device
6.6.6.73 cannot be SSH'd into today. Once that device upgraded
past 0.8.8 and the pin is removed (or this hardening ships and
the pin stops mattering), the workflow file is deleted. Do not
extend the mirror to new releases.

### Acceptance criteria (added)

19. A device env with `WEBUI_UPDATE_MANIFEST_URL` pinned to a
    versioned manifest whose version ≤ local, while the channel
    tip is newer: `/health` reports `webui_update_warnings`
    containing `manifest_pinned_stale`, and the update check
    uses the channel tip (update button appears).
20. The same pin with an unreachable channel URL: no warning,
    pinned result used, behavior identical to today (offline
    compatibility preserved).
21. No pin configured: zero warnings, zero behavior change.
22. Deploy script run with a versioned `WEBUI_UPDATE_MANIFEST_URL`
    and without `ALLOW_PINNED_MANIFEST=1` exits non-zero before
    touching the service.
23. The settings update section shows the yellow pinned-manifest
    banner with the pinned URL and the effective version.
24. All existing update tests stay green; new tests cover the
    three detection branches above (pinned+channel-newer,
    pinned+channel-down, no-pin).

## Out of scope (future work)

- Localized USB labels (volume name detection via blkid).
- Per-vault quota override.
- Export / import knowledge archives between devices.
- Round 3: LearningModeView backlinks + ExplorerModeView vec0
  inspector.

## References

- v0.8.8 spec: `task-11-metadata-only.md`.
- AGENTS.md hard rules (route order, getWebUiHome,
  deploy-source-armbian.sh bootstrap-only, sqlite-vec native
  bindings via package.json optionalDependencies).
- Device storage probe from earlier this session: emmc 64 GB
  total, user area 40 GB, current SQLite 540 MB, vec0 dim 1024.

## Extensibility — user-added vaults and visual directory picker

The four auto vaults cover the common cases, but users will want
their own folders — a project directory on USB, a synchronized
Nextcloud mirror, a manually curated archive. This section adds
the "create your own vault" path with the same UX standard as
auto-vaults: **zero free-text paths in the happy path**.

### What users see today vs after

Today (v0.8.8, confirmed by `walk-addmodal.png`): two text fields,
`名称 / 我的文档` and `根路径 / /path/to/documents`, plus a 确认
button. A non-technical user cannot fill in `根路径` because they
do not know what paths are valid on the device. The user
explicitly flagged this in the v0.8.8 design review and asked for
the USB explorer's visual file picker to be reused.

After v0.8.9: the `添加知识库` action opens a 720-px-wide NDrawer
(not NModal — drawers are easier to escape and match the
`KnowledgeSettingsCard` pattern already in use). Two columns:

```
┌──────────────────────────────────────────────────────────────┐
│ 添加知识库                                                  × │
├────────────────────────────┬─────────────────────────────────┤
│ 名称 [ 我的文档        ]   │ 📁 /home/quanthermes      [↻]  │
│ 类型 [●手动 ○U盘 ○自动归]  │ ─────────────────────────────  │
│                            │ 📁 Documents           [选择]   │
│ 路径 [/home/...        ]   │ 📁 Downloads           [选择]   │
│                            │ 📁 Desktop             [选择]   │
│ 快捷入口：                  │ 📁 knowledge           [选择]   │
│ [USB 设备]  [最近上传]      │ ─────────────────────────────  │
│ [扫码记录]  [应用默认]      │ 💾 KINGSTON 32GB       [挂载]   │
│                            │ 💾 SanDisk 64GB        [挂载]   │
├────────────────────────────┴─────────────────────────────────┤
│ ✓ 目录存在，已挂载 (2 GB)        取消          创建          │
└──────────────────────────────────────────────────────────────┘
```

The `名称` field auto-fills from the chosen directory's basename
and remains editable. The `类型` radio selects `kind` (`manual` /
`usb` / `auto`); `auto` only appears for power users behind a
`KNOWLEDGE_POWER_USER_UI=true` flag because it overlaps with the
four default vaults and confuses non-technical users. The `路径`
textbox is still present — power users can type any path
under the allowlist (see below).

### Directory picker backend

Two new endpoints, registered before the settings routes:

```
GET  /api/knowledge/dirs?path=<absolute-path>
  -> {
       path,
       entries: Array<{
         name, isDir, sizeBytes?, modifiedAt?,
         inAllowlist: boolean  // false if outside the allowlist
       }>,
       parent: string | null
     }

GET  /api/knowledge/drives
  -> {
       usb: Array<{ uuid, label, mountPath, sizeBytes, freeBytes }>,
       homeRoots: Array<{ name, path, exists }>  // quick-pick rows
     }
```

`GET /api/knowledge/dirs` behavior:

- Allowed roots (allowlist, evaluated in order):
  - `$HERMES_WEB_UI_HOME` (via `getWebUiHome()`; resolves
    `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`, falls back to
    `~/.hermes-web-ui`).
  - `$HERMES_WEB_UI_HOME/mnt/usb/<uuid>` for every mounted USB.
  - Standard user-writable roots: `/tmp`, `/data`, `/sdcard`,
    `/mnt` (each checked with `existsSync`; missing roots are
    silently skipped).
- Path normalization: rejects `..` traversal, resolves symlinks,
  refuses paths outside the allowlist with `403 forbidden_path`
  (not `404`, to make the reason visible to the UI).
- Empty directory listing is allowed (a user may want to point a
  vault at an empty folder they will populate later).
- Hidden files (dotfiles) are excluded by default; a `?includeHidden=true`
  flag is provided for power users.

The implementation reuses `USBService.listFiles()` patterns (same
`readdir({ withFileTypes: true })` + `stat`) but is **not** a
method on `USBService` because the allowlist and home-root
enumeration are knowledge-specific. Lives at
`packages/server/src/services/knowledge/dir-browser.ts`.

### Component layout

`KnowledgeVaultList.vue` keeps its table view but its `NModal`
becomes an `NDrawer` (`width=720`, `placement='right'`). New
component `KnowledgeVaultFormDrawer.vue` hosts the two-column
layout. New component `KnowledgeDirBrowser.vue` is the right
column — visually identical to `USBExplorerList.vue` (table of
`name / size / modified`, folder-row click → `path` deepens,
back/forward/up buttons, breadcrumb click → ancestor).

The browser component takes:

```ts
interface KnowledgeDirBrowserProps {
  initialPath: string
  homeRoots: HomeRoot[]
  usbDrives: USBDrive[]
  selection: { path: string | null; sizeBytes: number | null }
}
```

Emits:

```ts
emit('select', { path: string, sizeBytes: number, exists: boolean })
emit('navigate', { path: string })
emit('mount-usb', { uuid: string })
emit('pick-home', { path: string })
```

`KnowledgeVaultFormDrawer.vue` reuses `NDrawer`, `NInput`,
`NRadioGroup`, and `NButton` from naive-ui (same as the rest of
the knowledge plugin).

### Shortcut buttons (left column)

- `USB 设备`: opens a dropdown listing the USB volumes (reuses
  `GET /api/knowledge/drives` `usb[]`). Selecting one auto-fills
  `类型=usb`, `路径=/mnt/usb/<uuid>`, `名称=<label>`.
- `最近上传`: lists the last 5 distinct subdirectories of
  `$HERMES_WEB_UI_HOME/upload/<profile>/` that contain files.
- `扫码记录`: lists the directories that the scanner wrote to
  in the last 7 days (reuses `GET /api/scanner/sessions`).
- `应用默认`: picks from the four auto vault root paths (visible
  to power users behind the flag; non-power users see this button
  only as "复制默认路径" for reference).

### Extending beyond the four defaults

The user's spec calls out "用户自己选择方便高级扩展" — the
mechanism is:

1. Manual vaults created via the drawer are persisted with
   `kind='manual'` (or `'usb'` for USB pick).
2. The unique constraint `knowledge_vaults.root_path` is the
   hard backstop: duplicate root_paths are rejected with
   `409 vault_path_in_use`.
3. The 8-vault ceiling (`maxVaults: 8` in `QUOTA`) covers the
   four auto + four user-added; creating a 9th fails with
   `409 vault_quota_exceeded` and the drawer shows a tooltip
   pointing to the docs on removing a vault.
4. `KNOWLEDGE_DEFAULT_VAULTS=off` users get zero auto vaults
   and may add up to 8 manual ones.
5. The drawer is **the only** way to add a vault in the UI; the
   API still accepts `POST /api/knowledge/vaults` with a raw
   path for automation (CLI / MCP), so power users aren't blocked.

### Acceptance criteria (added)

11. Clicking `添加知识库` opens a 720-px drawer (not a modal) with
    a two-column layout; `名称` is auto-filled from the first
    selection.
12. The directory browser lists folders under the allowlist roots
    only; paths outside the allowlist return `403 forbidden_path`
    and the UI shows an inline warning.
13. Selecting a USB volume from the shortcut row auto-fills
    `kind='usb'`, `path=/mnt/usb/<uuid>`, `name=<label>`.
14. The path textbox remains editable so power users can type any
    allowlisted path; submitting a non-allowlisted path returns
    the same `403 forbidden_path` error as the browser.
15. After creating the 9th vault the drawer disables the create
    button with a tooltip pointing to the removal flow.
16. `KNOWLEDGE_DEFAULT_VAULTS=off`: bootstrap creates zero vaults;
    the drawer still allows adding up to 8 manual vaults.
17. The CLI/MCP path (`POST /api/knowledge/vaults` with raw
    path) continues to work; both the drawer and the CLI go
    through `KnowledgeService.addVault()` so the unique-constraint
    and 8-vault checks are uniform.
18. `walk-addmodal.png` is replaced by a new screenshot showing
    the drawer with the directory browser populated; the new
    screenshot is committed under `.deploy-staging/walk-drawer.png`.

### Files (added to "Create" list)

- `packages/server/src/services/knowledge/dir-browser.ts` —
  allowlist resolution, `listDirs()`, `listDrives()`.
- `packages/server/src/controllers/knowledge.ts` — `listDirs`,
  `listDrives` controllers (404 if not allowed, 403 if outside
  allowlist).
- `packages/server/src/routes/knowledge.ts` — register both new
  routes before settings routes.
- `packages/client/src/plugins/knowledge/components/KnowledgeVaultFormDrawer.vue`
  — two-column drawer.
- `packages/client/src/plugins/knowledge/components/KnowledgeDirBrowser.vue`
  — right-column directory picker (visually mirrors
  `USBExplorerList.vue`).
- `packages/client/src/plugins/knowledge/api.ts` — `listDirs(path)`,
  `listDrives()` helpers.
- `tests/server/knowledge-dir-browser.test.ts` — allowlist
  enforcement, traversal rejection, hidden-file default.
- `tests/release/knowledge-vault-drawer.e2e.test.ts` — full
  drawer flow with mocked `listDirs`.
- 11 new i18n keys (5 in zh-CN + en-US, others fall back to en):
  `vaults.drawer.title`, `vaults.drawer.column.browser`,
  `vaults.drawer.column.form`, `vaults.drawer.shortcuts.*`,
  `vaults.drawer.errors.forbidden_path`,
  `vaults.drawer.errors.vault_quota_exceeded`.

### Files (added to "Modify" list)

- `packages/client/src/plugins/knowledge/components/KnowledgeVaultList.vue`
  — replace `NModal` with the new `KnowledgeVaultFormDrawer`.
- `packages/client/src/plugins/knowledge/composables/useKnowledgeData.ts`
  — surface `drives` and `dirs` reactive state.
- `packages/server/src/services/knowledge/knowledge.service.ts`
  — `addVault(rootPath, name, kind)` enforces `maxVaults` (count
  `kind IN ('auto','manual','usb')` rows against the constant
  8) and the unique-constraint `409`.
- `AGENTS.md` — append a new hard rule in the section right
  after the `getWebUiHome()` paragraph: "Directory browser
  endpoints (`/api/knowledge/dirs`, `/api/knowledge/drives`)
  must use `getWebUiHome()` for the home root and never call
  `process.env.HERMES_WEB_UI_HOME` directly. The allowlist is
  closed; expanding it is a spec change, not a code change."

