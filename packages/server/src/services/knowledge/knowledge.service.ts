/**
 * Knowledge plugin — orchestrator service.
 *
 * Stitches the watcher, extractor, chunker, embedder, and search
 * together. Owns:
 *   - Single-writer coroutine (one async worker, bounded FIFO queue).
 *   - Atomic ingest pipeline (extract → chunk → embed → write).
 *   - Atomic delete pipeline (FTS5 + vec0 + chunks in one txn).
 *   - Search dispatch (hybrid or pure-vector via search.ts).
 *
 * Hard invariants:
 *   - `getDb()` is the only connection — never open a second one.
 *   - FTS5 + vec0 deletes are explicit (FK cascades don't apply
 *     to virtual tables — audit P0-1).
 *   - One writer, serialized. Never concurrent writes.
 */

import { createHash } from 'crypto'
import { statSync } from 'fs'
import { extname, join } from 'path'
import { EventEmitter } from 'events'
import type { DatabaseSync } from 'node:sqlite'
import {
  ensureKnowledgeSchema,
  type KnowledgeSchemaBootstrapStatus,
} from '../../db/knowledge-schema'
import { extract, type ExtractError } from './extractors'
import { chunkText, type Chunk } from './chunker'
import {
  createEmbedder,
  createTongyiProvider,
  KnowledgeEmbedError,
  type Embedder,
  type EmbedConfig,
} from './embedder'
import { search as searchFn, QueryTooLongError, type SearchParams, type SearchResponse } from './search'
import { tokenizeForFts } from './fts-tokenizer'
import type { KnowledgeConfig } from './config'

// --- Public types ---------------------------------------------------------

export { QueryTooLongError }

export type IngestStatus = 'pending' | 'indexing' | 'indexed' | 'failed' | 'metadata_only'

export interface KnowledgeHealthReport {
  vaults: { total: number; watching: number; offline: number }
  documents: { total: number; pending: number; indexed: number; failed: number; indexing: number; metadataOnly: number }
  chunks: { total: number }
  vecIndex: { vectorCount: number }
  ftsIndex: { sizeBytes: number; termCount: number }
  ingestion: {
    inFlight: number
    queued: number
    lastSuccessAt: number | null
    lastFailureAt: number | null
    lastError: string | null
  }
  embedder: {
    requestsLastHour: number
    tokensLastHour: number
    failuresLastHour: number
    avgLatencyMs: number
  }
}

export interface KnowledgeDocument {
  id: number
  source_path: string
  source_hash: string
  vault_id: number
  mime_type: string
  size_bytes: number
  mtime: number
  indexed_at: number
  status: IngestStatus
  error: string | null
}

export interface KnowledgeVault {
  id: number
  root_path: string
  name: string
  watch: number
  created_at: number
}

interface QueueItem {
  path: string
  vaultId: number
  resolve: (result: IngestResult) => void
  reject: (err: Error) => void
}

export interface IngestResult {
  documentId: number
  status: IngestStatus
  chunks: number
  error?: string
}

export interface KnowledgeServiceDeps {
  /** Override embedder for testing. */
  embedder?: Embedder
  /** Override extractor for testing. */
  extractorFn?: (path: string) => { text: string; tokenCount: number } | Promise<{ text: string; tokenCount: number }>
}

// --- Service --------------------------------------------------------------

export class KnowledgeService extends EventEmitter {
  private db: DatabaseSync
  private config: KnowledgeConfig
  private embedder: Embedder
  private extractorFn: (path: string) => { text: string; tokenCount: number } | Promise<{ text: string; tokenCount: number }>

  private queue: QueueItem[] = []
  private processing = false
  private activeWorkers = 0
  private vecAvailable = false

