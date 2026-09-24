# Knowledge plugin — integration guide

> Read `docs/knowledge-architecture.md` first. This document is the
> "what to build and in what order" companion to the architecture doc.

This guide is written for the coding agent (human or AI) that picks up
the next task. Each section is a self-contained implementation task
with an acceptance test. Do them in order — each one unblocks the next.

## Prerequisites

- `sqlite-vec` and `sqlite-vec-windows-x64` (or `-linux-x64` etc.) are
  already in `devDependencies`. The smoke test
  `tests/release/sqlite-vec-smoke.test.ts` must pass before you start.
- **`chokidar` must be added as a direct dependency** (it is currently
  only a transitive dependency — audit fix P1-4). Do it in Task 2.
- The Hermes Agent bridge is running and working.
- A cloud embedding API key is configured in
  `$HERMES_WEB_UI_HOME/secrets/knowledge-embed.env` (architecture doc
  §10.5).

## Task 1 — Schema bootstrap

**Files to create:**

- `packages/server/src/db/knowledge-schema.ts`
- `tests/server/knowledge-schema.test.ts`

**Files to modify (audit fixes P0-2, P0-3):**

- `packages/server/src/db/index.ts` — create the shared connection
  with `{ allowExtension: true }`. Without it, `loadExtension()`
  throws `ERR_INVALID_STATE` (verified empirically; calling
  `enableLoadExtension(true)` after creation is too late). This is
  the only change to that file; keep it minimal and note the security
  tradeoff in the PR description.

**Acceptance:**

- Calling `ensureKnowledgeSchema(db)` on an empty `hermes-web-ui.db`
  creates `knowledge_vaults`, `knowledge_documents`, `knowledge_chunks`,
  `knowledge_chunks_fts`, `knowledge_chunks_vec` exactly as §3 of the
  architecture doc specifies.
- Calling it on an already-populated db is idempotent.
- The test runs against an in-memory SQLite instance.
- The test asserts the FTS5 rowid coupling: insert a chunk, then read
  `knowledge_chunks_fts.rowid` back and expect the chunk id
  (architecture doc §3.3, audit fix P1-3).
- Config validation rejects a `KNOWLEDGE_EMBED_DIM` that differs from
  the dim baked into an existing `knowledge_chunks_vec` table
  (architecture doc §3.4, audit fix P1-7).

**Hard rules:**

- `knowledge_chunks_vec` must declare `FLOAT[<dim>]` with `dim` read
  from a config constant in the same file (not hardcoded at every
  call site).
- The FTS5 tokenizer is `porter`. Future: add a unigram/jieba option.
- `ensureKnowledgeSchema(db)` must idempotently run
  `PRAGMA foreign_keys=ON` and `PRAGMA busy_timeout=5000` on the
  shared connection, and warn when `journal_mode` is not `wal`
  (architecture doc §6.4, audit fix P0-2).
- Never rely on `ON DELETE CASCADE` for the FTS5 or vec0 virtual
  tables — worker code deletes all three indexes explicitly in one
  transaction (architecture doc §3.3, audit fix P0-1).

## Task 2 — Watcher (file ingestion trigger)

**Files to create:**

- `packages/server/src/services/knowledge/watcher.ts`
- `tests/server/knowledge-watcher.test.ts`

**Acceptance:**

- Registering a vault starts chokidar on its `root_path`.
- Adding a file emits an `ingest:add` event; modifying a file emits
  `ingest:change`; removing a file emits `ingest:remove`.
- Events are debounced: dropping 10 files in 1 second produces one
  batch of 10, not 10 single events.
- The watcher stops cleanly when the server closes.

**Hard rules:**

- The watcher never reads file contents. Reading is the extractor's
  job (Task 3). This separation lets us test the watcher with zero IO.
- Add `chokidar` as a direct dependency in `package.json` — it is
  currently only a transitive dependency (audit fix P1-4).
- Watcher tests use chokidar's `usePolling: true` against real temp
  directories; memfs-style fake filesystems are incompatible with
  chokidar's native backends (audit fix P2-4).

## Task 3 — Extractors

**Files to create:**

- `packages/server/src/services/knowledge/extractors/index.ts` (registry)
- `packages/server/src/services/knowledge/extractors/markdown.ts`
- `packages/server/src/services/knowledge/extractors/text.ts`
- `packages/server/src/services/knowledge/extractors/pdf.ts`
- `packages/server/src/services/knowledge/extractors/docx.ts`
- `tests/server/knowledge-extractors.test.ts`

