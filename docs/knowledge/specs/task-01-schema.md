# Task 1 — Schema bootstrap + shared connection change

> Status: unblocked. Every other task depends on this one.

## Summary

Create the DDL for the knowledge plugin tables in a new file
`knowledge-schema.ts`, add a regression test that validates the schema
(including the FTS5 rowid coupling and vec0 cosine distance), and
modify the shared SQLite connection in `db/index.ts` to accept
extension loading.

## Dependencies

- None. This is the seed task.

## Files

### Create

- `packages/server/src/db/knowledge-schema.ts`
- `tests/server/knowledge-schema.test.ts`

### Modify

- `packages/server/src/db/index.ts` — **one line only**: change the
  `new DatabaseSync(DB_PATH)` call to `new DatabaseSync(DB_PATH, {
  allowExtension: true })`. This is the minimum change required for
  `loadExtension()` to succeed; calling `enableLoadExtension(true)`
  after construction is too late (verified empirically on Node 24 +
  sqlite-vec 0.1.9).

## Acceptance criteria

1. `ensureKnowledgeSchema(db)` called on an empty `hermes-web-ui.db`
   creates exactly these tables:
   - `knowledge_vaults` (architecture doc §3.1)
   - `knowledge_documents` (§3.1)
   - `knowledge_chunks` (§3.2)
   - `knowledge_chunks_fts` (FTS5, §3.3)
   - `knowledge_chunks_vec` (vec0 with `distance=cosine`, §3.4)
2. Calling it on an already-populated db is idempotent
   (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).
3. The test runs against an in-memory SQLite instance via
   `new DatabaseSync(':memory:', { allowExtension: true })`.
4. The test asserts **FTS5 rowid coupling** (§3.3, audit P1-3): insert
   a chunk with id `X`, then query `knowledge_chunks_fts.rowid` and
   expect `X`.
5. The test asserts **vec0 `distance=cosine`** is honored: insert two
   vectors and verify `MATCH` returns them ordered by cosine
   distance, not L2.
6. The test asserts that `config.ts` (which will land in Task 6 but
   whose type can be defined here) rejects a `KNOWLEDGE_EMBED_DIM`
   that differs from the dim baked into an existing
   `knowledge_chunks_vec` table (§3.4, audit P1-7).

## Implementation steps

1. **Read** `packages/server/src/db/index.ts` end-to-end. Note the
   existing PRAGMAs per mode.
2. **Create** `knowledge-schema.ts` with:
   - `ensureKnowledgeSchema(db: DatabaseSync, dim: number): void`
   - Hardcoded `FLOAT[<dim>]` derived from the `dim` parameter (do
     not hardcode 1024 at every call site).
   - Idempotent PRAGMAs: `PRAGMA foreign_keys=ON`,
     `PRAGMA busy_timeout=5000`.
   - Warning log when `journal_mode != wal`.
3. **Edit** `db/index.ts` line 41:
   ```ts
   _db = new DatabaseSync(DB_PATH, { allowExtension: true })
   ```
   This is the ONLY change. Do not touch PRAGMAs, do not add the
   knowledge schema call to this file — it belongs in the service
   init path (Task 6).
4. **Create** `knowledge-schema.test.ts`:
   - Use `node:sqlite` directly with `:memory:`.
   - Load `sqlite-vec` extension.
   - Call `ensureKnowledgeSchema(db, 1024)`.
   - Assert all 5 tables exist.
   - Insert a chunk, assert FTS5 rowid coupling.
   - Insert two vectors, assert cosine ordering on `MATCH`.
   - Call `ensureKnowledgeSchema(db, 1024)` again — no errors.
   - Call `ensureKnowledgeSchema(db, 768)` on a DB with the vec0
     table already at dim=1024 — expect a thrown
     `KnowledgeSchemaError` describing the mismatch.

## Hard rules

- `knowledge_chunks_vec` must declare `FLOAT[<dim>]` with `dim` read
  from a parameter in the same file (not hardcoded at every call
  site). The schema function signature is the canonical dim source.
- FTS5 tokenizer is `porter` (`tokenize='porter'`).
- `ensureKnowledgeSchema` must idempotently enforce per-connection
  PRAGMAs (`foreign_keys=ON`, `busy_timeout=5000`) and warn when
  `journal_mode` is not `wal` (architecture doc §6.4, audit P0-2).
- Never rely on `ON DELETE CASCADE` for FTS5 or vec0 — worker code
  deletes all three indexes explicitly in one transaction. This task
  only defines the schema; the worker lands in Task 6. But the
  schema must not contain any FK declarations on the virtual tables.
- Security note in PR: enabling `allowExtension: true` on the shared
  connection permits extension loading. The only extension ever
  loaded is the pinned `vec0` binary from the `sqlite-vec` package.

## Suggested commit message

```
feat(knowledge): schema bootstrap + shared connection allowExtension

- Add ensureKnowledgeSchema() for knowledge_vaults, knowledge_documents,
  knowledge_chunks, knowledge_chunks_fts (FTS5/porter), and
  knowledge_chunks_vec (vec0 with distance=cosine).
- Modify db/index.ts to create the shared DatabaseSync with
  { allowExtension: true } — required for sqlite-vec loadExtension().
- enforce per-connection PRAGMAs (foreign_keys, busy_timeout) in the
  shared connection; warn when journal_mode != wal.
- Regression test covers FTS5 rowid coupling and vec0 cosine distance.

Refs: docs/knowledge-architecture.md §3, §6.4
Refs: docs/knowledge/specs/task-01-schema.md
```

## Out of scope

- Loading the vec0 extension at runtime (belongs in Task 6 service
  init).
- Config module (`config.ts` belongs in Task 6; the dim validation
  test can use a stubbed config).
- Worker / watcher / anything that writes rows beyond the test setup.

## References

- Architecture doc §3 (data model)
- Architecture doc §6.4 (shared connection requirements, audit P0-2/3)
- Integration guide Task 1
- Smoke test: `tests/release/sqlite-vec-smoke.test.ts`
