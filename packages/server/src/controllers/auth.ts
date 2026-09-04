import type { Context } from 'koa'
import { checkPassword, recordPasswordFailure, recordPasswordSuccess, extractIp, getLockedIps, unlockIp, unlockAll } from '../services/login-limiter'
import {
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
  bootstrapDefaultSuperAdmin,
  countActiveSuperAdmins,
  countUsers,
  createUser,
  deleteUser,
  findUserById,
  findUserByPhoneNumber,
  findUserByUsername,
  getUserAvatar,
  listUserProfiles,
  listUsers,
  normalizePhoneNumber,
  replaceUserProfiles,
  setUserAvatar,
  setUserWeChatBound,
  touchUserLogin,
  updateUserModelGuideStatus,
  updateUser,
  updateUsername,
  updateUserPassword,
  updateUserPhoneNumber,
  verifyPassword,
  type ModelGuideStatus,
  type UserRole,
  type UserRecord,
  type UserStatus,
} from '../db/hermes/users-store'
import { removeAllUserThemeAssets } from '../services/user-theme'
import { getUserTheme, toUserThemePayload } from '../db/hermes/user-theme-store'
import { getUserJwtExpiresSeconds, issueAppJwt, issueUserJwt } from '../middleware/user-auth'
import { consumeAppAuthorizationCode, upsertAppConnection, type AppConnectionType } from '../db/hermes/app-connections-store'
import { listProfileNamesFromDisk } from '../services/hermes/hermes-profile'
import { startOutboundRelayClient, stopOutboundRelayClient } from '../services/global-agent/outbound-relay-client'
import { getLanEndpointKind } from '../services/lan-discovery'
import { getPublicSystemInfo } from '../services/system-info'
import { config } from '../config'
import { randomUUID } from 'crypto'
import {
  fetchDeviceSelf,
  verifyDeviceApiKey,
  type TokenPlatformUserProfile,
} from '../services/token-platform-client'
import {
  deleteBindingByPlatformId,
  deleteBindingByUserId,
  findBindingByPlatformId,
  findBindingByUserId,
  findUnboundUserByPhone,
  listWeChatBindings,
  upsertBindingByPlatformId,
} from '../db/hermes/wechat-bindings-store'
import {
  deleteProfileFromDisk,
  ensurePersonalWorkspace,
  personalProfileNameFor,
} from '../services/hermes/wechat-user-provisioning'
import { clearProfileIdentity } from '../services/hermes/profile-metadata'
import { logger } from '../services/logger'

/**
 * GET /api/auth/status
 * Check if username/password login is configured (public).
 */
export async function authStatus(ctx: Context) {
  ctx.body = {
    hasPasswordLogin: true,
    hasUsers: countUsers() > 0,
  }
}

/**
 * GET /api/auth/me
 * Return the authenticated account.
 */
export async function currentUser(ctx: Context) {
  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }
  ctx.body = {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      phone_number: user.phone_number || null,
      wechat_bound: Boolean(user.wechat_bound),
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      avatar: user.avatar || '',
      modelGuideStatus: user.model_guide_status || 'pending',
      shouldShowModelGuide: process.env.HERMES_DESKTOP === 'true'
        ? false
        : user.username === DEFAULT_USERNAME && (user.model_guide_status || 'pending') === 'pending',
      requiresCredentialChange: process.env.HERMES_DESKTOP === 'true'
        ? false
        : user.username === DEFAULT_USERNAME && verifyPassword(DEFAULT_PASSWORD, user.password_hash),
    },
  }
}

function normalizeModelGuideStatus(value: unknown): ModelGuideStatus | null {
  return value === 'pending' || value === 'skipped' || value === 'completed' ? value : null
}

/**
 * POST /api/auth/model-guide
 * Update the authenticated user's model onboarding guide status.
 */
export async function updateMyModelGuideStatus(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const body = ctx.request.body as { status?: unknown }
  const status = normalizeModelGuideStatus(body?.status)
  if (!status || status === 'pending') {
    ctx.status = 400
    ctx.body = { error: 'status must be "skipped" or "completed"' }
    return
  }

  const user = findUserById(userId)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (!updateUserModelGuideStatus(userId, status)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to update model guide status' }
    return
  }

  ctx.body = {
    success: true,
    status,
  }
}

const MAX_AVATAR_BYTES = 500 * 1024

function isValidAvatarPayload(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Invalid avatar payload' }
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type !== 'image' && type !== 'default') return { ok: false, error: 'Avatar type must be "image" or "default"' }
  if (type === 'image') {
    if (typeof obj.dataUrl !== 'string' || !obj.dataUrl.startsWith('data:image/')) {
      return { ok: false, error: 'Image avatar must include a dataUrl' }
    }
    if (obj.dataUrl.length > MAX_AVATAR_BYTES) {
      return { ok: false, error: `Avatar image is too large (max ${MAX_AVATAR_BYTES} bytes)` }
    }
  }
  if (obj.seed != null && typeof obj.seed !== 'string') {
    return { ok: false, error: 'Avatar seed must be a string' }
  }
  return { ok: true, json: JSON.stringify(value) }
}

/**
 * GET /api/auth/avatar
 * Return the authenticated user's avatar JSON string.
 */
export async function getMyAvatar(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  ctx.body = { avatar: getUserAvatar(userId) }
}

/**
 * PUT /api/auth/avatar
 * Update the authenticated user's avatar. Body: { avatar: <json string> } OR
 * body directly contains the avatar object { type, dataUrl?, seed? }.
 */
export async function updateMyAvatar(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  const body = ctx.request.body as { avatar?: unknown } & Record<string, unknown>
  // Accept both { avatar: "<json string>" } and a direct avatar object
  const candidate = body && Object.prototype.hasOwnProperty.call(body, 'avatar') ? body.avatar : body
  if (typeof candidate === 'string') {
    if (candidate.length > MAX_AVATAR_BYTES * 2) {
      ctx.status = 400
      ctx.body = { error: 'Avatar string is too large' }
      return
    }
    try {
      const parsed = JSON.parse(candidate)
      const validation = isValidAvatarPayload(parsed)
      if (!validation.ok) {
        ctx.status = 400
        ctx.body = { error: validation.error }
        return
      }
      const ok = setUserAvatar(userId, candidate)
      if (!ok) {
        ctx.status = 500
        ctx.body = { error: 'Failed to save avatar' }
        return
      }
      ctx.body = { success: true, avatar: candidate }
      return
    } catch {
      ctx.status = 400
      ctx.body = { error: 'Avatar string is not valid JSON' }
      return
    }
  }
  const validation = isValidAvatarPayload(candidate)
  if (!validation.ok) {
    ctx.status = 400
    ctx.body = { error: validation.error }
    return
  }
  const ok = setUserAvatar(userId, validation.json)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to save avatar' }
    return
  }
  ctx.body = { success: true, avatar: validation.json }
}

