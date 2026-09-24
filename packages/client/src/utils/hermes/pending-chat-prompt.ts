/**
 * One-shot prompts queued for a chat session that is opened in another tab.
 *
 * The TRPG panel creates the Hermes recap session and opens the chat in a new
 * tab, so the recording tab is never navigated away. The instruction cannot ride
 * in the URL safely, and `sessionStorage` is not shared with the opened tab, so
 * it is written to `localStorage` (same origin, shared by every tab) under the
 * session id. The chat view of whichever tab loads that session consumes it once
 * and sends it as a normal user turn.
 */

const KEY_PREFIX = 'hermes.pending_chat_prompt.'
/** A queued prompt older than this is treated as abandoned (closed tab, etc.). */
const MAX_AGE_MS = 10 * 60 * 1000

export function queuePendingChatPrompt(sessionId: string, content: string): boolean {
  if (!sessionId || !content.trim()) return false
  try {
    localStorage.setItem(KEY_PREFIX + sessionId, JSON.stringify({ content, createdAt: Date.now() }))
    return true
  } catch {
    return false
  }
}

/** Read and delete the queued prompt for a session (one-shot). */
export function takePendingChatPrompt(sessionId: string): string | null {
  try {
    const key = KEY_PREFIX + sessionId
    const raw = localStorage.getItem(key)
    if (!raw) return null
    localStorage.removeItem(key)
    const parsed = JSON.parse(raw) as { content?: unknown; createdAt?: unknown }
    if (typeof parsed?.content !== 'string' || !parsed.content.trim()) return null
    if (typeof parsed.createdAt === 'number' && Date.now() - parsed.createdAt > MAX_AGE_MS) return null
    return parsed.content
  } catch {
    return null
  }
}

/**
 * Consume a queued prompt once the route session is live, then send it through
 * the provided sender. Kept store-agnostic so it can be unit-tested without
 * mounting the chat view.
 */
export async function flushPendingChatPrompt(
  sessionId: string | null,
  isActive: boolean,
  isLocalOnly: boolean,
  send: (content: string) => Promise<unknown>,
): Promise<boolean> {
  if (!sessionId || !isActive || isLocalOnly) return false
  const content = takePendingChatPrompt(sessionId)
  if (!content) return false
  await send(content)
  return true
}
