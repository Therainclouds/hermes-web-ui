/**
 * Safe localStorage JSON accessors.
 *
 * Always prefer these over raw `JSON.parse(localStorage.getItem(...))`:
 * - `safeGetJSON` returns a caller-supplied fallback on missing key,
 *   parse error, or storage access error (e.g. quota, disabled storage).
 * - `safeSetJSON` swallows serialization/storage errors and returns false,
 *   letting callers decide whether to surface a UI warning.
 *
 * Why: a corrupted archive or a thrown SyntaxError inside a Vue setup()
 * would otherwise render the whole component tree broken. See
 * docs/harness/meeting-asr-safety-audit.md (R-5) for the original incident.
 */

export function safeGetJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn(`[safe-storage] Failed to read ${key}:`, err)
    }
    return fallback
  }
}

export function safeSetJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn(`[safe-storage] Failed to persist ${key}:`, err)
    }
    return false
  }
}