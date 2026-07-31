import type { Context } from 'koa'
import { meetingASRService } from '../../services/meeting-asr'
import { logger } from '../../services/logger'

async function proxyToBackend(ctx: Context, path: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<any> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return null
  }

  try {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (body && method === 'POST') {
      options.body = JSON.stringify(body)
    }
    // Follow the protocol chosen by the ASR service — see
    // MeetingASRService.useTls. Hard-coding http:// breaks device images
    // where uvicorn was spawned with --ssl-certfile.
    if (status.useTls) {
      const { Agent } = await import('node:https')
      ;(options as any).dispatcher = new Agent({ rejectUnauthorized: false })
    }
    const scheme = status.useTls ? 'https' : 'http'
    const response = await fetch(`${scheme}://127.0.0.1:${status.asrPort}${path}`, options)
    const upstreamStatus = response.status
    const upstreamBody = await response.text()

    if (path === '/api/analysis/html') {
      ctx.type = 'text/html'
      ctx.body = upstreamBody
      return null
    }

    ctx.status = upstreamStatus
    try {
      ctx.body = upstreamBody ? JSON.parse(upstreamBody) : null
    } catch {
      // Backend returned non-JSON — surface the raw body so the client still sees something useful.
      ctx.body = upstreamBody
    }
    return ctx.body
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy to ASR backend: ${err}` }
    return null
  }
}

// Service lifecycle
export async function startASRService(ctx: Context): Promise<void> {
  try {
    const config = ctx.request.body as any || {}

    // If no API key provided, check if we have it in stored config
    if (!config.dashscopeApiKey) {
      // Try to read from data directory
      const fs = await import('fs/promises')
      const path = await import('path')
      const dataDir = config.dataDir || path.join(process.cwd(), 'data', 'meeting-asr')
      const configFile = path.join(dataDir, 'config.json')

      try {
        const content = await fs.readFile(configFile, 'utf-8')
        const storedConfig = JSON.parse(content)
        if (storedConfig.asr?.dashscope_api_key) {
          config.dashscopeApiKey = storedConfig.asr.dashscope_api_key
          logger.info('[meeting-asr-ctrl] dashscopeApiKey from config.asr.dashscope_api_key')
        } else if (storedConfig.llm?.api_key) {
          // Fallback: DashScope key 同时用于 LLM 和 ASR
          config.dashscopeApiKey = storedConfig.llm.api_key
          logger.info('[meeting-asr-ctrl] dashscopeApiKey fallback from config.llm.api_key')
        } else {
          logger.warn('[meeting-asr-ctrl] no dashscopeApiKey found in any config path')
        }
        if (storedConfig.llm?.api_key) {
          config.llmApiKey = storedConfig.llm.api_key
        }
        if (storedConfig.llm?.base_url) {
          config.llmBaseUrl = storedConfig.llm.base_url
        }
        if (storedConfig.llm?.model) {
          config.llmModel = storedConfig.llm.model
        }
      } catch {
        logger.error('[meeting-asr-ctrl] failed to read config file: %s', configFile)
      }
    } else {
      logger.info('[meeting-asr-ctrl] dashscopeApiKey provided by frontend')
    }

    await meetingASRService.start(config)
    ctx.body = {
      status: 'started',
      ...meetingASRService.status,
    }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function stopASRService(ctx: Context): Promise<void> {
  try {
    await meetingASRService.stop()
    ctx.body = {
      status: 'stopped',
    }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function getASRStatus(ctx: Context): Promise<void> {
  ctx.body = meetingASRService.status
}

export async function updateASRConfig(ctx: Context): Promise<void> {
  try {
    const config = ctx.request.body as any
    await meetingASRService.updateConfig(config)
    ctx.body = { status: 'ok', message: 'Configuration updated' }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Proxy endpoints
export async function proxyHealthCheck(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/healthz')
}

export async function getCurrentConfig(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/config')
}

export async function updateCurrentConfig(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/config', 'POST', ctx.request.body)
}

// Analysis endpoints
export async function startAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/start', 'POST', ctx.request.body)
}

export async function stopAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/stop', 'POST')
}

export async function triggerAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/trigger', 'POST')
}

export async function getAnalysisStatus(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/status')
}

export async function getAnalysisResult(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/result')
}

export async function getAnalysisHTML(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/html')
}

export async function proxyAnalysisStream(ctx: Context): Promise<void> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return
  }

  ctx.type = 'text/event-stream'
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')

  try {
    const scheme = status.useTls ? 'https' : 'http'
    const init: RequestInit = {}
    if (status.useTls) {
      const { Agent } = await import('node:https')
      ;(init as any).dispatcher = new Agent({ rejectUnauthorized: false })
    }
    const response = await fetch(`${scheme}://127.0.0.1:${status.asrPort}/api/analysis/stream`, init)
    ctx.status = response.status

    // HTTP stream: fetch returns a Web ReadableStream — wrap it for Koa.
    const reader = response.body?.getReader()
    if (!reader) {
      ctx.body = null
      return
    }

    ctx.body = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
        } finally {
          controller.close()
        }
      },
    })
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy to ASR backend: ${err}` }
  }
}

// Scene templates
export async function getSceneTemplates(ctx: Context): Promise<void> {
  const { SCENE_TEMPLATES } = await import('../../services/meeting-asr/scene-templates')
  ctx.body = SCENE_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))
}

// Realtime assist
export async function startAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../../services/meeting-asr/realtime-assist')
  const { sessionId, sceneTemplate } = ctx.request.body as any || {}
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  await realtimeAssistService.startSession(sessionId, sceneTemplate || 'general')
  ctx.body = { status: 'started', sessionId, sceneTemplate: sceneTemplate || 'general' }
}

export async function stopAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../../services/meeting-asr/realtime-assist')
  const { sessionId } = ctx.request.body as any || {}
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  realtimeAssistService.stopSession(sessionId)
  ctx.body = { status: 'stopped', sessionId }
}

export async function pushAssistSentence(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../../services/meeting-asr/realtime-assist')
  const { sessionId, speaker, text, timestamp } = ctx.request.body as any || {}
  if (!sessionId || !text) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and text are required' }
    return
  }
  realtimeAssistService.pushSentence(sessionId, { speaker, text, timestamp })
  ctx.body = { status: 'ok' }
}

// Report generation (SSE streaming)
export async function streamReport(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../../services/meeting-asr/realtime-assist')
  const { sessionId, sceneTemplate, transcript } = (ctx.request.body as any) || {}

  if (!sessionId || !transcript) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and transcript are required' }
    return
  }

  ctx.type = 'text/event-stream'
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')
  ctx.status = 200

  ctx.body = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        const stream = realtimeAssistService.generateReportStream(sessionId, transcript, sceneTemplate)
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`))
      } finally {
        controller.close()
      }
    },
  })
}

// Note: transcripts and prompts were removed as dead code (v0.7.6 audit #17).
// Frontend manages transcript locally via meetingStore; prompts are configured
// via /api/meeting-asr/config and used by the Python analysis service directly.