async function authenticatePasswordUser(
  ctx: Context,
  username: string,
  password: string,
): Promise<{ ok: true; ip: string; user: UserRecord } | { ok: false }> {
  const ip = extractIp(ctx)
  const result = checkPassword(ip)
  if (!result.allowed) {
    ctx.status = result.status
    ctx.body = { error: 'Too many login attempts, please try again later' }
    return { ok: false }
  }

  const existingUserCount = countUsers()
  const user = existingUserCount === 0
    ? bootstrapDefaultSuperAdmin(username, password)
    : findUserByUsername(username)

  if (!user || user.status !== 'active' || (existingUserCount > 0 && !verifyPassword(password, user.password_hash))) {
    recordPasswordFailure(ip)
    ctx.status = 401
    ctx.body = { error: 'Invalid username or password' }
    return { ok: false }
  }

  return { ok: true, ip, user }
}

async function passwordLogin(
  ctx: Context,
  username: string,
  password: string,
): Promise<{ ok: true; token: string; user: UserRecord } | { ok: false }> {
  const authentication = await authenticatePasswordUser(ctx, username, password)
  if (!authentication.ok) return authentication
  try {
    const token = await issueUserJwt(authentication.user)
    recordPasswordSuccess(authentication.ip)
    return { ok: true, token, user: authentication.user }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to issue login token' }
    return { ok: false }
  }
}

function accessibleProfileNames(user: UserRecord): string[] {
  if (user.role === 'super_admin') return listProfileNamesFromDisk()
  return listUserProfiles(user.id).map(profile => profile.profile_name)
}

/**
 * POST /api/auth/login
 * Authenticate with username/password (public).
 * Returns a user-scoped JWT on success.
 */
export async function login(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }

  const result = await passwordLogin(ctx, username, password)
  if (!result.ok) return
  ctx.body = {
    token: result.token,
    userId: result.user.id,
    profiles: accessibleProfileNames(result.user),
    theme: toUserThemePayload(getUserTheme(result.user.id)),
  }
}

function normalizeAppLoginField(value: unknown, maxLength: number): string {
  const normalized = String(value || '').trim()
  return normalized.length <= maxLength ? normalized : ''
}

function appConnectionType(ctx: Context): AppConnectionType {
  const requestAddresses = [ctx.ip, ctx.request.ip, ctx.req?.socket?.remoteAddress]
    .map(value => String(value || '').trim().replace(/^::ffff:/, ''))
    .filter(Boolean)
  const forwardedByLocalRelay = requestAddresses.some(value => (
    value === '::1' || value === 'localhost' || value.startsWith('127.')
  ))
  return forwardedByLocalRelay && ctx.get('x-hermes-app-connection').trim().toLowerCase() === 'cloud'
    ? 'cloud'
    : 'lan'
}

/**
 * POST /api/auth/app-login
 * Exchange either a one-time App authorization code or active user credentials
 * for a device-bound App token.
 */
export async function appLogin(ctx: Context) {
  const body = ctx.request.body as Record<string, unknown> | undefined
  const authorizationCode = normalizeAppLoginField(
    body?.authorization_code ?? body?.authorizationCode,
    255,
  )
  const deviceCode = normalizeAppLoginField(body?.device_code ?? body?.deviceCode, 255)
  const deviceName = normalizeAppLoginField(body?.device_name ?? body?.deviceName, 80)
  const deviceBrand = normalizeAppLoginField(body?.device_brand ?? body?.deviceBrand, 80)
  const deviceModel = normalizeAppLoginField(body?.device_model ?? body?.deviceModel, 120)
  const username = normalizeAppLoginField(body?.username ?? body?.account, 80)
  const rawPassword = typeof body?.password === 'string' ? body.password : ''
  const password = rawPassword.length <= 256 ? rawPassword : ''
  const requestedCloudUserId = Number(body?.cloud_user_id ?? body?.cloudUserId)
  const passwordCredentialsProvided = Boolean(username && password)
  if (!deviceCode || !deviceName || (!authorizationCode && !passwordCredentialsProvided)) {
    ctx.status = 400
    ctx.body = {
      error: 'device_code and device_name are required together with authorization_code or username and password',
    }
    return
  }

  let user: UserRecord | null = null
  let authenticatedPasswordIp = ''
  if (authorizationCode) {
    try {
      const authorization = consumeAppAuthorizationCode(authorizationCode, deviceCode)
      user = findUserById(authorization.created_by_user_id)
    } catch (error: any) {
      if (error?.message === 'app_authorization_code_expired') {
        ctx.status = 410
        ctx.body = { error: 'App authorization code has expired' }
        return
      }
      if (error?.message === 'app_authorization_code_used') {
        ctx.status = 409
        ctx.body = { error: 'App authorization code has already been used' }
        return
      }
      ctx.status = 401
      ctx.body = { error: 'Invalid App authorization code' }
      return
    }
  } else {
    const authentication = await authenticatePasswordUser(ctx, username, password)
    if (!authentication.ok) return
    user = authentication.user
    authenticatedPasswordIp = authentication.ip
  }

  if (!user || user.status !== 'active') {
    ctx.status = 403
    ctx.body = { error: 'The authorizing user is disabled or does not exist' }
    return
  }
  const connectionType = appConnectionType(ctx)
  const cloudUserId = connectionType === 'cloud' && Number.isSafeInteger(requestedCloudUserId) && requestedCloudUserId > 0
    ? requestedCloudUserId
    : 0
  if (connectionType === 'cloud' && !cloudUserId) {
    ctx.status = 400
    ctx.body = { error: 'cloud_user_id is required for cloud App connections' }
    return
  }
  const token = await issueAppJwt(user, deviceCode, connectionType)
  if (authenticatedPasswordIp) recordPasswordSuccess(authenticatedPasswordIp)
  const now = Math.floor(Date.now() / 1000)
  const tokenExpiresAt = now + getUserJwtExpiresSeconds()
  const connection = upsertAppConnection({
    deviceCode,
    deviceName,
    deviceBrand,
    deviceModel,
    connectionType,
    userId: user.id,
    cloudUserId,
    token,
    tokenExpiresAt,
    now,
  })
  ctx.body = {
    token,
    userId: user.id,
    profiles: accessibleProfileNames(user),
    theme: toUserThemePayload(getUserTheme(user.id)),
    appConnection: {
      id: connection.id,
      device_code: connection.device_code,
      device_name: connection.device_name,
      device_brand: connection.device_brand,
      device_model: connection.device_model,
      connection_type: connection.connection_type,
      cloud_user_id: connection.cloud_user_id,
      token_expires_at: connection.token_expires_at,
    },
  }
}

function normalizeRelayUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return null
  }
}

function requestBaseUrl(ctx: Context): string | undefined {
  const host = ctx.get('host').trim()
  if (!host) return undefined
  return `${ctx.protocol || 'http'}://${host}`
}

async function verifyRemoteRelayDeviceCode(deviceCode: string): Promise<boolean> {
  const url = `${config.remoteRelay.url.replace(/\/$/, '')}/global-agent/device/${encodeURIComponent(deviceCode)}`
  const response = await fetch(url, { method: 'GET' })
  return response.ok
}

async function localRelayMachineInfo(url: string) {
  const info = await getPublicSystemInfo()
  return {
    ...info,
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    url,
    relay_url: config.remoteRelay.url,
  }
}

