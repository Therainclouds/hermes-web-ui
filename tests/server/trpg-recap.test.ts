import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRecap, recapTranscript, saveRecap, listRecaps, deleteRecap, parseRecapInput, readRecapMarkdown, recapMarkdownPath, saveRecapImage, readRecapImage, recapImagePath, parseRecapImageInput } from '../../packages/server/src/services/trpg/recap'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg=='
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
const input = { meetingId: 'campaign-1', mode: 'literary', tone: '', setting: '', style: '', characters: [{ id: 'elf', name: '银月', player: '小林', card: 'secret' }], sentences: [{ text: '银月举盾。随后箭雨落下。' }] }
const body = { title: '城门', chapters: [{ title: '箭雨', startQuote: '银月举盾。', endQuote: '箭雨落下。', body: '银月举起盾牌。', highlights: [{ characterId: 'elf', action: '举盾', evidence: '银月举盾。' }] }], timeline: [] }
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'trpg-recap-')); vi.stubEnv('HERMES_WEB_UI_HOME', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
describe('recap snapshots and evidence', () => {
  it('persists a snapshot, excludes card secrets, validates and idempotently saves', async () => {
    const { requestId } = await prepareRecap(input, 'default')
    const source = await recapTranscript(input.meetingId, requestId, 'default')
    expect(source.options.tone).toBe('epic')
    expect(JSON.stringify(source)).not.toContain('secret')
    for (let n = 0; n < 2; n++) await saveRecap(input.meetingId, { ...body, requestId }, 'default')
    const entries = await listRecaps(input.meetingId, 'default')
    expect(entries).toHaveLength(1)
    expect(entries[0].chapters[0].highlights[0].name).toBe('【银月】')
    await deleteRecap(input.meetingId, requestId, 'default')
    expect(await listRecaps(input.meetingId, 'default')).toEqual([])
  })
  it('rejects fabricated anchors, unknown actors, oversized chapters and cross-profile access', async () => {
    const { requestId } = await prepareRecap(input, 'one')
    await expect(recapTranscript(input.meetingId, requestId, 'two')).rejects.toThrow('profile_forbidden')
    for (const change of [{ startQuote: '屠龙成功' }, { body: 'x'.repeat(1801) }, { highlights: [{ characterId: 'unknown', action: 'x', evidence: '银月举盾。' }] }]) {
      await expect(saveRecap(input.meetingId, { ...body, requestId, chapters: [{ ...body.chapters[0], ...change }] }, 'one')).rejects.toThrow('invalid_recap')
    }
    expect(await listRecaps(input.meetingId, 'two')).toEqual([])
    await expect(prepareRecap({ ...input, meetingId: '../escape' }, 'one')).rejects.toThrow()
    expect(() => parseRecapInput({ ...input, chapterHint: 9 })).toThrow()
  })
  it('paginates without losing sentences and serializes concurrent saves', async () => {
    const source = { ...input, sentences: Array.from({ length: 15 }, (_, i) => ({ text: `${i}:${'x'.repeat(6000)}` })) }
    const { requestId } = await prepareRecap(source, 'default')
    const first = await recapTranscript(input.meetingId, requestId, 'default')
    const second = await recapTranscript(input.meetingId, requestId, 'default', first.nextCursor!)
    expect([...first.sentences, ...second.sentences]).toEqual(source.sentences.map((s, index) => ({ index, ...s, speaker: '', timestamp: '' })))
    expect(second.nextCursor).toBeNull()
    const requests = await Promise.all([prepareRecap(input, 'default'), prepareRecap(input, 'default')])
    await Promise.all(requests.map(r => saveRecap(input.meetingId, { ...body, ...r }, 'default')))
    expect(await listRecaps(input.meetingId, 'default')).toHaveLength(2)
  })
  it('accepts sentence-index anchors and defaults optional highlights and timeline', async () => {
    const source = { ...input, sentences: [{ text: '第一句。' }, { text: '第二句。' }, { text: '第三句。' }] }
    const { requestId } = await prepareRecap(source, 'default')
    const entry = await saveRecap(input.meetingId, { requestId, title: '索引', chapters: [{ title: '一', body: '正文', from: 0, to: 1 }, { title: '二', body: '正文二', from: 2 }] }, 'default')
    expect(entry.chapters[0]).toMatchObject({ startQuote: '第一句。', endQuote: '第二句。', highlights: [] })
    expect(entry.chapters[1]).toMatchObject({ startQuote: '第三句。', endQuote: '第三句。' })
    expect(entry.timeline).toEqual([])
  })
  it('reports the failing field and reason in the error detail', async () => {
    const { requestId } = await prepareRecap(input, 'default')
    await expect(saveRecap(input.meetingId, { ...body, requestId, chapters: [{ ...body.chapters[0], body: 'x'.repeat(1801) }] }, 'default'))
      .rejects.toMatchObject({ message: 'invalid_recap', detail: expect.stringContaining('chapters[0].body') })
    await expect(saveRecap(input.meetingId, { ...body, requestId, chapters: [{ title: '一', body: '正文', from: 0, to: 9 }] }, 'default'))
      .rejects.toMatchObject({ detail: expect.stringContaining('out of range') })
  })
  it('tolerates whitespace differences when a quote crosses the sentence join', async () => {
    const source = { ...input, sentences: [{ text: '银月举盾。' }, { text: '随后箭雨落下。' }] }
    const { requestId } = await prepareRecap(source, 'default')
    const entry = await saveRecap(input.meetingId, { requestId, title: '跨句', chapters: [{ title: '一', body: '正文', startQuote: '银月举盾。 随后箭雨落下。', endQuote: '箭雨落下。' }] }, 'default')
    expect(entry.chapters[0].startQuote).toBe('银月举盾。 随后箭雨落下。')
  })
  it('saves a portable Markdown chronicle beside the index and reads it back', async () => {
    const { requestId } = await prepareRecap(input, 'default')
    const entry = await saveRecap(input.meetingId, { ...body, requestId }, 'default')
    const markdown = await readFile(recapMarkdownPath(input.meetingId, entry.id), 'utf8')
    expect(markdown).toContain('# 城门')
    expect(markdown).toContain('## 箭雨')
    expect(markdown).toContain('银月举起盾牌。')
    // Highlights become blockquote marginalia, evidence as an italic quote line.
    expect(markdown).toContain('**【银月】** 举盾')
    expect(markdown).toContain('> *银月举盾。*')
    // Reading is profile-scoped and returns the stored file.
    expect((await readRecapMarkdown(input.meetingId, entry.id, 'default')).markdown).toBe(markdown)
    await expect(readRecapMarkdown(input.meetingId, entry.id, 'other')).rejects.toMatchObject({ status: 404 })
    // A missing file (chronicle saved before Markdown export existed) heals on read.
    await rm(recapMarkdownPath(input.meetingId, entry.id))
    expect((await readRecapMarkdown(input.meetingId, entry.id, 'default')).markdown).toContain('# 城门')
    // Deleting the recap removes its Markdown file too.
    await deleteRecap(input.meetingId, entry.id, 'default')
    await expect(readFile(recapMarkdownPath(input.meetingId, entry.id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('recap illustrations', () => {
  async function saved() {
    const { requestId } = await prepareRecap(input, 'default')
    return saveRecap(input.meetingId, { ...body, requestId }, 'default')
  }
  it('stores a cover image, records it on the entry and reads the bytes back', async () => {
    const entry = await saved()
    const meta = await saveRecapImage(input.meetingId, entry.id, { kind: 'cover', mime: 'image/png', dataBase64: PNG, model: 'test-model', prompt: '封面提示词' }, 'default')
    expect(meta).toMatchObject({ kind: 'cover', mime: 'image/png', model: 'test-model', prompt: '封面提示词' })
    expect(meta.chapterId).toBeUndefined()
    const listed = (await listRecaps(input.meetingId, 'default'))[0]
    expect(listed.images).toEqual([meta])
    const read = await readRecapImage(input.meetingId, entry.id, 'cover', undefined, 'default')
    expect(read.mime).toBe('image/png')
    expect(read.buffer.equals(Buffer.from(PNG, 'base64'))).toBe(true)
    // Reading is profile-scoped: another profile never sees the bytes.
    await expect(readRecapImage(input.meetingId, entry.id, 'cover', undefined, 'other')).rejects.toMatchObject({ status: 404 })
  })
  it('binds a content image to a chapter and replaces the same slot idempotently', async () => {
    const entry = await saved()
    const chapterId = entry.chapters[0].id
    await saveRecapImage(input.meetingId, entry.id, { kind: 'content', chapterId, mime: 'image/png', dataBase64: PNG }, 'default')
    // Regenerating the same slot with a different extension must not leave the old file behind.
    const replaced = await saveRecapImage(input.meetingId, entry.id, { kind: 'content', chapterId, mime: 'image/jpeg', dataBase64: JPEG }, 'default')
    expect(replaced.mime).toBe('image/jpeg')
    const images = (await listRecaps(input.meetingId, 'default'))[0].images!
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ kind: 'content', chapterId, mime: 'image/jpeg' })
    await expect(readFile(recapImagePath(input.meetingId, entry.id, 'content', chapterId, 'image/png'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readRecapImage(input.meetingId, entry.id, 'content', chapterId, 'default')).mime).toBe('image/jpeg')
    // A cover and a chapter content image coexist.
    await saveRecapImage(input.meetingId, entry.id, { kind: 'cover', mime: 'image/png', dataBase64: PNG }, 'default')
    expect((await listRecaps(input.meetingId, 'default'))[0].images).toHaveLength(2)
  })
  it('rejects malformed slots, unknown chapters and mime mismatches', async () => {
    const entry = await saved()
    const chapterId = entry.chapters[0].id
    for (const bad of [
      { kind: 'cover', chapterId, mime: 'image/png', dataBase64: PNG },
      { kind: 'content', chapterId: '00000000-0000-0000-0000-000000000000', mime: 'image/png', dataBase64: PNG },
      { kind: 'content', chapterId, mime: 'image/jpeg', dataBase64: PNG },
      { kind: 'banner', mime: 'image/png', dataBase64: PNG },
      { kind: 'cover', mime: 'image/svg+xml', dataBase64: PNG },
      { kind: 'cover', mime: 'image/png', dataBase64: 'not-an-image' },
    ]) {
      await expect(saveRecapImage(input.meetingId, entry.id, bad as any, 'default')).rejects.toThrow('invalid_recap')
    }
    expect(() => parseRecapImageInput({ kind: 'cover', mime: 'image/png' })).not.toThrow()
    await expect(saveRecapImage(input.meetingId, entry.id, { kind: 'cover', mime: 'image/png', dataBase64: 'A'.repeat(13 * 1024 * 1024) }, 'default')).rejects.toMatchObject({ detail: expect.stringContaining('base64') })
    expect((await listRecaps(input.meetingId, 'default'))[0].images).toBeUndefined()
  })
  it('deletes every illustration file with the chronicle', async () => {
    const entry = await saved()
    const chapterId = entry.chapters[0].id
    await saveRecapImage(input.meetingId, entry.id, { kind: 'cover', mime: 'image/png', dataBase64: PNG }, 'default')
    await saveRecapImage(input.meetingId, entry.id, { kind: 'content', chapterId, mime: 'image/png', dataBase64: PNG }, 'default')
    await deleteRecap(input.meetingId, entry.id, 'default')
    await expect(readFile(recapImagePath(input.meetingId, entry.id, 'cover', undefined, 'image/png'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(recapImagePath(input.meetingId, entry.id, 'content', chapterId, 'image/png'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
