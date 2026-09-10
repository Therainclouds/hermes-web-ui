/**
 * Knowledge plugin — HTTP controllers.
 *
 * Thin request/response mapping. Business logic lives in
 * knowledge.service.ts. Error mapping follows §10.2 of the
 * architecture doc.
 */

import type { Context } from 'koa'
import { KnowledgeService, QueryTooLongError } from '../services/knowledge/knowledge.service'
import { KnowledgeConfigError } from '../services/knowledge/config'

// --- Helpers --------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function parseBooleanParam(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true' || value === '1'
}

// The service is injected at bootstrap time via setKnowledgeService().
// When the plugin is disabled (KNOWLEDGE_ENABLED=0) or sqlite-vec is
// missing, _service stays null and all endpoints reply 503.
// (Root-cause fix 2026-09-10 — previously this threw a 500 from the
// default error handler; now it's a friendly 503.)
let _service: KnowledgeService | null = null

export function setKnowledgeService(service: KnowledgeService | null): void {
  _service = service
}

/**
 * Returns the active service, or writes a 503 response to ctx and
 * returns null. Callers should early-return after a null result.
 */
function getServiceOr503(ctx: Context): KnowledgeService | null {
  if (!_service) {
    ctx.status = 503
    ctx.body = {
      error: 'knowledge_disabled',
      code: 'service_unavailable',
      message:
        'Knowledge plugin is not initialized. ' +
        'Set KNOWLEDGE_ENABLED=1 and ensure sqlite-vec is installed.',
    }
    return null
  }
  return _service
}

// --- Vault endpoints ------------------------------------------------------

export async function listVaults(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  ctx.body = { vaults: service.listVaults() }
}

export async function createVault(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  const { root_path, name } = ctx.request.body as { root_path?: string; name?: string }

  if (!root_path || !name) {
    ctx.status = 400
    ctx.body = { error: 'missing_fields', message: 'root_path and name are required' }
    return
  }

  try {
    const vault = service.addVault(root_path, name)
    ctx.status = 201
    ctx.body = { vault }
  } catch (err) {
    if ((err as Error).message?.includes('UNIQUE constraint')) {
      ctx.status = 409
      ctx.body = { error: 'vault_exists', message: 'A vault with this root_path already exists' }
    } else {
      throw err
    }
  }
}

export async function deleteVault(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  const id = parsePositiveInt(ctx.params.id, 0)
  if (!id) {
    ctx.status = 400
    ctx.body = { error: 'invalid_id', message: 'Vault id must be a positive integer' }
    return
  }

  const cascade = parseBooleanParam(ctx.query.cascade as string | undefined)
  service.removeVault(id, cascade)
  ctx.status = 204
}

// --- Document endpoints ---------------------------------------------------

export async function listDocuments(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  const vaultId = ctx.query.vault_id
    ? parsePositiveInt(ctx.query.vault_id as string, 0) || undefined
    : undefined
  const status = ctx.query.status as string | undefined

  let docs = service.listDocuments(vaultId)
  if (status) {
    docs = docs.filter(d => d.status === status)
  }
  ctx.body = { documents: docs }
}

export async function getDocument(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  const id = parsePositiveInt(ctx.params.id, 0)
  if (!id) {
    ctx.status = 400
    ctx.body = { error: 'invalid_id', message: 'Document id must be a positive integer' }
    return
  }

  const docs = service.listDocuments()
  const doc = docs.find(d => d.id === id)
  if (!doc) {
    ctx.status = 404
    ctx.body = { error: 'not_found', message: 'Document not found' }
    return
  }
  ctx.body = { document: doc }
}

export async function deleteDocument(ctx: Context): Promise<void> {
  // TODO: implement single-document delete when the service supports it.
  ctx.status = 501
  ctx.body = { error: 'not_implemented' }
}

// --- Search ---------------------------------------------------------------

export async function searchKnowledge(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  const body = ctx.request.body as {
    query?: string
    vault_id?: number
    limit?: number
    hybrid?: boolean
    max_distance?: number
  }

  const query = body.query?.trim() ?? ''
  if (!query) {
    ctx.status = 400
    ctx.body = { error: 'empty_query', message: 'Query must be a non-empty string' }
    return
  }
  if (query.length > 2000) {
    ctx.status = 400
    ctx.body = { error: 'query_too_long', message: `Query length ${query.length} exceeds limit 2000` }
    return
  }

  try {
    const result = await service.search({
      query,
      vaultId: body.vault_id ?? null,
      limit: body.limit ?? 5,
      hybrid: body.hybrid ?? true,
      maxDistance: body.max_distance,
    })
    ctx.body = result
  } catch (err) {
    if (err instanceof QueryTooLongError) {
      ctx.status = 400
      ctx.body = { error: 'query_too_long', message: err.message }
    } else {
      throw err
    }
  }
}

// --- Reindex --------------------------------------------------------------

export async function reindex(ctx: Context): Promise<void> {
  // TODO: implement bulk reindex when watcher integration is complete.
  ctx.status = 501
  ctx.body = { error: 'not_implemented' }
}

// --- Health ---------------------------------------------------------------

export async function health(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  ctx.body = service.health()
}

// Keep legacy name around (tests may still call getService()). The
// old behavior (throwing KnowledgeConfigError) is preserved so
// knowledge-service.test.ts expectations still hold.
function getService(): KnowledgeService {
  if (!_service) {
    throw new KnowledgeConfigError('Knowledge service not initialized')
  }
  return _service
}