/**
 * POST /api/auth/device-login
 * Complete a Token Platform WeChat scan login from the Hermes device.
 *
 * The client already received {api_base, api_key, models, device_id} from the
 * Token Platform device-login status endpoint (the user scanned the QR with
 * WeChat). This endpoint validates the device API key, resolves the bound user
 * profile, provisions a local regular user (role=admin — super admin stays
 * exclusive to the built-in `quanthermes` account) with a dedicated personal
 * agent profile (`u_<platform id>`), issues a Hermes JWT, and persists the
 * per-user binding so later boots can restore the session without re-scanning.
 *
 * Multiple different WeChat accounts can bind to the same device; each gets
 * its own user, its own personal profile, and its own api_key. The personal
 * profile's token_platform provider is written with the caller's api_key so
 * model calls are isolated per user.
 *
 * Body: { api_base, api_key, device_id, device_name, models }.
 */
export async function deviceLogin(ctx: Context) {
  const {
    api_base: apiBaseRaw,
    api_key: apiKey,
    device_id: deviceId,
    device_name: deviceName,
    models,
  } = ctx.request.body as {
    api_base?: string
    api_key?: string
    device_id?: number | string
    device_name?: string
    models?: string[]
  }

  const apiBase = String(apiBaseRaw || '').trim()
  const key = String(apiKey || '').trim()
  if (!apiBase || !key) {
    ctx.status = 400
    ctx.body = { error: 'api_base and api_key are required' }
    return
  }

  let profile: TokenPlatformUserProfile
  try {
    profile = await fetchDeviceSelf(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform profile verification failed' }
    return
  }
  if (!profile?.id) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Token Platform device key' }
    return
  }

  // Verify the key can actually reach the relay models endpoint.
  let verifiedModels: string[]
  try {
    verifiedModels = await verifyDeviceApiKey(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform model verification failed' }
    return
  }

  const modelList = Array.isArray(models) && models.length > 0
    ? models
    : verifiedModels

  // ── Two-phase device login ──
  // Phase 1: resolve the WeChat profile, then either:
  //   (a) if already bound → return a short "bound" token immediately
  //   (b) otherwise → return "needs_choice" with candidate options so the
  //       client can ask the user to pick (bind super admin / create new /
  //       pick existing unbound user). The second phase is handled by the
  //       bind-super-admin / create-user / bind-existing endpoints.
  const phoneFromProfile = normalizePhoneNumber(profile.phone)

  // 1. If this platform_profile_id is already bound, skip the choice screen.
  const existingBinding = findBindingByPlatformId(profile.id)
  if (existingBinding?.user_id) {
    const user = findUserById(existingBinding.user_id)
    if (user && user.status === 'active') {
      const displayName = profile.display_name || profile.username || user.username
      const token = await issueUserJwt(user)
      touchUserLogin(user.id)
      ctx.body = {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          display_name: displayName,
          bound_models: modelList,
        },
        binding: {
          device_id: existingBinding.device_id,
          display_name: displayName,
          platform_profile_id: profile.id,
        },
      }
      return
    }
    // Stale binding: user was deleted. Fall through to needs_choice.
  }

  // 2. Build candidate list: unbound local users whose phone matches.
  const candidates: Array<{ id: number; username: string; role: string; phone_number: string | null }> = []
  if (phoneFromProfile) {
    const allUsers = listUsers()
    for (const u of allUsers) {
      if (u.status === 'active' && normalizePhoneNumber(u.phone_number) === phoneFromProfile && !u.wechat_bound) {
        candidates.push({ id: u.id, username: u.username, role: u.role, phone_number: u.phone_number })
      }
    }
  }

  // 3. Return the choice screen.
  ctx.body = {
    status: 'needs_choice',
    profile: {
      id: profile.id,
      display_name: profile.display_name || profile.username || '',
      phone: phoneFromProfile,
      avatar_url: profile.avatar_url || null,
    },
    options: [
      'bind_super_admin',
      'create_local_user',
      ...(candidates.length > 0 ? ['login_existing'] : []),
    ],
    candidates,
  }
}

/**
 * Shared helper: after a choice endpoint has picked a user, finalize binding
 * (wechat_bound, avatar, personal workspace on disk, binding row, JWT).
 * The personal workspace is created on disk but NOT written to user_profiles —
 * we hide per-WeChat "u_<id>" profiles from the UI.
 */
async function finalizeWeChatBinding(
  user: UserRecord,
  profile: TokenPlatformUserProfile,
  apiBase: string,
  apiKey: string,
  deviceId: string | number | undefined,
  modelList: string[],
): Promise<{ token: string; user: unknown; binding: unknown }> {
  const displayName = profile.display_name || profile.username || user.username
  if (profile.display_name || profile.avatar_url) {
    setUserAvatar(user.id, profile.avatar_url
      ? JSON.stringify({ type: 'image', dataUrl: profile.avatar_url, seed: profile.display_name || '' })
      : JSON.stringify({ type: 'default', seed: profile.display_name || '' }))
  }

  await ensurePersonalWorkspace({
    userId: user.id,
    platformProfileId: profile.id,
    displayName,
    avatarUrl: profile.avatar_url || null,
    apiBase,
    apiKey,
    models: modelList,
  })
  // NOTE: we intentionally do NOT write the u_<id> personal profile to
  // user_profiles. Chinese users expect a single unified workspace; the
  // on-disk u_<id> profile exists only as an agent workspace, not as a
  // visible "可访问配置" in the UI.

  const token = await issueUserJwt(user)
  touchUserLogin(user.id)

  const binding = upsertBindingByPlatformId({
    userId: user.id,
    platformProfileId: profile.id,
    platformUsername: profile.username || '',
    apiBase,
    apiKey,
    deviceId: String(deviceId ?? ''),
    models: modelList,
    displayName,
  })

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: displayName,
      bound_models: modelList,
    },
    binding: {
      device_id: binding?.device_id || String(deviceId ?? ''),
      display_name: displayName,
      platform_profile_id: profile.id,
    },
  }
}

/**
 * POST /api/auth/device-login/bind-super-admin
 * Bind the WeChat scan to a super_admin account. Caller must supply the
 * super_admin's username, password, and phone number; all three are verified
 * before binding.
 */
