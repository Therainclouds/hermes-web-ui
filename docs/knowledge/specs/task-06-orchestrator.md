# Task 6 — Orchestrator (knowledge.service.ts + config.ts)

> Status: blocked on Tasks 1–5.

## Summary

The orchestrator stitches the watcher, extractor, chunker, and
embedder together. It owns the single-writer coroutine, the bounded
ingest queue, and the search path. This task also defines
`config.ts` — the typed config object that every other file reads
from.

## Dependencies

- Tasks 1 (schema), 2 (watcher), 3 (extractors), 4 (chunker),
  5 (embedder).

## Files

### Create

- `packages/server/src/services/knowledge/knowledge.service.ts`
- `packages/server/src/services/knowledge/config.ts`
- `packages/server/src/services/knowledge/search.ts`
- `tests/server/knowledge-service.test.ts`

## Acceptance criteria

1. `ingest(path)` runs `extract → chunk → embed`, then writes
   chunks + FTS5 + vec0 rows in **one SQLite transaction**.
2. On any failure, the transaction rolls back and the document is
   marked `status = 'failed'` with the error.
3. Re-ingesting the same file (same `source_hash`) is a no-op.
4. Re-ingesting a modified file (different `source_hash`) deletes
   old chunks + FTS5 + vec0 rows and inserts new ones atomically.
5. **`search({ query, vaultId, limit, hybrid, maxDistance })`**:
   - `hybrid: true` (default) runs the two-stage FTS5 + vec0 query
     (§3.5 hybrid).
   - `hybrid: false` runs pure-vector KNN via vec0's
     `MATCH ... AND k = ?` operator — never a bare
     `ORDER BY vec_distance_cosine(...)` full-table scan.
