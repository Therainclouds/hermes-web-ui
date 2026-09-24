import { parseWritingSettings } from '../../../../shared/trpg-writing'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getWebUiHome } from '../../config'
import { recapModes, recapTones, recapImageKinds, recapImageMimes, type RecapOptions, type RecapEntry, type RecapImage, type RecapImageKind, type RecapImageMime } from '../../../../shared/trpg-recap'
export type { RecapEntry, RecapImage } from '../../../../shared/trpg-recap'
/** Field-level validation failure. `message` stays 'invalid_recap' for compatibility; `detail` names the exact field and reason. */
export class RecapError extends Error {
  status = 400
  code = 'invalid_recap'
  constructor(readonly detail: string) { super('invalid_recap'); this.name = 'RecapError' }
}
function fail(detail: string): never { throw new RecapError(detail) }
export function meetingDir(id: string) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail('meetingId is missing or has an unsupported format')
  return join(getWebUiHome(), 'meetings', id)
}
const RECAP_ID = /^[0-9a-f-]{36}$/
/** Markdown chronicle files live beside recaps.json, one `<recapId>.md` per saved chronicle. */
export function recapMarkdownPath(meetingId: string, recapId: string) {
  if (!RECAP_ID.test(recapId)) fail('recapId is not a valid recap id')
  return join(meetingDir(meetingId), 'recaps', `${recapId}.md`)
}

/**
 * Chronicle illustrations live beside the Markdown chronicle:
 * `<recapId>.cover.<ext>` for the cover, and `<recapId>.content[.<chapterId>].<ext>`
 * for chapter illustrations. The extension follows the MIME type stored on the
 * entry, so a PNG-written image is not looked up as `.jpg`.
 */
const IMAGE_EXT: Record<RecapImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024
export function recapImagePath(meetingId: string, recapId: string, kind: RecapImageKind, chapterId: string | undefined, mime: RecapImageMime) {
  if (!RECAP_ID.test(recapId)) fail('recapId is not a valid recap id')
  if (!recapImageKinds.includes(kind)) fail(`kind must be one of ${recapImageKinds.join(', ')}`)
  if (kind === 'cover' && chapterId) fail('cover images cannot be bound to a chapter')
  if (chapterId && !RECAP_ID.test(chapterId)) fail('chapterId is not a valid chapter id')
  const suffix = chapterId ? `.${chapterId}` : ''
  return join(meetingDir(meetingId), 'recaps', `${recapId}.${kind}${suffix}.${IMAGE_EXT[mime]}`)
}
/** Every extension a given (recap, kind, chapter) slot could have used, for cleanup on rewrite/delete. */
function recapImagePaths(meetingId: string, recapId: string, kind: RecapImageKind, chapterId: string | undefined) {
  return recapImageMimes.map(mime => recapImagePath(meetingId, recapId, kind, chapterId, mime))
}
export function sameImageSlot(a: Pick<RecapImage, 'kind' | 'chapterId'>, kind: RecapImageKind, chapterId?: string) {
  return a.kind === kind && (a.chapterId || '') === (chapterId || '')
}
/** Decode a base64 data payload and confirm the bytes really are the claimed image type. */
function decodeImage(dataBase64: unknown, mime: RecapImageMime): Buffer {
  if (typeof dataBase64 !== 'string' || !dataBase64 || dataBase64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(dataBase64)) fail('image data must be a base64 string of at most 12 MB')
  const bytes = Buffer.from(dataBase64, 'base64')
  if (!bytes.length) fail('image data decoded to zero bytes')
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  const actual: RecapImageMime | '' = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : ''
  if (!actual) fail('image data is not a PNG, JPEG or WebP')
  if (actual !== mime) fail(`declared mime "${mime}" does not match the ${actual} bytes`)
  return bytes
}
export interface RecapImageInput { kind: RecapImageKind; chapterId?: string; mime: RecapImageMime; dataBase64: string; model?: string; prompt?: string }
export function parseRecapImageInput(body: any): RecapImageInput {
  if (!body || !recapImageKinds.includes(body.kind)) fail(`kind must be one of ${recapImageKinds.join(', ')}`)
  if (!recapImageMimes.includes(body.mime)) fail(`mime must be one of ${recapImageMimes.join(', ')}`)
  const chapterId = body.chapterId == null || body.chapterId === '' ? undefined : text(body.chapterId, 64, true, 'chapterId')
  if (body.kind === 'cover' && chapterId) fail('cover images cannot be bound to a chapter')
  if (chapterId && !RECAP_ID.test(chapterId)) fail('chapterId is not a valid chapter id')
  return { kind: body.kind, chapterId, mime: body.mime, dataBase64: body.dataBase64, model: text(body.model || '', 200, false, 'model') || undefined, prompt: text(body.prompt || '', 8000, false, 'prompt') || undefined }
}
async function findEntry(meetingId: string, recapId: string, profile: string) {
  const entry = (await readEntries(meetingId)).find(r => r.id === recapId && r.profile === profile)
  if (!entry) throw Object.assign(new Error('recap_not_found'), { status: 404 })
  return entry
}
/**
 * Store one illustration for a saved chronicle and record it on the entry.
 *
 * Rewriting the same slot (same kind + chapter) replaces the bytes and the
 * metadata instead of leaving two files behind, so "regenerate" is idempotent.
 */