export async function bindSuperAdminDeviceLogin(ctx: Context) {
  const {
    api_base: apiBaseRaw,
    api_key: apiKey,
    device_id: deviceId,
    device_name: deviceName,
    models,
    username,
    password,
    phone,
  } = ctx.request.body as {
    api_base?: string
    api_key?: string
    device_id?: number | string
    device_name?: string
    models?: string[]
    username?: string
    password?: string
    phone?: string
  }

  const apiBase = String(apiBaseRaw || '').trim()
  const key = String(apiKey || '').trim()
  if (!apiBase || !key) {
    ctx.status = 400
    ctx.body = { error: 'api_base and api_key are required' }
    return
  }

  let profile: TokenPlatformUserProfile
  try {
    profile = await fetchDeviceSelf(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform profile verification failed' }
    return
  }
  if (!profile?.id) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Token Platform device key' }
    return
  }

  let verifiedModels: string[]
  try {
    verifiedModels = await verifyDeviceApiKey(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform model verification failed' }
    return
  }
  const modelList = Array.isArray(models) && models.length > 0 ? models : verifiedModels

  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'username and password are required' }
    return
  }

  // 1. Find the super_admin user
  const user = findUserByUsername(username.trim())
  if (!user || user.role !== 'super_admin' || user.status !== 'active') {
    ctx.status = 404
    ctx.body = { error: 'Super admin account not found', code: 'SUPER_ADMIN_NOT_FOUND' }
    return
  }

  // 2. Verify password
  if (!verifyPassword(password, user.password_hash)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }
    return
  }

  // 3. Verify phone matches the super_admin's stored phone_number
  const normalizedPhone = normalizePhoneNumber(phone)
  if (normalizedPhone && user.phone_number && normalizePhoneNumber(user.phone_number) !== normalizedPhone) {
    ctx.status = 400
    ctx.body = { error: 'Phone number does not match the super admin account', code: 'PHONE_MISMATCH' }
    return
  }

  // 4. If the super_admin already has a WeChat binding, reject
  const existingBinding = findBindingByPlatformId(profile.id)
  if (existingBinding && existingBinding.user_id && existingBinding.user_id !== user.id) {
    ctx.status = 409
    ctx.body = { error: 'This WeChat account is already bound to another user', code: 'PHONE_ALREADY_BOUND' }
    return
  }

  // 5. Bind — transfer phone from tp_<id> user if needed
  if (normalizedPhone) {
    const phoneOwner = findUserByPhoneNumber(normalizedPhone)
    if (phoneOwner && phoneOwner.id !== user.id) {
      // Phone is on another user (likely tp_<id> from WeChat login) — clear it
      updateUserPhoneNumber(phoneOwner.id, null)
    }
    if (!user.phone_number || normalizePhoneNumber(user.phone_number) !== normalizedPhone) {
      updateUserPhoneNumber(user.id, normalizedPhone)
    }
  }
  if (!user.wechat_bound) {
    setUserWeChatBound(user.id, true)
  }

  const result = await finalizeWeChatBinding(user, profile, apiBase, key, deviceId, modelList)
  ctx.body = result
}

/**
 * POST /api/auth/device-login/create-user
 * Create a new local admin user and bind it to this WeChat scan. No role
 * selection: defaults to `admin` per product spec.
 */
export async function createWeChatUser(ctx: Context) {
  const {
    api_base: apiBaseRaw,
    api_key: apiKey,
    device_id: deviceId,
    device_name: deviceName,
    models,
    username,
    password,
    phone,
  } = ctx.request.body as {
    api_base?: string
    api_key?: string
    device_id?: number | string
    device_name?: string
    models?: string[]
    username?: string
    password?: string
    phone?: string
  }

  const apiBase = String(apiBaseRaw || '').trim()
  const key = String(apiKey || '').trim()
  if (!apiBase || !key) {
    ctx.status = 400
    ctx.body = { error: 'api_base and api_key are required' }
    return
  }

  let profile: TokenPlatformUserProfile
  try {
    profile = await fetchDeviceSelf(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform profile verification failed' }
    return
  }
  if (!profile?.id) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Token Platform device key' }
    return
  }

  let verifiedModels: string[]
  try {
    verifiedModels = await verifyDeviceApiKey(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform model verification failed' }
    return
  }
  const modelList = Array.isArray(models) && models.length > 0 ? models : verifiedModels

  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'username and password are required' }
    return
  }
  if (username.trim().length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (findUserByUsername(username.trim())) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists', code: 'USERNAME_TAKEN' }
    return
  }

  const normalizedPhone = phone ? normalizePhoneNumber(phone) : null
  if (normalizedPhone && findUserByPhoneNumber(normalizedPhone)) {
    ctx.status = 409
    ctx.body = { error: 'Phone number already in use', code: 'PHONE_ALREADY_BOUND' }
    return
  }

  const user = createUser({
    username: username.trim(),
    password,
    role: 'admin',
    status: 'active',
    phone: normalizedPhone,
    wechatBound: true,
  })
  if (!user) {
    ctx.status = 500
    ctx.body = { error: 'Failed to create user' }
    return
  }

  const result = await finalizeWeChatBinding(user, profile, apiBase, key, deviceId, modelList)
  ctx.body = result
}

/**
 * POST /api/auth/device-login/bind-existing
 * Bind the WeChat scan to an existing unbound local user picked from the
 * candidate list returned by the initial device-login call.
 */
