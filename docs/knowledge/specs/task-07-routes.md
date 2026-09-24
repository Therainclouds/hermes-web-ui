# Task 7 — Routes (`/api/knowledge/*`)

> Status: blocked on Task 6.

## Summary

Thin HTTP routes that delegate to `knowledge.service.ts`. All
endpoints under `/api/knowledge/`. Response shapes match §5 of the
architecture doc.

## Dependencies

- Task 6 (orchestrator + service).

## Files

### Create

- `packages/server/src/routes/knowledge.routes.ts`
- `tests/server/knowledge-routes.test.ts`

### Modify

- The main route registration file (whichever file mounts all
  server routes) — mount `knowledge.routes` **before the proxy
  catch-all** (AGENTS.md rule).

## Acceptance criteria

1. All §5.1 management endpoints are reachable and return the
   documented shapes:
   - `POST   /api/knowledge/vaults`
   - `GET    /api/knowledge/vaults`
   - `DELETE /api/knowledge/vaults/:id` (with `?cascade=true` optional)
   - `GET    /api/knowledge/documents` (with status filters)
   - `GET    /api/knowledge/documents/:id`
   - `DELETE /api/knowledge/documents/:id`
   - `POST   /api/knowledge/reindex`
2. §5.2 search endpoint:
   - `POST /api/knowledge/search` with the documented body/response
     shape.
   - Empty query → `400 empty_query`.
   - Query > 2000 chars → `400 query_too_long` (audit T2).
   - `limit > 20` is clamped; response includes `warning` field.
   - Response includes `totalCandidatesBeforeFilter: number`
     (audit T1).
3. The test uses `supertest` against the real Koa app with an
   in-memory SQLite.
4. Routes are registered before any proxy catch-all (AGENTS.md).

## Implementation steps

1. **Read** the existing route structure — pick the pattern used by
   other routes (e.g. `packages/server/src/routes/`). Match it.
2. **Create** `knowledge.routes.ts`:
   - Use the existing HTTP framework (Koa) and the existing router
     library (likely `@koa/router`).
   - Each route handler: parse request → call service → return JSON.
   - Centralize error mapping:
     - `KnowledgeConfigError` → `500`
     - `QueryTooLongError` → `400 query_too_long`
     - `EmptyQueryError` → `400 empty_query`
     - `KnowledgeNotFoundError` → `404`
3. **Search endpoint**:
   - Parse body with `zod` or hand-rolled validation (match existing
     pattern in repo).
   - `query` is a string; trim; check empty → 400; check length > 2000
     → 400.
   - `limit` default 5; clamp to 20; if clamped, set `warning`.
   - `hybrid` default true.
   - `maxDistance` default from config (0.3).
   - `vaultId` optional; pass through.
   - Return response shape verbatim from §5.2.
4. **Vault DELETE**:
   - Default: unregister vault only (leave documents indexed).
   - `?cascade=true`: also delete all documents + chunks + FTS + vec
     for that vault.
5. **Register** the routes in the main router. Ensure the registration
   is before any proxy catch-all.
6. **Test** with `supertest`:
   - One test per endpoint, happy path.
   - One test per documented error code.
   - One test for search with query > 2000 chars → 400.
   - One test for search with limit > 20 → warning field present.

## Hard rules

- Routes are **thin** — no business logic, only request/response
  mapping.
- Register before proxy catch-all (AGENTS.md).
- Response shapes match §5 of the architecture doc exactly — clients
  and the Agent tool both consume these.
- Error codes match §10.2 of the architecture doc.

## Suggested commit message

```
feat(knowledge): HTTP routes for /api/knowledge/*

- Management endpoints (vaults, documents, reindex).
- Search endpoint with query-length cap, limit clamp warning,
  totalCandidatesBeforeFilter response field.
- Thin route handlers; business logic in knowledge.service.ts.
- Routes registered before proxy catch-all per AGENTS.md.

Refs: docs/knowledge-architecture.md §5, §10.2
Refs: docs/knowledge/specs/task-07-routes.md
```

## Out of scope

- Client-side UI (Task 8).
- Auth middleware — reuse the existing session cookie + CSRF.

## References

- Architecture doc §5 (API surface)
- Architecture doc §10.2 (failure matrix)
- Integration guide Task 7
