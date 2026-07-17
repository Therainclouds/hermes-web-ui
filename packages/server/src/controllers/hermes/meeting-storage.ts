import type { Context } from 'koa'
import { meetingStorageService } from '../../services/meeting-storage'
import fs from 'fs/promises'

// Meeting metadata
export async function getMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = await meetingStorageService.getMeetingMetadata(meetingId)
  if (!data) {
    ctx.status = 404
    ctx.body = { error: 'Meeting not found' }
    return
  }
  ctx.body = data
}

export async function saveMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = ctx.request.body
  await meetingStorageService.saveMeetingMetadata(meetingId, data)
  ctx.body = { status: 'ok', message: 'Meeting saved' }
}

export async function deleteMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await meetingStorageService.deleteMeeting(meetingId)
  ctx.body = { status: 'ok', message: 'Meeting deleted' }
}

export async function listMeetings(ctx: Context): Promise<void> {
  const meetings = await meetingStorageService.listMeetings()
  ctx.body = { meetings }
}

// Audio
export async function uploadAudio(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  
  try {
    const chunks: Buffer[] = []
    const body = ctx.req
    
    // Read the raw body as buffer
    const chunks2: Buffer[] = []
    for await (const chunk of body) {
      chunks2.push(chunk)
    }
    const audioBuffer = Buffer.concat(chunks2)
    
    const filePath = await meetingStorageService.saveAudio(meetingId, audioBuffer)
    ctx.body = { status: 'ok', path: filePath }
  } catch (err) {
    ctx.status = 500
    ctx.body = { error: `Failed to upload audio: ${err}` }
  }
}

export async function downloadAudio(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const audioPath = await meetingStorageService.getAudioPath(meetingId)
  
  if (!audioPath) {
    ctx.status = 404
    ctx.body = { error: 'Audio not found' }
    return
  }

  try {
    const buffer = await fs.readFile(audioPath)
    const fileName = audioPath.split('/').pop() || 'recording.webm'
    
    ctx.type = 'audio/webm'
    ctx.set('Content-Disposition', `attachment; filename="${fileName}"`)
    ctx.body = buffer
  } catch (err) {
    ctx.status = 500
    ctx.body = { error: `Failed to read audio: ${err}` }
  }
}

// Transcript
export async function saveTranscript(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const sentences = ctx.request.body
  await meetingStorageService.saveTranscript(meetingId, sentences)
  ctx.body = { status: 'ok', message: 'Transcript saved' }
}

export async function getTranscript(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const sentences = await meetingStorageService.getTranscript(meetingId)
  ctx.body = { sentences }
}

// JSON report
export async function saveJsonReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = ctx.request.body
  await meetingStorageService.saveJsonReport(meetingId, data)
  ctx.body = { status: 'ok', message: 'JSON report saved' }
}

export async function downloadJsonReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = await meetingStorageService.getJsonReport(meetingId)
  
  if (!data) {
    ctx.status = 404
    ctx.body = { error: 'JSON report not found' }
    return
  }

  ctx.type = 'application/json'
  ctx.set('Content-Disposition', `attachment; filename="${meetingId}.json"`)
  ctx.body = data
}

// HTML report
export async function saveHtmlReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const { html } = ctx.request.body
  await meetingStorageService.saveHtmlReport(meetingId, html)
  ctx.body = { status: 'ok', message: 'HTML report saved' }
}

export async function downloadHtmlReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const html = await meetingStorageService.getHtmlReport(meetingId)
  
  if (!html) {
    ctx.status = 404
    ctx.body = { error: 'HTML report not found' }
    return
  }

  ctx.type = 'text/html'
  ctx.set('Content-Disposition', `attachment; filename="${meetingId}_report.html"`)
  ctx.body = html
}
