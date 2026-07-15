import http from 'http'
import https from 'https'
import { createHash } from 'crypto'
import { rmSync, createWriteStream } from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'

export type UpdateNetworkTransport = 'fetch' | 'node-http'
export type UpdateNetworkResponseType = 'json' | 'binary'

export interface UpdateNetworkResponse {
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  buffer: Buffer
  attempts: number
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
  attempts: number
  primaryError: UpdateNetworkErrorDetail
  fallbackError: UpdateNetworkErrorDetail

  constructor(
    url: string,
    responseType: UpdateNetworkResponseType,
    timeoutMs: number,
    attempts: number,
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
    this.attempts = attempts
    this.primaryError = primaryError
    this.fallbackError = fallbackError
  }
}

export interface UpdateNetworkRequestOptions {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
}

export interface UpdateBinaryDownloadOptions extends UpdateNetworkRequestOptions {
  expectedBytes?: number
  expectedSha256?: string
}

export interface UpdateBinaryDownloadResult {
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  attempts: number
  bytesWritten: number
  sha256: string
}

export type UpdateBinaryValidationReason =
  | 'content_length_mismatch'
  | 'size_exceeded'
  | 'size_mismatch'
  | 'sha256_mismatch'

export class UpdateBinaryValidationError extends Error {
  url: string
  reason: UpdateBinaryValidationReason
  expectedBytes?: number
  actualBytes?: number
  expectedSha256?: string
  actualSha256?: string

  constructor(
    url: string,
    reason: UpdateBinaryValidationReason,
    message: string,
    details: {
      expectedBytes?: number
      actualBytes?: number
      expectedSha256?: string
      actualSha256?: string
    } = {},
  ) {
    super(message)
    this.name = 'UpdateBinaryValidationError'
    this.url = url
    this.reason = reason
    this.expectedBytes = details.expectedBytes
    this.actualBytes = details.actualBytes
    this.expectedSha256 = details.expectedSha256
    this.actualSha256 = details.actualSha256
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

function parseContentLength(value: string | null | undefined): number | undefined {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function validateContentLength(url: string, contentLength: number | undefined, expectedBytes: number | undefined): void {
  if (expectedBytes == null || contentLength == null) return
  if (contentLength !== expectedBytes) {
    throw new UpdateBinaryValidationError(
      url,
      'content_length_mismatch',
      `Downloaded update binary size header mismatch for ${url}: expected ${expectedBytes} bytes but server announced ${contentLength}.`,
      {
        expectedBytes,
        actualBytes: contentLength,
      },
    )
  }
}

async function writeBinaryPayloadToFile(
  source: NodeJS.ReadableStream,
  targetFile: string,
  url: string,
  expectedBytes?: number,
  expectedSha256?: string,
): Promise<{ bytesWritten: number; sha256: string }> {
  let bytesWritten = 0
  const hash = createHash('sha256')
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesWritten += buffer.length
      if (expectedBytes != null && bytesWritten > expectedBytes) {
        callback(new UpdateBinaryValidationError(
          url,
          'size_exceeded',
          `Downloaded update binary exceeded the expected size for ${url}: expected ${expectedBytes} bytes but received more.`,
          {
            expectedBytes,
            actualBytes: bytesWritten,
          },
        ))
        return
      }
      hash.update(buffer)
      callback(null, buffer)
    },
  })

  try {
    await pipeline(source, validator, createWriteStream(targetFile))
    const sha256 = hash.digest('hex')
    if (expectedBytes != null && bytesWritten !== expectedBytes) {
      throw new UpdateBinaryValidationError(
        url,
        'size_mismatch',
        `Downloaded update binary size mismatch for ${url}: expected ${expectedBytes} bytes but received ${bytesWritten}.`,
        {
          expectedBytes,
          actualBytes: bytesWritten,
        },
      )
    }
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new UpdateBinaryValidationError(
        url,
        'sha256_mismatch',
        `Downloaded update binary checksum mismatch for ${url}.`,
        {
          expectedSha256,
          actualSha256: sha256,
          actualBytes: bytesWritten,
          expectedBytes,
        },
      )
    }
    return { bytesWritten, sha256 }
  } catch (error) {
    rmSync(targetFile, { force: true })
    throw error
  }
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
      attempts: 1,
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
          attempts: 1,
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
  attempts = 1,
): Promise<UpdateNetworkResponse> {
  try {
    const response = await requestWithFetch(url, responseType, timeoutMs)
    return { ...response, attempts }
  } catch (err: any) {
    const primaryError = toNetworkErrorDetail(err)
    try {
      const response = await requestWithNodeHttp(url, responseType, timeoutMs)
      return { ...response, attempts }
    } catch (fallbackErr: any) {
      throw new UpdateNetworkError(
        url,
        responseType,
        timeoutMs,
        attempts,
        primaryError,
        toNetworkErrorDetail(fallbackErr),
      )
    }
  }
}