export async function saveRecapImage(meetingId: string, recapId: string, body: any, profile: string) {
  const input = parseRecapImageInput(body)
  const entry = await findEntry(meetingId, recapId, profile)
  if (input.chapterId && !entry.chapters.some(chapter => chapter.id === input.chapterId)) fail(`chapterId "${input.chapterId}" is not a chapter of this chronicle`)
  const bytes = decodeImage(input.dataBase64, input.mime)
  const image: RecapImage = { kind: input.kind, ...(input.chapterId ? { chapterId: input.chapterId } : {}), mime: input.mime, createdAt: Date.now(), ...(input.model ? { model: input.model } : {}), ...(input.prompt ? { prompt: input.prompt } : {}) }
  await mkdir(join(meetingDir(meetingId), 'recaps'), { recursive: true })
  // Drop any previous file for this slot (including a different extension) before renaming the new one in.
  await Promise.all(recapImagePaths(meetingId, recapId, input.kind, input.chapterId).map(path => unlink(path).catch(() => {})))
  await atomicBinary(recapImagePath(meetingId, recapId, input.kind, input.chapterId, input.mime), bytes)
  await update(meetingId, entries => entries.map(item => item.id === recapId && item.profile === profile
    ? { ...item, images: [...(item.images || []).filter(existing => !sameImageSlot(existing, input.kind, input.chapterId)), image] }
    : item))
  return image
}
/** Read one stored illustration; missing bytes and missing metadata are both 404. */
export async function readRecapImage(meetingId: string, recapId: string, kindRaw: string, chapterIdRaw: string | undefined, profile: string) {
  if (!recapImageKinds.includes(kindRaw as RecapImageKind)) fail(`kind must be one of ${recapImageKinds.join(', ')}`)
  const kind = kindRaw as RecapImageKind
  const chapterId = chapterIdRaw ? chapterIdRaw : undefined
  const entry = await findEntry(meetingId, recapId, profile)
  const meta = (entry.images || []).find(image => sameImageSlot(image, kind, chapterId))
  if (!meta) throw Object.assign(new Error('recap_image_not_found'), { status: 404 })
  const buffer = await readFile(recapImagePath(meetingId, recapId, kind, chapterId, meta.mime))
  return { buffer, mime: meta.mime, image: meta }
}
/** Remove every illustration file for a chronicle (their metadata lives on the entry). */
async function removeRecapImages(meetingId: string, recapId: string, images: RecapImage[] = []) {
  const paths = new Set<string>()
  for (const image of images) for (const path of recapImagePaths(meetingId, recapId, image.kind, image.chapterId)) paths.add(path)
  await Promise.all([...paths].map(path => unlink(path).catch(() => {})))
}
async function atomicBinary(path: string, value: Buffer) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, value, { mode: 0o600 })
  await rename(tmp, path)
}
/**
 * Render a saved recap as a standalone Markdown chronicle.
 *
 * The document is intentionally free of localized labels: the title and chapter
 * headings come from the model, and per-chapter highlights are folded in as
 * blockquote marginalia that quote the transcript evidence. The viewer page
 * renders localized chrome (mode, tone, timeline appendix) from the structured
 * entry, so the `.md` file stays portable.
 */