export async function bindExistingUserDeviceLogin(ctx: Context) {
  const {
    api_base: apiBaseRaw,
    api_key: apiKey,
    device_id: deviceId,
    device_name: deviceName,
    models,
    user_id,
  } = ctx.request.body as {
    api_base?: string
    api_key?: string
    device_id?: number | string
    device_name?: string
    models?: string[]
    user_id?: number
  }

  const apiBase = String(apiBaseRaw || '').trim()
  const key = String(apiKey || '').trim()
  if (!apiBase || !key) {
    ctx.status = 400
    ctx.body = { error: 'api_base and api_key are required' }
    return
  }

  let profile: TokenPlatformUserProfile
  try {
    profile = await fetchDeviceSelf(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform profile verification failed' }
    return
  }
  if (!profile?.id) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Token Platform device key' }
    return
  }

  let verifiedModels: string[]
  try {
    verifiedModels = await verifyDeviceApiKey(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform model verification failed' }
    return
  }
  const modelList = Array.isArray(models) && models.length > 0 ? models : verifiedModels

  if (!user_id) {
    ctx.status = 400
    ctx.body = { error: 'user_id is required' }
    return
  }

  const user = findUserById(user_id)
  if (!user || user.status !== 'active') {
    ctx.status = 404
    ctx.body = { error: 'User not found or inactive' }
    return
  }
  if (user.wechat_bound) {
    ctx.status = 409
    ctx.body = { error: 'User is already bound to a WeChat account', code: 'USER_ALREADY_BOUND' }
    return
  }

  const phoneFromProfile = normalizePhoneNumber(profile.phone)
  if (phoneFromProfile && user.phone_number && normalizePhoneNumber(user.phone_number) !== phoneFromProfile) {
    ctx.status = 400
    ctx.body = { error: 'Phone number does not match the selected user', code: 'PHONE_MISMATCH' }
    return
  }

  setUserWeChatBound(user.id, true)
  if (phoneFromProfile && !user.phone_number) {
    updateUserPhoneNumber(user.id, phoneFromProfile)
  }

  const result = await finalizeWeChatBinding(user, profile, apiBase, key, deviceId, modelList)
  ctx.body = result
}

/**
 * POST /api/auth/device-login/bind-by-credentials
 * Safety net for users who unbound their WeChat and want to re-bind: accept
 * an identifier that may be either a username OR a phone number, plus the
 * account password. Works for any role (super_admin / admin), as long as the
 * target account is active and not already WeChat-bound.
 */
export async function bindByCredentialsDeviceLogin(ctx: Context) {
  const {
    api_base: apiBaseRaw,
    api_key: apiKey,
    device_id: deviceId,
    device_name: deviceName,
    models,
    identifier,
    password,
  } = ctx.request.body as {
    api_base?: string
    api_key?: string
    device_id?: number | string
    device_name?: string
    models?: string[]
    identifier?: string
    password?: string
  }

  const apiBase = String(apiBaseRaw || '').trim()
  const key = String(apiKey || '').trim()
  if (!apiBase || !key) {
    ctx.status = 400
    ctx.body = { error: 'api_base and api_key are required' }
    return
  }

  let profile: TokenPlatformUserProfile
  try {
    profile = await fetchDeviceSelf(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform profile verification failed' }
    return
  }
  if (!profile?.id) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Token Platform device key' }
    return
  }

  let verifiedModels: string[]
  try {
    verifiedModels = await verifyDeviceApiKey(apiBase, key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform model verification failed' }
    return
  }
  const modelList = Array.isArray(models) && models.length > 0 ? models : verifiedModels

  if (!identifier || !password) {
    ctx.status = 400
    ctx.body = { error: 'identifier (username or phone) and password are required' }
    return
  }

  // 1. Resolve the account: username first, then phone number.
  const idTrimmed = identifier.trim()
  let user = findUserByUsername(idTrimmed)
  if (!user) {
    const normalizedId = normalizePhoneNumber(idTrimmed)
    if (normalizedId) user = findUserByPhoneNumber(normalizedId)
  }
  if (!user || user.status !== 'active') {
    ctx.status = 404
    ctx.body = { error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' }
    return
  }
  if (user.wechat_bound) {
    ctx.status = 409
    ctx.body = { error: 'User is already bound to a WeChat account', code: 'USER_ALREADY_BOUND' }
    return
  }

  // 2. Verify password.
  if (!verifyPassword(password, user.password_hash)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }
    return
  }

  // 3. Phone cross-check: if both the local account and the WeChat profile
  // have phones, they must agree (identity bridge consistency).
  const phoneFromProfile = normalizePhoneNumber(profile.phone)
  if (phoneFromProfile && user.phone_number
    && normalizePhoneNumber(user.phone_number) !== phoneFromProfile) {
    ctx.status = 400
    ctx.body = { error: 'Phone number does not match the account', code: 'PHONE_MISMATCH' }
    return
  }

  // 4. Reject if this WeChat account is already bound to a different user.
  const existingBinding = findBindingByPlatformId(profile.id)
  if (existingBinding && existingBinding.user_id && existingBinding.user_id !== user.id) {
    ctx.status = 409
    ctx.body = { error: 'This WeChat account is already bound to another user', code: 'PHONE_ALREADY_BOUND' }
    return
  }

  // 5. Bind: adopt the profile phone when the account has none.
  setUserWeChatBound(user.id, true)
  if (phoneFromProfile && !user.phone_number) {
    updateUserPhoneNumber(user.id, phoneFromProfile)
  }

  const result = await finalizeWeChatBinding(user, profile, apiBase, key, deviceId, modelList)
  ctx.body = result
}

/**
 * GET /api/auth/device-binding
 * Return the WeChat accounts bound to this device. Used by the login page to
 * offer "restore previous scan" without re-scanning, and to disambiguate when
 * multiple WeChat accounts are bound.
 */
export async function getDeviceBinding(ctx: Context) {
  const bindings = listWeChatBindings()
  if (bindings.length === 0) {
    ctx.body = { bound: false, accounts: [] }
    return
  }
  ctx.body = {
    bound: true,
    accounts: bindings.map(binding => ({
      platform_profile_id: binding.platform_profile_id,
      display_name: binding.display_name,
      username: binding.platform_username,
      bound_at: binding.bound_at,
    })),
  }
}

/**
 * Delete every piece of data owned by a WeChat user: their personal agent
 * profile (`u_<platform id>`, disk + metadata), the binding row, theme assets,
 * and the local user record itself. Profiles that were merely assigned to or
 * created under other names stay on disk for the super administrator — they
 * are never visible to other regular users once the binding rows are gone.
 * Used by unbind and by super-admin user deletion.
 */
async function deleteWeChatUserData(user: UserRecord): Promise<string[]> {
  const deletedProfiles: string[] = []
  // Find the WeChat binding to determine the platform_profile_id for cleanup.
  const binding = findBindingByUserId(user.id)
  if (binding) {
    const personalProfile = personalProfileNameFor(binding.platform_profile_id)
    if (await deleteProfileFromDisk(personalProfile)) {
      deletedProfiles.push(personalProfile)
    }
  } else {
    // Legacy fallback: try tp_<id> username pattern.
    const personalMatch = /^tp_(\d+)$/.exec(user.username)
    if (personalMatch) {
      const personalProfile = personalProfileNameFor(Number(personalMatch[1]))
      if (await deleteProfileFromDisk(personalProfile)) {
        deletedProfiles.push(personalProfile)
      }
    }
  }
  await removeAllUserThemeAssets(user.id)
  deleteBindingByUserId(user.id)
  deleteUser(user.id)
  return deletedProfiles
}

/**
 * DELETE /api/auth/device-binding (protected)
 * Unbind a WeChat account from this device and wipe its data.
 *
 * Callable by the bound WeChat user themselves or by a super administrator
 * (who may pass ?platform_profile_id= to unbind another account). Deletion
 * covers the local `tp_<id>` user, its personal agent profiles (disk + Web-UI
 * metadata), its binding row, and its theme assets. Idempotent: unbinding
 * with no binding reports hadBinding=false. A previously bound WeChat account
 * that scans again starts from a clean slate.
 */
export async function clearDeviceBindingController(ctx: Context) {
  const actor = ctx.state.user
  if (!actor) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  let binding = findBindingByUserId(actor.id)
  if (!binding && actor.username.startsWith('tp_')) {
    const platformId = Number(actor.username.slice('tp_'.length))
    if (Number.isInteger(platformId)) {
      binding = findBindingByPlatformId(platformId) || binding
    }
  }
  // Super administrators may unbind a specific account on behalf of its owner.
  // A non-admin naming someone else's binding is rejected outright instead of
  // silently unbinding their own (or nothing).
  const requestedPlatformId = Number(ctx.query.platform_profile_id)
  if (Number.isInteger(requestedPlatformId) && requestedPlatformId > 0) {
    if (actor.role === 'super_admin') {
      binding = findBindingByPlatformId(requestedPlatformId)
    } else if (binding?.platform_profile_id !== requestedPlatformId) {
      ctx.status = 403
      ctx.body = { error: 'Only the bound WeChat owner or a super administrator can unbind' }
      return
    }
  }

  let deletedUser: string | null = null
  let deletedProfiles: string[] = []
  if (binding) {
    const isOwner = actor.id === binding.user_id
    if (!isOwner && actor.role !== 'super_admin') {
      ctx.status = 403
      ctx.body = { error: 'Only the bound WeChat owner or a super administrator can unbind' }
      return
    }
    const localUsername = binding.user_id
      ? null
      : `tp_${binding.platform_profile_id}`
    const user = (binding.user_id ? findUserById(binding.user_id) : null)
      || (localUsername ? findUserByUsername(localUsername) : null)
    if (user) {
      // Phone-number guard: if the user has no phone number and no password,
      // refuse to unbind because the account would become identity-less.
      // super_admin and any user with a password can re-authenticate, so
      // they are exempt from this guard.
      if (!user.phone_number && user.role !== 'super_admin' && !user.password_hash) {
        ctx.status = 400
        ctx.body = {
          error: 'Cannot unbind WeChat: please bind a phone number first as identity fallback',
          code: 'PHONE_REQUIRED_FOR_UNBIND',
        }
        return
      }
      // Unbind WeChat but keep the user account active
      deleteBindingByPlatformId(binding.platform_profile_id)
      setUserWeChatBound(user.id, false)
      deletedUser = user.username
    } else {
      deleteBindingByPlatformId(binding.platform_profile_id)
    }
  } else if (actor.username.startsWith('tp_')) {
    // Legacy user without an imported binding row
    const user = findUserByUsername(actor.username)
    if (user) {
      if (!user.phone_number && user.role !== 'super_admin' && !user.password_hash) {
        ctx.status = 400
        ctx.body = {
          error: 'Cannot unbind WeChat: please bind a phone number first as identity fallback',
          code: 'PHONE_REQUIRED_FOR_UNBIND',
        }
        return
      }
      deleteBindingByUserId(user.id)
      setUserWeChatBound(user.id, false)
      deletedUser = user.username
    }
  }

  logger.info({
    actor: actor.username,
    deletedUser,
    deletedProfiles,
  }, '[device-binding] wechat account unbound (user account preserved)')
  ctx.body = { success: true, hadBinding: Boolean(binding), deletedUser, deletedProfiles }
}

/**
 * POST /api/auth/device-login/restore
 * Restore a previous WeChat binding and re-issue a Hermes JWT without
 * requiring a new WeChat scan. Verifies the stored api_key is still valid.
 * Body/query: { platform_profile_id? } — optional when exactly one account is
 * bound; required to pick between multiple bound accounts (409 otherwise).
 */
export async function restoreDeviceLogin(ctx: Context) {
  const bindings = listWeChatBindings()
  if (bindings.length === 0) {
    ctx.status = 404
    ctx.body = { error: 'No device binding found' }
    return
  }

  const requestedId = Number(
    (ctx.request.body as { platform_profile_id?: unknown } | undefined)?.platform_profile_id
    ?? ctx.query.platform_profile_id,
  )
  const binding = Number.isInteger(requestedId) && requestedId > 0
    ? bindings.find(item => item.platform_profile_id === requestedId) || null
    : (bindings.length === 1 ? bindings[0] : null)
  if (!binding) {
    ctx.status = 409
    ctx.body = {
      error: 'Multiple WeChat accounts are bound to this device; pick one',
      code: 'MULTIPLE_BINDINGS',
      accounts: bindings.map(item => ({
        platform_profile_id: item.platform_profile_id,
        display_name: item.display_name,
        username: item.platform_username,
        bound_at: item.bound_at,
      })),
    }
    return
  }

  let profile: TokenPlatformUserProfile
  try {
    profile = await fetchDeviceSelf(binding.api_base, binding.api_key)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Token Platform verification failed' }
    return
  }
  if (!profile?.id) {
    ctx.status = 401
    ctx.body = { error: 'Bound Token Platform key is no longer valid' }
    return
  }

  const localUsername = `tp_${binding.platform_profile_id}`
  const user = (binding.user_id ? findUserById(binding.user_id) : null)
    || findUserByUsername(localUsername)
  if (!user || user.status !== 'active') {
    ctx.status = 401
    ctx.body = { error: 'Bound local user no longer exists' }
    return
  }

  const displayName = profile.display_name || binding.display_name || localUsername
  // Ensure the personal workspace on disk (u_<id>) for agent workspace isolation.
  // We do NOT write it to user_profiles — per-WeChat profiles should not appear
  // in the UI's "可访问配置" list.
  await ensurePersonalWorkspace({
    userId: user.id,
    platformProfileId: binding.platform_profile_id,
    displayName,
    avatarUrl: profile.avatar_url || null,
    apiBase: binding.api_base,
    apiKey: binding.api_key,
    models: (() => {
      try {
        const parsed = JSON.parse(binding.models_json)
        return Array.isArray(parsed) ? parsed.map(String) : []
      } catch {
        return []
      }
    })(),
  })

  // Refresh the binding's display_name from the remote profile so corrupted
  // rows (typically GBK bytes that were mojibake-encoded before the
  // token-platform-client's UTF-8/GBK fallback was added) get overwritten the
  // next time the user signs in. The remote value is the source of truth.
  if (profile.display_name && profile.display_name !== binding.display_name) {
    upsertBindingByPlatformId({
      userId: binding.user_id,
      platformProfileId: binding.platform_profile_id,
      platformUsername: profile.username || binding.platform_username,
      apiBase: binding.api_base,
      apiKey: binding.api_key,
      deviceId: binding.device_id,
      models: (() => {
        try {
          const parsed = JSON.parse(binding.models_json)
          return Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          return []
        }
      })(),
      displayName: profile.display_name,
    })
  }

  const token = await issueUserJwt(user)
  touchUserLogin(user.id)
  ctx.body = { token, user: { id: user.id, username: user.username, role: user.role } }
}

/**
 * POST /api/auth/bind-super-admin
 * Deprecated. The multi-user model reserves super admin for the built-in
 * `quanthermes` account; WeChat users are always regular users. Kept as a
 * stub so older clients fail with an explicit error instead of a 404.
 */
export async function bindSuperAdmin(ctx: Context) {
  ctx.status = 400
  ctx.body = {
    error: 'Binding to the super administrator account is no longer supported',
    code: 'BIND_SUPER_ADMIN_DEPRECATED',
  }
}

/**
 * POST /api/auth/unbind-super-admin
 * Demote the current super administrator back to a regular admin and clear the
 * WeChat identity from the default profile.
 *
 * Only callable by the current super-admin user themselves (e.g. via the
 * "解绑" button on the profile card). After unbinding, a future WeChat scan
 * re-prompts the bind flow because the role is admin again.
 */
export async function unbindSuperAdmin(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const user = findUserById(userId)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (user.role !== 'super_admin') {
    ctx.status = 403
    ctx.body = { error: 'Only a super administrator can unbind' }
    return
  }

  // Ensure at least one super administrator remains before demoting.
  if (countActiveSuperAdmins(userId) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  const demoted = updateUser({ userId, role: 'admin' })
  if (!demoted) {
    ctx.status = 500
    ctx.body = { error: 'Failed to unbind super administrator' }
    return
  }

  // Remove the WeChat name/avatar from the default agent profile so it falls
  // back to its original identity.
  clearProfileIdentity('default')

  const token = await issueUserJwt(demoted)
  touchUserLogin(demoted.id)
  ctx.body = { token, user: { id: demoted.id, username: demoted.username, role: demoted.role } }
}

/**
 * POST /api/auth/mcu-login
 * Authenticate with the existing username/password login for an MCU/device.
 * When remote relay is requested or a legacy relay URL is provided, connect this Hermes Studio instance to it.
 * Body: { token, id, account, password, url? }.
 */
export async function microcontrollerLogin(ctx: Context) {
  const {
    token: relayToken,
    url,
    id,
    account,
    password,
    relayMode,
    remote,
    device_code: deviceCode,
  } = ctx.request.body as {
    token?: string
    url?: string
    id?: string
    account?: string
    password?: string
    relayMode?: string
    remote?: boolean
    device_code?: string
  }

  if (!relayToken || !id || !account || !password) {
    ctx.status = 400
    ctx.body = { error: 'token, id, account and password are required' }
    return
  }

  const wantsRemoteRelay = relayMode === 'remote' || remote === true
  const remoteRelayUrl = wantsRemoteRelay ? config.remoteRelay.url : ''
  const relayUrl = typeof url === 'string' && url.trim()
    ? normalizeRelayUrl(url)
    : remoteRelayUrl || null
  if (url && !relayUrl) {
    ctx.status = 400
    ctx.body = { error: 'url must be a valid http, https, ws, or wss URL' }
    return
  }

  const normalizedDeviceCode = typeof deviceCode === 'string' ? deviceCode.trim() : ''
  if (wantsRemoteRelay && !normalizedDeviceCode) {
    ctx.status = 400
    ctx.body = { error: '缺少设备码' }
    return
  }

  const result = await passwordLogin(ctx, account, password)
  if (!result.ok) return

  if (wantsRemoteRelay) {
    try {
      if (!await verifyRemoteRelayDeviceCode(normalizedDeviceCode)) {
        ctx.status = 403
        ctx.body = { error: '非官方设备码' }
        return
      }
    } catch (err: any) {
      ctx.status = 502
      ctx.body = { error: err?.message || '远程设备码校验失败' }
      return
    }
  }

  const connectionId = id.trim()
  const forwardedRemoteMcuLogin = wantsRemoteRelay && ctx.get('x-hermes-relay-forwarded') === 'mcu-socket.io'
  if (!forwardedRemoteMcuLogin) {
    stopOutboundRelayClient(connectionId)
  }
  if (relayUrl && !forwardedRemoteMcuLogin) {
    const relayStartUrl = wantsRemoteRelay && relayUrl === remoteRelayUrl
      ? config.remoteRelay.url
      : relayUrl
    const localBaseUrl = requestBaseUrl(ctx)
    const machineInfo = localBaseUrl ? await localRelayMachineInfo(localBaseUrl) : undefined
    const client = startOutboundRelayClient({
      connectionId,
      relayUrl: relayStartUrl,
      relayToken,
      userToken: result.token,
      instanceId: connectionId,
      ...(normalizedDeviceCode ? { deviceCode: normalizedDeviceCode } : {}),
      ...(localBaseUrl ? { localBaseUrl } : {}),
      ...(machineInfo ? { machineInfo } : {}),
      relayProtocol: wantsRemoteRelay ? 'mcu-socket.io' : 'socket.io',
    })
    if (!client) {
      ctx.status = 400
      ctx.body = { error: 'Failed to start relay client' }
      return
    }
  }

  ctx.body = {
    token: result.token,
    profiles: accessibleProfileNames(result.user),
    relay: {
      connected: Boolean(relayUrl),
      id: connectionId,
      ...(wantsRemoteRelay && relayUrl === remoteRelayUrl ? { remote: true } : {}),
      ...(relayUrl ? { url: relayUrl } : {}),
    },
  }
}

/**
 * POST /api/auth/setup
 * Set up username/password (protected).
 */
export async function setupPassword(ctx: Context) {
  ctx.status = 400
  ctx.body = { error: 'Password login is managed by user accounts' }
}

/**
 * POST /api/auth/change-password
 * Change password (protected).
 */
export async function changePassword(ctx: Context) {
  const { currentPassword, newPassword } = ctx.request.body as { currentPassword?: string; newPassword?: string }
  if (!currentPassword || !newPassword) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new password are required' }
    return
  }
  if (newPassword.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'New password must be at least 6 characters' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  updateUserPassword(user.id, newPassword)
  ctx.body = { success: true }
}

/**
 * POST /api/auth/set-password
 * Set or reset the current user's password without requiring the current
 * password.
 *
 * Restricted to WeChat-provisioned users (`tp_` prefix): their password is a
 * random secret they never see, so a scan-verified JWT is the only way to set
 * a real one. Everyone else must use change-password with their current
 * password, otherwise any stolen JWT could silently take over the account.
 */
export async function setPassword(ctx: Context) {
  const { newPassword } = ctx.request.body as { newPassword?: unknown }
  if (typeof newPassword !== 'string' || !newPassword) {
    ctx.status = 400
    ctx.body = { error: 'New password is required' }
    return
  }
  if (newPassword.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'New password must be at least 6 characters' }
    return
  }

  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const user = findUserById(userId)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }
  if (!user.username.startsWith('tp_')) {
    ctx.status = 403
    ctx.body = { error: 'Use change-password to update your password' }
    return
  }

  updateUserPassword(user.id, newPassword)
  ctx.body = { success: true }
}

/**
 * POST /api/auth/change-username
 * Change username (protected).
 *
 * WeChat device users (tp_* prefix) are allowed to change their username
 * without providing the current password, because their initial password is
 * a random UUID they never see. Their JWT is already authenticated via
 * WeChat device binding scan, so requiring current password would lock them
 * out of ever changing their username unless they first set a password.
 */
export async function changeUsername(ctx: Context) {
  const { currentPassword, newUsername } = ctx.request.body as { currentPassword?: string; newUsername?: string }
  if (!newUsername) {
    ctx.status = 400
    ctx.body = { error: 'New username is required' }
    return
  }
  if (newUsername.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  // WeChat device users (tp_*) can skip current password verification
  // because their JWT is authenticated via WeChat device binding scan.
  const isWeChatDeviceUser = user.username.startsWith('tp_')
  if (!isWeChatDeviceUser) {
    if (!currentPassword) {
      ctx.status = 400
      ctx.body = { error: 'Current password is required' }
      return
    }
    if (!verifyPassword(currentPassword, user.password_hash)) {
      ctx.status = 400
      ctx.body = { error: 'Current password is incorrect' }
      return
    }
  }

  const existing = findUserByUsername(newUsername)
  if (existing && existing.id !== user.id) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }

  updateUsername(user.id, newUsername)
  ctx.body = { success: true }
}

/**
 * DELETE /api/auth/password
 * Remove username/password login (protected).
 */
export async function removePassword(ctx: Context) {
  ctx.status = 400
  ctx.body = { error: 'Password login cannot be removed for user accounts' }
}

function normalizeRole(value: unknown): UserRole | null {
  return value === 'super_admin' || value === 'admin' ? value : null
}

function normalizeStatus(value: unknown): UserStatus | null {
  return value === 'active' || value === 'disabled' ? value : null
}

function normalizeProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
}

