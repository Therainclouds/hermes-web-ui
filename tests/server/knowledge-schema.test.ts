/**
 * Regression test for the knowledge plugin schema bootstrap.
 *
 * Covers:
 *   - All five tables are created with the documented shape
 *     (§3 / spec task-01-schema.md).
 *   - Idempotency: calling ensureKnowledgeSchema twice does not
 *     raise or change state.
 *   - FTS5 rowid coupling: chunk id and FTS rowid stay in lockstep
 *     (audit P1-3).
 *   - vec0 cosine distance: table declares distance=cosine so the
 *     MATCH operator returns cosine distances, not L2 (audit S1).
 *   - Dim mismatch: a second call with a different embedDim throws
 *     KnowledgeSchemaError instead of silently reshaping the table
 *     (audit P1-7).
 *
 * The test runs against an in-memory SQLite instance — no files on
 * disk, no cross-test leakage.
 */

import { describe, expect, it } from 'vitest'

type DatabaseSyncCtor = new (
  path: string,
  options?: Record<string, unknown>,
) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    run: (...params: unknown[]) => unknown
    get: (...params: unknown[]) => unknown
  }
  close: () => void
  loadExtension: (path: string) => void
  enableLoadExtension: (value: boolean) => void
}

const NODE_UNAVAILABLE = 'node:sqlite is not available in this Node version'
const SQLITE_VEC_UNAVAILABLE =
  'sqlite-vec is not installed — skip with `npm install sqlite-vec sqlite-<platform>-<arch>`'

