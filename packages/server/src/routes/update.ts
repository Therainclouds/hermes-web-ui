import Router from '@koa/router'
import * as ctrl from '../controllers/update'

export const updateRoutes = new Router()

// Web UI self-update is exposed to any logged-in user, matching the "normal
// software" UX where anyone can click update and the service installs the
// new version and restarts itself. Admin-only update flows live under
// /api/hermes/update/preview/* when needed.
updateRoutes.post('/api/hermes/update', ctrl.handleUpdate)
updateRoutes.post('/api/hermes/update/reconcile', ctrl.reconcileUpdate)
updateRoutes.get('/api/hermes/update/environment', ctrl.getUpdateEnvironment)
updateRoutes.get('/api/hermes/update/status', ctrl.updateStatus)
updateRoutes.get('/api/hermes/update/capabilities', ctrl.updateCapabilities)
updateRoutes.post('/api/hermes/update/status/clear-stale', ctrl.clearStaleUpdateStatus)
updateRoutes.get('/api/hermes/update/preview', ctrl.previewStatus)
updateRoutes.get('/api/hermes/update/preview/tags', ctrl.previewTags)
updateRoutes.post('/api/hermes/update/preview/prepare', ctrl.preparePreview)
updateRoutes.post('/api/hermes/update/preview/install', ctrl.installPreview)
updateRoutes.post('/api/hermes/update/preview/start', ctrl.startPreview)
updateRoutes.post('/api/hermes/update/preview/stop', ctrl.stopPreview)
