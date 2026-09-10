/**
 * Knowledge plugin schema bootstrap.
 *
 * Defines the DDL for all knowledge-plugin tables and a single entry
 * point (`ensureKnowledgeSchema`) that the server calls once per boot.
 * Idempotent — safe to run on every startup.
 *
 * Tables created:
 *   - knowledge_vaults       (one row per watched directory)
 *   - knowledge_documents    (one row per ingested file)
 *   - knowledge_chunks       (one row per text chunk)
 *   - knowledge_chunks_fts   (FTS5 virtual table, porter tokenizer)
 *   - knowledge_chunks_vec   (vec0 virtual table, cosine distance)
 *
 * Source of truth: docs/knowledge-architecture.md §3.
 * Implementation spec: docs/knowledge/specs/task-01-schema.md.
 */

import { DatabaseSync } from 'node:sqlite'

export class KnowledgeSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeSchemaError'
  }
}

let cachedSqliteVecLoadablePath: string | null = null

async function resolveSqliteVecLoadablePath(): Promise<string> {
  if (cachedSqliteVecLoadablePath) return cachedSqliteVecLoadablePath
  // sqlite-vec is a shim; the real DLL lives in sqlite-vec-<platform>-<arch>.
  // `npm install` must have installed both the shim and the platform peer.
  // Using dynamic import() so this file stays ESM-compatible under vitest
  // (where require() is undefined after Vite's transform).
  const shim = (await import('sqlite-vec')) as {
    getLoadablePath: () => string
  }
  cachedSqliteVecLoadablePath = shim.getLoadablePath()
  return cachedSqliteVecLoadablePath
}

/**
 * Read the embedding dim baked into an existing `knowledge_chunks_vec`
 * table, or null if the table does not exist. Used by the orchestrator
 * (Task 6) to reject a mismatched `KNOWLEDGE_EMBED_DIM` at boot.
 *
 * Parses the CREATE TABLE SQL stored in sqlite_master and extracts the
 * first `FLOAT[<N>]` column definition. vec0 does not expose its schema
 * via PRAGMA table_info in a useful way.
 */
export function readExistingVecDim(db: DatabaseSync): number | null {
  const rows = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_vec'`,
    )
    .all() as Array<{ sql: string | null }>
  if (rows.length === 0 || !rows[0].sql) return null
  const match = /FLOAT\[\s*(\d+)\s*\]/i.exec(rows[0].sql)
  return match ? Number(match[1]) : null
}

/**
 * Ensure all knowledge-plugin tables exist on the shared connection.
 *
 * Side effects:
 *   - Loads the `sqlite-vec` extension on the shared connection. The
 *     extension is pinned by the `sqlite-vec` npm package; only this
 *     extension is ever loaded (§6.4 security note).
 *   - Enforces per-connection PRAGMAs (`foreign_keys=ON`,
 *     `busy_timeout=5000`) per §6.4 audit P0-2.
 *   - Logs a warning when `journal_mode != wal` (dev-mode caveat).
 *   - Creates tables idempotently via `CREATE … IF NOT EXISTS`.
 *
 * Throws `KnowledgeSchemaError` if:
 *   - `sqlite-vec` is not installed.
 *   - A pre-existing `knowledge_chunks_vec` table has a different dim
 *     than `embedDim` (audit P1-7 — switching dims requires explicit
 *     re-index, not a silent schema change).
 */
export async function ensureKnowledgeSchema(
  db: DatabaseSync,
  embedDim: number,
): Promise<void> {
  if (!Number.isInteger(embedDim) || embedDim <= 0) {
    throw new KnowledgeSchemaError(
      `embedDim must be a positive integer, got ${embedDim}`,
    )
  }

  // 1. Load the sqlite-vec extension on the shared connection.
  let loadablePath: string
  try {
    loadablePath = await resolveSqliteVecLoadablePath()
  } catch (err) {
    throw new KnowledgeSchemaError(
      `sqlite-vec is not installed: ${(err as Error).message}`,
    )
  }
  try {
    db.loadExtension(loadablePath)
  } catch (err) {
    // loadExtension is idempotent across repeated calls, but surfaces
    // errors the first time if the DLL is missing. Fail loudly — a
    // half-initialized schema is worse than none.
    throw new KnowledgeSchemaError(
      `failed to load sqlite-vec extension: ${(err as Error).message}`,
    )
  }

  // 2. Per-connection PRAGMAs (architect doc §6.4, audit P0-2).
  db.exec('PRAGMA foreign_keys=ON')
  db.exec('PRAGMA busy_timeout=5000')

  // 3. Warn when journal_mode is not WAL (dev-mode caveat).
  const modeRows = db
    .prepare('PRAGMA journal_mode')
    .all() as Array<{ journal_mode: string }>
  const journalMode = modeRows[0]?.journal_mode
  if (journalMode !== 'wal') {
    // console.warn is acceptable here: the operator wants to see this
    // on dev boots, and the noise is the point.
    // eslint-disable-next-line no-console
    console.warn(
      `knowledge: journal_mode=${journalMode ?? 'unknown'}; WAL is ` +
        `recommended for concurrent reads. See §6.4 / §10.3.`,
    )
  }

  // 4. Create tables.

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
    `CREATE INDEX IF NOT EXISTS knowledge_documents_source_hash
       ON knowledge_documents(source_hash)`,
  )
  db.exec(
    `CREATE INDEX IF NOT EXISTS knowledge_documents_vault_status
       ON knowledge_documents(vault_id, status)`,
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id  INTEGER NOT NULL,
      position     INTEGER NOT NULL,
      content      TEXT NOT NULL,
      token_count  INTEGER NOT NULL,
      FOREIGN KEY (document_id)
        REFERENCES knowledge_documents(id) ON DELETE CASCADE
    )
  `)
  db.exec(
    `CREATE INDEX IF NOT EXISTS knowledge_chunks_document
       ON knowledge_chunks(document_id)`,
  )

  // FTS5 virtual table — porter tokenizer (English-stemmed; Chinese
  // keyword match degrades to character-exact in v1 per §7.5).
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
       USING fts5(content, tokenize='porter')`,
  )

  // vec0 virtual table. Dimension is baked in at creation time; the
  // distance metric MUST be cosine so the hybrid and pure-vector
  // paths return comparable scores (§3.4, second-pass audit S1).
  const existingDim = readExistingVecDim(db)
  if (existingDim === null) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_chunks_vec USING vec0(
        chunk_id  INTEGER PRIMARY KEY,
        embedding FLOAT[${embedDim}] distance=cosine
      )
    `)
  } else if (existingDim !== embedDim) {
    throw new KnowledgeSchemaError(
      `knowledge_chunks_vec was created with dim=${existingDim} but ` +
        `KNOWLEDGE_EMBED_DIM=${embedDim}. Switching dims requires an ` +
        `explicit re-index (create new vec table → full re-embed → ` +
        `atomic swap → drop old). See §3.4 / §10.1.`,
    )
  }
  // else: matching dim, no-op.
}
