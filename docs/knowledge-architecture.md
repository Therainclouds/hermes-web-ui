# Knowledge plugin architecture

> Status: **v1 design locked + internally audited + externally
> verified + reality-checked** — decisions closed (§9), internal audit
> findings applied (§11 first + second pass), open verifications
> closed against DashScope live docs and git history (§11 third pass),
> product/cost/ops layer reality check applied (§11 fourth pass,
> 2026-09-09). Ready for any further external review before
> implementation.

This document is the source of truth for the knowledge plugin being built
on top of hermes-web-ui. It is the design contract that downstream code
must satisfy, and the context a future coding agent needs to build the
feature without re-debating the choices.

## 1. Goals & scope

**What this is.** A local-first knowledge base that passively ingests
files dropped onto an attached USB drive (or any path under the Web UI
home), indexes their text, turns them into embeddings via a cloud LLM,
and exposes itself to the Hermes Agent as a searchable tool. The Web UI
becomes a real AI system: anything the user ever drops in becomes
retrievable, summarizable, and linkable.

**What this is not.**

- Not a GUI for Obsidian / Notion / AFFiNE. We deliberately rejected
  embedding any of those (§2) to avoid the iframe / block-model cost.
- Not an AI writer. There is no "edit and publish" loop in v1 — the
  user's role is to drop files and ask questions.
- Not a replacement for Hermes Agent's memory. The Agent has its own
  session history; this plugin is a long-term, file-grounded corpus
  that complements it.

**Passive ingestion.** The user does not tag, categorize, or confirm
anything. Files land → worker extracts text → chunks → embeds →
indexes → done. The user only interacts when searching / asking.

## 2. Key decisions & why

### 2.1 Why not embed AFFiNE / SiYuan / AppFlowy

| Alternative | Rejected because |
|---|---|
| **AFFiNE** | Heavy; not pure Markdown; no plugin API for tight embedding; USB file handling is "open the file" not "auto-index + dual-link". We spent a full session verifying this before committing. |
| **SiYuan** | Better fit (Markdown + block-level links) but still iframe-only — no state sharing with the Vue3 host, no theme sync, no component-level reuse. |
| **AppFlowy** | Rust + Flutter — wrong toolchain for this Vue3 + Koa stack. |
| **BlockSuite page** | Data model is blocks, not Markdown. Same embedding friction as AFFiNE. |

### 2.2 Why sqlite-vec (not qdrant / chroma / LanceDB / pgvector)

The knowledge plugin stores three things in one database: metadata,
FTS5 keyword index, and vector embeddings. The single biggest value of
sqlite-vec is that all three share **one WAL, one backup file, one
process, one transaction**.

| Dimension | sqlite-vec | qdrant / chroma | LanceDB | pgvector |
|---|---|---|---|---|
| Extra service | none | required | required | required |
| Backup | one file copy | multi-file / server | separate store | separate server |
| Cross-index transaction | native | custom | custom | native but multi-process |
| ARM / ARMbian device | trivial | install overhead | install overhead | install overhead |
| Maturity | young (0.1.x), API stable | mature | mature | very mature |
| Scale | ~100k vectors comfortably | unlimited | unlimited | unlimited |

**Decision:** sqlite-vec. The ~100k-vector ceiling is plenty for a
personal USB archive. The device-deployment story of hermes-web-ui
makes any extra service a non-starter — the AGENTS.md rule about
`WEBUI_UPDATE_STRATEGY=source-deploy` means we cannot add a sidecar
without a deployment redesign.

### 2.3 Why cloud embedding (not local), and why Tongyi

The target devices are low-end ARMbian boxes. Running a local embedding
model would either saturate them during ingestion (blocking all other
work) or force us to buy time by running embeddings offline — but then
"passive ingestion" isn't really passive. Cloud embedding keeps the
device thin and matches the existing Hermes Agent pattern of remote
LLM calls.

**Decision (v1):** Alibaba **Tongyi `text-embedding-v3`** is the
default provider. Rationale:

- **1024-dim output** (configurable 1024 / 768 / 512 / 256 / 128 / 64;
  see §3.4 for the v3-only list — 1536 is a `text-embedding-v2` tier,
  not v3). A sweet spot between retrieval quality and sqlite-vec index
  size; OpenAI's equivalent at 1536 dim is ~50% more storage and
  retrieval cost per row with no measured win on the Chinese-heavy
  corpus we expect.
- **8192-token input cap** — enough for any chunk we produce at the
  default 500-token size with wide safety margin.
- **Batch limit: 10 texts per request** (DashScope documented limit
  for v3; see §4.4). Slightly tighter than OpenAI's batch limits,
  but the cloud-side throughput is fast enough that this is not a
  bottleneck.
- **Native support for Chinese** with better tokenization than
  OpenAI's multilingual model on zh-heavy text.
- **Pricing:** ¥0.0005 / 1k tokens (DashScope, verified 2026-09-09).
  An order of magnitude cheaper than OpenAI's equivalent tier.
- **API parity** with the existing Tongyi completion calls the Hermes
  Agent already makes — same auth path, same retry semantics, one
  fewer cloud dependency to manage.

**Consequence:** the schema persists `embedding_model` and
`embedding_dim` via the `knowledge_embeddings_meta` singleton table
(created by `ensureEmbeddingsMeta` in `knowledge-schema.ts`). The
table has a `CHECK(id = 1)` constraint ensuring exactly one row.
On startup, the meta row is compared against the current config;
dim mismatch throws `KnowledgeSchemaError`, model mismatch emits a
warning. Pre-existing deployments without meta get a soft migration
(`model='unverified'`) — clear it by re-indexing. Mixing embeddings
from two models in one index silently destroys ranking.

### 2.4 Why the Agent pulls from the plugin (not push)

The knowledge plugin is a **tool** the Hermes Agent invokes via
`/api/knowledge/search`. The Agent stays the orchestrator; the plugin
stays a data source. This matches the AGENTS.md rule that Hermes Agent
upgrades and Web UI updates are separate seams.

## 3. Data model

All tables live in the existing `hermes-web-ui.db` SQLite file used
by `packages/server/src/db/index.ts`. The knowledge plugin never opens
a second database.

### 3.1 Metadata

```sql
CREATE TABLE knowledge_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path  TEXT NOT NULL,       -- absolute path to the file
  source_hash  TEXT NOT NULL,       -- sha256 of content at index time
  vault_id     INTEGER NOT NULL,    -- FK to knowledge_vaults.id
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,    -- mtime as epoch ms
  indexed_at   INTEGER NOT NULL,
  status       TEXT NOT NULL,       -- 'pending' | 'indexed' | 'failed'
  error        TEXT,
  FOREIGN KEY (vault_id) REFERENCES knowledge_vaults(id)
);
CREATE INDEX knowledge_documents_source_hash ON knowledge_documents(source_hash);
CREATE INDEX knowledge_documents_vault_status ON knowledge_documents(vault_id, status);
```

`knowledge_vaults` is one row per watched directory (typically one per
USB mount):

```sql
CREATE TABLE knowledge_vaults (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path  TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  watch      INTEGER NOT NULL DEFAULT 1,  -- 1 = chokidar watches this
  created_at INTEGER NOT NULL
);
```

### 3.2 Chunks

Documents are split into chunks before embedding. Chunking is done in
the background worker and is **content-aware**: Markdown respects
heading boundaries, plain text uses a sliding window.

