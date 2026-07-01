export interface ClearLocksResponse {
  success: true
  action: 'cleared-locks'
  clearedCount: number
}

export interface ResetPasswordResponse {
  success: true
  action: 'reset-password'
  username: string
}

/**
 * Clear all in-process and on-disk login locks. Authenticated by a shared
 * recovery password (see server services/recovery.ts).
 */
export async function clearLoginLocks(recoveryPassword: string): Promise<ClearLocksResponse> {
  const res = await fetch('/api/auth/recovery/clear-locks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recoveryPassword }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err: any = new Error(data.error || 'Failed to clear login locks')
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * Reset the default admin password back to the shipped default.
 * Authenticated by a shared recovery password (see server services/recovery.ts).
 */
export async function resetDefaultLogin(recoveryPassword: string): Promise<ResetPasswordResponse> {
  const res = await fetch('/api/auth/recovery/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recoveryPassword }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err: any = new Error(data.error || 'Failed to reset default password')
    err.status = res.status
    throw err
  }
  return res.json()
}