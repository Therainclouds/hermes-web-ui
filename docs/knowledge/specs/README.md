# Knowledge plugin — implementation specs

> One spec per task. Each spec is self-contained: an agent that has read
> only this file and the architecture doc should be able to execute it
> without re-debating the design.

## Dependency graph

```
          ┌──── T2: watcher ────┐
          ├──── T3: extractor ──┤
  T1 ─────┼──── T4: chunker ────┼──── T6: orchestrator ────┬──── T8: client
          └──── T5: embedder ───┘                          ├──── T9: agent tool
                                                           └──── T10: hardening
                                                                     │
  T7: routes ────────────────────────────────────────────────────────┘
        (depends on T6; T8/T9/T10 can proceed once T7 is wired)
```

Parallel lanes (after T1 and T6 land):

- **Lane A** (T2 + T3 + T4 + T5): extract/chunk/embed pipeline pieces.
- **Lane B** (T7): routes. Blocks client and agent tool.
- **Lane C** (T8 + T9 + T10): UI + agent tool + hardening, mostly
  independent of each other once T7 is up.

## Spec files

| File | Task | Depends on | Est. size |
|---|---|---|---|
| [task-01-schema.md](./task-01-schema.md) | Schema bootstrap + shared-connection change | — | ~120 LOC |
| [task-02-watcher.md](./task-02-watcher.md) | File watcher (chokidar) | T1 | ~250 LOC |
| [task-03-extractor.md](./task-03-extractor.md) | Text extractors (md/txt/pdf/docx) | T1 | ~400 LOC |
| [task-04-chunker.md](./task-04-chunker.md) | Content-aware splitter | T1 | ~250 LOC |
| [task-05-embedder.md](./task-05-embedder.md) | Cloud embedding client (Tongyi) | T1 | ~350 LOC |
| [task-06-orchestrator.md](./task-06-orchestrator.md) | Pipeline + search service | T1–T5 | ~600 LOC |
| [task-07-routes.md](./task-07-routes.md) | `/api/knowledge/*` HTTP routes | T6 | ~300 LOC |
| [task-08-client.md](./task-08-client.md) | Vue3 UI (vault list + doc list + sidebar) | T7 | ~800 LOC |
| [task-09-agent-tool.md](./task-09-agent-tool.md) | Hermes Agent MCP tool binding | T6 + T7 | ~150 LOC |
| [task-10-hardening.md](./task-10-hardening.md) | Health endpoint + socket events + CI gates | T7 | ~200 LOC |

## Source of truth

Architecture doc: `docs/knowledge-architecture.md` (1061 lines, 4-pass audited).

Integration guide: `docs/harness/knowledge-plugin-integration-guide.md`
(308 lines, 4-pass audited).

Smoke test: `tests/release/sqlite-vec-smoke.test.ts` (8 pass / 2 skip).

## Assignment guidelines

- **T1 must land first** — every other spec depends on the schema and
  the shared-connection change.
- **T2–T5 can run in parallel** — each touches a different file set
  and only depends on the schema from T1.
- **T6 waits for T2–T5** — it stitches them together.
- **T7 waits for T6** — routes are a thin layer over the service.
- **T8 + T9 + T10 can run in parallel** after T7 — they each consume
  the service/routes but don't modify each other.
- Each spec has its own `acceptance` block — treat it as the test
  contract. Code is done when every acceptance item passes.

## Cross-cutting rules (apply to every spec)

These are inherited from AGENTS.md and the architecture doc. Read them
before touching any spec:

1. **One SQLite connection only.** Use `getDb()` from
   `packages/server/src/db/index.ts`. Never open a second connection.
2. **`getWebUiHome()` for all state paths.** Never
   `process.env.HERMES_WEB_UI_HOME` directly.
3. **Never rely on FK cascades for virtual tables.** FTS5 and vec0
   must be explicitly deleted in the same transaction as chunks.
4. **Routes before proxy catch-all.** Register all `/api/knowledge/*`
   before any proxy middleware.
5. **Never log API keys or file content.** Paths + hashes only.
6. **Token counts via `js-tiktoken` / `cl100k_base`.** No ad-hoc
   heuristics.
7. **Tests against real temp dirs for chokidar** — never memfs.
8. **No live Tongyi calls in CI** — use recorded HTTP fixtures.
