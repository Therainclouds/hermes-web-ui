import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/meeting-storage'

export const meetingStorageRoutes = new Router()

// Meeting metadata
meetingStorageRoutes.get('/api/meeting-storage/:meetingId', ctrl.getMeeting)
meetingStorageRoutes.put('/api/meeting-storage/:meetingId', ctrl.saveMeeting)
meetingStorageRoutes.delete('/api/meeting-storage/:meetingId', ctrl.deleteMeeting)
meetingStorageRoutes.get('/api/meeting-storage', ctrl.listMeetings)

// Audio
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/audio', ctrl.uploadAudio)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/audio', ctrl.downloadAudio)

// Transcript
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/transcript', ctrl.saveTranscript)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/transcript', ctrl.getTranscript)

// JSON report
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/json', ctrl.saveJsonReport)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/json', ctrl.downloadJsonReport)

// HTML report
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/html', ctrl.saveHtmlReport)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/html', ctrl.downloadHtmlReport)

import * as recap from '../../controllers/trpg-recap'
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/recaps', recap.list)
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/recaps', recap.save)
meetingStorageRoutes.delete('/api/meeting-storage/:meetingId/recaps/:recapId', recap.remove)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/recaps/:recapId/markdown', recap.markdown)
// Chronicle illustrations (cover / per-chapter content), stored beside the Markdown.
meetingStorageRoutes.put('/api/meeting-storage/:meetingId/recaps/:recapId/images/:kind', recap.saveImage)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/recaps/:recapId/images/:kind', recap.image)

meetingStorageRoutes.get('/api/meeting-storage/:meetingId/novel-jobs', recap.novelJobs)
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/novel-jobs', recap.novelStart)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/novel-jobs/:jobId', recap.novelGet)
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/novel-jobs/:jobId/resume', recap.novelResume)
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/novel-jobs/:jobId/cancel', recap.novelCancel)

meetingStorageRoutes.get('/api/meeting-storage/:meetingId/novel-jobs/:jobId/workbench', recap.novelWorkbench)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/novel-jobs/:jobId/artifacts/:artifact', recap.novelArtifact)
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/novel-jobs/:jobId/artifacts/:artifact', recap.novelArtifactUpdate)
meetingStorageRoutes.get('/api/meeting-storage/:meetingId/novel-jobs/:jobId/evidence', recap.novelEvidence)
meetingStorageRoutes.post('/api/meeting-storage/:meetingId/novel-jobs/:jobId/pause', recap.novelPause)
meetingStorageRoutes.patch('/api/meeting-storage/:meetingId/novel-jobs/:jobId/controls', recap.novelConfigure)

meetingStorageRoutes.post('/api/meeting-storage/:meetingId/novel-jobs/:jobId/visual-match', recap.novelVisual)