function validateProfiles(profiles: string[]): string | null {
  const available = new Set(listProfileNamesFromDisk())
  const missing = profiles.find(profile => !available.has(profile))
  return missing || null
}

/**
 * GET /api/auth/users
 * Super admin user management list.
 */
export async function listManagedUsers(ctx: Context) {
  ctx.body = {
    users: listUsers(),
    profiles: listProfileNamesFromDisk(),
  }
}

/**
 * GET /api/auth/users/:id/export
 * Export a single user account as JSON (super admin only). Used by the user
 * management table to back up an individual account's identity and profile
 * bindings. The password hash is deliberately excluded.
 */
export async function exportManagedUser(ctx: Context) {
  const rawId = String(ctx.params.id || '')
  const user = findUserById(rawId)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  const profiles = listUserProfiles(user.id)
  const avatarRaw = getUserAvatar(user.id)
  let avatar: unknown = null
  if (avatarRaw) {
    try {
      avatar = JSON.parse(avatarRaw)
    } catch {
      avatar = avatarRaw
    }
  }

  ctx.body = {
    exported_at: Date.now(),
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      profiles: profiles.map(p => p.profile_name),
      default_profile: profiles.find(p => p.is_default === 1)?.profile_name || null,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      avatar,
    },
  }
}

/**
 * POST /api/auth/users
 * Create a user account. Super admin only.
 */
