import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/user-auth'
import { provision, status } from '../controllers/xiaozhi'
import { uploadCameraPhoto, captureCameraPhoto, getCameraPhoto } from '../controllers/xiaozhi-camera'
export const xiaozhiPublicRoutes = new Router()
xiaozhiPublicRoutes.get('/api/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/xiaozhi/camera/upload', uploadCameraPhoto)
export const xiaozhiProtectedRoutes = new Router()
xiaozhiProtectedRoutes.get('/api/xiaozhi/status', requireSuperAdmin, status)
xiaozhiProtectedRoutes.post('/api/xiaozhi/camera/capture', requireSuperAdmin, captureCameraPhoto)
xiaozhiProtectedRoutes.get('/api/xiaozhi/photos/:id', requireSuperAdmin, getCameraPhoto)