```sql
CREATE TABLE knowledge_chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL,
  position     INTEGER NOT NULL,   -- order within document
  content      TEXT NOT NULL,      -- raw text of the chunk
  token_count  INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunks_document ON knowledge_chunks(document_id);
```

### 3.3 FTS5 keyword index

```sql
CREATE VIRTUAL TABLE knowledge_chunks_fts
  USING fts5(content, tokenize='porter');
```

FTS5 is a "shadow" of `knowledge_chunks.content`. Inserts and deletes
must stay in sync with the chunks table (enforced by the worker, not
by a trigger — we want the worker to be the only writer so it can also
schedule the embedding call).

**Rowid coupling (audit fix P1-3).** The hybrid query in §3.5 joins
FTS5 to `knowledge_chunks` on rowid. FTS5 does not auto-derive rowids
from the chunks table, so the worker MUST insert with an explicit
rowid equal to the chunk id:

```sql
INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (?, ?)
```

Anything else silently diverges the rowids and the join returns wrong
or empty results. `tests/server/knowledge-schema.test.ts` must assert
the coupling (insert a chunk → read the fts rowid back) as a
regression gate.

**No foreign keys on virtual tables (audit fix P0-1).** Neither FTS5
nor vec0 can participate in `ON DELETE CASCADE` — SQLite forbids FK
declarations on virtual tables. Deleting a document therefore requires
the worker to explicitly delete from `knowledge_chunks` (real table,
its cascade is fine), `knowledge_chunks_fts`, and `knowledge_chunks_vec`
in the same transaction.

### 3.4 vec0 vector index

```sql
CREATE VIRTUAL TABLE knowledge_chunks_vec USING vec0(
  chunk_id  INTEGER PRIMARY KEY,
  embedding FLOAT[<dim>] distance=cosine
);
```

The `distance=cosine` clause is **not optional**. vec0's default
distance metric is L2 (Euclidean); without this clause, the `MATCH`
operator used by pure-vector search (§3.5) returns L2 distances while
the hybrid path returns cosine distances — the two scores become
incomparable and the API's `maxDistance` filter (§5.2) has different
meanings depending on the query mode. The `distance=cosine` syntax
was verified working with sqlite-vec 0.1.9 + node:sqlite on Node 24
during the second-pass audit.
```

`FLOAT[<dim>]` must match the embedding model in use (default `1024`
for Tongyi `text-embedding-v3`). Storing the dimension at table
creation time lets us detect model mismatch at migration time, not at
query time.

**Dim is immutable per install (audit fix P1-7).** Migrations are out
of scope for v1 (§10.4), so `KNOWLEDGE_EMBED_DIM` is a creation-time
parameter only: `config.ts` validation must reject a value that
differs from the dim baked into the existing `knowledge_chunks_vec`
table. Switching dims requires the explicit re-index procedure —
create a new vec table with the new dim → full re-embed → atomic
swap → drop old — which ships with v1.1, not v1.

**Verified against DashScope docs (2026-09-09):**
`text-embedding-v3` supports dims **1024 (default) / 768 / 512 / 256 /
128 / 64**. 1536 is **not** a v3 dim — it is a `text-embedding-v2`
dim (v2 maxes at 2048 tokens, vs v3's 8192; batch 25 vs v3's 10).
Switching between v3 and v2 is a model-change event (different
embedding spaces, different API pricing), not a dim-tweak event.
The §10.1 config table reflects this verified list.

### 3.5 Hybrid search

Retrieval is a **two-stage** query that lives entirely inside SQLite:

```sql
-- Stage 1: keyword candidate set (cheap, recall-biased)
WITH candidates AS (
  SELECT rowid FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH ?
)
-- Stage 2: semantic re-rank over the candidates
SELECT c.document_id, c.position, vec_distance_cosine(v.embedding, ?) AS score
FROM knowledge_chunks c
JOIN knowledge_chunks_vec v ON v.chunk_id = c.id
WHERE c.rowid IN (SELECT rowid FROM candidates)
ORDER BY score
LIMIT ?
```

This is the killer query that motivated picking sqlite-vec over a
separate vector store: FTS5 and vec0 share `rowid`, and the join is
one SQL statement in one connection.

**Pure-vector search uses vec0's KNN operator (audit fix P1-1,
second-pass correction).** The hybrid query above is safe because the
FTS candidate set bounds how many `vec_distance_cosine` calls run. For
`hybrid: false`, the same `ORDER BY vec_distance_cosine(...)` over the
whole table is a brute O(N·d) scan — 100k vectors × 1024 dims is too
slow on the target ARMbian hardware. vec0 exposes an ANN index via
`MATCH`:

```sql
SELECT chunk_id, distance    -- cosine distance (table-level option)
FROM knowledge_chunks_vec
WHERE embedding MATCH :query AND k = :k
```

**Implementation notes from second-pass verification (2026-09-09):**

1. **Table must declare cosine distance.** The CREATE TABLE in §3.4
   includes `distance=cosine`; without it, `MATCH` returns L2
   (vec0's default) and the two search modes return incomparable
   scores.

2. **`distance` is only populated on the MATCH path.** Joining vec0
   by primary key and selecting `distance` returns NULL. This means
   pure-vector queries **cannot be joined against `knowledge_chunks`
   in SQL** to apply vault/status filters. The application must
   post-filter the MATCH result, with `k` inflated to absorb the
   expected filter rate (e.g. request `k = limit * 2` and trim
   after).

3. **Embedding reads back as `Uint8Array` in node:sqlite** (float32
   little-endian bytes, not `Float32Array`). `vec_distance_cosine()`
   and `MATCH` accept a `Float32Array` directly from callers; only
   application code that consumes `v.embedding` needs to know the
   byte layout.

4. **`MATCH` cannot be combined with a PK-join pre-filter.** The
   earlier draft of this paragraph suggested scoping the KNN with
   `chunk_id IN (SELECT id FROM knowledge_chunks WHERE ...)`. That
   does not work: the `distance` column is NULL under a PK join, so
   any query that mixes `MATCH` with a chunks-table join silently
   produces no ranking. Post-filter is the only supported path.

**Banned:** a bare full-table `ORDER BY vec_distance_cosine(...)` scan
in `hybrid: false`. Always use `MATCH` with `k`.

## 4. RAG pipeline

```
   ┌──────────┐      ┌──────────┐      ┌───────────┐      ┌──────────┐
   │ file     │ ───▶ │ extract  │ ───▶ │ chunk     │ ───▶ │ embed    │
   │ watcher  │      │ text     │      │ content   │      │ (cloud)  │
   └──────────┘      └──────────┘      └───────────┘      └──────────┘
                                                                  │
                                                                  ▼
                                              ┌──────────────────────────┐
                                              │ insert into chunks +     │
                                              │ FTS5 + vec0 (one txn)   │
                                              └──────────────────────────┘
