import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/meeting-asr'

export const meetingASRRoutes = new Router()

// ASR service lifecycle
meetingASRRoutes.post('/api/meeting-asr/start', ctrl.startASRService)
meetingASRRoutes.post('/api/meeting-asr/stop', ctrl.stopASRService)
meetingASRRoutes.get('/api/meeting-asr/status', ctrl.getASRStatus)

// ASR service configuration
meetingASRRoutes.post('/api/meeting-asr/config', ctrl.updateASRConfig)

// Proxy to ASR backend APIs
meetingASRRoutes.get('/api/meeting-asr/healthz', ctrl.proxyHealthCheck)
meetingASRRoutes.get('/api/meeting-asr/config/current', ctrl.getCurrentConfig)
meetingASRRoutes.post('/api/meeting-asr/config/current', ctrl.updateCurrentConfig)

// Analysis APIs
meetingASRRoutes.post('/api/meeting-asr/analysis/start', ctrl.startAnalysis)
meetingASRRoutes.post('/api/meeting-asr/analysis/stop', ctrl.stopAnalysis)
meetingASRRoutes.post('/api/meeting-asr/analysis/trigger', ctrl.triggerAnalysis)
meetingASRRoutes.get('/api/meeting-asr/analysis/status', ctrl.getAnalysisStatus)
meetingASRRoutes.get('/api/meeting-asr/analysis/result', ctrl.getAnalysisResult)
meetingASRRoutes.get('/api/meeting-asr/analysis/html', ctrl.getAnalysisHTML)
meetingASRRoutes.get('/api/meeting-asr/analysis/stream', ctrl.proxyAnalysisStream)

// Scene templates
meetingASRRoutes.get('/api/meeting-asr/scenes', ctrl.getSceneTemplates)

// Realtime assist
meetingASRRoutes.post('/api/meeting-asr/assist/start', ctrl.startAssist)
meetingASRRoutes.post('/api/meeting-asr/assist/stop', ctrl.stopAssist)
meetingASRRoutes.post('/api/meeting-asr/assist/sentence', ctrl.pushAssistSentence)

// Report generation (SSE streaming)
meetingASRRoutes.post('/api/meeting-asr/report/stream', ctrl.streamReport)

// Note: transcript and prompts endpoints were removed as dead code (v0.7.6 audit #17).
// Frontend manages transcripts locally via meetingStore; prompts are configured
// via /api/meeting-asr/config and used directly by the Python analysis service.
