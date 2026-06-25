import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/experts'

export const expertsRoutes = new Router()

expertsRoutes.get('/api/hermes/experts/config', ctrl.getConfig)
expertsRoutes.get('/api/hermes/experts/catalog', ctrl.getCatalog)
expertsRoutes.post('/api/hermes/experts/catalog/refresh', ctrl.refreshCatalog)
expertsRoutes.get('/api/hermes/experts/:slug/detail', ctrl.getDetail)
expertsRoutes.get('/api/hermes/experts/:slug/versions/:version/manifest', ctrl.getManifest)
expertsRoutes.get('/api/hermes/experts/installed', ctrl.getInstalled)
expertsRoutes.post('/api/hermes/experts/install', ctrl.installExpert)
expertsRoutes.post('/api/hermes/experts/:slug/upgrade', ctrl.upgradeExpert)
expertsRoutes.post('/api/hermes/experts/:slug/uninstall', ctrl.uninstallExpert)
expertsRoutes.get('/api/hermes/experts/:slug/status', ctrl.getStatus)
expertsRoutes.get('/api/hermes/experts/profile-binding/:name', ctrl.getBindingForProfile)
expertsRoutes.post('/api/hermes/experts/activate-profile', ctrl.activateProfile)
