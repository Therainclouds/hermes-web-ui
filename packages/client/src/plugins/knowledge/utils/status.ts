/**
 * Knowledge plugin — status mapping utilities.
 */
import type { TagProps } from 'naive-ui'

export type DocumentStatus = 'pending' | 'indexing' | 'indexed' | 'failed' | 'metadata_only'

export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'pending',
  'indexing',
  'indexed',
  'failed',
  'metadata_only',
] as const

const STATUS_TAG_TYPE: Record<DocumentStatus, TagProps['type']> = {
  pending: 'warning',
  indexing: 'info',
  indexed: 'success',
  failed: 'error',
  metadata_only: 'default',
}

/** Get Naive UI tag type for a document status. */
export function statusTagType(status: string): TagProps['type'] {
  return STATUS_TAG_TYPE[status as DocumentStatus] || 'default'
}

/** Normalize a MIME type to a short display label (e.g. "Markdown", "PDF"). */
export function mimeTypeLabel(mime: string): string {
  if (mime.includes('markdown')) return 'Markdown'
  if (mime.includes('pdf')) return 'PDF'
  if (mime.includes('wordprocessingml')) return 'Word'
  if (mime.includes('text/plain')) return 'Text'
  if (mime.includes('html')) return 'HTML'
  return mime.split('/').pop()?.toUpperCase() || mime
}

/** Extract a tag from a MIME type (e.g. "text/markdown" -> "markdown"). */
export function mimeTypeTag(mime: string): string {
  if (mime.includes('markdown')) return 'markdown'
  if (mime.includes('pdf')) return 'pdf'
  if (mime.includes('wordprocessingml')) return 'docx'
  if (mime.includes('text/plain')) return 'text'
  return 'other'
}