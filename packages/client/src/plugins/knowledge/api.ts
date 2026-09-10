/**
 * Knowledge plugin — API helpers.
 *
 * Thin typed wrappers around the shared `request()` helper.
 */

import { request } from '@/api/client'

// --- Types ----------------------------------------------------------------

export interface KnowledgeVault {
  id: number
  root_path: string
  name: string
  watch: number
  created_at: number
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
  status: 'pending' | 'indexing' | 'indexed' | 'failed'
  error: string | null
}

export interface KnowledgeHealth {
  vaults: { total: number; watching: number; offline: number }
  documents: { total: number; pending: number; indexed: number; failed: number; indexing: number; metadataOnly: number }
  chunks: { total: number }
  vecIndex: { vectorCount: number }
  ftsIndex: { sizeBytes: number; termCount: number }
  ingestion: { inFlight: number; queued: number; lastSuccessAt: number | null; lastFailureAt: number | null; lastError: string | null }
  embedder: { requestsLastHour: number; tokensLastHour: number; failuresLastHour: number; avgLatencyMs: number }
}

export interface SearchResult {
  chunkId: number
  documentId: number
  content: string
  distance: number
  vaultId: number
}

export interface SearchResponse {
  results: SearchResult[]
  totalCandidatesBeforeFilter: number
  warning?: string
}

// --- API calls ------------------------------------------------------------

export async function listVaults(): Promise<{ vaults: KnowledgeVault[] }> {
  return request('/api/knowledge/vaults')
}

export async function createVault(rootPath: string, name: string): Promise<{ vault: KnowledgeVault }> {
  return request('/api/knowledge/vaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: rootPath, name }),
  })
}

export async function deleteVault(id: number, cascade: boolean = false): Promise<void> {
  const qs = cascade ? '?cascade=true' : ''
  return request(`/api/knowledge/vaults/${id}${qs}`, { method: 'DELETE' })
}

export async function listDocuments(filters?: { vaultId?: number; status?: string }): Promise<{ documents: KnowledgeDocument[] }> {
  const params = new URLSearchParams()
  if (filters?.vaultId) params.set('vault_id', String(filters.vaultId))
  if (filters?.status) params.set('status', filters.status)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request(`/api/knowledge/documents${qs}`)
}

export async function getDocument(id: number): Promise<{ document: KnowledgeDocument }> {
  return request(`/api/knowledge/documents/${id}`)
}

export async function deleteDocument(id: number): Promise<void> {
  return request(`/api/knowledge/documents/${id}`, { method: 'DELETE' })
}

export async function searchKnowledge(body: {
  query: string
  vaultId?: number
  limit?: number
  hybrid?: boolean
  maxDistance?: number
}): Promise<SearchResponse> {
  return request('/api/knowledge/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function getHealth(): Promise<KnowledgeHealth> {
  return request('/api/knowledge/health')
}
