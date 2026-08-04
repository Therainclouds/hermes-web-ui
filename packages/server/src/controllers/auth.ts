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
  findUserByUsername,
  getUserAvatar,
  listUserProfiles,
  listUsers,
  replaceUserProfiles,
  setUserAvatar,
  touchUserLogin,
  updateUserModelGuideStatus,
  updateUser,
  updateUsername,
  updateUserPassword,
  verifyPassword,
  type ModelGuideStatus,
  type UserRole,
  type UserRecord,
  type UserStatus,
} from '../db/hermes/users-store'
import { issueUserJwt } from '../middleware/user-auth'
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
  loadDeviceBinding,
  saveDeviceBinding,
  clearDeviceBinding,
  type DeviceBinding,
} from '../services/device-binding'
import {
  setProfileDisplayName,
  setProfileAvatarRemote,
  setProfileAvatarGenerated,
  clearProfileIdentity,
} from '../services/hermes/profile-metadata'
import { getActiveProfileName } from '../services/hermes/hermes-profile'

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

async function passwordLogin(
  ctx: Context,
  username: string,
  password: string,
): Promise<{ ok: true; token: string; user: UserRecord } | { ok: false }> {
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

  try {
    const token = await issueUserJwt(user)
    recordPasswordSuccess(ip)
    return { ok: true, token, user }
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
  ctx.body = { token: result.token }
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
 * profile, provisions a local Hermes user (auto-bootstrapping a super_admin on
 * first run), issues a Hermes JWT, and persists the device binding so later
 * boots can restore the session without re-scanning.
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

  const localUsername = `tp_${profile.id}`
  let user = findUserByUsername(localUsername)
  if (!user) {
    if (countUsers() === 0) {
      // First run: auto-bootstrap a super_admin bound to this device.
      user = createUser({
        username: localUsername,
        password: randomUUID(),
        role: 'super_admin',
        status: 'active',
      })
    } else {
      // Device already configured locally: link a regular admin account.
      // Bind the default agent profile so the user can access profile-scoped
      // resources (profiles list, models, runtime status). Without this an
      // admin with no bound profiles gets 403 everywhere.
      user = createUser({
        username: localUsername,
        password: randomUUID(),
        role: 'admin',
        status: 'active',
        profiles: ['default'],
        defaultProfile: 'default',
      })
    }
  } else if (user.role !== 'super_admin' && listUserProfiles(user.id).length === 0) {
    // A previously-provisioned device user without any profile binding: grant
    // access to the default agent profile so login stays usable.
    replaceUserProfiles(user.id, ['default'], 'default')
  }
  if (!user) {
    ctx.status = 500
    ctx.body = { error: 'Failed to provision local user' }
    return
  }

  if (profile.display_name || profile.avatar_url) {
    // Sync the WeChat avatar/name onto the local user: use the real avatar URL
    // when present (rendered as an <img>), otherwise fall back to a seeded
    // multiavatar derived from the display name.
    setUserAvatar(user.id, profile.avatar_url
      ? JSON.stringify({ type: 'image', dataUrl: profile.avatar_url, seed: profile.display_name || '' })
      : JSON.stringify({ type: 'default', seed: profile.display_name || '' }))
  }

  const token = await issueUserJwt(user)
  touchUserLogin(user.id)

  const displayName = profile.display_name || profile.username || localUsername
  syncProfileIdentity(displayName, profile.avatar_url)
  const binding: DeviceBinding = {
    device_id: String(deviceId ?? ''),
    api_base: apiBase,
    api_key: key,
    models: modelList,
    display_name: displayName,
    username: profile.username || localUsername,
    bound_at: Date.now(),
  }
  await saveDeviceBinding(binding)

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
      device_id: binding.device_id,
      display_name: displayName,
    },
  }
}

/**
 * Reflect the Token Platform identity onto the active Hermes profile: the
 * "default" agent profile is displayed by its internal name in the meeting,
 * group chat, coding and profile selector surfaces. Writing the Web-UI
 * displayName metadata (plus the WeChat avatar) makes every surface show the
 * user's name instead of "default".
 */
function syncProfileIdentity(displayName: string, avatarUrl?: string | null): void {
  // Apply to the active profile and the "default" agent profile, so the name
  // shows up regardless of which profile the meeting/group-chat/coding surfaces
  // are scoped to.
  const names = new Set<string>([getActiveProfileName() || 'default', 'default'])
  for (const profileName of names) {
    setProfileDisplayName(profileName, displayName)
    if (avatarUrl) {
      setProfileAvatarRemote(profileName, avatarUrl)
    } else {
      setProfileAvatarGenerated(profileName, displayName)
    }
  }
}

