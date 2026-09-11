# Task 11 — metadata_only ingest mode (v0.8.8)

> Status: builds on Tasks 1–10. Reusable building block for the v0.8.9
> auto-vault / upload-checkbox / USB-on-demand features.
>
> Goal: introduce a new document status `metadata_only` so that "record
> this file exists" is a separate operation from "make it searchable".
> Apply the conservative default to a new class of vault (see
> `vault_kind`), preserve all existing behavior for already-configured
> vaults, and ship the manual promote-to-indexed path.

## Why this task exists

Up to v0.8.7, `KnowledgeService.ingest()` always: extract → chunk →
embed → write chunks+FTS5+vec0 atomically. The ingest cost is **dominated
by the embedding API call** (~$0.0001/file at 1024-dim, but the latency
budget is the killer on a 2.0 GHz Cortex-A53 — single file ~6 s, batch
of 50 files blocking the worker for ~5 min, which blocks every other
ingest and any half-completed search.

For the common case of "user drops a file into `upload/`", we almost
never want to spend that budget automatically. The file might be:

- A 200-page PDF the user wants to keep as evidence, not as searchable
  reference.
- A binary the user accidentally uploaded.
- A draft being edited.

The metadata-only status lets us **record the file cheaply** (1 row in
`knowledge_documents`) and **promote it on demand** when the user
actually wants to search across it. This is also the foundation for the
v0.8.9 default-vaults and upload-checkbox work — without this seam,
every auto-vault would block the queue for hours.

## Decisions captured in this spec

- (a) metadata_only documents are **not visible to search**.
- (b) The default ingest behavior is **conservative**: a new class of
  vault (auto-created user-upload vault) ingests as metadata_only.
  Manually-created vaults continue to ingest as full-indexed.
- (1) The distinction between "auto" and "manual" vaults is **a schema
  field**, not a name match. See `vault_kind` below.
- (2) Manual promote is async via the existing `KnowledgeService`
  single-writer queue. UX shows `metadata_only → pending → indexing →
  indexed`.

## Hard rules (must not regress)

- All existing acceptance criteria from Tasks 1–10 remain unchanged
  for **manually-created vaults** (`vault_kind='manual'`).
- The metadata_only → indexed promote **must reuse the existing
  ingest pipeline** (`extract → chunk → embed → write`) so that FTS5
  / vec0 / chunks stay in lockstep. We are not writing a second path.
- A metadata_only row **must never block** a search query; the search
  service already filters by `status='indexed'` (verify this in
  `services/knowledge/search.ts`).
- The kind column defaults to `'manual'` for any vault created through
  the existing `POST /api/knowledge/vaults` endpoint — no migration
  shenanigans for already-deployed devices.

## Summary

1. Add `vault_kind` enum to `knowledge_vaults` (`auto` | `manual` |
   `usb`).
2. Add `indexMode` enum to `KnowledgeConfig` and to the service so
   that auto-vault ingest can short-circuit before embed.
3. Add `metadata_only` to the document status union (it's already in
   the type enum but not wired through the ingest path).
4. Add `POST /api/knowledge/documents/:id/index` endpoint that
   enqueues the existing `ingest()` for an already-metadata_only row.
5. UI: `metadata_only` filter chip in the document list; detail
   drawer shows a "全文索引" button (only when status is
   `metadata_only`).
6. Tests: three new server test cases + i18n keys for zh/en.

## Files

### Create

- `tests/server/knowledge-vault-kind.test.ts` — schema migration +
  default + enum parsing.
- `tests/server/knowledge-metadata-only-ingest.test.ts` — auto-vault
  metadata_only; manual-vault full index; promote-to-indexed; search
  excludes metadata_only.

### Modify

- `packages/server/src/db/knowledge-schema.ts`
  - `knowledge_vaults`: add `kind TEXT NOT NULL DEFAULT 'manual'`
    column. Idempotent migration: `ALTER TABLE … ADD COLUMN kind`
    wrapped in a try/catch (sqlite throws on duplicate column).
    Add a CHECK constraint via separate `CREATE TRIGGER` or just
    validate in the service layer (lean toward the trigger so the
    DB itself rejects bad values).
  - Index `knowledge_vaults_kind` on `(kind)` for the bootstrap path.
- `packages/server/src/services/knowledge/knowledge.service.ts`
  - `IngestStatus` type: `metadata_only` already present, just add a
    type guard `isMetadataOnly(d): d is KnowledgeDocument & {
    status: 'metadata_only' }`.
  - New `MetadataIngestParams`: `{ documentId, sourcePath, vaultId,
    mimeType, sizeBytes, mtime }`. Writes the documents row with
    `status='metadata_only'` and **skips** extract/chunk/embed/FTS5/
    vec0.
  - `addVault()` accepts an optional `kind` (default `'manual'`).
  - `ingest()` is **unchanged** for full-index paths; the promote
    path re-uses it directly.
  - `promoteDocument(documentId)`: enqueues a re-ingest of a
    metadata_only row. Uses the same single-writer queue as
    regular ingest. Rejects if `status !== 'metadata_only'`.
- `packages/server/src/services/knowledge/watcher.ts`
  - After the existing `vault.watching` check, branch on
    `vault.kind === 'auto'`. For `auto`, call
    `service.metadataIngest(...)` instead of `service.ingest(...)`.
- `packages/server/src/services/knowledge/config.ts`
  - `KnowledgeConfig`: add `defaultIngestMode` (`'full'` |
    `'metadata_only'`), default `'full'` so existing devices see no
    behavior change. Auto-vault bootstrap can override this.
- `packages/server/src/controllers/knowledge.ts`
  - New `indexDocument(ctx)`: parse id, call
    `service.promoteDocument(id)`, respond 202.
- `packages/server/src/routes/knowledge.ts`
  - `POST /api/knowledge/documents/:id/index` registered **after**
    `GET /api/knowledge/documents/:id` and **before** the settings
    routes. Match the existing route ordering conventions.
- `packages/client/src/plugins/knowledge/api.ts`
  - `KnowledgeDocument.status` type: add `metadata_only` (already
    present, confirm).
  - `indexDocument(id)`: `POST` to the new endpoint.
- `packages/client/src/plugins/knowledge/components/KnowledgeDocumentList.vue`
  - The filter row already lists `metadata_only`; just confirm the
    label is present in zh/en locales (already added in round 1).
- `packages/client/src/plugins/knowledge/components/KnowledgeDocumentDetail.vue`
  - Add a primary "全文索引" button at the top of the drawer,
    visible only when `document.status === 'metadata_only'`. Click
    calls `api.indexDocument(document.id)`, then emits a `refresh`
    so the parent can re-load.
- `packages/client/src/plugins/knowledge/locales/zh.ts` and `en.ts`
  - `knowledge.detail.index` ("全文索引" / "Full-text index")
  - `knowledge.detail.indexingHint`
    ("正在索引,可能需要数十秒" / "Indexing in progress, may take
    up to a minute")
  - `knowledge.detail.indexQueued`
    ("已加入索引队列" / "Added to the index queue")

## Schema migration safety

The new `kind` column on `knowledge_vaults` must migrate safely on
existing devices with zero downtime:

```sql
-- Idempotent migration wrapped in try/catch.
ALTER TABLE knowledge_vaults ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
-- The NOT NULL DEFAULT clause makes SQLite fill existing rows
-- with 'manual', so no backfill is needed. New inserts must supply
-- a value (or accept the DEFAULT).
```

The CHECK constraint is enforced in the service layer (we don't ship
DDL changes that could break on partial schema state):

```ts
const ALLOWED_KINDS = new Set(['auto', 'manual', 'usb'])
if (!ALLOWED_KINDS.has(kind)) throw new Error(`invalid vault kind: ${kind}`)
```

`sqlite-vec` and FTS5 tables are **not** touched.

## Vault kind taxonomy (binding contract for v0.8.9)

| kind    | Meaning                                       | Watcher behavior | Used by                   |
|---------|-----------------------------------------------|------------------|---------------------------|
| `auto`  | Bootstrap-created, user-controlled path       | metadata_only    | user-upload vault (v0.8.9) |
| `manual`| User created via `POST /api/knowledge/vaults` | full ingest      | all v0.8.7 vaults         |
| `usb`   | On-demand mount-based (v0.8.9)                | FTS5-only, no vec0 | USB volumes              |

The v0.8.8 spec only adds the column and validates it. Wiring `auto`
to actually be auto-created lands in v0.8.9 (Task 12). Wiring `usb`
also lands in v0.8.9.

## Acceptance criteria

1. `ensureKnowledgeSchema(db)` on an empty DB creates `kind` with
   default `'manual'`. On an existing pre-v0.8.8 DB, the migration
   runs once, succeeds, and does not duplicate the column.
2. `service.metadataIngest({...})` on a fresh file creates one row
   in `knowledge_documents` with `status='metadata_only'`, **zero**
   rows in `knowledge_chunks` / `knowledge_chunks_fts` /
   `knowledge_chunks_vec`.
3. `service.promoteDocument(id)` on a metadata_only row transitions
   the row through `pending → indexing → indexed` (same queue, same
   extract/chunk/embed path as a regular ingest).
4. A search query (`POST /api/knowledge/search`) returns **zero**
   results whose `documentId` belongs to a metadata_only document.
   Verified by injecting a metadata_only row with no chunks and
   searching for content that would match if it were indexed.
5. The watcher, given a vault with `kind='auto'`, ingests new files
   as metadata_only. Given `kind='manual'`, it still does full
   ingest (regression coverage for v0.8.7 behavior).
6. `POST /api/knowledge/documents/:id/index` on a non-metadata_only
   row returns 409 with `error='not_metadata_only'`.
7. UI: document list filter chip `metadata_only` is present and
   functional; detail drawer shows the "全文索引" button only for
   metadata_only rows; clicking it triggers a list refresh after
   the promote completes.
8. `npm run harness:check`, `npm run build`, all existing knowledge
   tests still pass.
9. New tests in `tests/server/knowledge-metadata-only-ingest.test.ts`
   cover: auto-vault path, manual-vault regression, promote
   transition, search exclusion, 409 on bad promote.
10. On-device smoke: deploy to a real device, ingest one file
    through the user-upload vault, confirm metadata_only in the
    knowledge documents table, click "全文索引" in the UI, confirm
    the row transitions to indexed and the file becomes searchable.

## Suggested commit message

```
feat(knowledge): metadata_only ingest mode + vault.kind taxonomy

Vaults gain a `kind` column ('auto' | 'manual' | 'usb', default
'manual'). Auto-vault watcher ingests new files as metadata_only —
one row in knowledge_documents, no chunks / FTS5 / vec0 — so a 50-
file upload no longer blocks the embedding queue. Manual promote via
POST /api/knowledge/documents/:id/index re-uses the existing
extract→chunk→embed pipeline. Search already filters by
status='indexed' so metadata_only rows are invisible to results by
construction.

The auto / usb kinds are wired in v0.8.9 (Task 12). This task only
introduces the column, the metadata-only ingest path, and the
promote endpoint — manual vaults keep their current behavior
unchanged.
```

## Out of scope (deferred to Task 12 / v0.8.9)

- Auto-creating the four default vaults on bootstrap.
- Upload UI checkbox (`archive_to_knowledge`).
- USB on-demand vault registration.
- Storage quota monitor (4 GB hard cap, 80/90/100% warnings).
- Semi-auto archive on task finalize.

## References

- Architecture doc §3 (schema), §6 (client), §7 (MCP tool).
- v0.8.8 spec: this document.
- v0.8.9 spec: `task-12-auto-vaults-and-quotas.md`.
- AGENTS.md hard rules (route registration order; getWebUiHome;
  deploy-source-armbian.sh bootstrap-only).
