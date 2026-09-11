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

/** Format a unix timestamp (seconds) as a localized date string. */
export function formatTimestamp(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—'
  return new Date(unixSeconds * 1000).toLocaleString()
}

/** Format a unix timestamp as a relative time string ("2 hours ago"). */
export function formatRelativeTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—'
  const now = Math.floor(Date.now() / 1000)
  const diff = now - unixSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return formatTimestamp(unixSeconds)
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