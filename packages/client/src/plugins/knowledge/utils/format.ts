/**
 * Knowledge plugin — formatting utilities.
 */

/** Convert a byte count to a human-readable string (B / KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Format an epoch-milliseconds timestamp as a localized date string.
 * The knowledge API returns ms everywhere (Date.now() on the server) —
 * treating these as seconds displayed dates in the year ~55,000.
 */
export function formatTimestamp(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  return new Date(epochMs).toLocaleString()
}

/** Format an epoch-milliseconds timestamp as a relative time string ("2 hours ago"). */
export function formatRelativeTime(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  const diff = Date.now() - epochMs
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 86_400_000 * 30) return `${Math.floor(diff / 86_400_000)}d ago`
  return formatTimestamp(epochMs)
}

/** Extract filename from a full path. */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** Extract the parent directory name from a full path. */
export function dirname(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('/') || '/'
}