  constructor(
    db: DatabaseSync,
    config: KnowledgeConfig,
    deps: KnowledgeServiceDeps = {},
  ) {
    super()
    this.db = db
    this.config = config
    this.extractorFn = deps.extractorFn ?? ((path: string) => extract(path))

    if (deps.embedder) {
      this.embedder = deps.embedder
    } else {
      const embedConfig: EmbedConfig = {
        provider: config.embedProvider,
        model: config.embedModel,
        dim: config.embedDim,
        apiKey: config.embedApiKey,
        apiBase: config.embedApiBase,
        batchSize: config.embedBatchSize,
        timeoutMs: config.embedTimeoutMs,
        retries: config.embedRetries,
      }
      const provider = createTongyiProvider(embedConfig)
      this.embedder = createEmbedder(provider)
    }
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Bootstrap the knowledge schema on the shared DB connection.
   * Returns a status describing whether sqlite-vec (vector search)
   * was successfully loaded. Callers should check status.vecAvailable
   * before accepting ingest / search tasks.
   */
  init(): KnowledgeSchemaBootstrapStatus {
    const status = ensureKnowledgeSchema(this.db, this.config.embedDim, this.config.embedModel)
    this.vecAvailable = status.vecAvailable
    return status
  }

  // --- Vault management ---------------------------------------------------

  addVault(rootPath: string, name: string): KnowledgeVault {
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO knowledge_vaults (root_path, name, watch, created_at) VALUES (?, ?, 1, ?)'
    ).run(rootPath, name, now)

    const rows = this.db.prepare(
      'SELECT * FROM knowledge_vaults WHERE root_path = ?'
    ).all(rootPath) as unknown as KnowledgeVault[]
    return rows[0]
  }

  removeVault(vaultId: number, cascade: boolean = false): void {
    if (cascade) {
      // Atomic cascade: virtual tables (FTS5, vec0) don't participate in
      // FK cascades (P0-1), so we delete from all three manually inside
      // one transaction. If any step fails, ROLLBACK restores everything.
      this.db.exec('BEGIN')
      try {
        const docs = this.db.prepare(
          'SELECT id FROM knowledge_documents WHERE vault_id = ?'
        ).all(vaultId) as Array<{ id: number }>
        for (const doc of docs) {
          this.deleteDocumentIndexes(doc.id, true) // skipTransaction — outer txn covers us
        }
        this.db.prepare('DELETE FROM knowledge_documents WHERE vault_id = ?').run(vaultId)
        this.db.prepare('DELETE FROM knowledge_vaults WHERE id = ?').run(vaultId)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    } else {
      // Without cascade, just disable watching — documents remain
      // referencing the vault (FK constraint prevents row deletion).
      this.db.prepare('UPDATE knowledge_vaults SET watch = 0 WHERE id = ?').run(vaultId)
    }
  }

  listVaults(): KnowledgeVault[] {
    return this.db.prepare('SELECT * FROM knowledge_vaults ORDER BY id').all() as unknown as KnowledgeVault[]
  }

  // --- Document listing ---------------------------------------------------

  listDocuments(vaultId?: number): KnowledgeDocument[] {
    if (vaultId != null) {
      return this.db.prepare(
        'SELECT * FROM knowledge_documents WHERE vault_id = ? ORDER BY indexed_at DESC'
      ).all(vaultId) as unknown as KnowledgeDocument[]
    }
    return this.db.prepare(
      'SELECT * FROM knowledge_documents ORDER BY indexed_at DESC'
    ).all() as unknown as KnowledgeDocument[]
  }

  // --- Ingest pipeline ----------------------------------------------------

  /**
   * Queue a file for ingestion. Returns a promise that resolves when
   * the single-writer worker has processed the file.
   */
  ingest(path: string, vaultId: number): Promise<IngestResult> {
    return new Promise<IngestResult>((resolve, reject) => {
      if (this.queue.length >= this.config.queueDepth) {
        reject(new Error(`Ingest queue full (${this.config.queueDepth}). Try later.`))
        return
      }
      this.queue.push({ path, vaultId, resolve, reject })
      this.drainQueue()
    })
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      this.activeWorkers++
      try {
        const result = await this.processIngest(item.path, item.vaultId)
        item.resolve(result)
      } catch (err) {
        item.reject(err as Error)
      } finally {
        this.activeWorkers--
      }
    }

    this.processing = false
  }

