/**
 * Knowledge plugin — HTTP controllers.
 *
 * Thin request/response mapping. Business logic lives in
 * knowledge.service.ts. Error mapping follows §10.2 of the
 * architecture doc.
 */

import type { Context } from 'koa'
import { realpathSync, accessSync, constants, mkdirSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import { KnowledgeService, QueryTooLongError } from '../services/knowledge/knowledge.service'
import { KnowledgeConfigError, loadKnowledgeConfig } from '../services/knowledge/config'
import { getWebUiHome } from '../config'

// --- Vault path validation (ARM protection) -------------------------------

/**
 * Validate a vault root_path for safety before accepting it.
 * - Resolves symlinks via realpathSync.
 * - Rejects system directories (/etc, /proc, /sys, /root, /var, /boot, /dev
 *   on Unix; common Windows system paths).
 * - Checks read access.
 * - Limits path depth to 16 (prevents inotify quota exhaustion on Linux).
 */
function validateVaultPath(rootPath: string): { valid: boolean; error?: string; resolved?: string } {
  let resolved: string
  try {
    resolved = realpathSync(rootPath)
  } catch {
    return { valid: false, error: 'Path does not exist or is not accessible' }
  }

  // System directory blocklist (cross-platform).
  const normalized = resolved.replace(/\\/g, '/').toLowerCase()
  const systemPrefixes = [
    '/etc', '/proc', '/sys', '/root', '/var', '/boot', '/dev',
    '/usr', '/bin', '/sbin', '/lib', '/lib64', '/tmp', '/opt', '/snap',
    '/system', '/library', '/private', '/applications',
    '/windows', '/program files', '/program files (x86)',
    '/programdata', '/$recycle.bin', '/system volume information',
  ]
  for (const prefix of systemPrefixes) {
    if (normalized === prefix || normalized.startsWith(prefix + '/')) {
      return { valid: false, error: `Cannot index system directory: ${resolved}` }
    }
  }

  try {
    accessSync(resolved, constants.R_OK)
  } catch {
    return { valid: false, error: 'Path is not readable' }
  }

  const depth = resolved.split(sep).filter(Boolean).length
  if (depth > 16) {
    return { valid: false, error: `Path depth ${depth} exceeds limit 16` }
  }

  return { valid: true, resolved }
}

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

// Re-init hook: db/hermes/init.ts registers tryInitKnowledgeService here
// at module load, so the settings endpoint can re-attempt bootstrap after
// an operator saves an embedding API key via the UI. Callback injection
// avoids a controller → db/hermes/init import cycle.
let _reinit: (() => void) | null = null

export function setKnowledgeReinit(fn: (() => void) | null): void {
  _reinit = fn
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

  const pathCheck = validateVaultPath(root_path)
  if (!pathCheck.valid) {
    ctx.status = 400
    ctx.body = { error: 'invalid_root_path', message: pathCheck.error }
    return
  }

  try {
    // Use the resolved (canonical) path so the watcher operates on
    // the same path that was validated against the blocklist.
    const vault = service.addVault(pathCheck.resolved!, name)
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

// --- Settings (embedding API key) ------------------------------------------

const SECRETS_FILE = 'knowledge-embed.env'

/**
 * GET /api/knowledge/settings — reports whether the embedding API key is
 * configured. Never returns the key itself, only its last 4 characters.
 * Reachable even when the service is not initialized (that is the whole
 * point: this is how an operator recovers from a missing key at boot).
 */
export async function getKeySettings(ctx: Context): Promise<void> {
  try {
    const config = loadKnowledgeConfig()
    ctx.body = {
      enabled: config.enabled,
      keyConfigured: Boolean(config.embedApiKey),
      keyHint: config.embedApiKey ? config.embedApiKey.slice(-4) : undefined,
      initialized: Boolean(_service),
      model: config.embedModel,
      dim: config.embedDim,
    }
  } catch (err) {
    // loadKnowledgeConfig throws when the plugin is enabled but the key
    // is missing — that is exactly the state this endpoint reports.
    if (err instanceof KnowledgeConfigError) {
      ctx.body = { enabled: true, keyConfigured: false, initialized: Boolean(_service) }
      return
    }
    throw err
  }
}

/**
 * POST /api/knowledge/settings { api_key } — persists the embedding API
 * key to $HERMES_WEB_UI_HOME/secrets/knowledge-embed.env, then re-runs
 * plugin bootstrap so the key takes effect without a server restart.
 * The key is never logged and never echoed back.
 */
export async function saveKeySettings(ctx: Context): Promise<void> {
  const body = ctx.request.body as { api_key?: string }
  const apiKey = (body.api_key ?? '').trim()

  if (apiKey.length < 8 || apiKey.length > 256 || /\s/.test(apiKey)) {
    ctx.status = 400
    ctx.body = {
      error: 'invalid_api_key',
      message: 'API key must be 8-256 characters with no whitespace',
    }
    return
  }

  const secretsDir = join(getWebUiHome(process.env), 'secrets')
  mkdirSync(secretsDir, { recursive: true })
  // 0o600 where the OS honours it (no-op on Windows).
  writeFileSync(join(secretsDir, SECRETS_FILE), `DASHSCOPE_API_KEY=${apiKey}\n`, { mode: 0o600 })

  // Re-attempt bootstrap. Failure here (e.g. invalid dim config) is
  // reported as initialized=false with the reason — the key itself is
  // saved and will be picked up on next boot.
  let reinitError: string | undefined
  if (_reinit) {
    try {
      _reinit()
    } catch (err) {
      reinitError = (err as Error).message
    }
  }

  let enabled = true
  try {
    enabled = loadKnowledgeConfig().enabled
  } catch {
    enabled = true // key is now present; enabled defaults to true path
  }

  ctx.body = { ok: true, initialized: Boolean(_service), enabled, reinitError }
}

// --- Health ---------------------------------------------------------------

export async function health(ctx: Context): Promise<void> {
  const service = getServiceOr503(ctx)
  if (!service) return
  ctx.body = service.health()
}