6. **The vec0 table must be created with `distance=cosine`** (this is
   Task 1's job, but the orchestrator relies on it for score parity).
7. **Pure-vector results cannot be joined against `knowledge_chunks`
   in SQL** — `distance` is NULL under a PK join. Vault/status
   filtering happens in app code after MATCH with inflated `k`.
8. `maxDistance` is a cosine **distance** cutoff (default 0.3,
   lower = stricter). No `minScore` anywhere.
9. `query` is hard-capped at **2000 characters** — exceeding returns
   `400 query_too_long` (§5.2, audit T2).
10. Response includes `totalCandidatesBeforeFilter: number` — chunks
    that passed stage-1 before limit/maxDistance trim (§5.2, audit T1).
11. **Search must never return chunks whose document is
    `status != 'indexed'`.** The filter is in SQL, not post-hoc.
12. The service loads the sqlite-vec extension on init via
    `db.loadExtension(...)` using `sqliteVec.getLoadablePath()`.
13. Config is a single typed object exported from `config.ts`; nothing
    else in the plugin reads `process.env` directly.

## Implementation steps

### config.ts

1. Define `KnowledgeConfig` with all fields from §10.1.
2. Parse from env with validation:
   - `OVERLAP < CHUNK_SIZE / 2`.
   - `EMBED_API_KEY` required when `ENABLED=true`.
   - `EMBED_DIM` must be one of the v3 supported dims
     (1024/768/512/256/128/64) — 1536 is a v2-only dim, reject it.
   - `EMBED_BATCH_SIZE` in `1..10`.
3. Throw `KnowledgeConfigError` on any invalid combination — fail
   fast, don't half-initialize.
4. `EMBED_API_KEY` reads from env or from
   `$HERMES_WEB_UI_HOME/secrets/knowledge-embed.env` (survey existing
   credential services first — `credentials.ts`,
   `profile-credentials.ts` — per audit P1-6).

### knowledge.service.ts

5. On init:
   - Load config.
   - Get the shared `getDb()`, call `ensureKnowledgeSchema(db, dim)`.
   - Load sqlite-vec extension on the shared connection.
   - Re-establish watchers from `knowledge_vaults WHERE watch=1`.
   - Scan `status = 'pending'` → re-enqueue.
6. Single-writer coroutine:
   - Bounded FIFO queue (`QUEUE_DEPTH` from config, default 20).
   - One async worker drains the queue serially.
   - Watchers pause when queue is full.
7. `ingest(path)`:
   - Compute `source_hash = sha256(content)`.
   - Check DB: if `source_hash` matches → no-op; if differs →
     delete old chunks/FTS/vec in one txn.
   - Extract → chunk → embed → insert chunks/FTS/vec in one txn.
   - FTS5 rowid coupling: `INSERT INTO knowledge_chunks_fts(rowid, content)
     VALUES (?, ?)` with rowid = chunk.id (audit P1-3).
   - vec0 insert: `INSERT INTO knowledge_chunks_vec(chunk_id, embedding)
     VALUES (?, ?)`.
   - On failure: rollback, mark `status=failed` with error.
8. Delete flow (virtual tables don't cascade, audit P0-1):
   - `DELETE FROM knowledge_chunks WHERE document_id = ?` (cascade
     from documents is fine).
   - `DELETE FROM knowledge_chunks_fts WHERE rowid IN (SELECT id FROM
     knowledge_chunks WHERE document_id = ?)` — before deleting chunks.
   - `DELETE FROM knowledge_chunks_vec WHERE chunk_id IN (SELECT id FROM
     knowledge_chunks WHERE document_id = ?)` — same.
   - All three in one transaction.

### search.ts

9. Hybrid path (FTS5 + vec0, §3.5):
   ```sql
   WITH candidates AS (
     SELECT rowid FROM knowledge_chunks_fts
     WHERE knowledge_chunks_fts MATCH ?
   )
   SELECT c.document_id, c.id AS chunk_id, c.content,
          vec_distance_cosine(v.embedding, ?) AS distance
   FROM knowledge_chunks c
   JOIN knowledge_chunks_vec v ON v.chunk_id = c.id
   WHERE c.rowid IN (SELECT rowid FROM candidates)
     AND c.document_id IN (
       SELECT id FROM knowledge_documents
       WHERE status = 'indexed'
         AND (:vaultId IS NULL OR vault_id = :vaultId)
     )
   ORDER BY distance
   LIMIT :limit
   ```
10. Pure-vector path (vec0 `MATCH`, §3.5):
    ```sql
    SELECT chunk_id, distance
    FROM knowledge_chunks_vec
    WHERE embedding MATCH :query AND k = :k_inflated
    ```
    Then post-filter in app code:
    - Join with `knowledge_chunks` + `knowledge_documents` to get
      vault_id / status.
    - Keep only `status = 'indexed'` and matching vault_id.
    - Trim to `limit`.
11. Clamp `limit` to 20; if clamped, set `warning` field.
12. `query.length > 2000` → throw `QueryTooLongError` (caller maps
    to 400).
13. Always compute and return `totalCandidatesBeforeFilter` — the
    count of chunks that passed stage-1 before `maxDistance` trim.

### Tests

14. **knowledge-service.test.ts**:
    - Use an in-memory SQLite + sqlite-vec loaded.
    - Mock embedder (return fixed vectors).
    - Ingest a fixture → assert `status=indexed`, chunks/FTS/vec rows
      match.
    - Re-ingest same content → no new rows.
    - Re-ingest modified content → old rows replaced.
    - Fail embedder → `status=failed`, no partial rows.
    - Search hybrid → returns correct chunks, ordered by distance.
    - Search pure-vector → uses MATCH, returns correct chunks.
    - Query > 2000 chars → throws `QueryTooLongError`.
    - `status != 'indexed'` documents never appear in search results.

## Hard rules

- One writer, serialized. Never concurrent writes.
- FTS5 + vec0 rows deleted explicitly in the same transaction as
  chunks (never rely on FK cascades for virtual tables).
- `getDb()` is the only connection — never open a second one.
- Config reads env/secrets; nothing else in the plugin reads
  `process.env` directly.
- Search path must never return non-`indexed` documents — filter is
  in SQL for hybrid, in app post-filter for pure-vector.

## Suggested commit message

```
feat(knowledge): orchestrator + config + hybrid search

- Single-writer coroutine with bounded FIFO queue (default 20).
- Atomic ingest: chunks + FTS5 + vec0 in one transaction.
- Hybrid search (FTS5 candidate set + vec0 re-rank) and pure-vector
  KNN (vec0 MATCH with post-filter).
- Config validation: EMBED_DIM against existing vec table; EMBED_BATCH_SIZE
  capped at 10; API key from env or secrets sidecar.
- Query length cap 2000 chars; response includes totalCandidatesBeforeFilter.

Refs: docs/knowledge-architecture.md §4, §5.2, §10.1, §10.3, §10.4
Refs: docs/knowledge/specs/task-06-orchestrator.md
```

## Out of scope

- HTTP routes (Task 7).
- Vault-create UI cost estimate (P1 follow-up).
- Process-wide 429 backoff (P1 follow-up).

## References

- Architecture doc §4 (RAG pipeline)
- Architecture doc §5.2 (search API)
- Architecture doc §6.4 (shared connection)
- Architecture doc §10.1 (config)
- Architecture doc §10.3 (concurrency)
- Architecture doc §10.4 (data consistency)
- Architecture doc §10.5 (security)
- Integration guide Task 6