```

### 4.1 Watcher

- Server-side `chokidar` on every `knowledge_vaults.root_path` with
  `watch=1`.
- On `add` / `change`: enqueue an ingest job.
- On `unlink`: enqueue a delete job. The worker deletes from
  `knowledge_chunks`, `knowledge_chunks_fts`, and `knowledge_chunks_vec`
  explicitly in one transaction — virtual tables cannot participate in
  `ON DELETE CASCADE` (§3.3).
- Debounce: 2s idle before ingesting (so a USB drop that writes 50
  files over 3 seconds triggers one batch, not 50).
- **Dependency hygiene (audit fix P1-4):** chokidar is currently only
  a transitive dependency in this repo. The watcher task must add it
  as a direct dependency in `package.json`.

### 4.2 Text extraction

| Type       | Strategy (v1)                                  | Strategy (v1.1)                             |
|---|---|---|
| `.md`      | read raw                                       | —                                           |
| `.txt`     | read raw                                       | —                                           |
| `.pdf`     | `pdfjs-dist` (already in devDependencies)      | —                                           |
| `.docx`    | `docx` (already in dependencies)               | —                                           |
| `.xlsx`    | metadata only                                  | cell-level extraction + per-sheet chunks    |
| image      | metadata only                                  | cloud OCR (Tongyi VL / Qwen-VL)           |
| audio      | metadata only                                  | cloud ASR (Tongyi Paraformer)             |
| video      | metadata only                                  | audio-track extraction → cloud ASR        |

**Decision (v1.1 ASR):** cloud-only. ARMbian devices cannot run a
local ASR model with acceptable latency or accuracy on the Tongyi
stack we already use. The cloud ASR choice matches §2.3 (Tongyi
Paraformer on DashScope — same API key, same auth). `sherpa-onnx`
remains in dependencies for the meeting-transcription feature but
is not wired into the knowledge plugin.

For audio / video / images in v1: ingest the file's metadata
(name, path, size, mtime, MIME) but do not extract content. A hook
point (`packages/server/src/services/knowledge/extractors/index.ts`)
lets a future iteration add the extractor without changing the
pipeline.

### 4.3 Chunking

Chunking parameters are **configurable** via
`packages/server/src/services/knowledge/config.ts` and surfaced as
environment variables (`KNOWLEDGE_CHUNK_SIZE`, `KNOWLEDGE_CHUNK_OVERLAP`,
`KNOWLEDGE_CHUNK_FALLBACK_SIZE`). Defaults:

- **Markdown:** split at `##` / `###` heading boundaries; if a section
  exceeds `KNOWLEDGE_CHUNK_FALLBACK_SIZE` (default **800 tokens**),
  fall back to paragraph breaks.
- **Plain text:** sliding window of `KNOWLEDGE_CHUNK_SIZE` (default
  **500 tokens**) with `KNOWLEDGE_CHUNK_OVERLAP` (default **50
  tokens**) overlap.
- **PDF / DOCX:** treat as plain text after extraction. If the
  extractor surfaces heading metadata, prefer the Markdown rule.
- Chunk id is **not** stable across re-indexing — that is fine, we
  always re-derive by document hash + content hash of each chunk.
- **Token counting standard (audit fix P2-8):** every "token" number
  in this pipeline is counted with `js-tiktoken` (already a repo
  dependency) using the `cl100k_base` encoding. No ad-hoc
  word-splitting heuristics.

Why configurable: 500 tokens is an empirically-derived middle ground,
but the right size depends on corpus shape (many short docs vs few
long ones), embedding model input cap, and retrieval latency budget.
Tuning without a restart — via a UI knob in `VaultList` that writes
to `updates/policy.json` — is a planned follow-up but out of scope
for v1.

### 4.4 Embedding

- **Default provider:** Tongyi `text-embedding-v3`, 1024-dim output.
- **Configurable** via `packages/server/src/services/knowledge/config.ts`
  (`KNOWLEDGE_EMBED_PROVIDER`, `KNOWLEDGE_EMBED_MODEL`,
  `KNOWLEDGE_EMBED_DIM`, `KNOWLEDGE_EMBED_API_KEY`,
  `KNOWLEDGE_EMBED_API_BASE`, `KNOWLEDGE_EMBED_BATCH_SIZE`).
- **Batch size:** **10** chunks per request (DashScope documented
  hard limit for `text-embedding-v3`; the API rejects batches > 10).
- **Retry with backoff** (3 attempts, 1s / 2s / 4s); after 3
  failures, mark the document `status = 'failed'` with the error
  and move on.
- **Persist `embedding_model` per row** so migration to a new model
  can detect and re-embed stale rows.
- **Pluggable provider interface:** `embedder.ts` exports an
  `EmbedProvider` contract (`embed(texts: string[]): Promise<Float32Array[]>`)
  with one implementation per provider. Adding DeepSeek / OpenAI /
  local later is a single file — no schema change.

### 4.5 Atomic write

All three indexes (chunks, FTS5, vec0) are written in a single
SQLite transaction. If any insert fails (embedding timeout, chunk
too long), the entire document is rolled back and marked `failed`.
Partial indexes are never observable by the search path.

## 5. API surface

All endpoints live under `/api/knowledge/` and are registered in
`packages/server/src/routes/`. The routes are **thin**: they delegate
to `packages/server/src/services/knowledge/`.

### 5.1 Management (Web UI side)

```
POST   /api/knowledge/vaults           - register a new vault
GET    /api/knowledge/vaults           - list vaults
DELETE /api/knowledge/vaults/:id       - unregister vault (does not touch files)
GET    /api/knowledge/documents        - list documents with status filters
GET    /api/knowledge/documents/:id    - one document + chunks preview
DELETE /api/knowledge/documents/:id    - remove from index
POST   /api/knowledge/reindex          - force re-index of all failed/pending
```

### 5.2 Search (Hermes Agent side)

```
POST   /api/knowledge/search
  body: {
    query: string,           // max 2000 chars; longer → 400 query_too_long
    vaultId?: number,
    limit?: number,
    hybrid?: boolean,
    maxDistance?: number     // cosine-DISTANCE cutoff (0..1); default 0.3.
                             // Lower = stricter. similarity = 1 - distance.
  }
  response: {
    results: Array<{
      documentId: number,
      chunkId: number,
      content: string,
      distance: number,      // cosine distance (0 = identical)
      similarity: number,    // 1 - distance, convenience field
      sourcePath: string,
      documentTitle: string
    }>,
    truncated: boolean,      // true when the query matched more than limit
    totalCandidatesBeforeFilter: number,  // chunks that passed stage-1
                                          // (FTS5 MATCH or vec0 MATCH)
                                          // but before maxDistance trim
    warning?: string         // set when inputs were clamped (e.g. limit > 20)
  }
```

**Decision — default `limit`:** **5**, configurable per call. Rationale:
the Hermes Agent has a finite context window (typically 8k–32k
tokens). Each chunk at the default 500-token size contributes ~500
tokens when spliced in; 5 chunks = ~2500 tokens, leaving ample headroom
for the Agent's own reasoning and reply. A tool description exposed to
the Agent should recommend `limit=3` for factual lookups, `limit=10`
for research-style queries, and never exceed `limit=20` (server-side
hard cap to prevent context-window overflow).

`hybrid: true` (default) runs the two-stage FTS5 + vec0 query.
`hybrid: false` runs pure-vector KNN via vec0's `MATCH` operator (§3.5).

**Distance vs similarity (audit fix P1-2).** The cutoff is expressed
as a maximum cosine **distance**, not a minimum score. The originally
drafted `minScore=0.8` read as "distance ≤ 0.8" — i.e. similarity ≥
0.2 — which passes nearly everything and is a no-op filter. The
default `maxDistance=0.3` means similarity ≥ 0.7; tune from there.

