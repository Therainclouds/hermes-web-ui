/**
 * Knowledge plugin — DDL bootstrap for the shared SQLite connection.
 *
 * This file owns the schema definitions for the knowledge plugin. The
 * plugin shares the `hermes-web-ui.db` connection exposed by `getDb()`;
 * it never opens a second one (per AGENTS.md rule).
 *
 * `ensureKnowledgeSchema(db, dim)` is called once at service init.
 * It is additive: every CREATE statement uses IF NOT EXISTS, so re-running
 * it on an already-bootstrapped database is a no-op.
 *
 * Hard invariants (audit fixes, see architecture doc §11):
 *   - Per-connection PRAGMAs (foreign_keys, busy_timeout) are enforced
 *     on every boot (P0-2).
 *   - Journal-mode != 'wal' emits a warning (P0-2 dev caveat).
 *   - `knowledge_chunks_vec` is created with `distance=cosine` —
 *     without it, vec0's default metric is L2, and hybrid / pure-vector
 *     searches return incomparable scores (S1).
 *   - `dim` is baked in at table creation. Re-running with a different
 *     dim against an existing table throws KnowledgeSchemaError (P1-7).
 *   - FTS5 and vec0 are virtual tables — they cannot participate in
 *     FK cascades. Worker code must explicitly delete from both in
 *     the same transaction as `knowledge_chunks` (P0-1).
 */

import type { DatabaseSync } from 'node:sqlite'

export class KnowledgeSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeSchemaError'
  }
}

/**
 * Default embedding dimension for Tongyi text-embedding-v3.
 * Must match the model in use; changing it after the vec0 table
 * is created requires re-indexing the entire corpus (architecture
 * doc §3.4, audit fix P1-7).
 *
 * v3 verified dims: 1024 / 768 / 512 / 256 / 128 / 64.
 * 1536 is a v2-only dim — do NOT set it here.
 */
export const DEFAULT_KNOWLEDGE_EMBED_DIM = 1024

/**
 * Result of bootstrapping the knowledge plugin schema. Tells the caller
 * whether vec0 (and hence vector search) is available — if not, FTS5
 * keyword search still works and the rest of the plugin keeps operating.
 */
export interface KnowledgeSchemaBootstrapStatus {
  /** true iff sqlite-vec is installed AND vec0 table is usable. */
  vecAvailable: boolean
  /** Populated when vecAvailable is false — explains why. */
  vecReason?: string
}

/**
 * Idempotently bootstrap every table the knowledge plugin needs on
 * the shared connection. Returns a status object describing whether
 * sqlite-vec (vector search) was successfully loaded. Throws
 * KnowledgeSchemaError only on unrecoverable inconsistencies (e.g.,
 * embed-dim mismatch against an already-created vec0 table).
 *
 * Graceful-degradation path: if sqlite-vec is not installed (e.g.,
 * on a Docker image where it was moved to optionalDependencies and
 * failed to install), the base tables (vaults/documents/chunks/fts)
 * are still created, but knowledge_chunks_vec is skipped. The caller
 * (KnowledgeService) must check vecAvailable and refuse search /
 * ingest tasks that depend on vec0.
 *
 * Root-cause fix (2026-09-10): loadSqliteVec now returns a status
 * instead of throwing, and is idempotent (skips if vec0 table is
 * already present — avoids double-loading the extension).
 */
