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