**Recall observability (third-pass audit fix).** At 1024-dim on
mixed zh/en text, `maxDistance=0.3` typically passes 30–60% of the
stage-1 candidates — so `limit=5` often returns only 2–3 real
results. The Agent has no way to tell whether it got "the only
matches" or "most matches were filtered out" from `results.length`
alone. `totalCandidatesBeforeFilter` tells the Agent:

- `results.length ≈ totalCandidatesBeforeFilter` → threshold is not
  the bottleneck; consider asking a different question or widening
  the vault scope.
- `results.length << totalCandidatesBeforeFilter` → threshold is
  filtering aggressively; the Agent can re-call with a higher
  `maxDistance` to see more candidates, or rephrase the query.

The tool description exposed to the Agent must call this field out
explicitly — it is the main signal the Agent uses to decide whether
to retry with looser parameters.

### 5.3 Hermes Agent integration

**Mechanism (audit fix P2-1):** `knowledge_search` is exposed as an
**MCP tool through the existing agent-bridge**
(`packages/server/src/services/hermes/agent-bridge/`), reusing the
same tool-registration and filtering path the bridge already uses for
other MCP tools (see `agent-bridge-mcp-tools-filter` tests). The
Agent discovers the tool via MCP; the bridge forwards the call to the
local Web UI route; results are stitched into the Agent's context.

No core change to the Hermes Agent is required — only bridge-side
tool registration, which this repo owns. The tool description exposed
to the Agent must state: returns chunks (≤ 500 tokens each) with
source paths; recommend `limit=3` for factual lookups, `limit=10`
for research-style queries; for Chinese queries prefer semantic
search (FTS5 keyword match is unreliable on Chinese text in v1, §7.5).

## 6. Integration into hermes-web-ui

### 6.1 Server side

```
packages/server/src/
├── db/
│   └── knowledge-schema.ts            - DDL for all knowledge tables
├── services/knowledge/
│   ├── knowledge.service.ts           - orchestrates ingest + search
│   ├── watcher.ts                     - chokidar manager
│   ├── extractors/
│   │   ├── index.ts                   - registry
│   │   ├── markdown.ts
│   │   ├── text.ts
│   │   ├── pdf.ts
│   │   └── docx.ts
│   ├── chunker.ts                     - content-aware splitter
│   ├── embedder.ts                    - cloud API client
│   └── search.ts                      - FTS5 + vec0 hybrid query
└── routes/
    └── knowledge.routes.ts            - /api/knowledge/*
```

### 6.2 Client side

```
packages/client/src/
├── features/knowledge/
│   ├── KnowledgeSidebar.vue           - entry in the main nav
│   ├── VaultList.vue                  - CRUD on watched directories
│   ├── DocumentList.vue               - ingest status, search preview
│   └── DocumentDetail.vue             - chunk viewer + AI summary
├── stores/
│   └── knowledge.ts                   - Pinia store
└── api/
    └── knowledge.ts                   - axios helpers
```

### 6.3 Path resolution

All state lives under `getWebUiHome()` (per AGENTS.md hard rule).
Default: `~/.hermes-web-ui/knowledge.db` — but we reuse the existing
`hermes-web-ui.db` in `config.appHome` per §3.

### 6.4 Shared connection requirements (audit fixes P0-2, P0-3)

The knowledge plugin uses the shared connection from
`packages/server/src/db/index.ts`. Three changes to that file are
required and are part of Task 1:

1. **Extension loading.** The connection is currently created as
   `new DatabaseSync(DB_PATH)` — without `allowExtension: true`,
   `loadExtension()` throws `ERR_INVALID_STATE` (verified empirically;
   calling `enableLoadExtension(true)` after creation is too late).
   Change to `new DatabaseSync(DB_PATH, { allowExtension: true })`.
   Security note: this permits extension loading on the main
   connection; the only extension ever loaded is the pinned
   `vec0` binary from the `sqlite-vec` package (§7.3).
2. **Per-connection PRAGMAs.** `ensureKnowledgeSchema(db)` must
   idempotently execute `PRAGMA foreign_keys=ON` and
   `PRAGMA busy_timeout=5000` on the shared connection at every boot.
   In dev, `db/index.ts` currently sets neither (and uses
   `journal_mode=DELETE`), so §10.3's concurrency guarantees and the
   real-table cascade are inert in development until this runs.
3. **Journal-mode assertion.** `ensureKnowledgeSchema` logs a warning
   when `journal_mode` is not `wal`. Dev uses `DELETE`, which
   serializes readers during writes. The dev split was introduced
   as a side-effect of PR #1895 (`76ce827b`, "Add workspace run diff
   cards") — the PR description and commit message give no explicit
   rationale. Most likely reasons: keep the dev data dir free of
   `-wal`/`-shm` sidecars so nodemon / vite watchers don't trigger
   reload loops, or work around stale reports of WAL lock issues on
   WSL1. Flipping dev to WAL is safe to try, but requires watching
   for nodemon reload storms.

## 7. Risks & mitigations

### 7.1 sqlite-vec is young

**Risk:** API breakage between 0.1.x → 1.0.x; performance regressions.

**Mitigation:**
- Pin `sqlite-vec` + `sqlite-vec-windows-x64` to `0.1.9` exactly
  (no caret) until the library reaches 1.0.
- `tests/release/sqlite-vec-smoke.test.ts` catches any load/query
  failure in CI before it ships.
- The schema is designed so swapping sqlite-vec for LanceDB / pgvector
  later only requires rewriting `knowledge_chunks_vec` and the search
  query — chunks and metadata stay untouched.

### 7.2 Node:sqlite is still experimental

**Risk:** API changes in Node 25+.

**Mitigation:** hermes-web-ui already depends on `node:sqlite` for
its main database. We inherit the same risk; nothing new.

### 7.3 Windows DLL loading

**Risk:** `sqlite-vec-windows-x64` DLL missing from `node_modules`
causes silent skip in CI.

**Mitigation:** `sqlite-vec-smoke.test.ts` fails loudly if installed
but broken (vs. gracefully skips if absent). On Windows, `npm ci`
must install the peer package — this is enforced by `package.json`.

### 7.4 Embedding cost

**Risk:** cloud embedding costs scale with ingestion volume.

**Mitigation:** expose a "budget" toggle in the UI. If enabled,
ingest pauses once monthly token spend hits the cap. Not implemented
in v1 but the schema already has `embedding_model` per row so we can
audit spend.

### 7.5 Chinese tokenization

**Risk:** FTS5 `porter` tokenizer is English-only. Chinese docs will
only match on exact characters.

**Mitigation (v1.1):** plug in `jieba` or unigram tokenizer behind
the FTS5 `tokenize` parameter. v1 ships with `porter`; semantic match
still works via vec0.

**Be precise about what v1 FTS does to Chinese (audit fix P2-6):**
with the default unicode61-derived tokenization, a run of CJK
characters is a single token — "keyword-exact match" means the whole
punctuation-bounded run must match. A Chinese keyword search will
under-deliver in v1. The Agent tool description (§5.3) must steer
Chinese queries toward semantic search, and the UI search box should
default to hybrid mode.

### 7.6 WAL backup is not a bare file copy

**Risk:** after a large ingest, recent writes live in the `-wal`
sidecar file; copying only `hermes-web-ui.db` produces a stale
snapshot that silently loses the most recent documents.

