/**
 * Knowledge plugin — validation utilities.
 */

const MIN_API_KEY_LENGTH = 8
const MAX_API_KEY_LENGTH = 256

/** Validate an embedding API key. Returns null if valid, or an error message. */
export function validateApiKey(key: string): string | null {
  const trimmed = key.trim()
  if (trimmed.length < MIN_API_KEY_LENGTH) {
    return 'API key must be at least 8 characters'
  }
  if (trimmed.length > MAX_API_KEY_LENGTH) {
    return 'API key must be at most 256 characters'
  }
  if (/\s/.test(trimmed)) {
    return 'API key cannot contain whitespace'
  }
  return null
}

/** Returns true if the key passes basic validation. */
export function isValidApiKey(key: string): boolean {
  return validateApiKey(key) === null
}