export async function createManagedUser(ctx: Context) {
  const body = ctx.request.body as {
    username?: string
    password?: string
    role?: unknown
    status?: unknown
    phone?: unknown
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const role = normalizeRole(body.role || 'admin')
  const status = normalizeStatus(body.status || 'active')
  const phone = typeof body.phone === 'string' ? body.phone : null
  const profiles = normalizeProfiles(body.profiles)

  if (username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (!role || !status) {
    ctx.status = 400
    ctx.body = { error: 'Invalid role or status' }
    return
  }
  if (findUserByUsername(username)) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }
  // Check phone uniqueness
  const normalizedPhone = normalizePhoneNumber(phone)
  if (normalizedPhone && findUserByPhoneNumber(normalizedPhone)) {
    ctx.status = 409
    ctx.body = { error: 'Phone number already in use' }
    return
  }

  const missingProfile = validateProfiles(profiles)
  if (missingProfile) {
    ctx.status = 400
    ctx.body = { error: `Profile "${missingProfile}" does not exist` }
    return
  }

  const user = createUser({
    username,
    password,
    role,
    status,
    phone: normalizedPhone,
    profiles: role === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.status = 201
  ctx.body = { user, users: listUsers() }
}

/**
 * PUT /api/auth/users/:id
 * Update user account metadata, password, and profile bindings.
 */
export async function updateManagedUser(ctx: Context) {
  const id = Number(ctx.params.id)
  const user = Number.isInteger(id) ? findUserById(id) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  const body = ctx.request.body as {
    username?: string
    password?: string
    role?: unknown
    status?: unknown
    phone?: string | null
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = body.username == null ? undefined : String(body.username).trim()
  const password = body.password == null ? undefined : String(body.password)
  const role = body.role == null ? undefined : normalizeRole(body.role)
  const status = body.status == null ? undefined : normalizeStatus(body.status)
  const phone = body.phone == null ? undefined : (body.phone === '' ? null : body.phone)
  const profiles = body.profiles == null ? undefined : normalizeProfiles(body.profiles)

  if (username !== undefined && username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password !== undefined && password.length > 0 && password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (body.role != null && !role || body.status != null && !status) {
    ctx.status = 400
    ctx.body = { error: 'Invalid role or status' }
    return
  }
  if (username && username !== user.username) {
    const existing = findUserByUsername(username)
    if (existing && existing.id !== user.id) {
      ctx.status = 409
      ctx.body = { error: 'Username already exists' }
      return
    }
  }
  // Check phone uniqueness
  if (phone !== undefined) {
    const normalizedPhone = normalizePhoneNumber(phone)
    if (normalizedPhone) {
      const phoneOwner = findUserByPhoneNumber(normalizedPhone)
      if (phoneOwner && phoneOwner.id !== user.id) {
        ctx.status = 409
        ctx.body = { error: 'Phone number already in use' }
        return
      }
    }
  }

  const nextRole = role || user.role
  const nextStatus = status || user.status
  const currentUserId = ctx.state.user?.id
  if (user.id === currentUserId && nextStatus !== 'active') {
    ctx.status = 400
    ctx.body = { error: 'You cannot disable your own account' }
    return
  }
  if (user.role === 'super_admin' && user.status === 'active' && (nextRole !== 'super_admin' || nextStatus !== 'active') && countActiveSuperAdmins(user.id) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  if (profiles) {
    const missingProfile = validateProfiles(profiles)
    if (missingProfile) {
      ctx.status = 400
      ctx.body = { error: `Profile "${missingProfile}" does not exist` }
      return
    }
  }

  updateUser({
    userId: user.id,
    username,
    password: password || undefined,
    role: role || undefined,
    status: status || undefined,
    phone: phone !== undefined ? phone : undefined,
    profiles: nextRole === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.body = { user: findUserById(user.id), users: listUsers() }
}

/**
 * DELETE /api/auth/users/:id
 * Delete a user account and wipe everything it owns (WeChat bindings,
 * personal agent profiles). Super admin only.
 */
export async function deleteManagedUser(ctx: Context) {
  const id = Number(ctx.params.id)
  const user = Number.isInteger(id) ? findUserById(id) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (ctx.state.user?.id === user.id) {
    ctx.status = 400
    ctx.body = { error: 'You cannot delete your own account' }
    return
  }
  if (user.role === 'super_admin' && user.status === 'active' && countActiveSuperAdmins(user.id) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  const deletedProfiles = await deleteWeChatUserData(user)
  ctx.body = { success: true, deletedProfiles, users: listUsers() }
}

/**
 * POST /api/auth/bind-phone
 * Bind a phone number to the current user. The phone number serves as the
 * identity bridge between WeChat and the local account (1:1 binding).
 *
 * Body: { phone: string }
 */
export async function bindPhone(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const { phone } = ctx.request.body as { phone?: string }
  const normalized = normalizePhoneNumber(phone)
  if (!normalized) {
    ctx.status = 400
    ctx.body = { error: 'A valid phone number is required' }
    return
  }

  // Check if the phone is already taken by another user
  const existingUser = findUserByPhoneNumber(normalized)
  if (existingUser && existingUser.id !== userId) {
    ctx.status = 409
    ctx.body = {
      error: 'This phone number is already bound to another account',
      code: 'PHONE_ALREADY_IN_USE',
    }
    return
  }

  if (!updateUserPhoneNumber(userId, normalized)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to bind phone number' }
    return
  }

  const user = findUserById(userId)
  ctx.body = {
    success: true,
    phone_number: user?.phone_number || normalized,
  }
}

/**
 * DELETE /api/auth/phone
 * Unbind the current user's phone number. Refused if the user is currently
 * WeChat-bound (must unbind WeChat first).
 */
export async function unbindPhone(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const user = findUserById(userId)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (user.wechat_bound) {
    ctx.status = 400
    ctx.body = {
      error: 'Cannot remove phone number: please unbind WeChat first',
      code: 'WECHAT_BOUND',
    }
    return
  }

  if (!updateUserPhoneNumber(userId, null)) {
    ctx.status = 500
    ctx.body = { error: 'Failed to unbind phone number' }
    return
  }

  ctx.body = { success: true }
}

/**
 * GET /api/auth/locked-ips
 * List all currently locked IPs (protected).
 */
export async function listLockedIps(ctx: Context) {
  const locks = getLockedIps()
  ctx.body = { locks }
}

/**
 * DELETE /api/auth/locked-ips?ip=xxx
 * Unlock a specific IP. No ip param = unlock all.
 */
export async function unlockIpHandler(ctx: Context) {
  const ip = ctx.query.ip as string
  if (ip) {
    const found = unlockIp(ip)
    if (!found) {
      ctx.status = 404
      ctx.body = { error: 'IP not locked' }
      return
    }
    ctx.body = { success: true }
    return
  }
  // No IP specified — unlock all
  const count = unlockAll()
  ctx.body = { success: true, count }
}