**Acceptance:**

- Each extractor returns `{ text: string, tokenCount: number }` for
  its file type, or throws a known error class on failure.
- Unknown file types return a sentinel `extractor:none` (metadata
  only).
- The test covers all four v1 extractors with fixture files in
  `tests/server/fixtures/knowledge/`.

**Hard rule:** the registry uses file extension (lowercased) as the
dispatch key. No MIME sniffing in v1 — it is fragile and hard to test.

## Task 4 — Chunker

**Files to create:**

- `packages/server/src/services/knowledge/chunker.ts`
- `tests/server/knowledge-chunker.test.ts`

**Acceptance:**

- Markdown input is split at `##` / `###` boundaries; a section
  longer than the configured max is further split at paragraph
  boundaries.
- Plain text input uses a sliding window (default 500 tokens, 50
  overlap).
- Each chunk is returned with its content and a stable
  `contentHash = sha256(content)` so re-indexing can detect drift.

**Configurable:** max tokens per chunk, overlap. Exposed through
`packages/server/src/services/knowledge/config.ts` (next task).

## Task 5 — Embedder

**Files to create:**

- `packages/server/src/services/knowledge/embedder.ts`
- `tests/server/knowledge-embedder.test.ts`

**Acceptance:**

- `embedder.embed(chunks: string[]): Promise<Float32Array[]>` calls
  the configured cloud provider and returns one vector per chunk.
- Batching: a single call with 200 chunks is broken into provider-
  sized batches (e.g. 50 per batch for OpenAI).
- Retries with exponential backoff; after 3 failures, throws a
  `KnowledgeEmbedError` with the provider's status code and message.
- The test uses a recorded fixture (no live API calls in CI).

**Hard rule:** the embedder must never silently return fewer vectors
than chunks — throw instead. Silent length mismatch corrupts the
vec0 index irrecoverably.

## Task 6 — Orchestrator

**Files to create:**

- `packages/server/src/services/knowledge/knowledge.service.ts`
- `packages/server/src/services/knowledge/config.ts`
- `tests/server/knowledge-service.test.ts`

**Acceptance:**

- `ingest(path)` runs extractor → chunker → embedder, and writes
  chunks + FTS5 + vec0 rows in one SQLite transaction.
- On any failure, the transaction rolls back and the document is
  marked `status = 'failed'` with the error recorded.
- `search({ query, vaultId, limit, hybrid, maxDistance })` returns the
  two-stage hybrid result when `hybrid: true`, or pure-vector KNN via
  vec0's `MATCH ... AND k = ?` operator when `hybrid: false` — never a
  bare `ORDER BY vec_distance_cosine(...)` full-table scan
  (architecture doc §3.5, audit fix P1-1).
- **The vec0 table must be created with `distance=cosine`** (schema
  doc §3.4). Without it, `MATCH` returns L2 distances and the two
  search modes disagree. Verified in
  `tests/release/sqlite-vec-smoke.test.ts` (`named-pk and cosine
  distance`).
- **Pure-vector results cannot be joined against `knowledge_chunks` in
  SQL.** The `distance` column is NULL under a PK join (vec0
  behavior). Vault / status filtering must happen in application code
  after the MATCH, with an inflated `k` to absorb the filter rate
  (architecture doc §3.5 item 2 + 4).
- `maxDistance` is a cosine **distance** cutoff (default 0.3, lower =
  stricter). There is no `minScore` anywhere in the API — the original
  minScore semantics were a no-op filter (audit fix P1-2).
- `query` is hard-capped at **2000 characters** (audit fix T2,
  architecture doc §5.2); exceeding returns `400 query_too_long`.
- Response must include `totalCandidatesBeforeFilter: number` — the
  count of chunks that passed stage-1 (FTS5 MATCH or vec0 MATCH)
  before `limit` and `maxDistance` were applied. The Agent uses this
  to decide whether to retry with looser parameters (audit fix T1,
  architecture doc §5.2).
- Re-ingesting the same file (same `source_hash`) is a no-op.
- Re-ingesting a modified file (different `source_hash`) replaces
  the old chunks + FTS5 + vec0 rows atomically.