let DatabaseSync: DatabaseSyncCtor
try {
  const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
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

const canRun = DatabaseSync !== null && tryLoadSqliteVec() !== null

describe.skipIf(!canRun)('knowledge schema bootstrap', () => {
  function newMemoryDb() {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    db.enableLoadExtension(true)
    const loadablePath = tryLoadSqliteVec()
    if (!loadablePath) throw new Error(SQLITE_VEC_UNAVAILABLE)
    db.loadExtension(loadablePath)
    return db
  }

  it('creates all five knowledge tables idempotently', async () => {
    const { ensureKnowledgeSchema } = await import(
      '../../packages/server/src/db/knowledge-schema'
    )
    const db = newMemoryDb()
    try {
      await ensureKnowledgeSchema(db, 1024)

      // FTS5 and vec0 create shadow internal tables
      // (knowledge_chunks_fts_content, knowledge_chunks_vec_chunks, etc.).
      // Assert the five primary tables are present; the shadow tables are
      // an implementation detail we don't want to pin.
      const tables = new Set(
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%'`,
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      )

      const expectedPrimary = [
        'knowledge_chunks',
        'knowledge_chunks_fts',
        'knowledge_chunks_vec',
        'knowledge_documents',
        'knowledge_vaults',
      ]
      for (const name of expectedPrimary) {
        expect(tables).toContain(name)
      }

      // Idempotency: a second call with the same dim must not throw.
      await expect(ensureKnowledgeSchema(db, 1024)).resolves.toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('enforces per-connection PRAGMAs (foreign_keys, busy_timeout)', async () => {
    const { ensureKnowledgeSchema } = await import(
      '../../packages/server/src/db/knowledge-schema'
    )
    const db = newMemoryDb()
    try {
      await ensureKnowledgeSchema(db, 1024)

      const fk = db.prepare('PRAGMA foreign_keys').get() as {
        foreign_keys: number
      }
      expect(fk.foreign_keys).toBe(1)

      const bt = db.prepare('PRAGMA busy_timeout').get() as {
        timeout: number
      }
      expect(bt.timeout).toBe(5000)
    } finally {
      db.close()
    }
  })

  it('FTS5 rowid coupling: explicit chunk id equals FTS rowid (audit P1-3)', async () => {
    const { ensureKnowledgeSchema } = await import(
      '../../packages/server/src/db/knowledge-schema'
    )
    const db = newMemoryDb()
    try {
      await ensureKnowledgeSchema(db, 1024)

      // Insert a chunk with a specific id, then insert into FTS with
      // the SAME rowid. The worker (Task 6) is responsible for
      // keeping these in sync; this test asserts the schema supports
      // that contract. First insert a vault + document so the FK on
      // knowledge_chunks(document_id) is satisfied.
      db.prepare(
        `INSERT INTO knowledge_vaults (id, root_path, name, watch, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(1, '/tmp/vault', 'test-vault', 1, Date.now())
      db.prepare(
        `INSERT INTO knowledge_documents (id, source_path, source_hash, vault_id, mime_type, size_bytes, mtime, indexed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(1, '/tmp/vault/doc.md', 'hash1', 1, 'text/markdown', 100, Date.now(), Date.now(), 'indexed')
      db.prepare(
        `INSERT INTO knowledge_chunks (id, document_id, position, content, token_count)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(42, 1, 0, 'transformer attention mechanism', 4)
      db.prepare(
        `INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (?, ?)`,
      ).run(42, 'transformer attention mechanism')

      const ftsRows = db
        .prepare(
          `SELECT rowid FROM knowledge_chunks_fts
           WHERE knowledge_chunks_fts MATCH 'transformer'`,
        )
        .all() as Array<{ rowid: number }>
      expect(ftsRows).toHaveLength(1)
      expect(ftsRows[0].rowid).toBe(42)

      // The join across FTS5 and chunks via shared rowid works —
      // this is the hybrid-search building block. FTS5 virtual tables
      // must be referenced by their real name in the MATCH clause,
      // so we alias only the chunks table and use the full FTS name.
      const joined = db
        .prepare(
          `SELECT c.content, knowledge_chunks_fts.rowid AS fts_rowid
           FROM knowledge_chunks c
           JOIN knowledge_chunks_fts ON c.id = knowledge_chunks_fts.rowid
           WHERE knowledge_chunks_fts MATCH 'transformer'`,
        )
        .all() as Array<{ content: string; fts_rowid: number }>
      expect(joined).toHaveLength(1)
      expect(joined[0].fts_rowid).toBe(42)
      expect(joined[0].content).toBe('transformer attention mechanism')
    } finally {
      db.close()
    }
  })

  it('vec0 declares cosine distance: MATCH returns cosine, not L2', async () => {
    const { ensureKnowledgeSchema } = await import(
      '../../packages/server/src/db/knowledge-schema'
    )
    const db = newMemoryDb()
    try {
      await ensureKnowledgeSchema(db, 4) // small dim for test vectors

      db.exec(
        `INSERT INTO knowledge_chunks_vec (chunk_id, embedding) VALUES
           (10, '[1.0, 0.0, 0.0, 0.0]'),
           (20, '[0.0, 1.0, 0.0, 0.0]'),
           (30, '[0.7071, 0.7071, 0.0, 0.0]')`,
      )

      const rows = db
        .prepare(
          `SELECT chunk_id, distance
           FROM knowledge_chunks_vec
           WHERE embedding MATCH ? AND k = 3`,
        )
        .all(new Float32Array([0.9, 0.1, 0.0, 0.0])) as Array<{
        chunk_id: number
        distance: number
      }>

      expect(rows.map((r) => r.chunk_id)).toEqual([10, 30, 20])
      // Cosine distance between [1,0,0,0] and [0.9,0.1,0,0] is ~0.006.
      // L2 would be ~0.141. Assert the metric is cosine.
      expect(rows[0].distance).toBeLessThan(0.01)
    } finally {
      db.close()
    }
  })

  it('dim mismatch throws KnowledgeSchemaError (audit P1-7)', async () => {
    const {
      ensureKnowledgeSchema,
      KnowledgeSchemaError,
    } = await import('../../packages/server/src/db/knowledge-schema')
    const db = newMemoryDb()
    try {
      await ensureKnowledgeSchema(db, 1024)
      // Second call with a DIFFERENT dim must throw, not silently reshape.
      await expect(ensureKnowledgeSchema(db, 768)).rejects.toThrow(
        KnowledgeSchemaError,
      )
    } finally {
      db.close()
    }
  })

  it('readExistingVecDim returns null before creation, dim after', async () => {
    const {
      readExistingVecDim,
      ensureKnowledgeSchema,
    } = await import('../../packages/server/src/db/knowledge-schema')
    const db = newMemoryDb()
    try {
      expect(readExistingVecDim(db)).toBeNull()
      await ensureKnowledgeSchema(db, 1024)
      expect(readExistingVecDim(db)).toBe(1024)
    } finally {
      db.close()
    }
  })
})

describe.skipIf(canRun)('knowledge schema bootstrap — prerequisites missing', () => {
  it.skipIf(DatabaseSync !== null)(
    'reports when node:sqlite is unavailable',
    () => {
      expect(NODE_UNAVAILABLE).toContain('node:sqlite')
    },
  )
  it.skipIf(DatabaseSync === null || tryLoadSqliteVec() !== null)(
    'reports when sqlite-vec is not installed',
    () => {
      expect(SQLITE_VEC_UNAVAILABLE).toContain('sqlite-vec')
    },
  )
})