**Mitigation:** backup/restore tooling must run
`PRAGMA wal_checkpoint(TRUNCATE)` first (or copy the db + wal + shm
trio atomically). The v1 health endpoint (§10.6) exposes the WAL file
size so operators can see when a checkpoint is due.

## 8. What is NOT in v1

- Editor / note-taking UI. We are a search layer, not a writing tool.
- Graph visualization of links.
- Local embedding model support.
- Audio / video / image content extraction (metadata-only).
- Multi-tenant isolation (one Web UI instance = one corpus).

## 9. Decision log

All v1-scoped design decisions are closed here. Any change to these
decisions requires re-running this document through multi-agent audit
before code changes.

| # | Question | Decision | Rationale | § reference |
|---|---|---|---|---|
| 1 | Embedding provider | **Tongyi `text-embedding-v3` (1024-dim)** | Cheaper, native Chinese support, same auth path as the existing Hermes Agent completion calls, 1024-dim is a sweet spot vs 1536 | §2.3, §3.4, §4.4 |
| 2 | Chunk size | **Configurable**; default 500 tokens, 50 overlap, 800 fallback | Corpus shape varies; fixed sizes either lose context or bloat retrieval | §4.3 |
| 3 | Agent search `limit` | **Default 5**, hard cap 20, tool description should recommend 3–10 | Each chunk is ~500 tokens; 5 chunks = ~2500 tokens, fits Agent context window with headroom | §5.2 |
| 4 | v1.1 audio/video ASR | **Cloud-only (Tongyi Paraformer on DashScope)** | ARMbian devices can't run local ASR at acceptable quality; reuses existing Tongyi auth | §4.2 |

### Supporting decisions (carried forward)

| # | Question | Decision | § reference |
|---|---|---|---|
| 5 | Storage backend | SQLite (single file, WAL) — no sidecar DB | §2.2 |
| 6 | Vector index | sqlite-vec 0.1.9, pinned | §2.2, §7.1 |
| 7 | FTS5 tokenizer (v1) | `porter` (English-stemmed); Chinese uses character-exact in v1, jieba/unigram in v1.1 | §3.3, §7.5 |
| 8 | Agent integration style | Agent pulls (tool call), not push | §2.4 |
| 9 | Path resolution | `getWebUiHome()` per AGENTS.md hard rule | §6.3 |
| 10 | sqlite-vec install | `sqlite-vec` (shim) + `sqlite-vec-<platform>-<arch>` (peer) as devDependencies; smoke test in CI | §7.3 |


## 10. v1 detailed design

This section is the audit target. Every subsection answers "what
exactly happens when X, in code, on disk, over the wire." Multi-agent
review should find disagreements here before code exists.

### 10.1 Configuration surface

All knobs live in `packages/server/src/services/knowledge/config.ts`
and are exposed as environment variables. The file exports a single
typed `KnowledgeConfig` object; nothing else in the plugin reads
`process.env` directly (per AGENTS.md `getWebUiHome()` rule).

| Variable | Type | Default | Valid values | Notes |
|---|---|---|---|---|
| `KNOWLEDGE_ENABLED` | bool | `false` | `true` / `false` | Master kill switch. Default false in config; deploy/install scripts flip it to true on new installs (§10.8, audit fix P1-5) |
| `KNOWLEDGE_VAULT_PATHS` | JSON | `[]` | JSON array of absolute paths | Bootstrap vaults on first run; subsequent vaults go through `/api/knowledge/vaults` |
| `KNOWLEDGE_CHUNK_SIZE` | int | `500` | `100..4000` | Plain-text sliding window (tokens) |
| `KNOWLEDGE_CHUNK_OVERLAP` | int | `50` | `0..(KNOWLEDGE_CHUNK_SIZE/2)` | Tokens shared between windows |
| `KNOWLEDGE_CHUNK_FALLBACK_SIZE` | int | `800` | `KNOWLEDGE_CHUNK_SIZE..8192` | Markdown section overflow threshold |
| `KNOWLEDGE_EMBED_PROVIDER` | string | `tongyi` | `tongyi` (v1; others added later) | Pluggable via `EmbedProvider` interface |
| `KNOWLEDGE_EMBED_MODEL` | string | `text-embedding-v3` | Tongyi model id | |
| `KNOWLEDGE_EMBED_DIM` | int | `1024` | `1024` / `768` / `512` / `256` / `128` / `64` (v3 verified list, §3.4). 1536 is a **v2** dim, not v3 | Must match the model AND the dim baked into the existing vec0 table — mismatch is a startup error |
| `KNOWLEDGE_EMBED_API_KEY` | string | (required) | — | Read from env or `$HERMES_WEB_UI_HOME/secrets/knowledge-embed.env` (§10.5). Never stored in `updates/policy.json` — that file is the update-policy domain, not a secret store |
| `KNOWLEDGE_EMBED_API_BASE` | URL | `https://dashscope.aliyuncs.com/api/v1` | — | Override for air-gapped mirrors |
| `KNOWLEDGE_EMBED_BATCH_SIZE` | int | `10` | `1..10` | DashScope documented **hard limit** for `text-embedding-v3` |
| `KNOWLEDGE_EMBED_TIMEOUT_MS` | int | `30000` | `5000..300000` | Per-batch HTTP timeout |
| `KNOWLEDGE_EMBED_RETRIES` | int | `3` | `0..10` | With exponential backoff 1s/2s/4s/... |
| `KNOWLEDGE_SEARCH_LIMIT_DEFAULT` | int | `5` | `1..20` | Server-enforced hard cap |
| `KNOWLEDGE_SEARCH_MAX_DISTANCE_DEFAULT` | float | `0.3` | `0.0..1.0` | Maximum cosine distance (lower = stricter). similarity = 1 − distance |
| `KNOWLEDGE_WATCHER_DEBOUNCE_MS` | int | `2000` | `500..30000` | Idle-before-ingest |
| `KNOWLEDGE_WATCHER_QUEUE_DEPTH` | int | `20` | `5..200` | Max in-flight ingest jobs. Default lowered from 100 → 20 on third-pass audit: each queued job holds extracted text + chunks + embedding in memory; on ARMbian devices with 1–2 GB RAM, a 100-job queue against large PDFs can peak above 500 MB and trigger OOM. 20 is a safe default for USB-drop scenarios |
| `KNOWLEDGE_MONTHLY_BUDGET_USD` | float | `0` (unlimited) | `0..` | 0 = no cap. **Reserved, not enforced in v1** (§7.4) — read and reported by `/health` but ingest is never paused |

**Startup validation.** `config.ts` throws `KnowledgeConfigError` on
any invalid combination (e.g. `OVERLAP >= CHUNK_SIZE/2`, or
`EMBED_API_KEY` missing when `ENABLED=true`). The server refuses to
start — fail fast, don't half-initialize.

### 10.2 Failure-mode matrix

Each pipeline stage has exactly one failure contract. No silent
degradation; every failure surfaces as one of three states:
`pending`, `indexed`, `failed`.

