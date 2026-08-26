const DEFAULT_MAX = 600
const TRUNCATION_NOTE = '\n…[truncated]'

export function clampMessageForUi(
  value: string | null | undefined,
  maxChars = DEFAULT_MAX,
): string {
  const raw = (value ?? '').toString().replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  if (raw.length <= maxChars) return raw
  return raw.slice(0, maxChars).trimEnd() + TRUNCATION_NOTE
}