  private async processIngest(path: string, vaultId: number): Promise<IngestResult> {
    // 0. Extension whitelist — skip unsupported types before touching disk.
    const ext = extname(path).toLowerCase()
    if (ext && !this.config.supportedExtensions.includes(ext)) {
      // Metadata-only: record the document but don't extract.
      let fileStat: { size: number; mtimeMs: number }
      try {
        const s = statSync(path)
        fileStat = { size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        // File was deleted between watcher event and processing — skip.
        return { documentId: 0, status: 'failed', chunks: 0, error: 'File disappeared before processing' }
      }
      const docId = this.upsertDocument(path, vaultId, '', fileStat)
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'metadata_only', indexed_at = ? WHERE id = ?"
      ).run(Date.now(), docId)
      return { documentId: docId, status: 'metadata_only', chunks: 0 }
    }

    // 1. Read file and compute source_hash.
    let fileContent: { text: string; tokenCount: number }
    let fileStat: { size: number; mtimeMs: number } = { size: 0, mtimeMs: Date.now() }
    try {
      fileStat = statSync(path)
      // ARM protection: reject files exceeding the size limit.
      if (fileStat.size > this.config.maxFileSizeBytes) {
        const maxMb = Math.round(this.config.maxFileSizeBytes / (1024 * 1024))
        throw new Error(`File too large (${Math.round(fileStat.size / (1024 * 1024))}MB > ${maxMb}MB limit)`)
      }
      fileContent = await this.extractorFn(path)
    } catch (err) {
      // File unreadable — record failure.
      const docId = this.upsertDocument(path, vaultId, '', fileStat)
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?"
      ).run((err as Error).message, docId)
      return { documentId: docId, status: 'failed', chunks: 0, error: (err as Error).message }
    }

    const sourceHash = createHash('sha256').update(fileContent.text).digest('hex')
    const mimeType = guessMimeType(path)

    // 2. Check if source_hash matches existing document (no-op).
    const existing = this.db.prepare(
      'SELECT id, source_hash, status FROM knowledge_documents WHERE source_path = ? AND vault_id = ?'
    ).all(path, vaultId) as Array<{ id: number; source_hash: string; status: string }>

    if (existing.length > 0 && existing[0].source_hash === sourceHash && existing[0].status === 'indexed') {
      return { documentId: existing[0].id, status: 'indexed', chunks: 0 }
    }