function normalizeRequestOptions(
  optionsOrTimeout: UpdateNetworkRequestOptions | number | undefined,
  defaultTimeoutMs: number,
): Required<UpdateNetworkRequestOptions> {
  if (typeof optionsOrTimeout === 'number') {
    return {
      timeoutMs: optionsOrTimeout,
      retries: 0,
      retryDelayMs: 0,
    }
  }

  return {
    timeoutMs: Math.max(optionsOrTimeout?.timeoutMs ?? defaultTimeoutMs, 1),
    retries: Math.max(optionsOrTimeout?.retries ?? 0, 0),
    retryDelayMs: Math.max(optionsOrTimeout?.retryDelayMs ?? 0, 0),
  }
}

function shouldRetryResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function delayForRetry(baseDelayMs: number, attempt: number): Promise<void> {
  const delayMs = Math.max(baseDelayMs, 0) * Math.max(attempt, 1)
  if (delayMs <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

async function requestUpdateResourceWithRetry(
  url: string,
  responseType: UpdateNetworkResponseType,
  optionsOrTimeout: UpdateNetworkRequestOptions | number | undefined,
  defaultTimeoutMs: number,
): Promise<UpdateNetworkResponse> {
  const options = normalizeRequestOptions(optionsOrTimeout, defaultTimeoutMs)
  const maxAttempts = options.retries + 1
  let lastError: unknown = null
  let lastResponse: UpdateNetworkResponse | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await requestUpdateResource(url, responseType, options.timeoutMs, attempt)
      if (response.ok || !shouldRetryResponse(response.status) || attempt === maxAttempts) {
        return response
      }
      lastResponse = response
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        throw error
      }
    }

    await delayForRetry(options.retryDelayMs, attempt)
  }

  if (lastResponse) {
    return lastResponse
  }
  throw lastError ?? new Error(`request failed for ${url}`)
}

export async function fetchUpdateJson(url: string, optionsOrTimeout?: UpdateNetworkRequestOptions | number): Promise<{
  ok: boolean
  status: number
  url: string
  transport: UpdateNetworkTransport
  data: unknown
  attempts: number
}> {
  const response = await requestUpdateResourceWithRetry(url, 'json', optionsOrTimeout, 10_000)
  const raw = response.buffer.toString('utf-8')
  const data = raw ? JSON.parse(raw) : {}
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    transport: response.transport,
    data,
    attempts: response.attempts,
  }
}

export async function fetchUpdateBinary(
  url: string,
  optionsOrTimeout?: UpdateNetworkRequestOptions | number,
): Promise<UpdateNetworkResponse> {
  return requestUpdateResourceWithRetry(url, 'binary', optionsOrTimeout, 60_000)
}