export function renderRecapMarkdown(entry: RecapEntry): string {
  const quote = (value: string) => value.split(/\r?\n/).map(line => line.trim() ? `> ${line}` : '>').join('\n')
  const lines: string[] = [`# ${entry.title}`, '']
  for (const [index, chapter] of entry.chapters.entries()) {
    if (index > 0) lines.push('', '---', '')
    lines.push(`## ${chapter.title}`, '', chapter.body.trim())
    for (const highlight of chapter.highlights) {
      const evidence = highlight.evidence.trim()
      lines.push('', quote(`**${highlight.name}** ${highlight.action}${evidence ? `\n\n*${evidence}*` : ''}`))
    }
  }
  lines.push('')
  return lines.join('\n')
}
function text(v: unknown, max: number, required = true, field = 'value'): string {
  if (typeof v !== 'string') fail(`${field} must be a string`)
  if (v.length > max) fail(`${field} exceeds ${max} characters (got ${v.length})`)
  if (required && !v.trim()) fail(`${field} is required`)
  return v
}
export function parseRecapInput(v: any): RecapOptions {
  if (!v || !recapModes.includes(v.mode) || !recapTones.includes(v.tone || 'epic') ||
    (v.chapterHint != null && (!Number.isInteger(v.chapterHint) || v.chapterHint < 2 || v.chapterHint > (v.mode === 'long_novel' ? 24 : 8))) ||
    !Array.isArray(v.characters) || v.characters.length > 20) return fail('invalid mode, tone, characters or chapterHint (2-24 for long_novel, 2-8 otherwise)')
  const ids = new Set<string>()
  const characters = v.characters.map((c: any, i: number) => {
    const id = text(c?.id, 80, true, `characters[${i}].id`)
    const name = text(c?.name, 80, true, `characters[${i}].name`).replace(/[【】\r\n]/g, '').trim()
    if (!name) fail(`characters[${i}].name is empty after removing 【】 and line breaks`)
    if (ids.has(id)) fail(`characters[${i}].id "${id}" is duplicated`)
    ids.add(id)
    return { id, name, player: text(c.player || '', 100, false, `characters[${i}].player`), ...(v.mode === 'long_novel' ? { appearance: text(c.appearance || '', 2000, false, `characters[${i}].appearance`) } : {}) }
  })
  if (v.mode === 'long_novel' && v.targetChars != null && (!Number.isInteger(v.targetChars) || v.targetChars < 5000 || v.targetChars > 60000)) fail('targetChars must be an integer between 5000 and 60000')
  let writing
  try { writing = v.writing == null ? undefined : parseWritingSettings(v.writing) } catch { fail('invalid writing model settings') }
  return { ...(writing ? { writing } : {}), ...(v.mode === 'long_novel' ? { targetChars: v.targetChars ?? 20000 } : {}), mode: v.mode, tone: v.tone || 'epic', chapterHint: v.chapterHint ?? undefined, characters, setting: text(v.setting || '', 3000, false, 'setting'), style: text(v.style || '', 500, false, 'style') }
}
export interface Snapshot { id: string; meetingId: string; profile: string; options: RecapOptions; sentences: { text: string; speaker?: string; timestamp?: string | number }[] }
async function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}
async function atomicText(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, value, { mode: 0o600 })
  await rename(tmp, path)
}
export async function prepareRecap(v: any, profile: string) {
  const dir = meetingDir(v?.meetingId), options = parseRecapInput(v)
  if (!Array.isArray(v.sentences) || !v.sentences.length || v.sentences.length > 20000) return fail('sentences must be a non-empty array of at most 20000 items')
  const sentences = v.sentences.map((s: any, i: number) => ({ text: text(s?.text, 12000, true, `sentences[${i}].text`), speaker: text(s.speaker || '', 100, false, `sentences[${i}].speaker`), timestamp: typeof s.timestamp === 'number' ? s.timestamp : text(s.timestamp || '', 100, false, `sentences[${i}].timestamp`) }))
  if (JSON.stringify(sentences).length > 2000000) return fail('transcript snapshot is too large')
  const id = randomUUID()
  await mkdir(join(dir, 'recap-requests'), { recursive: true })
  await atomicJson(join(dir, 'recap-requests', `${id}.json`), { id, meetingId: v.meetingId, profile, options, sentences } satisfies Snapshot)
  return { requestId: id }
}
export async function snapshot(meetingId: string, id: string, profile: string): Promise<Snapshot> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return fail('requestId is missing or not a prepared snapshot id')
  const data = JSON.parse(await readFile(join(meetingDir(meetingId), 'recap-requests', `${id}.json`), 'utf8')) as Snapshot
  if (data.profile !== profile) throw Object.assign(new Error('profile_forbidden'), { status: 403 })
  return data
}
export async function recapTranscript(meetingId: string, id: string, profile: string, cursor = 0) {
  const data = await snapshot(meetingId, id, profile)
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= data.sentences.length) return fail(`cursor must be an integer in 0-${data.sentences.length - 1}`)
  let end = cursor, count = 0
  while (end < data.sentences.length && count + data.sentences[end].text.length <= 60000) count += data.sentences[end++].text.length
  const sentences = data.sentences.slice(cursor, end).map((s, offset) => ({ index: cursor + offset, ...s }))
  return { meetingId, requestId: id, options: data.options, sentences, nextCursor: end < data.sentences.length ? end : null, total: data.sentences.length }
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Locate a quote in the joined transcript, treating any run of whitespace (including the sentence-join newline) as equivalent. */
function findInTranscript(transcript: string, quote: string): number {
  const exact = transcript.indexOf(quote)
  if (exact >= 0) return exact
  const pattern = quote.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
  const match = pattern ? new RegExp(pattern).exec(transcript) : null
  return match ? match.index : -1
}
function resolveAnchor(c: any, at: string, sentences: Snapshot['sentences'], transcript: string) {
  if (c?.from != null || c?.to != null) {
    const from = c.from, to = c.to == null ? c.from : c.to
    if (!Number.isInteger(from) || !Number.isInteger(to)) fail(`${at}.from and ${at}.to must be integer sentence indices`)
    if (from < 0 || to < from || to >= sentences.length) fail(`${at}.from/${at}.to out of range: valid sentence indices are 0-${sentences.length - 1}`)
    return { startQuote: sentences[from].text, endQuote: sentences[to].text }
  }
  const startQuote = c?.startQuote == null ? '' : text(c.startQuote, 2000, true, `${at}.startQuote`)
  const endQuote = c?.endQuote == null ? '' : text(c.endQuote, 2000, true, `${at}.endQuote`)
  if (!startQuote && !endQuote) return { startQuote: '', endQuote: '' }
  const start = startQuote ? findInTranscript(transcript, startQuote) : -1
  if (startQuote && start < 0) fail(`${at}.startQuote is not verbatim in the transcript; prefer from/${at}.to sentence indices`)
  const end = endQuote ? findInTranscript(transcript, endQuote) : -1
  if (endQuote && (end < 0 || (startQuote && end < start))) fail(`${at}.endQuote is not verbatim in the transcript at or after startQuote; prefer from/${at}.to sentence indices`)
  return { startQuote, endQuote }
}
export function validateRecap(v: any, source: Snapshot): RecapEntry {
  if (!v || !Array.isArray(v.chapters) || !v.chapters.length || v.chapters.length > (source.options.mode === 'long_novel' ? 24 : 8)) return fail('chapters must be an array of 1-24 chapters for long_novel, 1-8 otherwise')
  const timelineInput = v.timeline == null ? [] : v.timeline
  if (!Array.isArray(timelineInput) || timelineInput.length > 300) return fail('timeline must be an array of at most 300 rows')
  const { sentences } = source
  const transcript = sentences.map(s => s.text).join('\n')
  const chapters = v.chapters.map((c: any, i: number) => {
    const at = `chapters[${i}]`
    const title = text(c?.title, 200, true, `${at}.title`)
    const body = text(c?.body, source.options.mode === 'long_novel' ? 80000 : 1800, true, `${at}.body`)
    const { startQuote, endQuote } = resolveAnchor(c, at, sentences, transcript)
    const rawHighlights = c?.highlights == null ? [] : c.highlights
    if (!Array.isArray(rawHighlights) || rawHighlights.length > 30) return fail(`${at}.highlights must be an array of at most 30 items`)
    const highlights = rawHighlights.map((h: any, j: number) => {
      const hat = `${at}.highlights[${j}]`
      const character = source.options.characters.find(ch => ch.id === h?.characterId)
      if (!character) return fail(`${hat}.characterId "${String(h?.characterId ?? '')}" is not in the character roster [${source.options.characters.map(ch => ch.id).join(', ')}]`)
      const evidence = text(h?.evidence ?? '', 2000, false, `${hat}.evidence`)
      if (evidence && findInTranscript(transcript, evidence) < 0) return fail(`${hat}.evidence is not verbatim in the transcript: "${evidence.slice(0, 40)}"`)
      return { characterId: character.id, name: `【${character.name}】`, action: text(h?.action, 500, true, `${hat}.action`), evidence }
    })
    return { id: randomUUID(), title, startQuote, endQuote, body, highlights }
  })
  return { ...source.options, id: source.id, meetingId: source.meetingId, title: text(v.title, 200, true, 'title'), chapters,
    timeline: timelineInput.map((t: any, i: number) => ({ time: text(t?.time ?? '', 100, false, `timeline[${i}].time`), text: text(t?.text, 1000, true, `timeline[${i}].text`) })), generatedAt: Date.now(), skillUsed: 'trpg-recap' }
}
type StoredEntry = RecapEntry & { profile: string }
async function readEntries(meetingId: string): Promise<StoredEntry[]> {
  try { return JSON.parse(await readFile(join(meetingDir(meetingId), 'recaps.json'), 'utf8')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
export async function listRecaps(meetingId: string, profile: string) {
  return (await readEntries(meetingId)).filter(r => r.profile === profile).map(({ profile: _, ...r }) => r)
}
const queues = new Map<string, Promise<unknown>>()
async function update(meetingId: string, fn: (entries: StoredEntry[]) => StoredEntry[]) {
  const key = meetingDir(meetingId), previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => { const entries = fn(await readEntries(meetingId)); await mkdir(key, { recursive: true }); await atomicJson(join(key, 'recaps.json'), entries) })
  queues.set(key, next)
  try { await next } finally { if (queues.get(key) === next) queues.delete(key) }
}
export async function saveRecap(meetingId: string, body: any, profile: string, fromNovelPipeline = false) {
  const source = await snapshot(meetingId, body?.requestId, profile)
  if (source.options.mode === 'long_novel' && !fromNovelPipeline) fail('long_novel must be saved by the durable novel pipeline')
  const entry = validateRecap(body, source)
  await update(meetingId, entries => [{ ...entry, profile }, ...entries.filter(r => r.id !== entry.id)])
  // Write the portable Markdown chronicle next to the structured index. The
  // file is derived from validated fields, so a retry of the same requestId
  // overwrites the same `<recapId>.md` instead of leaving stale copies.
  await atomicText(recapMarkdownPath(meetingId, entry.id), renderRecapMarkdown(entry))
  return entry
}
/**
 * Read the Markdown chronicle for one recap. Recaps saved before Markdown
 * export existed have no file yet, so a missing file is rendered from the
 * stored entry and healed on first read.
 */
export async function readRecapMarkdown(meetingId: string, id: string, profile: string) {
  const entry = (await readEntries(meetingId)).find(r => r.id === id && r.profile === profile)
  if (!entry) throw Object.assign(new Error('recap_not_found'), { status: 404 })
  const path = recapMarkdownPath(meetingId, id)
  try {
    return { markdown: await readFile(path, 'utf8'), title: entry.title }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    const markdown = renderRecapMarkdown(entry)
    await atomicText(path, markdown)
    return { markdown, title: entry.title }
  }
}
export async function deleteRecap(meetingId: string, id: string, profile: string) {
  // Read the entry before dropping it so the illustration files can be cleaned up too.
  const entries = await readEntries(meetingId).catch(() => [] as StoredEntry[])
  const entry = entries.find(r => r.id === id && r.profile === profile)
  await update(meetingId, list => list.filter(r => r.id !== id || r.profile !== profile))
  if (!RECAP_ID.test(id)) return
  await unlink(recapMarkdownPath(meetingId, id)).catch(() => {})
  await removeRecapImages(meetingId, id, entry?.images)
}
