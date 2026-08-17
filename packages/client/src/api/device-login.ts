import { request } from './client'

export interface TokenPlatformDeviceLoginRequest {
  login_id: string
  expires_at: number
  appid: string
  scope?: string
  state: string
  redirect_uri: string
  style?: string
}

export type TokenPlatformDeviceLoginStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'approved'
      device: { device_id: number; name: string }
      api: { api_base: string; api_key: string; models: string[] }
    }

export interface HermesDeviceLoginPayload {
  api_base: string
  api_key: string
  device_id: number | string
  device_name?: string
  models?: string[]
}

export interface HermesDeviceLoginResult {
  token: string
  user: {
    id: number
    username: string
    role: string
    display_name?: string
    bound_models?: string[]
  }
  binding?: {
    device_id: string
    display_name: string
  }
}

export interface HermesDeviceBindingStatus {
  bound: boolean
  display_name?: string
  username?: string
  models?: string[]
  bound_at?: number
}

function tokenPlatformBaseUrl(): string {
  return (
    (import.meta.env.VITE_TOKEN_PLATFORM_BASE_URL as string | undefined)?.trim() ||
    'https://api.quantclaw.vip'
  )
}

/**
 * Request a pending Token Platform device login session and return the QR
 * parameters. Called directly from the browser (CORS is open on the platform).
 */
export async function requestTokenPlatformDeviceLogin(
  hardwareId: string,
  deviceName: string,
): Promise<TokenPlatformDeviceLoginRequest> {
  const res = await fetch(
    `${tokenPlatformBaseUrl()}/api/device-login/request`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hardware_id: hardwareId, device_name: deviceName }),
    },
  )
  if (!res.ok) throw new Error(`Device login request failed (HTTP ${res.status})`)
  const data = await res.json()
  if (!data?.success || !data.data) {
    throw new Error(data?.message || 'Failed to start device login')
  }
  return data.data
}

/**
 * Poll the Token Platform device login status until approved/expired.
 */
export async function pollTokenPlatformDeviceLoginStatus(
  loginId: string,
): Promise<TokenPlatformDeviceLoginStatus> {
  const res = await fetch(
    `${tokenPlatformBaseUrl()}/api/device-login/status?login_id=${encodeURIComponent(loginId)}`,
  )
  if (!res.ok) throw new Error(`Device login status failed (HTTP ${res.status})`)
  const data = await res.json()
  if (!data?.success || !data.data) {
    throw new Error(data?.message || 'Failed to poll device login status')
  }
  return data.data
}

/**
 * Build the WeChat qrconnect URL. Opening this URL in a new tab/page shows the
 * real WeChat login QR (WeChat renders it server-side); the Hermes login page
 * keeps polling the device-login status while the new tab handles the scan.
 */
export function buildWeChatQrConnectUrl(params: TokenPlatformDeviceLoginRequest): string {
  return (
    `https://open.weixin.qq.com/connect/qrconnect` +
    `?appid=${encodeURIComponent(params.appid)}` +
    `&scope=${encodeURIComponent(params.scope || 'snsapi_login')}` +
    `&redirect_uri=${encodeURIComponent(params.redirect_uri)}` +
    `&state=${encodeURIComponent(params.state)}` +
    `&style=${encodeURIComponent(params.style || 'white')}` +
    `&self_redirect=true`
  )
}

/**
 * Complete the Hermes-side device login: validates the Token Platform device
 * key, provisions the local Hermes user, and returns a Hermes session token.
 */
export async function completeHermesDeviceLogin(
  payload: HermesDeviceLoginPayload,
): Promise<HermesDeviceLoginResult> {
  return request<HermesDeviceLoginResult>('/api/auth/device-login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * Restore a previous Token Platform binding and re-issue a Hermes session token.
 */
export async function restoreHermesDeviceLogin(): Promise<HermesDeviceLoginResult> {
  return request<HermesDeviceLoginResult>('/api/auth/device-login/restore', {
    method: 'POST',
  })
}

/**
 * Fetch whether this Hermes device has a persisted Token Platform binding.
 */
export async function fetchHermesDeviceBinding(): Promise<HermesDeviceBindingStatus> {
  return request<HermesDeviceBindingStatus>('/api/auth/device-binding')
}

/**
 * Unbind the WeChat account from this device: forget the persisted Token
 * Platform binding, delete the local `tp_<id>` user, and restore the default
 * profile identity. After this the device is available for a new WeChat owner.
 */
export async function unbindHermesDevice(): Promise<{ hadBinding: boolean; deletedUser?: string | null }> {
  return request<{ hadBinding: boolean; deletedUser?: string | null }>('/api/auth/device-binding', {
    method: 'DELETE',
  })
}
