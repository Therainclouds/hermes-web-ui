import type { Context } from 'koa'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
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
    // HTTP path uses Node's native fetch (cert verification isn't a concern).
    // HTTPS path must use node:https with rejectUnauthorized:false because the
    // ASR backend is fronted by a self-signed cert generated at start time.
    let upstreamStatus: number
    let upstreamBody: string

    if (status.https) {
      const reqBody = body && method === 'POST' ? JSON.stringify(body) : undefined
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port: status.asrPort!,
            path,
            method,
            rejectUnauthorized: false,
            headers: {
              'Content-Type': 'application/json',
              ...(reqBody ? { 'Content-Length': Buffer.byteLength(reqBody) } : {}),
            },
            timeout: 30000,
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
            )
          },
        )
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('upstream timeout'))
        })
        if (reqBody) req.write(reqBody)
        req.end()
      })
      upstreamStatus = result.status
      upstreamBody = result.body
    } else {
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      }
      if (body && method === 'POST') {
        options.body = JSON.stringify(body)
      }
      const response = await fetch(`http://127.0.0.1:${status.asrPort}${path}`, options)
      upstreamStatus = response.status
      upstreamBody = await response.text()
    }

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
    if (status.https) {
      // HTTPS stream: node:https IncomingMessage is a Node Readable; hand it
      // straight to Koa which will pipe it to ctx.res.
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port: status.asrPort!,
            path: '/api/analysis/stream',
            method: 'GET',
            rejectUnauthorized: false,
            timeout: 30000,
          },
          resolve,
        )
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('upstream timeout'))
        })
        req.end()
      })
      ctx.status = upstream.statusCode ?? 502
      ctx.body = upstream as unknown as NodeJS.ReadableStream
      return
    }

    const response = await fetch(`http://127.0.0.1:${status.asrPort}/api/analysis/stream`)
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

// Note: transcripts and prompts were removed as dead code (v0.7.6 audit #17).
// Frontend manages transcript locally via meetingStore; prompts are configured
// via /api/meeting-asr/config and used by the Python analysis service directly.