| Stage | Failure mode | Handling | User-visible signal |
|---|---|---|---|
| Watcher | `root_path` gone (USB unplugged) | Mark vault `watch=0`, emit `knowledge:vault:offline` socket event | UI badge "vault offline" |
| Watcher | `chokidar` throws | Retry 3x; if all fail, vault `watch=0` | same |
| Extractor | Unsupported file type | Metadata-only row, `status=indexed`, `token_count=0` | Document listed as "metadata only" |
| Extractor | Corrupt PDF / DOCX | `status=failed`, `error=extract:<kind>` | "Extraction failed" with retry button |
| Chunker | 0 tokens after extraction | Treat as metadata-only (not an error) | "Empty document" |
| Chunker | Single chunk > 8192 tokens (Tongyi input cap) | Sub-split at paragraph boundary; if still too big, truncate with `…(truncated)` marker and log warning | Chunk content shows truncation notice |
| Embedder | HTTP 401 | `status=failed`, `error=embed:auth`, vault paused until key rotated | UI "API key invalid — configure in Settings" |
| Embedder | HTTP 429 | Retry with `Retry-After` header; back off | Transient, no user signal unless it persists > 5 min |
| Embedder | HTTP 5xx | Retry with exponential backoff (1s/2s/4s) | Transient |
| Embedder | Network timeout | Same as 5xx | Transient |
| Embedder | 3 failures exhausted | `status=failed`, `error=embed:<last>` | "Embedding failed — retry" button |
| SQLite | Transaction rollback (any of chunks/FTS/vec fails) | Entire doc rolled back, `status=failed` | "Index write failed" |
| SQLite | DB locked (WAL contention) | Busy timeout 5s; if still locked, `status=failed` | Same |
| Search | Empty query | Return `400` with `error=empty_query` | — |
| Search | `query` > 2000 chars | Return `400` with `error=query_too_long`. Hard cap — FTS5 + vec0 `MATCH` on a 100KB string would consume seconds of CPU and trigger a cloud embed call for every invocation (fourth-pass audit) | — |
| Search | `limit` > 20 | Clamp to 20 (server hard cap), respond `200` with the `warning` field set (§5.2 response schema) | — |
| Search | vec0 extension not loaded | `503 service_unavailable` — server refuses to start if this happens at boot | Admin action |

### 10.3 Concurrency model

```
                     ┌─────────────────────────────────┐
                     │ knowledge.service.ts             │
                     │  - receives ingest/search calls  │
                     │  - owns the SQLite connection    │
                     └────────────┬────────────────────┘
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
             ▼                    ▼                    ▼
     ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
     │ watcher A     │    │ watcher B     │    │ watcher N     │
     │ (vault 1)     │    │ (vault 2)     │    │ (vault N)     │
     └──────┬────────┘    └──────┬────────┘    └──────┬────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
                                 ▼
                      ┌─────────────────────┐
                      │ ingest queue        │
                      │ (bounded, FIFO)     │
                      │ size = QUEUE_DEPTH  │
                      └──────────┬──────────┘
                                 │
                                 ▼
                      ┌─────────────────────┐
                      │ single worker       │
                      │ (serialize writes)  │
                      └─────────────────────┘
```

**One writer.** All writes to `hermes-web-ui.db` for the knowledge
schema go through a single worker coroutine. Watchers are concurrent;
write-side is serialized. Rationale: SQLite WAL allows concurrent
reads with one writer; with one writer we avoid `SQLITE_BUSY` in the
common case. If `SQLITE_BUSY` still fires (busy_timeout exceeded),
the document is marked `failed` — not retried silently.

**One reader.** Read paths (search, list) go directly through
`getDb()` without locking the writer. SQLite WAL allows this.

**Dev caveat (audit fix P0-2).** These guarantees assume WAL +
`busy_timeout` + `foreign_keys=ON`, which `db/index.ts` only sets in
test/production. `ensureKnowledgeSchema` enforces the per-connection
PRAGMAs on every boot (§6.4); with dev's `journal_mode=DELETE`, reads
still serialize during writes — an accepted, documented limitation,
not a silent assumption. The `DELETE` dev-mode split was introduced
as a side-effect of PR #1895 ("Add workspace run diff cards",
commit `76ce827b`) — the PR description and commit message do not
explain the journal change; the most likely reason is to keep the
dev data dir free of `-wal`/`-shm` sidecars so nodemon / vite file
watchers don't pick them up as reload triggers, or to work around
stale reports of WAL lock issues on WSL1. Flipping dev to WAL is
safe to try, but requires watching for nodemon reload storms.

**Bounded queue.** `KNOWLEDGE_WATCHER_QUEUE_DEPTH` prevents an
attached USB drive with 10 000 files from blowing memory. When the
queue is full, the watcher pauses (chokidar `awaitWriteFinish`) until
drain. The default is 20 (down from 100 after the third-pass audit):
each queued job holds the extracted text + chunk list + embedding
vectors in memory; on ARMbian devices with 1–2 GB RAM, a 100-job
queue against a burst of large PDFs can peak well above 500 MB. With
20 the worst case is bounded to ~100 MB on typical document sizes.
Users who need higher throughput and have headroom can raise the env
variable.

### 10.4 Data consistency & restart

**Idempotency.** Every ingest job is keyed by `(vault_id, source_path)`.
Submitting the same key twice is a no-op if the existing row's
`source_hash` matches; if `source_hash` differs, it is a re-ingest
(delete old chunks/FTS/vec, insert new).

**Crash during ingest.** The SQLite transaction guarantees atomicity.
If the server dies mid-write, the row stays in its previous state
(`pending` if first ingest, or `indexed` with old chunks if re-ingest).
On restart:

1. `knowledge.service.ts` scans `status = 'pending'` → re-enqueues.
2. Scans `status = 'failed'` → leaves alone (user decides via UI).
3. Watches are re-established from `knowledge_vaults` where `watch=1`.

