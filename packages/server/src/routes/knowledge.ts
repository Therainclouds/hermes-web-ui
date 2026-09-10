/**
 * Knowledge plugin — route registration.
 *
 * Mounts all /api/knowledge/* endpoints. Must be registered before
 * any proxy catch-all (AGENTS.md rule).
 */

import Router from '@koa/router'
import * as ctrl from '../controllers/knowledge'
import type { KnowledgeService } from '../services/knowledge/knowledge.service'

export const knowledgeRoutes = new Router()

/**
 * Initialize the knowledge routes with a service instance.
 * Must be called before the routes are mounted.
 */
export function initKnowledgeRoutes(service: KnowledgeService): void {
  ctrl.setKnowledgeService(service)
}

// --- Management endpoints (§5.1) ---

knowledgeRoutes.get('/api/knowledge/vaults', ctrl.listVaults)
knowledgeRoutes.post('/api/knowledge/vaults', ctrl.createVault)
knowledgeRoutes.delete('/api/knowledge/vaults/:id', ctrl.deleteVault)

knowledgeRoutes.get('/api/knowledge/documents', ctrl.listDocuments)
knowledgeRoutes.get('/api/knowledge/documents/:id', ctrl.getDocument)
knowledgeRoutes.delete('/api/knowledge/documents/:id', ctrl.deleteDocument)

knowledgeRoutes.post('/api/knowledge/reindex', ctrl.reindex)

// --- Search (§5.2) ---

knowledgeRoutes.post('/api/knowledge/search', ctrl.searchKnowledge)

// --- Health ---

knowledgeRoutes.get('/api/knowledge/health', ctrl.health)