**Hard rule:** `search` must never return chunks whose document is
`status != 'indexed'`. The filter is in the SQL, not post-hoc.

## Task 7 — Routes

**Files to create:**

- `packages/server/src/routes/knowledge.routes.ts`
- `tests/server/knowledge-routes.test.ts`

**Acceptance:**

- All §5 endpoints are reachable and return the documented shapes.
- `/api/knowledge/search` rejects empty queries with 400.
- `/api/knowledge/search` rejects `query` > 2000 chars with `400
  query_too_long` (audit fix T2).
- Clamping `limit` > 20 sets the `warning` field in the response body
  (architecture doc §5.2) — include the field in the response schema
  from day one (audit fix P2-2).
- `/api/knowledge/search` response body always includes
  `totalCandidatesBeforeFilter: number` (audit fix T1).
- `/api/knowledge/vaults/:id` DELETE unregisters the vault and
  optionally (query flag `cascade=true`) deletes all documents.
- The test uses supertest against the real Koa app.

**Hard rule:** routes are registered before any proxy catch-all
(AGENTS.md rule).

## Task 8 — Client side

**Files to create:**

- `packages/client/src/features/knowledge/KnowledgeSidebar.vue`
- `packages/client/src/features/knowledge/VaultList.vue`
- `packages/client/src/features/knowledge/DocumentList.vue`
- `packages/client/src/stores/knowledge.ts`
- `packages/client/src/api/knowledge.ts`
- `packages/client/src/i18n/locales/{en,zh,zh-TW}.ts` — add keys

**Acceptance:**

- Sidebar entry is visible; clicking it shows the Vault list.
- Adding a vault triggers a server-side watch; the UI shows the
  ingest status of new documents in real time via Socket.IO event
  `knowledge:ingest:progress`.
- All strings are translated into all three locales.

## Task 9 — Hermes Agent tool binding

**Files to create / modify:**

- Hermes Agent tool definition (wherever Agent tools are registered)
- `tests/server/knowledge-agent-tool.test.ts`

**Acceptance:**

- Hermes Agent can invoke `knowledge_search` as a tool.
- The tool's description tells the Agent what the endpoint returns
  and when to use it (e.g. "use when the user asks about a document
  they dropped on USB").
- The tool response format matches §5.2.

**Hard rules:**

- The tool is registered through the agent-bridge MCP tool path
  (`packages/server/src/services/hermes/agent-bridge/`), not by
  modifying the Hermes Agent core (architecture doc §5.3, audit fix
  P2-1).
- Do NOT change the Agent's internal memory to mix knowledge results
  with conversation history. The knowledge tool is a pure lookup, not
  a memory write.
- The tool description must steer Chinese queries toward semantic
  search — v1 FTS5 keyword match is unreliable on Chinese text
  (architecture doc §7.5, audit fix P2-6).

## Task 10 — Hardening & observability

- Add a `/api/knowledge/health` endpoint reporting: vault count,
  document count (by status), vec0 index size, last error.
- Add a `knowledge:ingest:error` Socket.IO event for real-time UI
  notification of failures.
- Add a CI gate that runs `sqlite-vec-smoke.test.ts` on all three
  platforms (Windows / Linux / ARMbian) — see the smoke test for
  platform coverage.

## Cross-cutting rules

- **Never open a second SQLite connection** for the knowledge plugin.
  The existing `getDb()` from `packages/server/src/db/index.ts` is the
  only one. The WAL + vec0 + FTS5 transaction guarantee only holds
  inside a single connection — which is why Task 1 adds
  `{ allowExtension: true }` to that shared connection instead of
  creating a new one.
- **Never rely on FK cascades for virtual tables.** FTS5 and vec0
  ignore foreign keys; every delete touches chunks + fts + vec
  explicitly in one transaction.
- **Never `process.env.HERMES_WEB_UI_HOME` directly.** Use
  `getWebUiHome()` per AGENTS.md.
- **Never add a separate service** (qdrant / chroma / LanceDB) without
  re-opening the architecture decision in §2 of the architecture doc.
- **Never let the watcher read file content.** Extraction belongs to
  Task 3; conflation makes the watcher un-testable.

## Suggested first commit

If you are picking this up and want the smallest possible first step,
do **Task 1 + Task 10's health endpoint** only. That gives you a
runnable schema + an observability window into the existing db, and
every subsequent task builds on it without changing what came before.