**Schema migration.** `ensureKnowledgeSchema(db)` runs on server boot.
It is additive (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
There is no destructive migration in v1. If a future version needs
one, it goes through a versioned migration table (out of scope).

### 10.5 Security

**API key storage.** `KNOWLEDGE_EMBED_API_KEY` is read at boot from
env or from a sidecar file at
`$HERMES_WEB_UI_HOME/secrets/knowledge-embed.env`. The sidecar file
is `chmod 600`, owned by the Web UI user, excluded from git, and
never logged. Logging the key, even partially, is a hard rule
violation.

**Reuse before inventing (audit fix P1-6).** Before implementing the
sidecar, survey the repo's existing credential mechanisms
(`packages/server/src/services/credentials.ts` — `.credentials` file
written with `mode: 0o600`; hermes profile `.env` handling in
`services/hermes/profile-credentials.ts`). If one extends cleanly to
provider API keys, use it; the sidecar env is the fallback, not the
default. `updates/policy.json` is never a secret store — it is the
operator update-policy domain (AGENTS.md).

**API surface.** `/api/knowledge/*` is behind the same auth as the
rest of the Web UI (session cookie + CSRF). The Hermes Agent's tool
call hits the same route through the bridge, inheriting the same
auth — the bridge acts as an authenticated client on the Agent's
behalf.

**No cross-tenant leak.** One Web UI instance = one corpus = one
API key scope. No multi-tenant in v1 (§8).

### 10.6 Observability

**Metrics** exposed via `/api/knowledge/health`:

```json
{
  "vaults":     { "total": 0, "watching": 0, "offline": 0 },
  "documents":  { "total": 0, "pending": 0, "indexed": 0, "failed": 0, "metadataOnly": 0 },
  "chunks":     { "total": 0 },
  "vecIndex":   { "sizeBytes": 0, "vectorCount": 0 },
  "ftsIndex":   { "sizeBytes": 0, "termCount": 0 },
  "ingestion":  { "inFlight": 0, "queued": 0, "lastSuccessAt": null, "lastFailureAt": null, "lastError": null },
  "embedder":   { "requestsLastHour": 0, "tokensLastHour": 0, "failuresLastHour": 0, "avgLatencyMs": 0 }
}
```

**Socket events** (all prefixed `knowledge:`):

- `vault:added` / `vault:removed` / `vault:offline`
- `ingest:progress` — per-document state change, rate-limited to 1/s
- `ingest:error` — document-level failure, includes `documentId` + `error`

**Logs.** All knowledge-plugin logs carry the `knowledge:` prefix for
grep-ability. Error logs include `documentId`, `vaultId`, `error`
class. PII rule: never log file content (only paths + hashes).

### 10.7 Testing strategy

| Layer | Location | Scope |
|---|---|---|
| Smoke | `tests/release/sqlite-vec-smoke.test.ts` | sqlite-vec loads + FTS5 + vec0 + join (already done) |
| Unit | `tests/server/knowledge-*.test.ts` | schema, chunker, embedder, search SQL in isolation |
| Integration | `tests/server/knowledge-routes.test.ts` | supertest against real Koa app with in-memory SQLite |
| E2E | `tests/e2e/knowledge.spec.ts` | Playwright: drop file on vault → UI shows ingest progress → search returns result |
| Failure | `tests/server/knowledge-failures.test.ts` | embedder timeout, corrupt PDF, DB locked — asserts `status=failed`, not silent loss |
| Fixture | `tests/server/fixtures/knowledge/` | sample .md / .txt / .pdf / .docx |

**Mocking.** Embedder tests use recorded HTTP fixtures (no live Tongyi
calls). Watcher tests run chokidar with `usePolling: true` against
real temp directories — memfs-style fake filesystems are incompatible
with chokidar's native `fs.watch` backends and would test a fiction
(audit fix P2-4).

### 10.8 Migration plan (from current state to v1)

1. **Add deps** (already done): `sqlite-vec`, `sqlite-vec-windows-x64`.
2. **Add files** per integration guide Tasks 1–10, in order.
3. **First commit:** Task 1 (schema) + Task 10 (health endpoint).
   Ships an empty schema + observability window. Zero user-facing
   change.
4. **Second commit:** Task 2 (watcher) + Task 3 (extractors). File
   watcher runs but writes no rows yet (extractor returns
   metadata-only for everything).
5. **Third commit:** Task 4–6 (chunker + embedder + orchestrator).
   Real ingest starts. Behind `KNOWLEDGE_ENABLED=false` by default.
6. **Fourth commit:** Task 7–8 (routes + client). UI visible.
   `KNOWLEDGE_ENABLED` stays `false` in `config.ts` (single source of
   truth, audit fix P1-5); the deploy script
   (`deploy-source-armbian.sh`, same pattern as `WEBUI_UPDATE_STRATEGY`)
   exports `KNOWLEDGE_ENABLED=true` for new installs only. Existing
   installs opt in via the UI or env.
7. **Fifth commit:** Task 9 (Agent tool binding). Hermes Agent can
   call `knowledge_search`.

Each commit is mergeable and deployable independently. No single
commit is a "big bang." If any commit needs to be reverted, it
leaves the db in a consistent state (knowledge tables remain, no
half-migrated rows).

## 11. Audit record

This section preserves the review trail so external auditors (human
or AI) can see what was already found and fixed, and verify the
fixes rather than re-deriving them.

### 2026-09-09 — internal audit (agent-run, pre-implementation)

Scope: full document cross-checked against actual code
(`packages/server/src/db/index.ts`, root `package.json`,
`services/credentials.ts`, `services/hermes/profile-credentials.ts`)
and against empirical `node:sqlite` + sqlite-vec behavior verified
in-session (extension-loading flags, FTS5 tokenization, vec0 k-NN).

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| P0-1 | blocker | §4.1 claimed `ON DELETE CASCADE` covers FTS5/vec0 rows — impossible on virtual tables | §3.3 + §4.1 rewritten: worker deletes chunks + fts + vec explicitly in one txn |
| P0-2 | blocker | dev-mode PRAGMAs (`journal_mode=DELETE`, no `busy_timeout`, no `foreign_keys`) contradict §10.3/§10.4 guarantees | §6.4 + §10.3: `ensureKnowledgeSchema` enforces per-connection PRAGMAs; dev WAL alignment flagged as separate decision |
| P0-3 | blocker | `getDb()` creates the connection without `allowExtension: true`; `loadExtension()` throws `ERR_INVALID_STATE`; integration guide Task 1 never mentioned touching `db/index.ts` | §6.4: shared-connection requirements incl. security note; Task 1 updated |
| P1-1 | major | `hybrid:false` as specified is a brute-force O(N·d) scan; vec0's `MATCH` KNN operator never mentioned | §3.5: MATCH-based KNN mandated; bare full-table ORDER BY scan banned |
| P1-2 | major | `minScore=0.8` as a *distance* cutoff = similarity ≥ 0.2 → no-op filter | §5.2 + §10.1: renamed to `maxDistance`, default 0.3 (similarity ≥ 0.7); response now returns both `distance` and `similarity` |
| P1-3 | major | FTS5↔chunks rowid coupling assumed but never specified | §3.3: explicit-rowid insert spec + schema-test regression gate |
| P1-4 | major | chokidar is an undeclared transitive dependency (3.6.0 in node_modules, absent from `package.json`) | §4.1 + guide Task 2: direct dependency required |
| P1-5 | major | `KNOWLEDGE_ENABLED` default contradicted itself (§10.1 true vs §10.8 false/per-install) | §10.1 + §10.8: default false in config; deploy script flips for new installs (mirrors `WEBUI_UPDATE_STRATEGY` pattern) |
| P1-6 | major | API key note pointed at `updates/policy.json` (update-policy domain, not a secret store); existing credential services ignored | §10.1 + §10.5: survey-then-reuse rule; sidecar env is fallback |
| P1-7 | major | `EMBED_DIM` changeable via env but table dim is immutable at creation; `1536` may not be a valid v3 dim | §3.4 + §10.1: startup validation against existing table; dims list marked pending verification |
| P2-1 | minor | Agent tool binding hand-waved as "a new tool definition" | §5.3: pinned to MCP tool via agent-bridge |
| P2-2 | minor | §10.2 "respond with warning" but §5.2 response had no warning field | §5.2: `warning?` field added; §10.2 wording aligned |
| P2-3 | minor | Budget knob in v1 config (§10.1) but §7.4 says not implemented in v1 | §10.1: marked reserved/not enforced |
| P2-4 | minor | Watcher test plan (memfs + chokidar) incompatible with chokidar's native backends | §10.7 + guide Task 2: `usePolling` against real temp dirs |
| P2-5 | minor | WAL sidecar makes bare-file backups stale | §7.6 added: checkpoint before backup; WAL size in `/health` |
| P2-6 | minor | §7.5 overstated v1 Chinese FTS ("keyword-exact") — CJK runs are single tokens | §7.5 + §5.3: reality documented; Agent tool steers Chinese to semantic search |
| P2-7 | minor | 19 env vars for v1 is heavy | accepted as-is; reserved vars marked; no blocker |
| P2-8 | minor | Token counting had no named tokenizer | §4.3: `js-tiktoken` / `cl100k_base` pinned |

**Verdict:** skeleton sound (single-file SQLite + sqlite-vec + cloud
Tongyi embedding; pull-based Agent tool; staged task breakdown). All
blocking findings fixed in-doc before implementation.

### 2026-09-09 — third-pass verification (agent-run, open items closed)

Scope: verify the three "open external verifications" left by the
first-pass audit. All three are now closed; the findings uncovered
additional doc errors that needed fixing.

| # | Was | Verified | Corrections triggered |
|---|---|---|---|
| 1 | "confirm v3 supported dims and pricing" | DashScope docs (2026-09-09): v3 dims = **1024 / 768 / 512 / 256 / 128 / 64** (default 1024); **1536 is NOT a v3 dim**, it is a v2-only dim; price = **¥0.0005 / 1k tokens** (not the 0.0007 quoted in §2.3); batch = **10 per request** (not 25) | §2.3 pricing fixed; §3.4 verified-dims note rewritten; §4.4 batch fixed; §10.1 config table `KNOWLEDGE_EMBED_DIM` valid values corrected; `KNOWLEDGE_EMBED_BATCH_SIZE` default 25 → 10, valid range 1..10 |
| 2 | "check git history for dev journal_mode=DELETE" | Introduced as a side-effect of commit `76ce827b` / PR #1895 "Add workspace run diff cards". The PR description and commit message do not explain the journal-mode change. Most likely reason: avoid `-wal`/`-shm` sidecars triggering nodemon / vite reload loops in dev, or work around stale WSL1 WAL lock reports | §6.4 + §10.3 rewritten with the PR/citation so the rationale is no longer "undocumented" — it's "side-effect of unrelated PR, not a deliberate design choice" |
| 3 | "confirm Tongyi batch limit and 8192-token input cap" | DashScope docs confirm: **batch = 10 hard limit** for v3 (not 25); **max input = 8192 tokens** (correct). Also confirmed v2 has batch 25, max 2048 — so v3 vs v2 batch/length trade-offs are real and not configurable | §4.4 "25" → "10"; §10.1 batch default + valid range fixed |

**Net effect of this pass:** three "minor open verification" items
turned out to contain two real doc errors (batch size 25 → 10, v3
does not support 1536-dim) plus a missing PR citation. All three
are now closed.

**No remaining open verifications.** The architecture doc is now
fully grounded against (a) the actual sqlite-vec runtime behavior
(run + observed), (b) the actual codebase's PRAGMAs and file
layout, and (c) the actual DashScope API spec as of 2026-09-09.

### 2026-09-09 — second-pass audit (agent-run, post first-pass fixes)

Scope: verify the first-pass audit's own fixes didn't introduce new
inconsistencies. Driven by re-reading §3.4 + §3.5 + the smoke test
after the changes landed, then running end-to-end queries against
sqlite-vec 0.1.9 / node:sqlite on Node 24 with a `distance=cosine`
table and a named-PK vec0.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| S1 | blocker | §3.5's P1-1 fix told pure-vector search to use `MATCH ... AND k = :limit` and return `distance`, but didn't specify that vec0's default distance metric is **L2**, not cosine. Hybrid mode returned cosine while pure-vector would return L2 — scores incomparable, `maxDistance` API parameter ambiguous | §3.4 CREATE TABLE now requires `distance=cosine` clause; §3.5 rewritten with verified syntax and explicit notes |
| S2 | blocker | §3.5's P1-1 fix suggested scoping the pure-vector KNN with `chunk_id IN (SELECT id FROM knowledge_chunks WHERE ...)`. Verified: vec0's `distance` column is only populated on the `MATCH` path; when the table is joined by PK, `distance` is NULL. The suggested query silently produces no ranking | §3.5 item 2 + 4: document the limitation; pure-vector search must post-filter in application code with inflated `k` |
| S3 | minor | The smoke test only exercises vec0's rowid form; named-PK (`chunk_id INTEGER PRIMARY KEY`) was untested, which is what the architecture actually uses | Smoke test extended with `sqlite-vec-named-pk-and-cosine` cases |
| S4 | minor | node:sqlite returns vec0 `embedding` columns as `Uint8Array` (float32 LE bytes), not `Float32Array` | §3.5 item 3 documents this; only affects application-layer consumers, not SQL functions |

**Closed from the first-pass open list:** open verification #3 (vec0
named-PK DDL) — now verified working, plus `distance=cosine`, plus
the NULL-distance-on-PK-join caveat.