    // 3. Mark document as indexing.
    const docId = this.upsertDocument(path, vaultId, sourceHash, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    })
    this.db.prepare(
      "UPDATE knowledge_documents SET status = 'indexing', error = NULL WHERE id = ?"
    ).run(docId)

    try {
      // 4. If re-indexing, delete old chunks/FTS/vec.
      if (existing.length > 0) {
        this.deleteDocumentIndexes(docId)
      }

      // 5. Chunk.
      const ext = extname(path).toLowerCase()
      const kind = (ext === '.md') ? 'markdown' : 'plaintext'
      const chunks = chunkText(fileContent.text, kind, {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        chunkFallbackSize: this.config.chunkFallbackSize,
      })

      if (chunks.length === 0) {
        // Metadata-only document (empty file).
        this.db.prepare(
          "UPDATE knowledge_documents SET status = 'indexed', indexed_at = ? WHERE id = ?"
        ).run(Date.now(), docId)
        return { documentId: docId, status: 'indexed', chunks: 0 }
      }

      // 6. Embed.
      const chunkTexts = chunks.map(c => c.content)
      const vectors = await this.embedder.embed(chunkTexts)

      // 7. Write chunks + FTS5 + vec0 in one transaction.
      this.insertChunks(docId, chunks, vectors)

      // 8. Mark as indexed.
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'indexed', indexed_at = ? WHERE id = ?"
      ).run(Date.now(), docId)

      // Track success.
      this._lastSuccessAt = Date.now()
      this.emit('knowledge:ingest:success', { documentId: docId, chunks: chunks.length })

      return { documentId: docId, status: 'indexed', chunks: chunks.length }
    } catch (err) {
      const errorMsg = (err as Error).message
      // Rollback: mark as failed.
      this.db.prepare(
        "UPDATE knowledge_documents SET status = 'failed', error = ? WHERE id = ?"
      ).run(errorMsg, docId)

      // Track failure.
      this._lastFailureAt = Date.now()
      this._lastError = errorMsg
      this.emit('knowledge:ingest:error', { documentId: docId, error: errorMsg })

      return { documentId: docId, status: 'failed', chunks: 0, error: errorMsg }
    }
  }

  private upsertDocument(
    path: string,
    vaultId: number,
    sourceHash: string,
    stat: { size: number; mtimeMs: number },
  ): number {
    const existing = this.db.prepare(
      'SELECT id FROM knowledge_documents WHERE source_path = ? AND vault_id = ?'
    ).all(path, vaultId) as Array<{ id: number }>

    if (existing.length > 0) {
      this.db.prepare(`
        UPDATE knowledge_documents
        SET source_hash = ?, size_bytes = ?, mtime = ?, mime_type = ?
        WHERE id = ?
      `).run(
        sourceHash || '',
        stat.size,
        Math.floor(stat.mtimeMs),
        guessMimeType(path),
        existing[0].id,
      )
      return existing[0].id
    }

    this.db.prepare(`
      INSERT INTO knowledge_documents
        (source_path, source_hash, vault_id, mime_type, size_bytes, mtime, indexed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      path,
      sourceHash || '',
      vaultId,
      guessMimeType(path),
      stat.size,
      Math.floor(stat.mtimeMs),
      Date.now(),
    )

    const rows = this.db.prepare('SELECT last_insert_rowid() AS id').all() as Array<{ id: number }>
    return rows[0].id
  }

  private insertChunks(documentId: number, chunks: Chunk[], vectors: Float32Array[]): void {
    // Single transaction for chunks + FTS5 (+ vec0 if available).
    // virtual tables can't use FK cascades (P0-1), so we insert
    // into all three explicitly.
    this.db.exec('BEGIN')
    try {
      const insertChunk = this.db.prepare(`
        INSERT INTO knowledge_chunks (document_id, position, content, token_count)
        VALUES (?, ?, ?, ?)
      `)
      const insertFts = this.db.prepare(`
        INSERT INTO knowledge_chunks_fts (rowid, content) VALUES (?, ?)
      `)
      const insertVec = this.vecAvailable
        ? this.db.prepare(`
            INSERT INTO knowledge_chunks_vec (chunk_id, embedding)
            VALUES (CAST(? AS INTEGER), ?)
          `)
        : null

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const vector = vectors[i]

        // insertChunk returns { lastInsertRowid, changes }.
        const insertResult = insertChunk.run(documentId, i, chunk.content, chunk.tokenCount) as { lastInsertRowid: number; changes: number }
        const chunkId = Number(insertResult.lastInsertRowid)

        // FTS5 rowid coupling: explicit rowid = chunk.id (P1-3).
        // Write bigram-tokenized text so CJK queries can match via FTS5.
        // The original content stays in knowledge_chunks for display.
        insertFts.run(chunkId, tokenizeForFts(chunk.content).join(' '))

        // vec0 insert: only when the extension is loaded.
        if (insertVec) {
          const vecJson = '[' + Array.from(vector).join(',') + ']'
          insertVec.run(chunkId, vecJson)
        }
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private deleteDocumentIndexes(documentId: number, skipTransaction = false): void {
    // Virtual tables don't cascade — delete from all three explicitly
    // in one transaction (P0-1).
    // Uses prepared statements with parameterized documentId to prevent
    // SQL injection (root-cause fix: was using string interpolation).
    // When called from removeVault (which already holds a transaction),
    // skipTransaction=true avoids nested BEGIN.
    if (!skipTransaction) this.db.exec('BEGIN')
    try {
      // FTS5: delete by rowid = chunk.id.
      this.db.prepare(`
        DELETE FROM knowledge_chunks_fts WHERE rowid IN (
          SELECT id FROM knowledge_chunks WHERE document_id = ?
        )
      `).run(documentId)
      // vec0: delete by chunk_id (only when vec0 is available).
      if (this.vecAvailable) {
        this.db.prepare(`
          DELETE FROM knowledge_chunks_vec WHERE chunk_id IN (
            SELECT id FROM knowledge_chunks WHERE document_id = ?
          )
        `).run(documentId)
      }
      // Chunks: cascade from documents will handle this, but be explicit.
      this.db.prepare(
        'DELETE FROM knowledge_chunks WHERE document_id = ?'
      ).run(documentId)
      if (!skipTransaction) this.db.exec('COMMIT')
    } catch (err) {
      if (!skipTransaction) this.db.exec('ROLLBACK')
      throw err
    }
  }

  // --- Search -------------------------------------------------------------

  async search(params: SearchParams): Promise<SearchResponse> {
    // Embed the query, then delegate to search.ts.
    const queryVectors = await this.embedder.embed([params.query])
    const queryEmbedding = queryVectors[0]
    return searchFn(this.db, queryEmbedding, params)
  }

  // --- Health -------------------------------------------------------------

  health(): KnowledgeHealthReport {
    // Vault counts.
    const vaultRows = this.db.prepare(
      'SELECT count(*) AS total, SUM(CASE WHEN watch = 1 THEN 1 ELSE 0 END) AS watching FROM knowledge_vaults'
    ).all() as Array<{ total: number; watching: number }>
    const vaultTotal = vaultRows[0]?.total ?? 0
    const vaultWatching = vaultRows[0]?.watching ?? 0

    // Document counts by status.
    const docRows = this.db.prepare(
      'SELECT status, count(*) AS n FROM knowledge_documents GROUP BY status'
    ).all() as Array<{ status: string; n: number }>
    const docCounts: Record<string, number> = {}
    let docTotal = 0
    for (const row of docRows) {
      docCounts[row.status] = row.n
      docTotal += row.n
    }

    // Chunk count.
    const chunkRows = this.db.prepare('SELECT count(*) AS n FROM knowledge_chunks').all() as Array<{ n: number }>
    const chunkTotal = chunkRows[0]?.n ?? 0

    // vec0 index size (vector count) — only when vec0 is available.
    let vecCount = 0
    if (this.vecAvailable) {
      const vecRows = this.db.prepare('SELECT count(*) AS n FROM knowledge_chunks_vec').all() as Array<{ n: number }>
      vecCount = vecRows[0]?.n ?? 0
    }

    // FTS5 content size (approximate).
    const ftsRows = this.db.prepare(
      'SELECT SUM(length(content)) AS total_len, count(*) AS n FROM knowledge_chunks_fts'
    ).all() as Array<{ total_len: number; n: number }>
    const ftsSizeBytes = ftsRows[0]?.total_len ?? 0
    const ftsTermCount = ftsRows[0]?.n ?? 0

    return {
      vaults: { total: vaultTotal, watching: vaultWatching, offline: vaultTotal - vaultWatching },
      documents: {
        total: docTotal,
        pending: docCounts['pending'] ?? 0,
        indexed: docCounts['indexed'] ?? 0,
        failed: docCounts['failed'] ?? 0,
        indexing: docCounts['indexing'] ?? 0,
        metadataOnly: docCounts['metadata_only'] ?? 0,
      },
      chunks: { total: chunkTotal },
      vecIndex: { vectorCount: vecCount },
      ftsIndex: { sizeBytes: ftsSizeBytes, termCount: ftsTermCount },
      ingestion: {
        inFlight: this.activeWorkers,
        queued: this.queue.length,
        lastSuccessAt: this._lastSuccessAt,
        lastFailureAt: this._lastFailureAt,
        lastError: this._lastError,
      },
      embedder: this._embedderStats,
    }
  }

  // In-memory ingestion tracking (populated by processIngest).
  private _lastSuccessAt: number | null = null
  private _lastFailureAt: number | null = null
  private _lastError: string | null = null
  private _embedderStats = { requestsLastHour: 0, tokensLastHour: 0, failuresLastHour: 0, avgLatencyMs: 0 }
}

// --- Helpers --------------------------------------------------------------

function guessMimeType(path: string): string {
  const ext = extname(path).toLowerCase()
  const map: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  return map[ext] || 'application/octet-stream'
}
