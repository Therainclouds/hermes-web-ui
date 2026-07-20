import type { Context } from 'koa'
import { meetingASRService } from '../../services/meeting-asr'

async function proxyToBackend(ctx: Context, path: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<any> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return null
  }

  const url = `http://127.0.0.1:${status.asrPort}${path}`

  try {
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }

    if (body && method === 'POST') {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)

    if (path === '/api/analysis/html') {
      const html = await response.text()
      ctx.type = 'text/html'
      ctx.body = html
      return null
    }

    const data = await response.json()
    ctx.status = response.status
    ctx.body = data
    return data
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
        // Config file doesn't exist yet
      }
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

  const url = `http://127.0.0.1:${status.asrPort}/api/analysis/stream`

  try {
    const response = await fetch(url)

    ctx.status = response.status
    ctx.type = 'text/event-stream'
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('Connection', 'keep-alive')

    // Stream the response
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

// Note: transcripts and prompts were removed as dead code (v0.7.6 audit #17).
// Frontend manages transcript locally via meetingStore; prompts are configured
// via /api/meeting-asr/config and used by the Python analysis service directly.
