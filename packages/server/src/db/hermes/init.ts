/**
 * Unified initializer for all Hermes SQLite stores.
 * Call this once at bootstrap to create/migrate all tables.
 *
 * All table schemas, creation, and migration logic are now centralized
 * in schemas.ts to avoid duplication and ensure consistency.
 *
 * The knowledge plugin (vaults / chunks / FTS5 / vec0) is also wired
 * here: it lives in its own file (knowledge-schema.ts) but needs the
 * shared connection, so bootstrap() calls into it from this module.
 * Root-cause fix 2026-09-10: previously the knowledge plugin was
 * mounted on routes/index.ts but its service was never instantiated,
 * which made every /api/knowledge/* endpoint throw 500.
 */

import { initAllHermesTables } from './schemas'
import { getDb } from '../index'
import { loadKnowledgeConfig } from '../../services/knowledge/config'
import { KnowledgeService } from '../../services/knowledge/knowledge.service'
import { initKnowledgeRoutes } from '../../routes/knowledge'
import {
  setKnowledgeService,
} from '../../controllers/knowledge'

// Module-level handle for subsequent wiring (e.g., future Socket.IO
// integration for ingest events). Null when the plugin is disabled
// or bootstrap failed.
let _knowledgeService: KnowledgeService | null = null

export function getKnowledgeService(): KnowledgeService | null {
  return _knowledgeService
}

/**
 * Bootstrap the knowledge plugin:
 *   1. If KNOWLEDGE_ENABLED is not truthy → skip (plugin stays off).
 *   2. Load + validate KnowledgeConfig.
 *   3. On the shared SQLite connection, ensure schema is bootstrapped
 *      (which now returns vecAvailability — vec0 load is graceful).
 *   4. Construct KnowledgeService and inject into controllers + routes.
 *
 * Any failure is caught and logged — the host server keeps booting.
 * Controllers fall back to 503 via getServiceOr503().
 */
function tryInitKnowledgeService(): void {
  // eslint-disable-next-line no-console
  const log = (msg: string, ...rest: unknown[]) => console.log(`[bootstrap] ${msg}`, ...rest)
  // eslint-disable-next-line no-console
  const warn = (msg: string, ...rest: unknown[]) => console.warn(`[bootstrap] ${msg}`, ...rest)

  try {
    const config = loadKnowledgeConfig()
    if (!config.enabled) {
      log('knowledge plugin disabled (KNOWLEDGE_ENABLED is falsy)')
      return
    }

    const db = getDb()
    if (!db) {
      warn('knowledge plugin skipped: SQLite backend not available (Node <22.5)')
      return
    }

    const service = new KnowledgeService(db, config)
    const status = service.init()

    if (!status.vecAvailable) {
      warn(
        `knowledge plugin running without vec0: ${status.vecReason ?? 'unknown'}. ` +
          'FTS5 keyword search will work; vector search and ingest are disabled.'
      )
    } else {
      log(`knowledge plugin initialized (vec0 dim=${config.embedDim})`)
    }

    initKnowledgeRoutes(service)
    // Note: initKnowledgeRoutes already calls setKnowledgeService internally.
    _knowledgeService = service
  } catch (err) {
    warn(
      'failed to initialize knowledge plugin:',
      err instanceof Error ? err.message : err,
    )
  }
}

export function initAllStores(): void {
  // Initialize all tables with centralized schema definitions and migrations
  initAllHermesTables()

  // Bootstrap the knowledge plugin on the shared connection. Must run
  // AFTER initAllHermesTables (the shared DB handle is set up there).
  tryInitKnowledgeService()
}
