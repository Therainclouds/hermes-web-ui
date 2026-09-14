import { randomBytes } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { getProfileUploadDir } from '../services/hermes/upload-paths'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../lib/multipart'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../lib/request-body'
import { PAGE_UPLOAD_MAX_BYTES } from '../services/hermes/upload-limits'
import { getKnowledgeServiceOrNull } from './knowledge'
import { resolveDefaultRoots } from '../services/knowledge/bootstrap'

const DEFAULT_MAX_UPLOAD_SIZE = PAGE_UPLOAD_MAX_BYTES

// Operators can raise the limit for large-file workflows (e.g. media uploads)
// via HERMES_MAX_UPLOAD_SIZE (bytes) without patching the bundle. The value is
// read per request so tests can override it with vi.stubEnv.
function getMaxUploadSize(): number {
  const override = Number(process.env.HERMES_MAX_UPLOAD_SIZE)
  if (Number.isFinite(override) && override > 0) return override
  return DEFAULT_MAX_UPLOAD_SIZE
}

function formatUploadLimit(maxBytes: number): string {
  if (maxBytes % (1024 * 1024 * 1024) === 0) return `${maxBytes / (1024 * 1024 * 1024)}G`
  return `${Math.round(maxBytes / 1024 / 1024)}MB`
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

export async function handleUpload(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data' }; return
  }
  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400; ctx.body = { error: 'Missing boundary' }; return
  }
  let chunks: Buffer[] = []
  let totalSize = 0
  let oversize = false
  const maxUploadSize = getMaxUploadSize()
  // Leave the stream alive when the loop ends early; the iterator would
  // otherwise destroy it and take the unsent response down with it.
  const body = nonDestroyingRequestBody(ctx.req)
  for await (const chunk of body) {
    totalSize += chunk.length
    if (totalSize > maxUploadSize) {
      oversize = true
      break
    }
    chunks.push(chunk)
  }
  if (oversize) {
    chunks = []
    await drainRejectedRequest(ctx.req)
    ctx.status = 413
    ctx.body = { error: `File too large (max ${formatUploadLimit(maxUploadSize)})` }
    return
  }
  const raw = Buffer.concat(chunks)
  const parts = splitMultipart(raw, boundaryBuf)
  const results: { name: string; path: string }[] = []
  const uploadDir = getProfileUploadDir(requestedProfile(ctx))
  await mkdir(uploadDir, { recursive: true })
  let archiveToKnowledge = false
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)
    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400; ctx.body = { error: error.message }; return
      }
      throw error
    }
    // A field part (no filename) — capture the archive opt-in checkbox.
    if (!filename) {
      if (/name="archive_to_knowledge"/.test(header)) {
        archiveToKnowledge = ['true', '1', 'on', 'yes'].includes(data.toString('utf-8').trim().toLowerCase())
      }
      continue
    }
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    const savedName = randomBytes(8).toString('hex') + ext
    const savedPath = join(uploadDir, savedName)
    await writeFile(savedPath, data)
    results.push({ name: filename, path: savedPath })
  }

  // Archive opt-in (task-12): record each saved file as metadata_only in
  // the uploads auto vault so it is visible in the knowledge library
  // immediately (never copies; full indexing is a user promote). Best
  // effort — a knowledge failure must never fail the upload itself.
  let archive: { archived: boolean; reason?: string; documentIds?: number[] } =
    { archived: false }
  if (archiveToKnowledge && results.length > 0) {
    const service = getKnowledgeServiceOrNull()
    if (!service) {
      archive = { archived: false, reason: 'plugin_disabled' }
    } else {
      try {
        const roots = resolveDefaultRoots()
        let vault = service.findVaultByPath(roots.uploadDir)
        if (!vault) vault = service.addVault(roots.uploadDir, '我的上传', 'auto')
        const documentIds: number[] = []
        for (const f of results) {
          try {
            const res = await service.ingest(f.path, vault.id)
            if (res.documentId) documentIds.push(res.documentId)
          } catch { /* per-file: keep archiving the rest */ }
        }
        archive = { archived: documentIds.length > 0, reason: documentIds.length ? undefined : 'ingest_failed', documentIds }
      } catch (err) {
        archive = { archived: false, reason: err instanceof Error ? err.message : 'archive_failed' }
      }
    }
  } else if (archiveToKnowledge) {
    archive = { archived: false, reason: 'no_files' }
  }

  ctx.body = { files: results, archive }
}
