/**
 * Smoke test for the sqlite-vec extension running on the node:sqlite built-in
 * driver that hermes-web-ui actually uses in production.
 *
 * Why this test exists
 * --------------------
 * The knowledge plugin is about to rely on three SQLite subsystems living in
 * one database file:
 *   - the regular tables (documents, chunks, metadata),
 *   - an FTS5 virtual table for keyword search,
 *   - a vec0 virtual table for semantic / ANN search.
 * The entire value of picking sqlite-vec over qdrant / chroma / LanceDB is
 * that all three share a single WAL, a single process, and a single backup
 * file. If any of those subsystems stops loading on a target platform
 * (Windows DLL missing, Node version drift, sqlite-vec API change), the
 * whole knowledge feature silently breaks.
 *
 * Historical pitfall captured here
 * --------------------------------
 * `node:sqlite` requires `{ allowExtension: true }` in the constructor;
 * calling `enableLoadExtension(true)` afterwards is too late and throws.
 * Also the `sqlite-vec` npm package is a shim — the real DLL lives in
 * `sqlite-vec-windows-x64` / `sqlite-vec-linux-x64` / etc. — so missing the
 * platform peer package is the classic reason for "找不到指定的模块".
 *
 * Behavior
 * --------
 *   - If `sqlite-vec` is not installed (e.g. a clean workspace that hasn't
 *     added the dependency yet), the whole describe block is skipped with a
 *     clear reason. Nothing in CI breaks.
 *   - If installed, every capability the knowledge plugin depends on is
 *     exercised: extension load, vec0 table, k-NN, FTS5, and a join across
 *     the two indexes in one query.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type DatabaseSyncCtor = new (path: string, options?: Record<string, unknown>) => {
  exec: (sql: string) => void
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => unknown }
  close: () => void
  loadExtension: (path: string) => void
  enableLoadExtension: (value: boolean) => void
}

const NODE_SQLITE_UNAVAILABLE = 'node:sqlite is not available in this Node version'
const SQLITE_VEC_UNAVAILABLE = 'sqlite-vec is not installed — skip with `npm install sqlite-vec sqlite-<platform>-<arch>`'

let DatabaseSync: DatabaseSyncCtor
try {
  const mod: { DatabaseSync: DatabaseSyncCtor } = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
  DatabaseSync = mod.DatabaseSync
} catch {
  DatabaseSync = null as unknown as DatabaseSyncCtor
}

function tryLoadSqliteVec(): string | null {
  try {
    const shim = require('sqlite-vec') as { getLoadablePath: () => string }
    return shim.getLoadablePath()
  } catch {
    return null
  }
}

let db: InstanceType<DatabaseSyncCtor> | null = null
let tempDir: string | null = null

const canRun = DatabaseSync !== null && tryLoadSqliteVec() !== null

describe.skipIf(!canRun)('sqlite-vec integration smoke test', () => {
  beforeEach(() => {
    if (!DatabaseSync) return
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-sqlite-vec-'))
    const dbPath = join(tempDir, 'knowledge-test.db')
    db = new DatabaseSync(dbPath, { allowExtension: true })
    db.enableLoadExtension(true)
    const loadablePath = tryLoadSqliteVec()
    if (!loadablePath) throw new Error(SQLITE_VEC_UNAVAILABLE)
    db.loadExtension(loadablePath)
  })

  afterEach(() => {
    try { db?.close() } catch { /* best-effort */ }
    db = null
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('can load sqlite-vec and create a vec0 virtual table', () => {
    expect(db).not.toBeNull()
    db!.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])')
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (1, '[1.0, 0.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (2, '[0.0, 1.0, 0.0, 0.0]')")
    const rows = db!.prepare('SELECT count(*) AS n FROM v').all() as Array<{ n: number }>
    expect(rows[0].n).toBe(2)
  })

  it('k-NN cosine query returns nearest vectors in the correct order', () => {
    db!.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])')
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (1, '[1.0, 0.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (2, '[0.0, 1.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (3, '[0.7071, 0.7071, 0.0, 0.0]')")
    const rows = db!.prepare(
      'SELECT rowid, vec_distance_cosine(embedding, ?) AS d FROM v ORDER BY d LIMIT 3'
    ).all(new Float32Array([0.9, 0.1, 0.0, 0.0])) as Array<{ rowid: number; d: number }>

    // [0.9, 0.1] is closest to [1,0,0] (rowid=1), then [0.7071,0.7071] (rowid=3),
    // then [0,1,0] (rowid=2).
    expect(rows.map(r => r.rowid)).toEqual([1, 3, 2])
    expect(rows[0].d).toBeLessThan(rows[1].d)
    expect(rows[1].d).toBeLessThan(rows[2].d)
  })

  it('can build an FTS5 index and run keyword search', () => {
    // FTS5 without an explicit tokenizer does exact-token matching — no
    // stemming. The knowledge plugin will want the `porter` tokenizer for
    // real documents, but this smoke test only asserts the baseline works.
    db!.exec("CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize='porter')")
    db!.exec("INSERT INTO t VALUES ('transformer paper', 'Attention is all you need')")
    db!.exec("INSERT INTO t VALUES ('resnet paper', 'Deep residual learning')")
    db!.exec("INSERT INTO t VALUES ('bert paper', 'Pre-training of deep bidirectional transformers')")
    const rows = db!.prepare("SELECT rowid, title FROM t WHERE t MATCH 'transformer'").all() as Array<{ rowid: number; title: string }>
    expect(rows.map(r => r.title).sort()).toEqual(['bert paper', 'transformer paper'])
  })

  it('can join FTS5 + vec0 via shared rowid in a single query', () => {
    db!.exec('CREATE VIRTUAL TABLE t USING fts5(title, body)')
    db!.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])')
    db!.exec("INSERT INTO t(rowid, title, body) VALUES (1, 'transformer paper', 'Attention is all you need')")
    db!.exec("INSERT INTO t(rowid, title, body) VALUES (2, 'resnet paper', 'Deep residual learning')")
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (1, '[1.0, 0.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(rowid, embedding) VALUES (2, '[0.0, 1.0, 0.0, 0.0]')")
    // Hybrid query: keyword match first, then rank by semantic distance.
    const rows = db!.prepare(`
      SELECT t.title, vec_distance_cosine(v.embedding, ?) AS d
      FROM t JOIN v ON t.rowid = v.rowid
      WHERE t MATCH 'transformer OR resnet'
      ORDER BY d
    `).all(new Float32Array([0.8, 0.2, 0.0, 0.0])) as Array<{ title: string; d: number }>
    expect(rows.length).toBe(2)
    // transformer paper (1,0,0) is closer to (0.8,0.2) than resnet (0,1,0)
    expect(rows[0].title).toBe('transformer paper')
    expect(rows[0].d).toBeLessThan(rows[1].d)
  })

  it('named primary key + distance=cosine: MATCH KNN returns cosine distance', () => {
    // Second-pass audit locked behavior: the production schema uses
    // `chunk_id INTEGER PRIMARY KEY` + `distance=cosine` on the
    // embedding column. Without the distance option, MATCH returns L2
    // (the vec0 default), which breaks score parity with hybrid mode.
    db!.exec('CREATE VIRTUAL TABLE v USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[4] distance=cosine)')
    db!.exec("INSERT INTO v(chunk_id, embedding) VALUES (10, '[1.0, 0.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(chunk_id, embedding) VALUES (20, '[0.0, 1.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(chunk_id, embedding) VALUES (30, '[0.7071, 0.7071, 0.0, 0.0]')")
    const rows = db!.prepare(
      'SELECT chunk_id, distance FROM v WHERE embedding MATCH ? AND k = 3'
    ).all(new Float32Array([0.9, 0.1, 0.0, 0.0])) as Array<{ chunk_id: number; distance: number }>
    // Nearest: [1,0,0,0] (row 10), then [0.7071,0.7071,0,0] (row 30),
    // then [0,1,0,0] (row 20). Cosine distances, NOT L2.
    expect(rows.map(r => r.chunk_id)).toEqual([10, 30, 20])
    // Cosine distance ~0.006 between [1,0,0,0] and [0.9,0.1,0,0].
    // L2 would give ~0.1414. Assert the metric is cosine, not L2.
    expect(rows[0].distance).toBeLessThan(0.01)
  })

  it('vec0 distance is NULL on PK-only reads (post-filter must be in app code)', () => {
    // Second-pass audit: joining vec0 by primary key and selecting
    // `distance` returns NULL. Pure-vector queries cannot scope the
    // KNN via an SQL join on knowledge_chunks; they must post-filter.
    db!.exec('CREATE VIRTUAL TABLE v USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[4] distance=cosine)')
    db!.exec("INSERT INTO v(chunk_id, embedding) VALUES (10, '[1.0, 0.0, 0.0, 0.0]')")
    const rows = db!.prepare('SELECT chunk_id, distance FROM v WHERE chunk_id = 10').all() as Array<{ chunk_id: number; distance: unknown }>
    expect(rows.length).toBe(1)
    expect(rows[0].distance).toBeNull()
  })

  it('vec_distance_cosine over a PK join returns cosine (hybrid path)', () => {
    // Second-pass audit: the hybrid query uses vec_distance_cosine()
    // over a PK join of FTS5 candidates. This path works regardless
    // of the table-level distance option and must stay the documented
    // hybrid form.
    db!.exec('CREATE VIRTUAL TABLE v USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[4] distance=cosine)')
    db!.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, doc_id INTEGER)')
    db!.exec("INSERT INTO v(chunk_id, embedding) VALUES (10, '[1.0, 0.0, 0.0, 0.0]')")
    db!.exec("INSERT INTO v(chunk_id, embedding) VALUES (20, '[0.0, 1.0, 0.0, 0.0]')")
    db!.exec('INSERT INTO chunks VALUES (10, 1)')
    db!.exec('INSERT INTO chunks VALUES (20, 1)')
    const rows = db!.prepare(`
      SELECT c.id, vec_distance_cosine(v.embedding, ?) AS d
      FROM chunks c JOIN v ON v.chunk_id = c.id
      WHERE c.doc_id = 1
      ORDER BY d
    `).all(new Float32Array([0.9, 0.1, 0.0, 0.0])) as Array<{ id: number; d: number }>
    expect(rows.length).toBe(2)
    // (1,0,0,0) is cosine-closer to (0.9,0.1,0,0) than (0,1,0,0)
    expect(rows[0].id).toBe(10)
    expect(rows[0].d).toBeLessThan(rows[1].d)
  })

  it('survives a WAL checkpoint and re-open (single-file backup invariant)', () => {
    const dbPath = join(tempDir!, 'reopen.db')
    db!.close()
    const fresh = new DatabaseSync(dbPath, { allowExtension: true })
    fresh.enableLoadExtension(true)
    const loadablePath = tryLoadSqliteVec()!
    fresh.loadExtension(loadablePath)
    fresh.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[2])')
    fresh.exec("INSERT INTO v(rowid, embedding) VALUES (1, '[1.0, 0.0]')")
    fresh.close()

    const reopened = new DatabaseSync(dbPath, { allowExtension: true })
    reopened.enableLoadExtension(true)
    reopened.loadExtension(loadablePath)
    const rows = reopened.prepare('SELECT count(*) AS n FROM v').all() as Array<{ n: number }>
    expect(rows[0].n).toBe(1)
    reopened.close()
  })
})

describe.skipIf(DatabaseSync !== null)('sqlite-vec smoke test — node:sqlite unavailable', () => {
  it('reports the Node requirement when node:sqlite is missing', () => {
    expect(NODE_SQLITE_UNAVAILABLE).toContain('node:sqlite')
  })
})

describe.skipIf(canRun || DatabaseSync === null)('sqlite-vec smoke test — sqlite-vec not installed', () => {
  it('reports the missing dependency with installation hint', () => {
    expect(SQLITE_VEC_UNAVAILABLE).toContain('sqlite-vec')
  })
})