/**
 * GET /api/auth/device-binding
 * Return whether this Hermes device has a persisted Token Platform binding.
 * Used by the login page to offer "restore previous scan" without re-scanning.
 */
export async function getDeviceBinding(ctx: Context) {
  const binding = await loadDeviceBinding()
  if (!binding) {
    ctx.body = { bound: false }
    return
  }
  ctx.body = {
    bound: true,
    display_name: binding.display_name,
    username: binding.username,
    models: binding.models,
    bound_at: binding.bound_at,
  }
}

/**
 * DELETE /api/auth/device-binding
 * Forget the persisted Token Platform binding on this device.
 */
export async function clearDeviceBindingController(ctx: Context) {
  await clearDeviceBinding()
  ctx.body = { success: true }
}

/**
 * POST /api/auth/device-login/restore
 * Restore a previous Token Platform binding and re-issue a Hermes JWT without
 * requiring a new WeChat scan. Verifies the stored api_key is still valid.
 */
export async function restoreDeviceLogin(ctx: Context) {
  const binding = await loadDeviceBinding()
  if (!binding?.api_key || !binding.api_base) {
    ctx.status = 404
    ctx.body = { error: 'No device binding found' }
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

  const localUsername = `tp_${profile.id}`
  const user = findUserByUsername(localUsername)
  if (!user || user.status !== 'active') {
    ctx.status = 401
    ctx.body = { error: 'Bound local user no longer exists' }
    return
  }

  // Ensure a non-super-admin device user always has the default profile bound.
  if (user.role !== 'super_admin' && listUserProfiles(user.id).length === 0) {
    replaceUserProfiles(user.id, ['default'], 'default')
  }

  const token = await issueUserJwt(user)
  touchUserLogin(user.id)
  syncProfileIdentity(profile.display_name || profile.username || localUsername, profile.avatar_url)
  ctx.body = { token, user: { id: user.id, username: user.username, role: user.role } }
}

/**
 * POST /api/auth/bind-super-admin
 * Upgrade the currently authenticated user to a super administrator, after
 * verifying that they can provide valid super-admin credentials.
 *
 * Used by WeChat device-login users who are provisioned as regular admins:
 * after scanning they can choose to bind to the super administrator account by
 * entering its username/password. Wrong credentials are rejected and the user
 * stays a regular admin. A fresh JWT is issued because the old token still
 * carries the previous role.
 *
 * Body: { username, password }.
 */
export async function bindSuperAdmin(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const body = ctx.request.body as { username?: unknown; password?: unknown }
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')

  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Super administrator username and password are required' }
    return
  }

  const target = findUserByUsername(username)
  if (!target || target.role !== 'super_admin' || target.status !== 'active') {
    ctx.status = 401
    ctx.body = { error: 'Invalid super administrator credentials' }
    return
  }

  if (!verifyPassword(password, target.password_hash)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid super administrator credentials' }
    return
  }

  const user = findUserById(userId)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (user.role === 'super_admin') {
    ctx.body = { token: await issueUserJwt(user), user: { id: user.id, username: user.username, role: user.role } }
    return
  }

  const upgraded = updateUser({ userId, role: 'super_admin' })
  if (!upgraded) {
    ctx.status = 500
    ctx.body = { error: 'Failed to bind super administrator' }
    return
  }

  const token = await issueUserJwt(upgraded)
  touchUserLogin(upgraded.id)
  ctx.body = { token, user: { id: upgraded.id, username: upgraded.username, role: upgraded.role } }
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
 * Identity is already established by the caller (JWT issued after a WeChat
 * scan login, or a normal password login). This lets WeChat device users set
 * their own account password for the first time, or reset it after forgetting
 * it by re-scanning with WeChat.
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

  updateUserPassword(user.id, newPassword)
  ctx.body = { success: true }
}

/**
 * POST /api/auth/change-username
 * Change username (protected).
 */
export async function changeUsername(ctx: Context) {
  const { currentPassword, newUsername } = ctx.request.body as { currentPassword?: string; newUsername?: string }
  if (!currentPassword || !newUsername) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new username are required' }
    return
  }
  if (newUsername.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
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
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const role = normalizeRole(body.role || 'admin')
  const status = normalizeStatus(body.status || 'active')
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
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = body.username == null ? undefined : String(body.username).trim()
  const password = body.password == null ? undefined : String(body.password)
  const role = body.role == null ? undefined : normalizeRole(body.role)
  const status = body.status == null ? undefined : normalizeStatus(body.status)
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
    profiles: nextRole === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.body = { user: findUserById(user.id), users: listUsers() }
}

/**
 * DELETE /api/auth/users/:id
 * Delete a user account. Super admin only.
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

  deleteUser(user.id)
  ctx.body = { success: true, users: listUsers() }
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
