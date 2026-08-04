import { logger } from './logger'

/**
 * Minimal client for the Token Platform (api.quantclaw.vip) device login APIs.
 *
 * The Hermes device renders a WeChat QR, the user scans it, and this module
 * polls the platform until the login session is approved. On approval the
 * platform returns the device's dedicated API key plus the model capabilities
 * the user's account grants. `fetchDeviceSelf` then resolves the bound user
 * profile so Hermes can sync the account locally.
 */

const DEFAULT_TIMEOUT_MS = 10_000

export interface TokenPlatformDeviceLoginRequest {
  login_id: string
  expires_at: number
  appid: string
  state: string
  redirect_uri: string
}

export type TokenPlatformDeviceLoginStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'approved'
      device: { device_id: number; name: string }
      api: { api_base: string; api_key: string; models: string[] }
    }

export interface TokenPlatformUserProfile {
  id: number
  username: string
  display_name?: string
  role?: number
  status?: number
  email?: string
  phone?: string
  wechat_id?: string
  group?: string
  quota?: number
  used_quota?: number
}

interface ApiEnvelope {
  success: boolean
  message?: string
  data?: unknown
}

async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<ApiEnvelope> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      logger.warn({ status: res.status, url }, 'Token Platform request failed')
    }
    return (json as ApiEnvelope) || { success: false, message: `HTTP ${res.status}` }
  } catch (err: any) {
    logger.warn({ err, url }, 'Token Platform request error')
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export function tokenPlatformBaseUrl(): string {
  return process.env.TOKEN_PLATFORM_BASE_URL?.trim() || 'https://api.quantclaw.vip'
}

function deviceLoginUrl(path: string): string {
  const base = tokenPlatformBaseUrl().replace(/\/+$/, '')
  return `${base}${path}`
}

/**
 * Request a new pending device login session and return the QR parameters.
 */
export async function requestDeviceLogin(
  hardwareId: string,
  deviceName: string,
): Promise<TokenPlatformDeviceLoginRequest> {
  const res = await requestJson(deviceLoginUrl('/api/device-login/request'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hardware_id: hardwareId, device_name: deviceName }),
  })
  if (!res.success || !res.data) {
    throw new Error(res.message || 'Failed to start device login')
  }
  const data = res.data as TokenPlatformDeviceLoginRequest
  if (!data?.login_id || !data.appid || !data.state) {
    throw new Error('Invalid device login response')
  }
  return data
}

/**
 * Poll the device login status until approved/expired.
 */
export async function pollDeviceLoginStatus(
  loginId: string,
): Promise<TokenPlatformDeviceLoginStatus> {
  const res = await requestJson(
    deviceLoginUrl(`/api/device-login/status?login_id=${encodeURIComponent(loginId)}`),
  )
  if (!res.success || !res.data) {
    throw new Error(res.message || 'Failed to poll device login status')
  }
  return res.data as TokenPlatformDeviceLoginStatus
}

/**
 * Fetch the bound user profile using the device's dedicated API key.
 */
export async function fetchDeviceSelf(
  apiBase: string,
  apiKey: string,
): Promise<TokenPlatformUserProfile> {
  const base = apiBase.replace(/\/+$/, '')
  const res = await requestJson(`${base}/api/device/self`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.success || !res.data) {
    throw new Error(res.message || 'Failed to fetch device profile')
  }
  return res.data as TokenPlatformUserProfile
}

/**
 * Verify a device API key against the Token Platform by fetching its models.
 * Returns the list of usable models, or throws when the key is invalid.
 */
export async function verifyDeviceApiKey(
  apiBase: string,
  apiKey: string,
): Promise<string[]> {
  const base = apiBase.replace(/\/+$/, '')
  const res = await requestJson(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.success || !res.data) {
    throw new Error(res.message || 'API key verification failed')
  }
  const data = res.data as { data?: Array<{ id?: string }> }
  const ids = (data?.data || [])
    .map(model => model?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids
}
