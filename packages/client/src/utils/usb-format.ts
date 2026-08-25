/**
 * USB explorer format utilities.
 * Shared between toolbar, breadcrumb, tree, list, and preview components.
 */

export type ExplorerEntryKind =
  | 'folder'
  | 'image'
  | 'text'
  | 'code'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'unknown'

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less',
  'html', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf',
  'py', 'java', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh',
])

const DOCUMENT_EXT = new Set([
  'md', 'markdown', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'csv', 'rtf', 'odt', 'ods', 'odp',
])

const ARCHIVE_EXT = new Set(['zip', 'tar', 'tgz', 'gz', 'bz2', 'xz', '7z', 'rar', 'iso'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v'])
const TEXT_EXT = new Set(['txt', 'log', 'env'])

export function getExplorerEntryKind(name: string, isDir: boolean): ExplorerEntryKind {
  if (isDir) return 'folder'
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex < 0 || dotIndex === name.length - 1) return 'unknown'
  const ext = name.slice(dotIndex + 1).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (DOCUMENT_EXT.has(ext)) return 'document'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (CODE_EXT.has(ext)) return 'code'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'unknown'
}

export function isImageKind(kind: ExplorerEntryKind): boolean {
  return kind === 'image'
}

export function isTextPreviewKind(kind: ExplorerEntryKind): boolean {
  return kind === 'text' || kind === 'code'
}

export function joinExplorerPath(parentPath: string, childName: string): string {
  if (!parentPath || parentPath === '/') return `/${childName}`
  const trimmed = parentPath.replace(/\/+$/, '')
  return `${trimmed}/${childName}`
}

export function parentExplorerPath(currentPath: string): string {
  if (!currentPath || currentPath === '/') return '/'
  const trimmed = currentPath.replace(/\/+$/, '') || '/'
  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return trimmed.slice(0, lastSlash) || '/'
}

export function explorerBaseName(currentPath: string): string {
  if (!currentPath || currentPath === '/') return ''
  const trimmed = currentPath.replace(/\/+$/, '') || '/'
  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash < 0) return trimmed
  return trimmed.slice(lastSlash + 1)
}

export function normalizeExplorerPath(input: string): string {
  if (!input) return '/'
  const replaced = input.replace(/\\/g, '/').trim()
  if (!replaced) return '/'
  const withSlash = replaced.startsWith('/') ? replaced : `/${replaced}`
  const collapsed = withSlash.replace(/\/+/g, '/')
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1)
  }
  return collapsed
}

export function formatExplorerBytes(value: number | null | undefined, fallback = '—'): string {
  if (value == null || !Number.isFinite(value)) return fallback
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let next = value
  let unitIndex = 0
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024
    unitIndex += 1
  }
  return `${next.toFixed(next >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatExplorerTime(value: string | null | undefined, fallback = '—'): string {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}