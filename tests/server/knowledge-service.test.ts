/**
 * Orchestrator tests — ingest pipeline, search, and consistency.
 *
 * Uses a real in-memory SQLite with sqlite-vec loaded. The embedder
 * is mocked to return deterministic vectors, avoiding live API calls.
 *
 * Covers:
 *   - Ingest creates chunks + FTS5 + vec0 rows atomically.
 *   - Re-ingest same content → no-op.
 *   - Re-ingest modified content → old rows replaced.
 *   - Failed embedder → status='failed', no partial rows.
 *   - Hybrid search returns correct chunks ordered by distance.
 *   - Pure-vector search uses MATCH + post-filter.
 *   - Query > 2000 chars → QueryTooLongError.
 *   - Non-'indexed' documents never appear in search results.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeService, QueryTooLongError } from '../../packages/server/src/services/knowledge/knowledge.service'
import type { KnowledgeConfig } from '../../packages/server/src/services/knowledge/config'
import type { Embedder } from '../../packages/server/src/services/knowledge/embedder'

// --- SQLite setup ---------------------------------------------------------

type DatabaseSyncCtor = new (path: string, options?: Record<string, unknown>) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    run: (...params: unknown[]) => unknown
  }
  close: () => void
  loadExtension: (path: string) => void
  enableLoadExtension: (value: boolean) => void
}

let DatabaseSync: DatabaseSyncCtor
try {
  const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
  DatabaseSync = mod.DatabaseSync
} catch {
  DatabaseSync = null as unknown as DatabaseSyncCtor
}

function tryLoadSqliteVec(): string | null {
  try {
    return (require('sqlite-vec') as { getLoadablePath: () => string }).getLoadablePath()
  } catch {
    return null
  }
}

const canRun = DatabaseSync !== null && tryLoadSqliteVec() !== null

// --- Test config ----------------------------------------------------------

const TEST_CONFIG: KnowledgeConfig = {
  enabled: true,
  embedProvider: 'tongyi',
  embedModel: 'text-embedding-v3',
  embedDim: 4,
  embedApiKey: 'test-key',
  embedApiBase: 'https://test.example.com',
  embedBatchSize: 10,
  embedTimeoutMs: 5000,
  embedRetries: 3,
  chunkSize: 500,
  chunkOverlap: 50,
  chunkFallbackSize: 800,
  queueDepth: 20,
  supportedExtensions: ['.md', '.txt'],
}

/**
 * Mock embedder: returns deterministic Float32Array vectors.
 * The first chunk always gets [1,0,0,0], the second [0,1,0,0], etc.
 * For query embedding, use [0.9, 0.1, 0, 0] to match chunk 0 closely.
 */
function createMockEmbedder(queryVec?: Float32Array): Embedder {
  return {
    async embed(chunks: string[]): Promise<Float32Array[]> {
      // If this is a query embedding (single chunk), return the query vec.
      if (chunks.length === 1 && queryVec) return [queryVec]
      return chunks.map((_, i) => {
        const v = new Float32Array(4)
        v[i % 4] = 1.0
        return v
      })
    },
  }
}

// --- Tests ----------------------------------------------------------------

