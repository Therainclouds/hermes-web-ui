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

export interface HermesDeviceBindingAccount {
  platform_profile_id: number
  display_name?: string
  username?: string
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
 * key. If the WeChat profile is already bound to a local user, returns a
 * session token directly. Otherwise returns a `needs_choice` object so the
 * client can ask the user to pick an identity (bind super admin / create new
 * / pick existing).
 */
export async function completeHermesDeviceLogin(
  payload: HermesDeviceLoginPayload,
): Promise<HermesDeviceLoginResult | DeviceLoginChoice> {
  return request<HermesDeviceLoginResult | DeviceLoginChoice>('/api/auth/device-login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * Unbind the current WeChat account (owner) — or another account when called
 * by a super administrator with `platformProfileId`. Requires an
 * authenticated session and deletes that user's data: the local `tp_<id>`
 * user, its personal agent profile(s), and its binding row.
 */
export async function unbindHermesDevice(
  platformProfileId?: number,
): Promise<{ hadBinding: boolean; deletedUser?: string | null; deletedProfiles?: string[] }> {
  return request<{ hadBinding: boolean; deletedUser?: string | null; deletedProfiles?: string[] }>(
    '/api/auth/device-binding' + (platformProfileId ? `?platform_profile_id=${platformProfileId}` : ''),
    { method: 'DELETE' },
  )
}

// ── Two-phase device login: choice endpoints ──

export interface DeviceLoginChoice {
  status: 'needs_choice'
  profile: {
    id: number
    display_name: string
    phone: string | null
    avatar_url: string | null
  }
  options: string[]
  candidates: Array<{
    id: number
    username: string
    role: string
    phone_number: string | null
  }>
}

export interface BindSuperAdminPayload {
  api_base: string
  api_key: string
  device_id: number | string
  device_name?: string
  models?: string[]
  username: string
  password: string
  phone?: string
}

export interface CreateWeChatUserPayload {
  api_base: string
  api_key: string
  device_id: number | string
  device_name?: string
  models?: string[]
  username: string
  password: string
  phone?: string
}

export interface BindExistingPayload {
  api_base: string
  api_key: string
  device_id: number | string
  device_name?: string
  models?: string[]
  user_id: number
}

export async function bindSuperAdminDeviceLogin(
  payload: BindSuperAdminPayload,
): Promise<HermesDeviceLoginResult> {
  return request<HermesDeviceLoginResult>('/api/auth/device-login/bind-super-admin', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function createWeChatUser(payload: CreateWeChatUserPayload): Promise<HermesDeviceLoginResult> {
  return request<HermesDeviceLoginResult>('/api/auth/device-login/create-user', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function bindExistingUserDeviceLogin(
  payload: BindExistingPayload,
): Promise<HermesDeviceLoginResult> {
  return request<HermesDeviceLoginResult>('/api/auth/device-login/bind-existing', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