**Verdict:** the first-pass audit caught the right structural
problems but overcorrected §3.5 with a syntactically valid but
semantically wrong query shape. The second pass closed the gap.
Architecture doc now reflects behavior that has been run, observed,
and pinned with a smoke-test regression gate.

### 2026-09-09 — fourth-pass audit (reality check, human-guided)

The first two passes verified "does the document hang together and
match what the libraries actually do." The third pass (done in
parallel) closed the open external verifications against DashScope
live docs and `db/index.ts` git history. The fourth pass — prompted
by human review — challenged "even if everything self-consistent,
will this hurt in production?" All findings are at the
product/cost/ops layer rather than the SQL/API layer.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| T1 | major | Search response gave the Agent no signal for recall. At `maxDistance=0.3` on mixed zh/en text, typically 30–60% of stage-1 candidates get filtered, so `limit=5` frequently returns 2–3 results; the Agent could not tell whether "only 2 relevant" or "most were filtered out" | §5.2 response gains `totalCandidatesBeforeFilter` field + explanatory paragraph. Tool description must steer the Agent on interpreting it |
| T2 | major | No query-length constraint. A `query` of 1 MB of text would burn CPU in FTS5 + vec0 MATCH and trigger a cloud embed call per invocation — prompt-injection surface | §5.2 body schema + §10.2 failure matrix: `query` > 2000 chars → `400 query_too_long` hard cap |
| T3 | major | `KNOWLEDGE_WATCHER_QUEUE_DEPTH=100` unsafe on ARMbian. Each queued job holds extracted text + chunks + embeddings in memory; 100 jobs × large PDFs can peak > 500 MB, OOM on 1–2 GB RAM devices | §10.1 config + §10.3: default lowered to **20** (valid range 5..200); rationale documented; users with headroom can raise |
| T4 | minor | Cost model (§2.3) was plausible but under-reported Chinese text cost (cl100k_base treats CJK ~1.5 chars/token, so 100 MB Chinese ≈ 66M tokens, not 25M). Real monthly cost at ¥0.0007/千token is ~¥32–45 not ~¥12.5 | Acknowledged; no doc change required (the §2.3 figure was illustrative, not committed). P1 follow-up: vault-create UI should estimate token count and show expected first-ingest cost before confirmation |
| T5 | minor | Single-worker embedder + HTTP 429 would cascade: one 429 with 4s Retry-After stalls all queued ingests | Acknowledged. P1 follow-up: embedder gains a process-wide 429 backoff state so one 429 stops all embed calls for the retry window instead of each task retrying independently |

**Verdict:** three real product-layer risks closed (recall
observability, query-length cap, ARMbian memory headroom). Two
cost/ops items acknowledged as P1 follow-ups. The v1 design is now
safe to build against on the target hardware without surprises that
only surface in production.

