# Task 2 — File watcher (chokidar)

> Status: unblocked once Task 1 lands.

## Summary

Add a chokidar-based watcher that emits file events (`add`, `change`,
`unlink`) per vault without reading file contents. The watcher is the
trigger for the ingest pipeline — it never does extraction itself.

## Dependencies

- Task 1 (schema + shared connection).
- **Add `chokidar` as a direct dependency** in `package.json` — it is
  currently only a transitive dep (audit P1-4).

## Files

### Create

- `packages/server/src/services/knowledge/watcher.ts`
- `tests/server/knowledge-watcher.test.ts`

### Modify

- Root `package.json` — add `chokidar` to `dependencies` (not
  `devDependencies`; it runs in production).

## Acceptance criteria

1. Registering a vault starts chokidar on its `root_path` with
   `awaitWriteFinish: { stabilityThreshold: 2000 }` (debounce, arch
   doc §4.1).
2. Adding a file emits `ingest:add` via the service's EventEmitter;
   modifying emits `ingest:change`; removing emits `ingest:remove`.
3. Dropping 10 files in 1 second produces one batch of 10 events,
   not 10 single events (debounce works).
4. The watcher stops cleanly when the server closes — no leaked file
   handles, no pending watchers.
5. Unplugging a USB (root_path disappears) triggers a `vault:offline`
   event and marks the vault `watch=0` in the DB.

## Implementation steps

1. **Install chokidar** as a direct dependency:
   ```bash
   npm install chokidar --save
   ```
2. **Create** `watcher.ts` with:
   - `KnowledgeWatcher` class per vault, taking `(vaultId, rootPath,
     eventEmitter)`.
   - Internal chokidar instance with:
     - `ignored: /(^|[\/\\])\../` (ignore dotfiles).
     - `persistent: true`.
     - `ignoreInitial: true` (only watch new events, not existing files
       on boot — initial scan belongs in the bootstrap path, Task 6).
     - `awaitWriteFinish: { stabilityThreshold: <config> }`.
   - Methods: `start()`, `stop()`.
   - On `add`/`change`/`unlink`: emit namespaced events.
   - On chokidar `error`: retry 3x; if all fail, emit `vault:offline`.
3. **Create** `KnowledgeWatcherManager` that holds a map of
   `vaultId → KnowledgeWatcher`, with `addVault()` /
   `removeVault()` / `stopAll()`.
4. **Create** `knowledge-watcher.test.ts`:
   - Use real temp dirs (`fs.mkdtemp`), never memfs.
   - Use `usePolling: true` in tests (chokidar's native backends are
     incompatible with most fakes).
   - Assert: 10 rapid file writes → 1 batch of 10 events, not 10
     separate fires.
   - Assert: `stop()` releases the watcher.

## Hard rules

- **The watcher never reads file contents.** Reading is the
  extractor's job (Task 3). This separation lets the watcher be
  tested with zero IO.
- Add `chokidar` as a direct dependency — it is currently only a
  transitive dep (audit P1-4).
- Watcher tests use `usePolling: true` against real temp dirs; never
  memfs (audit P2-4).
- Debounce lives in chokidar's `awaitWriteFinish`, not in a manual
  setTimeout.

## Suggested commit message

```
feat(knowledge): file watcher for vault ingestion triggers

- Add chokidar as a direct dependency (audit P1-4).
- Add KnowledgeWatcherManager with per-vault chokidar instances.
- Debounce via awaitWriteFinish (2s default).
- Emit ingest:add/change/remove events; mark vault watch=0 on offline.
- Tests against real temp dirs with usePolling: true (audit P2-4).

Refs: docs/knowledge-architecture.md §4.1
Refs: docs/knowledge/specs/task-02-watcher.md
```

## Out of scope

- Reading file contents (Task 3).
- Queueing / batching against the SQLite writer (Task 6).
- Vault persistence (Task 6).

## References

- Architecture doc §4.1 (watcher)
- Architecture doc §10.3 (bounded queue — watcher enforces via
  chokidar pause/resume when queue is full)
- Integration guide Task 2
