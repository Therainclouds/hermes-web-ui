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

// Transcript APIs
meetingASRRoutes.post('/api/meeting-asr/transcript', ctrl.addTranscript)
meetingASRRoutes.get('/api/meeting-asr/transcript', ctrl.getTranscript)
meetingASRRoutes.post('/api/meeting-asr/transcript/clear', ctrl.clearTranscript)

// Prompts
meetingASRRoutes.get('/api/meeting-asr/prompts', ctrl.getPrompts)
