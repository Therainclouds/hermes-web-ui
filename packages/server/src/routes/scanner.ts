import Router from '@koa/router'
import * as ctrl from '../controllers/scanner'

/**
 * 扫描 OCR 插件路由。
 *
 * 端点列表：
 *   POST /api/scanner/ocr   — 提交图片（多页）做 DashScope Qwen-VL-OCR 识别
 *   POST /api/scanner/pdf   — 把多张扫描图打包成 PDF（图片直嵌）
 *   POST /api/scanner/save  — 把扫描图 + OCR 文本写到 Hermes profile workspace
 *
 * 必须注册在任何代理 catch-all 之前（见 routes/index.ts）。
 */
export const scannerRoutes = new Router()

scannerRoutes.post('/api/scanner/ocr', ctrl.runOcr)
scannerRoutes.post('/api/scanner/pdf', ctrl.buildPdf)
scannerRoutes.post('/api/scanner/save', ctrl.saveScan)
