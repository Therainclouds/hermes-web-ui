# Task 10 — Hardening & observability

> Status: spans all other tasks; hardening-specific code lands after
> Task 7 is wired.

## Summary

Health endpoint, real-time error Socket.IO events, and CI gates
across platforms. This task makes the knowledge plugin observable in
production and testable in CI.

## Dependencies

- Task 7 (routes — the health endpoint mounts under `/api/knowledge/`).
- Other tasks contribute socket events as they land; this task adds
  the `knowledge:ingest:error` event and the CI gate.

## Files

### Create / modify

- `packages/server/src/routes/knowledge.routes.ts` — add
  `GET /api/knowledge/health`.
- `tests/server/knowledge-health.test.ts` — acceptance for the health
  endpoint.
- `.github/workflows/` — add a CI gate that runs
  `sqlite-vec-smoke.test.ts` on Windows + Linux + ARMbian.

## Acceptance criteria

1. `GET /api/knowledge/health` returns the documented shape:
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
2. `knowledge:ingest:error` Socket.IO event fires on document-level
   failure with `documentId` + `error` payload.
3. `knowledge:ingest:progress` event is rate-limited to 1/s per
   document (avoid flooding the client).
4. CI gate: `sqlite-vec-smoke.test.ts` runs on all three platforms
   (Windows / Linux / ARMbian) before merge.

## Implementation steps

1. **Health endpoint**:
   - Query each table for counts: `knowledge_vaults`,
     `knowledge_documents` (grouped by status), `knowledge_chunks`.
   - For `vecIndex.sizeBytes`: use SQLite's `page_count * page_size`
     on the vec0 virtual table (or `length()` on a dump — whatever
     gives a reasonable size estimate).
   - For `ftsIndex.termCount`: query
     `SELECT COUNT(*) FROM knowledge_chunks_fts_segstats` if exposed,
     else approximate via `SELECT SUM(length(content)) FROM
     knowledge_chunks_fts`.
   - For `ingestion.*`: read from the orchestrator's in-memory state
     (in-flight, queued, last success/failure).
   - For `embedder.*`: track per-embedder-call stats in an
     in-memory ring buffer (last hour).
2. **Socket events**:
   - The orchestrator already emits progress events (Task 6). Add the
     `knowledge:ingest:error` event emission on document failure.
   - Add rate-limiting (1/s per document) to
     `knowledge:ingest:progress` — use a simple per-doc timestamp map.
3. **CI gate**:
   - Create a new workflow file or add a job to the existing workflow
     that runs `sqlite-vec-smoke.test.ts` on the matrix of platforms.
   - The existing smoke test already handles graceful skip when
     sqlite-vec is not installed; the gate should fail only when
     sqlite-vec IS installed but tests fail (real breakage).
4. **Tests**:
   - `knowledge-health.test.ts`: use supertest; seed the DB with a
     few vaults/documents; assert every field of the response is
     populated correctly.

## Hard rules

- Health endpoint is read-only; never mutates state.
- Never log API keys, even partially.
- Never log file content. Paths + hashes only.
- Socket event names are `knowledge:`-prefixed.

## Suggested commit message

```
feat(knowledge): health endpoint + socket events + CI gates

- GET /api/knowledge/health returns the documented shape (vaults,
  documents, chunks, vecIndex, ftsIndex, ingestion, embedder).
- knowledge:ingest:error socket event on document failure.
- knowledge:ingest:progress rate-limited to 1/s per document.
- CI gate runs sqlite-vec-smoke.test.ts on Windows/Linux/ARMbian.

Refs: docs/knowledge-architecture.md §10.6, §10.7
Refs: docs/knowledge/specs/task-10-hardening.md
```

## Out of scope

- Budget enforcement (reserved, not enforced in v1).
- WAL checkpoint automation — documented in §7.6 but manual in v1.

## References

- Architecture doc §10.6 (observability)
- Architecture doc §10.7 (testing strategy)
- Architecture doc §7.6 (WAL backup)
- Integration guide Task 10
