import type { Context } from 'koa'
import { extractIp } from '../services/login-limiter'
import { logger } from '../services/logger'
import {
  clearAllLoginLocksInProcess,
  resetDefaultAdminPassword,
  verifyRecoveryPassword,
} from '../services/recovery'

interface RecoveryRequestBody {
  recoveryPassword?: unknown
}

function readRecoveryPassword(ctx: Context): string | null {
  const body = (ctx.request.body ?? {}) as RecoveryRequestBody
  if (typeof body.recoveryPassword !== 'string') return null
  const trimmed = body.recoveryPassword.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * POST /api/auth/recovery/clear-locks
 *
 * Clears all in-process and on-disk login locks. Intended for self-hosted LAN devices
 * where the operator cannot easily access the server shell. Authenticated by a single
 * fixed recovery password — see services/recovery.ts for the trust model.
 */
export async function clearLocksHandler(ctx: Context) {
  const password = readRecoveryPassword(ctx)
  if (!password || !verifyRecoveryPassword(password)) {
    logger.warn({ ip: extractIp(ctx), action: 'clear-locks' }, 'recovery: rejected clear-locks attempt')
    ctx.status = 401
    ctx.body = { error: 'Invalid recovery password' }
    return
  }

  const result = clearAllLoginLocksInProcess()
  ctx.status = 200
  ctx.body = { success: true, action: result.action, clearedCount: result.clearedCount }
}

/**
 * POST /api/auth/recovery/reset-password
 *
 * Resets the default admin password back to `DEFAULT_PASSWORD` and ensures super-admin /
 * active status. See clearLocksHandler for the trust model.
 */
export async function resetPasswordHandler(ctx: Context) {
  const password = readRecoveryPassword(ctx)
  if (!password || !verifyRecoveryPassword(password)) {
    logger.warn({ ip: extractIp(ctx), action: 'reset-password' }, 'recovery: rejected reset-password attempt')
    ctx.status = 401
    ctx.body = { error: 'Invalid recovery password' }
    return
  }

  const result = resetDefaultAdminPassword()
  if (!result.ok) {
    ctx.status = result.reason === 'user_missing' ? 404 : 500
    ctx.body = { error: result.reason }
    return
  }
  ctx.status = 200
  ctx.body = { success: true, action: result.action, username: result.username }
}