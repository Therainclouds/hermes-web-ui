import http from 'http'
import https from 'https'

export type UpdateNetworkTransport = 'fetch' | 'node-http'
export type UpdateNetworkResponseType = 'json' | 'binary'

export interface UpdateNetworkResponse {
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  buffer: Buffer
}

export interface UpdateNetworkErrorDetail {
  name: string
  message: string
  code?: string
  syscall?: string
  address?: string
  port?: number
}

export class UpdateNetworkError extends Error {
  url: string
  responseType: UpdateNetworkResponseType
  timeoutMs: number
  primaryError: UpdateNetworkErrorDetail
  fallbackError: UpdateNetworkErrorDetail

  constructor(
    url: string,
    responseType: UpdateNetworkResponseType,
    timeoutMs: number,
    primaryError: UpdateNetworkErrorDetail,
    fallbackError: UpdateNetworkErrorDetail,
  ) {
    super(
      `${responseType} request failed for ${url}: fetch failed (${primaryError.message}); `
      + `node-http fallback failed (${fallbackError.message})`,
    )
    this.name = 'UpdateNetworkError'
    this.url = url
    this.responseType = responseType
    this.timeoutMs = timeoutMs
    this.primaryError = primaryError
    this.fallbackError = fallbackError
  }
}

function toNetworkErrorDetail(err: any): UpdateNetworkErrorDetail {
  return {
    name: String(err?.name || 'Error'),
    message: String(err?.message || err || 'request failed'),
    code: typeof err?.code === 'string' ? err.code : undefined,
    syscall: typeof err?.syscall === 'string' ? err.syscall : undefined,
    address: typeof err?.address === 'string' ? err.address : undefined,
    port: typeof err?.port === 'number' ? err.port : undefined,
  }
}

function buildAcceptHeader(responseType: UpdateNetworkResponseType): string {
  return responseType === 'json' ? 'application/json' : 'application/octet-stream, */*'
}

async function requestWithFetch(
  url: string,
  responseType: UpdateNetworkResponseType,
  timeoutMs: number,
): Promise<UpdateNetworkResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader(responseType),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      redirect: 'follow',
      signal: controller.signal,
    })

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      transport: 'fetch',
      buffer: Buffer.from(await response.arrayBuffer()),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function requestWithNodeHttp(
  url: string,
  responseType: UpdateNetworkResponseType,
  timeoutMs: number,
  redirectCount = 0,
): Promise<UpdateNetworkResponse> {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading update resource: ${url}`))
  }

  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader(responseType),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0
      const location = res.headers.location

      if (status >= 300 && status < 400 && typeof location === 'string' && location.trim()) {
        res.resume()
        const redirectedUrl = new URL(location, target).toString()
        requestWithNodeHttp(redirectedUrl, responseType, timeoutMs, redirectCount + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => {
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url,
          transport: 'node-http',
          buffer: Buffer.concat(chunks),
        })
      })
    })

    req.on('timeout', () => {
      const err = new Error(`request timed out after ${timeoutMs}ms`) as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', reject)
    req.end()
  })
}

async function requestUpdateResource(
  url: string,
  responseType: UpdateNetworkResponseType,
  timeoutMs: number,
): Promise<UpdateNetworkResponse> {
  try {
    return await requestWithFetch(url, responseType, timeoutMs)
  } catch (err: any) {
    const primaryError = toNetworkErrorDetail(err)
    try {
      return await requestWithNodeHttp(url, responseType, timeoutMs)
    } catch (fallbackErr: any) {
      throw new UpdateNetworkError(
        url,
        responseType,
        timeoutMs,
        primaryError,
        toNetworkErrorDetail(fallbackErr),
      )
    }
  }
}

export async function fetchUpdateJson(url: string, timeoutMs = 10_000): Promise<{
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  data: unknown
}> {
  const response = await requestUpdateResource(url, 'json', timeoutMs)
  const raw = response.buffer.toString('utf-8')
  const data = raw ? JSON.parse(raw) : {}
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    transport: response.transport,
    data,
  }
}

export async function fetchUpdateBinary(url: string, timeoutMs = 60_000): Promise<UpdateNetworkResponse> {
  return requestUpdateResource(url, 'binary', timeoutMs)
}

export function describeUpdateNetworkError(err: unknown): Record<string, unknown> | null {
  if (err instanceof UpdateNetworkError) {
    return {
      message: err.message,
      url: err.url,
      responseType: err.responseType,
      timeoutMs: err.timeoutMs,
      primary: err.primaryError,
      fallback: err.fallbackError,
    }
  }

  if (!err) return null
  return { message: String((err as any)?.message || err) }
}
