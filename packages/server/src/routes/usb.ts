import Router from '@koa/router'
import * as ctrl from '../controllers/usb'

export const usbRoutes = new Router()

usbRoutes.get('/api/usb/devices', ctrl.listUSBDevices)
usbRoutes.get('/api/usb/history', ctrl.listUSBHistory)
usbRoutes.get('/api/usb/devices/:uuid/ls', ctrl.listUSBFiles)
usbRoutes.get('/api/usb/devices/:uuid/stat', ctrl.statUSBPath)
usbRoutes.get('/api/usb/devices/:uuid/read', ctrl.readUSBFile)
usbRoutes.get('/api/usb/devices/:uuid/disk-usage', ctrl.usbDiskUsage)
usbRoutes.post('/api/usb/devices/:uuid/copy-to-workspace', ctrl.copyUSBFileToWorkspace)