async function downloadWithFetchToFile(
  url: string,
  targetFile: string,
  options: Required<UpdateNetworkRequestOptions> & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>,
): Promise<UpdateBinaryDownloadResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader('binary'),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const contentLength = parseContentLength(response.headers?.get?.('content-length'))
    if (!response.ok) {
      response.body?.cancel?.().catch(() => {})
      return {
        ok: false,
        status: response.status,
        url: response.url || url,
        transport: 'fetch',
        attempts: 1,
        bytesWritten: 0,
        sha256: '',
      }
    }
    validateContentLength(response.url || url, contentLength, options.expectedBytes)
    const bodyStream = response.body
      // Node's fromWeb expects the stream/web definition, while fetch() here is typed
      // against the global Web stream. Bridge the types without changing runtime behavior.
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream)
      : Readable.from([Buffer.from(await response.arrayBuffer())])
    const result = await writeBinaryPayloadToFile(
      bodyStream,
      targetFile,
      response.url || url,
      options.expectedBytes,
      options.expectedSha256,
    )
    return {
      ok: true,
      status: response.status,
      url: response.url || url,
      transport: 'fetch',
      attempts: 1,
      ...result,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function downloadWithNodeHttpToFile(
  url: string,
  targetFile: string,
  options: Required<UpdateNetworkRequestOptions> & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>,
  redirectCount = 0,
): Promise<UpdateBinaryDownloadResult> {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading update resource: ${url}`))
  }

  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'GET',
      headers: {
        Accept: buildAcceptHeader('binary'),
        'User-Agent': 'hermes-web-ui-update-client',
      },
      timeout: options.timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0
      const location = res.headers.location

      if (status >= 300 && status < 400 && typeof location === 'string' && location.trim()) {
        res.resume()
        const redirectedUrl = new URL(location, target).toString()
        downloadWithNodeHttpToFile(redirectedUrl, targetFile, options, redirectCount + 1)
          .then(resolve)
          .catch(reject)
        return
      }

      if (status < 200 || status >= 300) {
        res.resume()
        resolve({
          ok: false,
          status,
          url,
          transport: 'node-http',
          attempts: 1,
          bytesWritten: 0,
          sha256: '',
        })
        return
      }

      try {
        validateContentLength(url, parseContentLength(typeof res.headers['content-length'] === 'string' ? res.headers['content-length'] : undefined), options.expectedBytes)
      } catch (error) {
        res.resume()
        reject(error)
        return
      }

      writeBinaryPayloadToFile(res, targetFile, url, options.expectedBytes, options.expectedSha256)
        .then(result => resolve({
          ok: true,
          status,
          url,
          transport: 'node-http',
          attempts: 1,
          ...result,
        }))
        .catch(reject)
    })

    req.on('timeout', () => {
      const err = new Error(`request timed out after ${options.timeoutMs}ms`) as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', reject)
    req.end()
  })
}

async function downloadUpdateBinaryToFileAttempt(
  url: string,
  targetFile: string,
  options: Required<UpdateNetworkRequestOptions> & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>,
  attempts = 1,
): Promise<UpdateBinaryDownloadResult> {
  try {
    const response = await downloadWithFetchToFile(url, targetFile, options)
    return { ...response, attempts }
  } catch (err: any) {
    if (err instanceof UpdateBinaryValidationError) {
      throw err
    }
    const primaryError = toNetworkErrorDetail(err)
    try {
      const response = await downloadWithNodeHttpToFile(url, targetFile, options)
      return { ...response, attempts }
    } catch (fallbackErr: any) {
      throw new UpdateNetworkError(
        url,
        'binary',
        options.timeoutMs,
        attempts,
        primaryError,
        toNetworkErrorDetail(fallbackErr),
      )
    }
  }
}

export async function downloadUpdateBinaryToFile(
  url: string,
  targetFile: string,
  optionsOrTimeout?: UpdateBinaryDownloadOptions | number,
): Promise<UpdateBinaryDownloadResult> {
  const options = normalizeRequestOptions(optionsOrTimeout, 60_000) as Required<UpdateNetworkRequestOptions>
    & Pick<UpdateBinaryDownloadOptions, 'expectedBytes' | 'expectedSha256'>
  if (typeof optionsOrTimeout !== 'number') {
    options.expectedBytes = typeof optionsOrTimeout?.expectedBytes === 'number' && optionsOrTimeout.expectedBytes > 0
      ? optionsOrTimeout.expectedBytes
      : undefined
    options.expectedSha256 = typeof optionsOrTimeout?.expectedSha256 === 'string' && optionsOrTimeout.expectedSha256.trim()
      ? optionsOrTimeout.expectedSha256.trim().toLowerCase()
      : undefined
  }

  const maxAttempts = options.retries + 1
  let lastError: unknown = null
  let lastResponse: UpdateBinaryDownloadResult | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await downloadUpdateBinaryToFileAttempt(url, targetFile, options, attempt)
      if (response.ok || !shouldRetryResponse(response.status) || attempt === maxAttempts) {
        return response
      }
      lastResponse = response
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        throw error
      }
    }

    await delayForRetry(options.retryDelayMs, attempt)
  }

  if (lastResponse) {
    return lastResponse
  }
  throw lastError ?? new Error(`request failed for ${url}`)
}

export function describeUpdateNetworkError(err: unknown): Record<string, unknown> | null {
  if (err instanceof UpdateNetworkError) {
    return {
      message: err.message,
      url: err.url,
      responseType: err.responseType,
      timeoutMs: err.timeoutMs,
      attempts: err.attempts,
      primary: err.primaryError,
      fallback: err.fallbackError,
    }
  }

  if (err instanceof UpdateBinaryValidationError) {
    return {
      message: err.message,
      url: err.url,
      reason: err.reason,
      expectedBytes: err.expectedBytes,
      actualBytes: err.actualBytes,
      expectedSha256: err.expectedSha256,
      actualSha256: err.actualSha256,
    }
  }

  if (!err) return null
  return { message: String((err as any)?.message || err) }
}