export function ensureKnowledgeSchema(
  db: DatabaseSync,
  dim: number = DEFAULT_KNOWLEDGE_EMBED_DIM
): KnowledgeSchemaBootstrapStatus {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new KnowledgeSchemaError(`Invalid embed dim: ${dim}`)
  }

  // --- Per-connection PRAGMAs (audit fix P0-2). ---
  db.exec('PRAGMA foreign_keys=ON')
  db.exec('PRAGMA busy_timeout=5000')

  // --- Journal-mode assertion (P0-2 dev caveat). ---
  const jm = db.prepare('PRAGMA journal_mode').all() as Array<{
    journal_mode: string
  }>
  const mode = jm[0]?.journal_mode
  if (mode !== 'wal') {
    // eslint-disable-next-line no-console
    console.warn(
      `[knowledge] journal_mode=${mode}; WAL is required for concurrent reads. ` +
        `Consider switching dev to WAL (audit fix P0-2).`
    )
  }

  // --- sqlite-vec extension (lazy, idempotent, graceful degradation). ---
  const vecStatus = loadSqliteVec(db)

  // --- Idempotent DDL. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_vaults (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path  TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      watch      INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path  TEXT NOT NULL,
      source_hash  TEXT NOT NULL,
      vault_id     INTEGER NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      mtime        INTEGER NOT NULL,
      indexed_at   INTEGER NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      FOREIGN KEY (vault_id) REFERENCES knowledge_vaults(id)
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_documents_source_hash ' +
      'ON knowledge_documents(source_hash)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_documents_vault_status ' +
      'ON knowledge_documents(vault_id, status)'
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id  INTEGER NOT NULL,
      position     INTEGER NOT NULL,
      content      TEXT NOT NULL,
      token_count  INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS knowledge_chunks_document ' +
      'ON knowledge_chunks(document_id)'
  )

  // FTS5 virtual table — shadow of knowledge_chunks.content.
  // The worker MUST insert with an explicit rowid equal to chunk.id
  // so the join in hybrid search remains correct (audit fix P1-3).
  // Virtual tables cannot participate in foreign keys (P0-1).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
    USING fts5(content, tokenize='porter')
  `)

  // vec0 virtual table with cosine distance — only created when
  // sqlite-vec was successfully loaded. The dim is baked in at
  // creation time; switching dims requires re-creating the table
  // plus a full re-embed (P1-7). Without distance=cosine, the vec0
  // default is L2 and the hybrid / pure-vector scores disagree (S1).
  if (vecStatus.available) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_vec
      USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}] distance=cosine)
    `)

    // --- Dim-mismatch check (P1-7). ---
    assertVecDim(db, dim)
  }

  return { vecAvailable: vecStatus.available, vecReason: vecStatus.reason }
}

/**
 * Load sqlite-vec into the shared database connection.
 *
 * Idempotent: skips if knowledge_chunks_vec already exists (the
 * extension must have been loaded on a prior boot, per root-cause
 * fix 2026-09-10).
 *
 * Graceful degradation: if the sqlite-vec package is not installed,
 * returns `{ available: false, reason: ... }` rather than throwing.
 * This lets the rest of the plugin (vaults, documents, FTS5 keyword
 * search) continue working on Docker / source-deploy targets where
 * vec0 failed to install.
 *
 * Loading gate: opens enableLoadExtension(true) momentarily and
 * closes it after loadExtension, keeping the window during which
 * arbitrary native extensions can be loaded as narrow as possible
 * (root-cause fix 2026-09-10).
 */
interface SqliteVecLoadResult {
  available: boolean
  reason?: string
}

function loadSqliteVec(db: DatabaseSync): SqliteVecLoadResult {
  // Idempotent: if the vec0 virtual table already exists, the
  // extension must have been loaded on a prior boot. Skip.
  const existing = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_vec'"
    )
    .all() as Array<{ name: string | null }>
  if (existing.length > 0) {
    return { available: true }
  }

  let sqliteVec: { getLoadablePath: () => string }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteVec = require('sqlite-vec')
  } catch (err) {
    return {
      available: false,
      reason: `sqlite-vec package is not installed (${(err as Error).message}). ` +
        'Vector search and ingest will be disabled; FTS5 keyword search still works. ' +
        'Install: npm install sqlite-vec',
    }
  }

  try {
    db.enableLoadExtension(true)
    try {
      db.loadExtension(sqliteVec.getLoadablePath())
    } finally {
      db.enableLoadExtension(false)
    }
    return { available: true }
  } catch (err) {
    return {
      available: false,
      reason: `loadExtension failed: ${(err as Error).message}. ` +
        'Vector search and ingest will be disabled; FTS5 keyword search still works.',
    }
  }
}

function assertVecDim(db: DatabaseSync, expectedDim: number): void {
  // vec0 virtual tables don't expose their columns via PRAGMA
  // table_info, so we parse the CREATE VIRTUAL TABLE statement
  // stored in sqlite_master. This is stable across sqlite-vec
  // versions because FLOAT[<dim>] is part of the documented syntax.
  const master = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_vec'"
    )
    .all() as Array<{ sql: string | null }>
  if (!master[0]?.sql) return // table doesn't exist yet (shouldn't happen here)
  const match = master[0].sql.match(/FLOAT\[(\d+)\]/)
  if (!match) return
  const actualDim = Number(match[1])
  if (actualDim !== expectedDim) {
    throw new KnowledgeSchemaError(
      `knowledge_chunks_vec already exists with dim=${actualDim}; ` +
        `refusing to bootstrap with dim=${expectedDim}. ` +
        `Switching dims requires re-indexing the entire corpus ` +
        `(architecture doc §3.4, audit fix P1-7).`
    )
  }
}