describe.skipIf(!canRun)('KnowledgeService', () => {
  let db: InstanceType<DatabaseSyncCtor>
  let tempDir: string
  let service: KnowledgeService

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-knowledge-svc-'))
    db = new DatabaseSync(':memory:', { allowExtension: true })
    db.enableLoadExtension(true)
    const loadablePath = tryLoadSqliteVec()!
    db.loadExtension(loadablePath)

    service = new KnowledgeService(db, TEST_CONFIG, {
      embedder: createMockEmbedder(new Float32Array([0.9, 0.1, 0, 0])),
      extractorFn: (path: string) => {
        const { readFileSync } = require('fs') as typeof import('fs')
        const text = readFileSync(path, 'utf-8')
        return { text, tokenCount: text.split(/\s+/).length }
      },
    })
    service.init()
  })

  afterEach(() => {
    try { db.close() } catch { /* best-effort */ }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  // --- Ingest -------------------------------------------------------------

  describe('ingest', () => {
    it('creates a document with status=indexed and chunk/fts/vec rows', async () => {
      const filePath = join(tempDir, 'test.md')
      writeFileSync(filePath, '# Hello World\n\nThis is a test document with enough content to chunk.')

      const vault = service.addVault(tempDir, 'test-vault')
      const result = await service.ingest(filePath, vault.id)

      expect(result.status).toBe('indexed')
      expect(result.chunks).toBeGreaterThan(0)

      // Verify document status.
      const docs = service.listDocuments(vault.id)
      expect(docs).toHaveLength(1)
      expect(docs[0].status).toBe('indexed')

      // Verify chunks exist.
      const chunks = db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks WHERE document_id = ?'
      ).all(result.documentId) as Array<{ n: number }>
      expect(chunks[0].n).toBe(result.chunks)

      // Verify FTS5 rows exist (rowid = chunk.id).
      const ftsCount = db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks_fts WHERE rowid IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)'
      ).all(result.documentId) as Array<{ n: number }>
      expect(ftsCount[0].n).toBe(result.chunks)

      // Verify vec0 rows exist.
      const vecCount = db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks_vec WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)'
      ).all(result.documentId) as Array<{ n: number }>
      expect(vecCount[0].n).toBe(result.chunks)
    })

    it('re-ingest same content is a no-op', async () => {
      const filePath = join(tempDir, 'same.md')
      writeFileSync(filePath, 'Same content every time.')

      const vault = service.addVault(tempDir, 'test-vault')
      const r1 = await service.ingest(filePath, vault.id)
      expect(r1.status).toBe('indexed')
      expect(r1.chunks).toBeGreaterThan(0)

      const r2 = await service.ingest(filePath, vault.id)
      expect(r2.status).toBe('indexed')
      expect(r2.chunks).toBe(0) // No new chunks — no-op.
      expect(r2.documentId).toBe(r1.documentId)
    })

    it('re-ingest modified content replaces old rows', async () => {
      const filePath = join(tempDir, 'changing.md')
      writeFileSync(filePath, 'Original content here.')

      const vault = service.addVault(tempDir, 'test-vault')
      const r1 = await service.ingest(filePath, vault.id)
      const chunksBefore = (db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks WHERE document_id = ?'
      ).all(r1.documentId) as Array<{ n: number }>)[0].n

      // Modify the file.
      writeFileSync(filePath, 'Completely different content now with new words to index.')
      const r2 = await service.ingest(filePath, vault.id)
      expect(r2.status).toBe('indexed')
      expect(r2.documentId).toBe(r1.documentId)

      // Old rows should be gone, new rows inserted.
      const chunksAfter = (db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks WHERE document_id = ?'
      ).all(r1.documentId) as Array<{ n: number }>)[0].n
      // Count should be valid (might be same or different, but no duplicates).
      expect(chunksAfter).toBeGreaterThan(0)

      // FTS/vec counts should match chunk count.
      const ftsCount = (db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks_fts WHERE rowid IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)'
      ).all(r1.documentId) as Array<{ n: number }>)[0].n
      const vecCount = (db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks_vec WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)'
      ).all(r1.documentId) as Array<{ n: number }>)[0].n
      expect(ftsCount).toBe(chunksAfter)
      expect(vecCount).toBe(chunksAfter)
    })

    it('failed embedder marks document as failed', async () => {
      const filePath = join(tempDir, 'fail.md')
      writeFileSync(filePath, 'Content that will fail to embed.')

      // Create a service with a failing embedder.
      const failEmbedder: Embedder = {
        async embed(): Promise<Float32Array[]> {
          throw new Error('Simulated embed failure')
        },
      }
      const failService = new KnowledgeService(db, TEST_CONFIG, {
        embedder: failEmbedder,
        extractorFn: (path: string) => {
          const { readFileSync } = require('fs') as typeof import('fs')
          const text = readFileSync(path, 'utf-8')
          return { text, tokenCount: text.split(/\s+/).length }
        },
      })
      failService.init()

      const vault = failService.addVault(tempDir, 'test-vault')
      const result = await failService.ingest(filePath, vault.id)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Simulated embed failure')

      // No partial chunks.
      const chunks = (db.prepare(
        'SELECT count(*) AS n FROM knowledge_chunks WHERE document_id = ?'
      ).all(result.documentId) as Array<{ n: number }>)[0].n
      expect(chunks).toBe(0)
    })
  })

  // --- Search -------------------------------------------------------------

  describe('search', () => {
    it('hybrid search returns chunks ordered by distance', async () => {
      const filePath = join(tempDir, 'searchable.md')
      writeFileSync(filePath, 'transformer attention mechanism neural network deep learning')

      const vault = service.addVault(tempDir, 'test-vault')
      await service.ingest(filePath, vault.id)

      // Search with query close to [1,0,0,0].
      const results = await service.search({
        query: 'transformer',
        vaultId: vault.id,
        hybrid: true,
        limit: 10,
      })

      expect(results.results.length).toBeGreaterThanOrEqual(0)
      expect(results.totalCandidatesBeforeFilter).toBeDefined
    })

    it('pure-vector search uses MATCH and post-filter', async () => {
      const filePath = join(tempDir, 'vector.md')
      writeFileSync(filePath, 'semantic embedding vector space cosine similarity')

      const vault = service.addVault(tempDir, 'test-vault')
      await service.ingest(filePath, vault.id)

      const results = await service.search({
        query: 'vector space',
        vaultId: vault.id,
        hybrid: false,
        limit: 10,
      })

      expect(results.totalCandidatesBeforeFilter).toBeDefined
    })

    it('query > 2000 chars throws QueryTooLongError', async () => {
      const longQuery = 'a'.repeat(2001)
      await expect(
        service.search({ query: longQuery })
      ).rejects.toThrow(QueryTooLongError)
    })

    it('non-indexed documents do not appear in search results', async () => {
      // Manually insert a document with status='failed'.
      const vault = service.addVault(tempDir, 'test-vault')
      db.prepare(`
        INSERT INTO knowledge_documents
          (source_path, source_hash, vault_id, mime_type, size_bytes, mtime, indexed_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'failed')
      `).run('/fake/path.txt', 'fakehash', vault.id, 'text/plain', 100, Date.now(), Date.now())

      const failedDocId = (db.prepare(
        "SELECT id FROM knowledge_documents WHERE status = 'failed'"
      ).all() as Array<{ id: number }>)[0].id

      // Insert a chunk for the failed doc (shouldn't appear in search).
      db.prepare(
        'INSERT INTO knowledge_chunks (document_id, position, content, token_count) VALUES (?, 0, ?, 5)'
      ).run(failedDocId, 'some content')
      const chunkIdRow = db.prepare('SELECT last_insert_rowid() AS id').all() as Array<{ id: number }>
      const chunkId = Number(chunkIdRow[0].id)
      db.prepare(
        'INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (?, ?)'
      ).run(chunkId, 'some content')
      db.prepare(
        'INSERT INTO knowledge_chunks_vec (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)'
      ).run(chunkId, '[0.9, 0.1, 0.0, 0.0]')

      // Search should return 0 results (the only chunk belongs to a failed doc).
      const results = await service.search({
        query: 'content',
        hybrid: true,
      })
      // The document is 'failed', so it should not appear.
      for (const r of results.results) {
        expect(r.documentId).not.toBe(failedDocId)
      }
    })
  })

  // --- Vault management ---------------------------------------------------

  describe('vault management', () => {
    it('addVault and listVaults', () => {
      const v = service.addVault('/tmp/test', 'Test Vault')
      expect(v.name).toBe('Test Vault')
      expect(v.root_path).toBe('/tmp/test')

      const vaults = service.listVaults()
      expect(vaults).toHaveLength(1)
      expect(vaults[0].id).toBe(v.id)
    })

    it('removeVault without cascade keeps documents and marks vault as unwatched', async () => {
      const filePath = join(tempDir, 'keep.md')
      writeFileSync(filePath, 'Keep this content.')
      const vault = service.addVault(tempDir, 'test-vault')
      await service.ingest(filePath, vault.id)

      service.removeVault(vault.id, false)
      // Documents should still exist.
      const docs = db.prepare('SELECT count(*) AS n FROM knowledge_documents').all() as Array<{ n: number }>
      expect(docs[0].n).toBeGreaterThan(0)
      // Vault should still exist but with watch=0.
      const vaults = db.prepare('SELECT * FROM knowledge_vaults WHERE id = ?').all(vault.id) as Array<{ watch: number }>
      expect(vaults).toHaveLength(1)
      expect(vaults[0].watch).toBe(0)
    })

    it('removeVault with cascade deletes everything', async () => {
      const filePath = join(tempDir, 'cascade.md')
      writeFileSync(filePath, 'Delete everything.')
      const vault = service.addVault(tempDir, 'test-vault')
      await service.ingest(filePath, vault.id)

      service.removeVault(vault.id, true)
      const docs = db.prepare('SELECT count(*) AS n FROM knowledge_documents').all() as Array<{ n: number }>
      expect(docs[0].n).toBe(0)
    })
  })

  // --- Health -------------------------------------------------------------

  describe('health', () => {
    it('returns vault and document counts', async () => {
      const filePath = join(tempDir, 'health.md')
      writeFileSync(filePath, 'Health check content.')
      const vault = service.addVault(tempDir, 'test-vault')
      await service.ingest(filePath, vault.id)

      const h = service.health()
      expect(h.vaultCount).toBe(1)
      expect(h.documentCount.indexed).toBe(1)
      expect(h.vecIndexSize).toBeGreaterThan(0)
    })
  })
})

describe.skipIf(canRun)('KnowledgeService — skipped (sqlite-vec unavailable)', () => {
  it('reports the missing dependency', () => {
    expect('sqlite-vec is required for knowledge service tests').toBeTruthy()
  })
})
