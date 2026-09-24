import type { RecapEntry } from '../../../../shared/trpg-recap'

/**
 * Minimal API access for the standalone reader page.
 *
 * The reader deliberately does not import `@/api/client`: that module pulls in
 * the SPA router and its auth redirects, which have no meaning in a document
 * that only shows one book. This keeps the entry independent while still
 * sending the same bearer token and active-profile header the SPA uses, so the
 * saved chronicle is found under the same profile.
 */
function baseUrl(): string {
  return localStorage.getItem('hermes_server_url') || ''
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = localStorage.getItem('hermes_api_key')
  if (token) headers.Authorization = `Bearer ${token}`
  const profile = activeProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile
  return headers
}

async function get(path: string): Promise<Response> {
  const response = await fetch(`${baseUrl()}${path}`, { headers: authHeaders() })
  if (!response.ok) {
    throw Object.assign(new Error(`API Error ${response.status}`), { status: response.status })
  }
  return response
}

/** Find one saved chronicle by id, or null when it is gone / another profile. */
export async function loadRecap(meetingId: string, recapId: string): Promise<RecapEntry | null> {
  const response = await get(`/api/meeting-storage/${encodeURIComponent(meetingId)}/recaps`)
  const data = (await response.json()) as { recaps?: RecapEntry[] }
  return (data.recaps || []).find(recap => recap.id === recapId) || null
}

/** Read the saved Markdown chronicle; `download` adds the attachment disposition. */
export async function loadRecapMarkdown(meetingId: string, recapId: string, download = false): Promise<string> {
  const path = `/api/meeting-storage/${encodeURIComponent(meetingId)}/recaps/${encodeURIComponent(recapId)}/markdown${download ? '?download=1' : ''}`
  return (await get(path)).text()
}

/**
 * Fetch one chronicle illustration as bytes. The reader turns this into an
 * object URL because the endpoint needs the bearer/profile headers, so the URL
 * cannot be used directly in an `<img src>`.
 */
export async function loadRecapImage(meetingId: string, recapId: string, kind: 'cover' | 'content', chapterId?: string): Promise<Blob> {
  const query = chapterId ? `?chapterId=${encodeURIComponent(chapterId)}` : ''
  const path = `/api/meeting-storage/${encodeURIComponent(meetingId)}/recaps/${encodeURIComponent(recapId)}/images/${kind}${query}`
  return (await get(path)).blob()
}

/** Active profile name as the SPA stores it (shared localStorage, same origin). */
function activeProfileName(): string | null {
  return new URLSearchParams(location.search).get('profile') || localStorage.getItem('hermes_active_profile_name')
}

/** User id from the bearer token, mirroring `getStoredUserId()` in the SPA client. */
function storedUserId(): number | null {
  const token = localStorage.getItem('hermes_api_key')
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data = JSON.parse(atob(padded)) as { sub?: unknown }
    const id = Number(data.sub)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * The IndexedDB key the TRPG panel uses for a meeting's campaign (character
 * cards, avatars, highlights). Reproduced here so the standalone reader can
 * show the same characters; see `TrpgPanel.vue` for the writer side.
 */
export function campaignStorageKey(meetingId: string): string {
  return JSON.stringify([baseUrl(), storedUserId(), activeProfileName(), meetingId])
}

/** Standalone workbench requests bind to its opening profile, even if another tab switches profile. */
export async function writingRequest<T>(path: string, profile: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, { method, headers: { ...authHeaders(), 'X-Hermes-Profile': profile, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw Object.assign(new Error(`API Error ${response.status}`), { status: response.status })
  return response.json() as Promise<T>
}
