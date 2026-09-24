import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareRecap, snapshot, listRecaps, saveRecap, readRecapMarkdown } from '../../packages/server/src/services/trpg/recap'
import { startNovelJob, getNovelJob, resumeNovelJob, cancelNovelJob, listNovelJobs, waitForNovelJob, getNovelWorkbench, updateNovelHarness, updateNovelArtifact, getNovelArtifact, getNovelEvidence, pauseNovelJob } from '../../packages/server/src/services/trpg/novel'
import { splitTranscript, validateExtraction } from '../../packages/server/src/services/trpg/novel-material'
import { reconcileNovelJobs } from '../../packages/server/src/services/trpg/novel-lease'
import type { NovelModel } from '../../packages/server/src/services/trpg/novel-model'

const meetingId = 'long-campaign'
const input = { meetingId, mode: 'long_novel', tone: 'epic', writing: { concurrency: 1 }, targetChars: 5000, setting: '城堡', style: '',
  characters: [{ id: 'elf', name: '银月', player: '小林', appearance: '银发', card: 'SECRET' }],
  sentences: [{ text: '银月问：“有人吗？”' }, { text: '我要跳过去。' }, { text: 'GM：更正，跳跃失败，落在井底。' }],
}
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'trpg-novel-')); vi.stubEnv('HERMES_WEB_UI_HOME', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
const paragraph = '【银月】抬起头，银发拂过肩膀。“有人吗？”她问。井壁将声音送回耳畔。她没能跃过缺口，落在了井底。\n\n'
const proseFor = (target = 5000) => { let value = paragraph.repeat(Math.max(1, Math.ceil(target / paragraph.replace(/\s/g, '').length))); while (value.replace(/\s/g, '').length > target) value = value.slice(0, -1); return value }
const prose = proseFor()

function consistencyFixture(v: any): string | undefined {
  if (v.candidate && !v.owned) return JSON.stringify({ updates: v.candidate.updates })
  if (v.rows && !v.scene && !v.owned) return JSON.stringify({ events: [{ kind: 'confirmed', fact: '跳跃失败', evidence: v.rows.map((r: any) => ({ index: r.index, quote: r.text })) }], omitted: [], updates: [{ entity: '银月', attribute: 'location', value: '井底', evidence: [{ index: v.rows[0].index, quote: v.rows[0].text }] }] })
  if (v.manuscript) return JSON.stringify({ coverage: v.canon.events.map((e: any) => ({ eventId: e.id, quote: '井壁将声音送回耳畔。' })), issues: [] })
}
function modelFixture() {
  return vi.fn<NovelModel>(async (instructions, raw) => {
    const v = raw as any
    const checked = consistencyFixture(v); if (checked) return checked
    if (v.owned) return JSON.stringify({ segments: [{ ...v.owned, kind: 'story', title: '井底', facts: '跳跃失败，落井。', dialogueIndices: [v.owned.from] }], corrections: [{ from: 2, to: 2, targetFrom: 1, targetTo: 1, text: '跳跃失败' }], memory: '银月[0]；跳跃失败[2]' })
    if (v.scenes || v.plans) return JSON.stringify({ title: '井底回声', guide: '保留对白与失败裁决。' })
    if (v.auditFeedback) return JSON.stringify({ edits: [{ paragraph: 0, text: v.paragraphs[0].text + '她扶住井壁。' }], continuity: '银月在井底', warnings: [], covered: [v.scene.from] })
    expect(instructions).toContain('不新增信息')
    return JSON.stringify({ body: proseFor(v.targetChars), continuity: '银月在井底。', warnings: [], covered: [v.scene.from] })
  })
}
describe('durable long novel pipeline', () => {
  it('reads the full snapshot, preserves public appearance, reviews and saves long chapters', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const model = modelFixture()
    await startNovelJob(meetingId, requestId, 'table', model)
    await waitForNovelJob(meetingId, requestId)
    const job = await getNovelJob(meetingId, requestId, 'table')
    expect(job).toMatchObject({ status: 'completed', processedSentences: 3, reviewed: 1, recapId: requestId })
    expect(job.outputChars).toBeGreaterThan(1800)
    expect(JSON.stringify(model.mock.calls)).not.toContain('SECRET')
    expect(JSON.stringify(model.mock.calls)).toContain('银发')
    const review = model.mock.calls.find(([, v]) => (v as any).draft)?.[1] as any
    expect(review.rows).toHaveLength(3)
    expect(review.corrections[0].evidence[0].text).toContain('更正')
    expect((await listRecaps(meetingId, 'table'))[0].mode).toBe('long_novel')
    expect((await readRecapMarkdown(meetingId, requestId, 'table')).markdown).toContain(prose.trim())
    const calls = model.mock.calls.length
    await startNovelJob(meetingId, requestId, 'table', model)
    await resumeNovelJob(meetingId, requestId, 'table', model)
    expect(model).toHaveBeenCalledTimes(calls)
    expect(job).not.toHaveProperty('profile')
    expect(job).not.toHaveProperty('ranges')
  })
  it('resumes at a failed review without regenerating extraction, plan or draft', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const good = modelFixture()
    const failing: NovelModel = async (prompt, v, signal) => {
      if ((v as any).draft) throw new Error('novel_model_failed')
      return good(prompt, v, signal)
    }
    await startNovelJob(meetingId, requestId, 'table', failing)
    await waitForNovelJob(meetingId, requestId)
    expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'failed', written: 1, reviewed: 0 })
    good.mockClear()
    await resumeNovelJob(meetingId, requestId, 'table', good)
    await waitForNovelJob(meetingId, requestId)
    expect(good).toHaveBeenCalledTimes(2)
    expect((good.mock.calls[0][1] as any).draft).toBeTruthy()
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  })
  it('rejects omitted middle sentences, retries with precise feedback and unchanged source, and does not publish', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const model = vi.fn<NovelModel>(async () => JSON.stringify({ segments: [{ from: 0, to: 0, kind: 'story', title: '遗漏', facts: '只读了第一句', dialogueIndices: [] }], corrections: [], memory: '' }))
    await startNovelJob(meetingId, requestId, 'table', model)
    await waitForNovelJob(meetingId, requestId)
    expect(model).toHaveBeenCalledTimes(4)
    expect((model.mock.calls[0][1] as any).rows).toEqual((model.mock.calls[1][1] as any).rows)
    expect(model.mock.calls[1][0]).toContain('unprocessed sentences')
    expect((await getNovelJob(meetingId, requestId, 'table')).failure).toMatchObject({ step: 'extract-0', attempt: 4 })
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('failed')
    expect(await listRecaps(meetingId, 'table')).toEqual([])
  })
  it('enforces profile isolation, excludes secrets and prevents bypassing the pipeline', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    expect((await snapshot(meetingId, requestId, 'table')).options.characters[0]).toEqual({ id: 'elf', name: '银月', player: '小林', appearance: '银发' })
    await expect(startNovelJob(meetingId, requestId, 'other', modelFixture())).rejects.toMatchObject({ status: 403 })
    await expect(saveRecap(meetingId, { requestId, title: '绕过', chapters: [] }, 'table')).rejects.toThrow('invalid_recap')
    await startNovelJob(meetingId, requestId, 'table', modelFixture())
    await waitForNovelJob(meetingId, requestId)
    expect(await listNovelJobs(meetingId, 'other')).toEqual([])
    await expect(cancelNovelJob(meetingId, requestId, 'other')).rejects.toMatchObject({ status: 404 })
    await expect(resumeNovelJob(meetingId, requestId, 'other')).rejects.toMatchObject({ status: 404 })
  })
  it('cancels an in-flight call without publishing, and concurrent starts share one worker', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    const model = vi.fn<NovelModel>(async (_p, _v, signal) => {
      entered()
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return ''
    })
    await Promise.all([startNovelJob(meetingId, requestId, 'table', model), startNovelJob(meetingId, requestId, 'table', model)])
    await ready
    await cancelNovelJob(meetingId, requestId, 'table')
    await waitForNovelJob(meetingId, requestId)
    expect(model).toHaveBeenCalledTimes(1)
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('cancelled')
    expect(await listRecaps(meetingId, 'table')).toEqual([])
  })
  it('reports a stale worker as interrupted on disk and rejects a changed snapshot on resume', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    await startNovelJob(meetingId, requestId, 'table', async () => { throw new Error('novel_model_failed') })
    await waitForNovelJob(meetingId, requestId)
    const dir = join(home, 'meetings', meetingId, 'novel-jobs', requestId)
    const path = join(dir, 'job.json')
    const job = JSON.parse(await readFile(path, 'utf8'))
    // A crashed/restarted server leaves `running` on disk. No live lease exists, so the durable
    // state is `interrupted` — not an invented `paused` read from the in-memory worker map.
    await writeFile(path, JSON.stringify({ ...job, status: 'running' }))
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('interrupted')
    const reconciled = await reconcileNovelJobs(home)
    expect(reconciled.interrupted).toBe(1)
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('interrupted')
    const src = join(home, 'meetings', meetingId, 'recap-requests', `${requestId}.json`)
    const data = JSON.parse(await readFile(src, 'utf8')); data.sentences[0].text = '变更'
    await writeFile(src, JSON.stringify(data))
    await expect(resumeNovelJob(meetingId, requestId, 'table', modelFixture())).rejects.toMatchObject({ status: 409 })
  })
  it('chunks long ASR without gaps and rejects overlap or invalid dialogue references', async () => {
    const { requestId } = await prepareRecap({ ...input, sentences: Array.from({ length: 500 }, (_, i) => ({ text: `${i}银月发现了线索。`.repeat(20) })) }, 'table')
    const source = await snapshot(meetingId, requestId, 'table')
    const ranges = await splitTranscript(source)
    expect(ranges.length).toBeGreaterThan(2)
    expect(ranges.flatMap(r => Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i))).toEqual(Array.from({ length: 500 }, (_, i) => i))
    expect(() => validateExtraction({ segments: [{ from: 0, to: 2, kind: 'story', title: 'x', facts: 'x', dialogueIndices: [3] }], corrections: [], memory: '' }, { from: 0, to: 2 })).toThrow()
  })
  it('feeds later cross-block corrections back into earlier scenes and retains middle/end evidence', async () => {
    const sentences = Array.from({ length: 245 }, (_, i) => ({ text: `源句${i}：银月继续前行。` }))
    sentences[240].text = 'GM：更正开场裁决，银月没能跳过去。'
    const { requestId } = await prepareRecap({ ...input, chapterHint: 3, sentences }, 'table')
    const model = vi.fn<NovelModel>(async (_prompt, raw) => {
      const v = raw as any
    const checked = consistencyFixture(v); if (checked) return checked
      if (v.owned) return JSON.stringify({
        segments: [{ ...v.owned, kind: 'story', title: '旅程', facts: `事件在${v.owned.from}至${v.owned.to}`, dialogueIndices: [v.owned.from] }],
        corrections: v.owned.from === 240 ? [{ from: 240, to: 240, targetFrom: 0, targetTo: 0, text: '跳跃失败' }] : [], memory: '待核对开场跳跃[0]',
      })
      if (v.scenes || v.plans) return JSON.stringify({ title: '漫长旅程', guide: '忠于源文' })
      return JSON.stringify({ body: proseFor(v.targetChars), continuity: '继续旅程', warnings: [], covered: [v.scene.from] })
    })
    await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', processedSentences: 245, extracted: 3, reviewed: 3 })
    const writers = model.mock.calls.map(([, v]) => v as any).filter(v => v.scene && !v.draft && !v.manuscript)
    expect(writers.map(v => v.scene.from)).toEqual([0, 120, 240])
    expect(writers[0].corrections[0].evidence[0].text).toContain('更正开场裁决')
    expect(writers[1].rows[0].index).toBe(120)
    expect(writers[2].rows.at(-1).index).toBe(244)
    expect((await listRecaps(meetingId, 'table'))[0].chapters).toHaveLength(3)
    const before = (await getNovelArtifact(meetingId, requestId, 'table', 'write-0')).artifact
    model.mockClear()
    await updateNovelHarness(meetingId, requestId, 'table', { action: 'regenerate', chapter: 1, revision: 0 })
    await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    expect(model).toHaveBeenCalledTimes(6) // write/review/check for chapters 2 and 3 only
    expect((await getNovelArtifact(meetingId, requestId, 'table', 'write-0')).artifact.inputHash).toBe(before.inputHash)
    expect((await getNovelArtifact(meetingId, requestId, 'table', 'write-1')).versions).toHaveLength(1)
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  })
})

describe('novel writing harness', () => {
  it('pauses at outline and chapter gates, routes models and rejects stale edits', async () => {
    const writing = { defaultModel: { provider: 'base', model: 'default' }, stages: { extract: { provider: 'reader', model: 'read' }, review: { provider: 'judge', model: 'audit' } }, pauseAfterOutline: true, pauseAfterChapter: true }
    const { requestId } = await prepareRecap({ ...input, writing }, 'table')
    const model = modelFixture()
    await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    let work = await getNovelWorkbench(meetingId, requestId, 'table')
    expect(work.job).toMatchObject({ status: 'paused', pauseReason: 'outline', written: 0 })
    expect(model.mock.calls[0][3]).toEqual(writing.stages.extract)
    expect(model.mock.calls.at(-1)?.[3]).toEqual(writing.defaultModel)
    await updateNovelHarness(meetingId, requestId, 'table', { action: 'approve-outline', revision: 0 })
    await expect(updateNovelHarness(meetingId, requestId, 'table', { action: 'settings', revision: 0, settings: {} })).rejects.toMatchObject({ status: 409 })
    await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    work = await getNovelWorkbench(meetingId, requestId, 'table')
    expect(work.job).toMatchObject({ status: 'paused', pauseReason: 'chapter', waitingChapter: 0, reviewed: 1 })
    expect(model.mock.calls.at(-1)?.[3]).toEqual(writing.stages.review)
    expect(await listRecaps(meetingId, 'table')).toEqual([])
    await updateNovelHarness(meetingId, requestId, 'table', { action: 'approve-chapter', chapter: 0, revision: 1 })
    await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
    await expect(getNovelArtifact(meetingId, requestId, 'other', 'book')).rejects.toMatchObject({ status: 404 })
    await expect(getNovelArtifact(meetingId, requestId, 'table', '../snapshot')).rejects.toMatchObject({ status: 400 })
    expect((await getNovelEvidence(meetingId, requestId, 'table', 1, 2)).rows).toHaveLength(2)
    await expect(getNovelEvidence(meetingId, requestId, 'table', -1, 2)).rejects.toMatchObject({ status: 400 })
  })
  it('changes total length without rereading ASR or rebuilding verified facts', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const model = modelFixture()
    await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    await updateNovelHarness(meetingId, requestId, 'table', { action: 'settings', revision: 0, settings: { targetChars: 6000, concurrency: 4 } })
    expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'paused', targetChars: 6000 })
    model.mockClear()
    await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
    expect(model.mock.calls.some(([, v]) => (v as any).owned)).toBe(false)
    expect(model.mock.calls.some(([, v]) => (v as any).rows && !(v as any).scene)).toBe(false)
    expect(model.mock.calls.some(([, v]) => (v as any).options?.targetChars === 6000)).toBe(true)
  })
  it('checkpoints a paid call before manual pause and refuses editing an active worker', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const good = modelFixture()
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(r => { entered = r }), waiting = new Promise<void>(r => { release = r })
    const model = vi.fn<NovelModel>(async (p, v, signal, route) => { entered(); await waiting; return good(p, v, signal, route) })
    await startNovelJob(meetingId, requestId, 'table', model); await ready
    await expect(updateNovelHarness(meetingId, requestId, 'table', { action: 'settings', revision: 0, settings: {} })).rejects.toMatchObject({ status: 409 })
    await expect(updateNovelArtifact(meetingId, requestId, 'table', { action: 'delete', name: 'extract-0', revision: 0 })).rejects.toMatchObject({ status: 409 })
    expect(await pauseNovelJob(meetingId, requestId, 'table')).toMatchObject({ pauseRequested: true })
    release(); await waitForNovelJob(meetingId, requestId)
    expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'paused', extracted: 1 })
    expect(model).toHaveBeenCalledTimes(1)
    await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
    expect(good.mock.calls.filter(([, v]) => (v as any).owned)).toHaveLength(1)
  })
  it('blocks publication on semantic issues, then regenerates prose with retained source checkpoints and history', async () => {
    const { requestId } = await prepareRecap({ ...input, writing: { concurrency: 1, consistency: 'block' } }, 'table')
    const good = modelFixture()
    await startNovelJob(meetingId, requestId, 'table', async (p, v, sig, route) => {
      if ((v as any).manuscript) return JSON.stringify({ coverage: [{ eventId: 's0-e0', quote: '井壁将声音送回耳畔。' }], issues: [{ detail: '重复灌水，应改为一次完整描写' }] })
      return good(p, v, sig, route)
    }); await waitForNovelJob(meetingId, requestId)
    expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'failed', error: 'novel_revision_stalled', reviewed: 0 })
    expect((await getNovelArtifact(meetingId, requestId, 'table', 'check-0')).artifact.value).toMatchObject({ passed: false })
    expect(await listRecaps(meetingId, 'table')).toEqual([])
    good.mockClear()
    await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
    expect(good).not.toHaveBeenCalled()
    const original = (await getNovelArtifact(meetingId, requestId, 'table', 'write-0')).artifact
    await updateNovelHarness(meetingId, requestId, 'table', { action: 'chapter', chapter: 0, revision: 0, direction: { title: '回声', guide: '压缩重复，保留一次对白', pacing: 'fast' } })
    good.mockClear()
    await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
    expect(good).toHaveBeenCalledTimes(3)
    expect((good.mock.calls[0][1] as any).chapter.pacing).toBe('fast')
    const versions = await getNovelArtifact(meetingId, requestId, 'table', 'write-0')
    expect(versions.versions.map(v => v.inputHash)).toContain(original.inputHash)
    expect((await getNovelArtifact(meetingId, requestId, 'table', 'write-0', original.inputHash)).artifact.value).toEqual(original.value)
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  })
})

it('automatically repairs invalid evidence output without a manual resume', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture(); let invalid = true
  const model = vi.fn<NovelModel>(async (p, v, signal, route) => {
    if (invalid && (v as any).rows && !(v as any).owned) { invalid = false; return '{"events":[]}' }
    return good(p, v, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', canonized: 1 })
  expect(model.mock.calls.some(([p]) => p.includes('canon shape'))).toBe(true)
  expect((await getNovelWorkbench(meetingId, requestId, 'table')).events.some(e => e.type === 'step_retry')).toBe(true)
})
it('grounds visual descriptions in source evidence before rebuilding chapters', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const model = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  const direction = { title: '井底', guide: '借鉴高光图片光线', visualReferences: [{ id: 'photo', description: '银发映着井口微光', evidence: [{ index: 0, quote: input.sentences[0].text }] }] }
  await expect(updateNovelHarness(meetingId, requestId, 'table', { action: 'chapter', chapter: 0, revision: 0, direction: { ...direction, visualReferences: [{ ...direction.visualReferences[0], evidence: [{ index: 900, quote: '不存在' }] }] } })).rejects.toMatchObject({ status: 400 })
  await updateNovelHarness(meetingId, requestId, 'table', { action: 'chapter', chapter: 0, revision: 0, direction })
  model.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect((model.mock.calls[0][1] as any).chapter.visualReferences[0].description).toBe('银发映着井口微光')
  expect(model.mock.calls[0][0]).toContain('不是跑团事实证据')
})
it('runs independent plans concurrently but keeps their chapter order', async () => {
  const { requestId } = await prepareRecap({ ...input, chapterHint: 3, writing: { concurrency: 2 } }, 'table')
  const good = modelFixture(); let activePlans = 0, peak = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.owned) return JSON.stringify({ segments: input.sentences.map((_, i) => ({ from: i, to: i, kind: 'story', title: `场景${i}`, facts: '保留原文事件', dialogueIndices: [i] })), corrections: [], memory: '' })
    if (v.scenes) {
      peak = Math.max(peak, ++activePlans)
      await new Promise(r => setTimeout(r, 15)); activePlans--
      return JSON.stringify({ title: `章节${v.chapter}`, guide: '保留原文' })
    }
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(peak).toBe(2)
  expect((await listRecaps(meetingId, 'table'))[0].chapters.map(c => c.title)).toEqual(['章节1', '章节2', '章节3'])
})
it('repairs a failed semantic audit once and requires a fresh passing report', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture(); let checks = 0, repairs = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript && checks++ === 0) return JSON.stringify({ coverage: [], issues: [{ detail: '遗漏扶墙动作' }] })
    if (v.auditFeedback) { repairs++; return JSON.stringify({ edits: [{ paragraph: 0, text: v.paragraphs[0].text + '她扶住井壁。' }], continuity: '银月在井底', warnings: [], covered: [v.scene.from] }) }
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(repairs).toBe(1); expect(checks).toBe(2)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect((await getNovelArtifact(meetingId, requestId, 'table', 'check-0')).versions).toHaveLength(1)
})

it('patches one missing ASR sentence without regenerating a valid scene ledger', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture(); let ledgers = 0, patches = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.missingRows) {
      patches++
      expect(v.missingRows.map((r: any) => r.index)).toEqual([2])
      return JSON.stringify({ events: [{ kind: 'correction', fact: '更正跳跃失败落井', evidence: [{ index: 2 }] }], omitted: [], updates: [] })
    }
    if (v.rows && !v.owned && !v.scene) {
      ledgers++
      return JSON.stringify({ events: [{ kind: 'attempt', fact: '银月呼喊并尝试跳跃', evidence: [{ index: 0 }, { index: 1 }] }], omitted: [], updates: [] })
    }
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed' })
  expect(ledgers).toBe(1); expect(patches).toBe(1)
  const canon = await getNovelArtifact(meetingId, requestId, 'table', 'canon-0')
  expect((canon.artifact.value as any).events).toHaveLength(2)
})

it('economy skips unconditional rewrites, keeps audits and cumulative token accounting across resumes', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { economy: true } }, 'table')
  const good = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  const job = await getNovelJob(meetingId, requestId, 'table')
  expect(job.status).toBe('completed')
  expect(good.mock.calls.some(([, v]) => (v as any).draft)).toBe(false)
  expect(good.mock.calls.some(([, v]) => (v as any).manuscript)).toBe(true)
  expect(job.tokenUsage?.inputTokens).toBeGreaterThan(0)
  expect(job.tokenUsage?.outputTokens).toBeGreaterThan(0)
  expect(job.tokenUsage?.estimatedCalls).toBe(good.mock.calls.length)
  await resumeNovelJob(meetingId, requestId, 'table', good)
  expect((await getNovelJob(meetingId, requestId, 'table')).tokenUsage).toEqual(job.tokenUsage)
})
it('economy still repairs and rechecks a rejected initial draft', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { economy: true } }, 'table')
  const good = modelFixture(); let audits = 0, repairs = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript && audits++ === 0) return JSON.stringify({ coverage: [], issues: [{ detail: '核对落井裁决' }] })
    if (v.auditFeedback) { repairs++; return JSON.stringify({ edits: [{ paragraph: 0, text: v.paragraphs[0].text + '她扶住井壁。' }], continuity: '银月在井底', warnings: [], covered: [v.scene.from] }) }
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(audits).toBe(2); expect(repairs).toBe(1)
})
it('resumes from the latest paragraph repair after audit transport failure without drafting again', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture(); let checks = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript) {
      if (checks++ === 0) return JSON.stringify({ coverage: [], issues: [{ detail: '扶墙动作需要明确' }] })
      throw new Error('novel_model_failed')
    }
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('failed')
  good.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(good.mock.calls).toHaveLength(1)
  expect((good.mock.calls[0][1] as any).manuscript).toContain('她扶住井壁。')
  expect((good.mock.calls[0][1] as any).draft).toBeUndefined()
})
it('automatically repairs short output to the overall ten-percent length budget', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { economy: true } }, 'table')
  const good = modelFixture(); let patches = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) {
      patches++
      return JSON.stringify({ edits: v.paragraphs.map((part: any, i: number) => ({ paragraph: part.paragraph, text: i ? '' : proseFor(v.targetChars) })), covered: [v.scene.from], warnings: [], continuity: '银月在井底' })
    }
    if (v.scene && !v.manuscript && !v.draft) return JSON.stringify({ body: proseFor(500), covered: [v.scene.from], warnings: [], continuity: '银月在井底' })
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  const job = await getNovelJob(meetingId, requestId, 'table')
  expect(job.status).toBe('completed'); expect(patches).toBe(1)
  expect(job.outputChars).toBeGreaterThanOrEqual(4500); expect(job.outputChars).toBeLessThanOrEqual(5500)
})
it('repairs malformed audit identifiers without rewriting the manuscript', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture(); let invalid = true
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript && invalid) { invalid = false; return JSON.stringify({ coverage: [{ eventId: 'unknown', quote: '井壁将声音送回耳畔。' }], issues: [] }) }
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(model.mock.calls.filter(([, v]) => (v as any).draft)).toHaveLength(1)
  expect(model.mock.calls.filter(([, v]) => (v as any).manuscript)).toHaveLength(2)
  expect(model.mock.calls.some(([, v]) => (v as any).auditFeedback)).toBe(false)
})
it('migrates a legacy failed job from its latest saved review without repeating prose calls', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', async (p, raw, signal, route) => {
    if ((raw as any).manuscript) throw new Error('novel_model_failed')
    return good(p, raw, signal, route)
  }); await waitForNovelJob(meetingId, requestId)
  const dir = join(home, 'meetings', meetingId, 'novel-jobs', requestId)
  const review = JSON.parse(await readFile(join(dir, 'review-0.json'), 'utf8'))
  review.value.body += '她握紧了手。'; review.inputHash = 'f'.repeat(64)
  await writeFile(join(dir, 'review-0.json'), JSON.stringify(review))
  await rm(join(dir, 'revision-state-0.json'))
  good.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(good.mock.calls).toHaveLength(1)
  expect((good.mock.calls[0][1] as any).manuscript).toContain('她握紧了手。')
})
it('accepts unequal scene lengths when the complete book meets its target', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.owned) return JSON.stringify({ segments: [{ from: 0, to: 0, kind: 'story', title: '呼喊', facts: '呼喊', dialogueIndices: [0] }, { from: 1, to: 2, kind: 'story', title: '落井', facts: '落井', dialogueIndices: [1] }], corrections: [], memory: '在井底' })
    if (v.scene && !v.manuscript && !v.auditFeedback) return JSON.stringify({ body: proseFor(v.scene.from === 0 ? 3500 : 1500), continuity: '银月在井底。', covered: [v.scene.from], warnings: [] })
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', reviewed: 2, outputChars: 5000 })
  expect(model.mock.calls.filter(([, v]) => (v as any).auditFeedback)).toHaveLength(0)
})
it('persists an impossible whole-book length conflict without spending tokens again on unchanged resume', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { economy: true } }, 'table')
  const good = modelFixture()
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) return JSON.stringify({ tool: 'report_conflict', reason: '素材不足，不应编造情节凑字数。' })
    if (v.scene && !v.manuscript && !v.draft) return JSON.stringify({ body: proseFor(500), covered: [v.scene.from], continuity: '银月在井底', warnings: [] })
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'failed', error: 'novel_length_mismatch', outputChars: 500 })
  expect(await listRecaps(meetingId, 'table')).toEqual([])
  model.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(model).not.toHaveBeenCalled()
  expect((await getNovelArtifact(meetingId, requestId, 'table', 'chapter-0')).artifact.value).toHaveProperty('body')
})
it('re-audits a blocked draft with a changed review model rather than reusing its rejected report', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { consistency: 'block' } }, 'table')
  const good = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript) return JSON.stringify({ coverage: [], issues: [{ detail: '待核实角色归属' }] })
    if (v.auditFeedback) return JSON.stringify({ tool: 'report_conflict', reason: '归属含糊，请更换审核模型核实。' })
    return good(p, raw, signal, route)
  }); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).error).toBe('novel_revision_stalled')
  await updateNovelHarness(meetingId, requestId, 'table', { action: 'settings', revision: 0, settings: { concurrency: 1, stages: { review: { provider: 'judge', model: 'second' } } } })
  good.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  const recovered = await getNovelJob(meetingId, requestId, 'table')
  expect(recovered.status).toBe('completed')
  expect(recovered.failure).toBeUndefined()
  expect(good.mock.calls).toHaveLength(1)
  expect(good.mock.calls[0][3]).toEqual({ provider: 'judge', model: 'second' })
  expect(good.mock.calls[0][1]).toHaveProperty('manuscript')
})
it('rejects a length edit that passes its own facts but breaks the next scene continuity', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { economy: true, concurrency: 1 } }, 'table')
  const good = modelFixture()
  let boundaries = 0
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.owned) return JSON.stringify({ segments: [{ from: 0, to: 0, kind: 'story', title: '呼喊', facts: '呼喊', dialogueIndices: [0] }, { from: 1, to: 2, kind: 'story', title: '落井', facts: '落井', dialogueIndices: [1] }], corrections: [], memory: '在井底' })
    if (v.manuscript && v.scene.from === 1 && v.precedingProse.includes('候选尾部')) {
      boundaries++
      return JSON.stringify({ coverage: [], issues: [{ detail: '前后场景衔接矛盾' }] })
    }
    if (v.auditFeedback) {
      if (v.scene.from) return JSON.stringify({ tool: 'report_conflict', reason: '不应强行扩写' })
      return JSON.stringify({ tool: 'patch_paragraphs', edits: v.paragraphs.map((part: any, i: number) => ({ paragraph: part.paragraph, text: i ? '' : proseFor(2400) + '候选尾部' })) })
    }
    if (v.scene && !v.manuscript) return JSON.stringify({ body: proseFor(500), covered: [v.scene.from], continuity: '银月在井底', warnings: [] })
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(boundaries).toBe(1)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ error: 'novel_length_mismatch', outputChars: 1000 })
  expect((await getNovelArtifact(meetingId, requestId, 'table', 'review-0')).artifact.value).toHaveProperty('body', proseFor(500).trim())
  expect(await listRecaps(meetingId, 'table')).toEqual([])
})
it('requires renewed chapter approval after whole-book length edits', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { economy: true, concurrency: 1, pauseAfterChapter: true } }, 'table')
  const good = modelFixture()
  const model: NovelModel = async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) return JSON.stringify({ tool: 'patch_paragraphs', edits: v.paragraphs.map((part: any, i: number) => ({ paragraph: part.paragraph, text: i ? '' : proseFor(v.targetChars) })) })
    if (v.scene && !v.manuscript && !v.draft) return JSON.stringify({ body: proseFor(500), covered: [v.scene.from], continuity: '银月在井底', warnings: [] })
    return good(p, raw, signal, route)
  }
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  await updateNovelHarness(meetingId, requestId, 'table', { action: 'approve-chapter', chapter: 0, revision: 0 })
  await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  const state = await getNovelWorkbench(meetingId, requestId, 'table')
  expect(state.job).toMatchObject({ status: 'paused', pauseReason: 'chapter', outputChars: 5000 })
  expect(state.controls.approvedChapters).toEqual([])
  expect(await listRecaps(meetingId, 'table')).toEqual([])
  await updateNovelHarness(meetingId, requestId, 'table', { action: 'approve-chapter', chapter: 0, revision: state.controls.revision })
  await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
})
it('accepts a faithful scene with advisory omissions instead of stalling the whole book', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript) return JSON.stringify({
      coverage: v.canon.events.map((e: any) => ({ eventId: e.id, quote: '井壁将声音送回耳畔。' })),
      issues: [{ detail: '漏了原句里的一句调侃', kind: 'omission' }, { detail: '有两段措辞重复', kind: 'format' }],
    })
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  const job = await getNovelJob(meetingId, requestId, 'table')
  expect(job).toMatchObject({ status: 'completed', reviewed: 1 })
  // Advisory findings never start a repair round, and they are surfaced rather than dropped.
  expect(model.mock.calls.some(([, v]) => (v as any).auditFeedback)).toBe(false)
  expect(job.warnings.join(' ')).toContain('漏了原句里的一句调侃')
  expect(job.warnings.join(' ')).toContain('有两段措辞重复')
})
it('blocks publication when the audit reports an unresolved factual contradiction', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { consistency: 'block' } }, 'table')
  const good = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript) return JSON.stringify({ coverage: [], issues: [{ detail: '把跳跃失败写成了成功', kind: 'contradiction' }] })
    if (v.auditFeedback) return JSON.stringify({ tool: 'report_conflict', reason: '事实冲突无法在不编造的前提下修正。' })
    return good(p, raw, signal, route)
  }); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'failed', error: 'novel_revision_stalled', reviewed: 0 })
  expect(await listRecaps(meetingId, 'table')).toEqual([])
})
it('deletes out-of-scene prose the audit flags instead of stalling three rounds with a no-op patch', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  const reviewPrompts: string[] = []
  const reviewInputs: any[] = []
  let writerGuide: string | undefined
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.manuscript) {
      // A reviewer that expanded the chapter guide into later scenes is exactly what the
      // live stall reported: the audit is right and only a real deletion can resolve it.
      if (v.manuscript.includes('奴隶商队')) return JSON.stringify({ coverage: [], issues: [{ detail: '正文包含本场景范围之外的后续剧情，应删除这些段落。' }] })
      return good(p, raw, signal, route)
    }
    if (v.auditFeedback) return JSON.stringify({ tool: 'patch_paragraphs', edits: v.paragraphs.filter((part: any) => part.text.includes('奴隶商队')).map((part: any) => ({ paragraph: part.paragraph, delete: true })) })
    if (v.draft && !v.manuscript) { reviewPrompts.push(p); reviewInputs.push(v); return JSON.stringify({ body: v.draft.body, continuity: v.draft.continuity, warnings: [], covered: [v.scene.from] }) }
    if (v.scene && !v.draft) { writerGuide = v.chapter?.guide; return JSON.stringify({ body: `${proseFor(v.targetChars)}\n\n【卡洛其】“我是从奴隶商队里逃出来的。”`, continuity: '银月在井底', warnings: [], covered: [v.scene.from] }) }
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', reviewed: 1 })
  expect(model.mock.calls.filter(([, v]) => (v as any).auditFeedback)).toHaveLength(1)
  expect(reviewPrompts[0]).toContain('场景边界')
  // The writer keeps the chapter guide for style; the reviewer and repair editor must not
  // inherit its whole-chapter beat list or they write and keep other scenes' plot.
  expect(writerGuide).toBe('保留对白与失败裁决。')
  expect(reviewInputs[0].book).toBeUndefined()
  expect(reviewInputs[0].chapter.guide).toBeUndefined()
  expect((await getNovelArtifact(meetingId, requestId, 'table', 'review-0')).artifact.value.body).not.toContain('奴隶商队')
})
it('recovers when the editor cannot express the audit fix as paragraph edits', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  let editorTurns = 0
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) {
      editorTurns++
      // The first action is the all-delete patch a live run kept submitting: it can never apply.
      if (editorTurns === 1) return JSON.stringify({ tool: 'patch_paragraphs', edits: v.paragraphs.map((part: any) => ({ paragraph: part.paragraph, delete: true })) })
      return JSON.stringify({ tool: 'replace_scene', body: `${proseFor(v.targetChars)}重写后的正文。`, covered: [v.availableSourceIndices[0]], continuity: '银月在井底', warnings: [] })
    }
    if (v.manuscript) {
      if (v.manuscript.includes('重写后的正文')) return good(p, raw, signal, route)
      return JSON.stringify({ coverage: [], issues: [{ detail: '整场需要重写，逐段修改无法收敛' }] })
    }
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', reviewed: 1 })
  expect(model.mock.calls.filter(([, v]) => (v as any).auditFeedback)).toHaveLength(2)
  expect((await getNovelArtifact(meetingId, requestId, 'table', 'review-0')).artifact.value.body).toContain('重写后的正文')
})
it('fixes a factual contradiction with an exact-excerpt edit instead of paragraph numbers', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  const marker = '【银月】把跳跃当成了成功。'
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) return JSON.stringify({ tool: 'patch_paragraphs', edits: [{ find: marker, replace: '【银月】没能跃过缺口，落在了井底。' }] })
    if (v.manuscript) {
      if (v.manuscript.includes(marker)) return JSON.stringify({ coverage: [], issues: [{ detail: '把尝试写成了成功', kind: 'contradiction' }] })
      return good(p, raw, signal, route)
    }
    if (v.draft && !v.manuscript) return JSON.stringify({ body: `${proseFor(v.targetChars).slice(0, -1)}${marker}`, continuity: '银月在井底', warnings: [], covered: [v.scene.from] })
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', reviewed: 1 })
  expect(model.mock.calls.filter(([, v]) => (v as any).auditFeedback)).toHaveLength(1)
  const body = (await getNovelArtifact(meetingId, requestId, 'table', 'review-0')).artifact.value.body
  expect(body).not.toContain(marker)
  expect(body).toContain('没能跃过缺口')
})
it('keeps writing with a recorded warning when a contradiction cannot be resolved', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  let edits = 0
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) { edits++; return JSON.stringify({ tool: 'patch_paragraphs', edits: [{ paragraph: 0, text: `换个说法${edits}。` }] }) }
    if (v.manuscript) return JSON.stringify({ coverage: [], issues: [{ detail: '把跳跃失败写成了成功', kind: 'contradiction' }] })
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  const job = await getNovelJob(meetingId, requestId, 'table')
  expect(job).toMatchObject({ status: 'completed', reviewed: 1 })
  expect(job.error).toBeUndefined()
  expect(job.warnings.join(' ')).toContain('已按当前设置继续写作')
})
it('remembers earlier repair rounds so the editor does not repeat a failed fix', async () => {
  const { requestId } = await prepareRecap({ ...input, writing: { consistency: 'block' } }, 'table')
  const good = modelFixture()
  const editorInputs: any[] = []
  const model = vi.fn<NovelModel>(async (p, raw, signal, route) => {
    const v = raw as any
    if (v.auditFeedback) {
      editorInputs.push(v)
      const advanced = editorInputs.length === 1 ? '第一处改好。' : '修好了。'
      return JSON.stringify({ tool: 'replace_scene', body: `${proseFor(v.targetChars)}${advanced}`, covered: [v.availableSourceIndices[0]], continuity: '银月在井底', warnings: [] })
    }
    if (v.manuscript) {
      if (v.manuscript.includes('修好了')) return good(p, raw, signal, route)
      if (v.manuscript.includes('第一处改好')) return JSON.stringify({ coverage: [], issues: [{ detail: '第二处矛盾：伤势被抹去', kind: 'contradiction' }] })
      return JSON.stringify({ coverage: [], issues: [{ detail: '第一处矛盾：把失败写成成功', kind: 'contradiction' }] })
    }
    return good(p, raw, signal, route)
  })
  await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
  expect(await getNovelJob(meetingId, requestId, 'table')).toMatchObject({ status: 'completed', reviewed: 1 })
  expect(editorInputs).toHaveLength(2)
  expect(editorInputs[0].history).toBe('')
  expect(editorInputs[1].history).toContain('第1轮')
  expect(editorInputs[1].history).toContain('第一处矛盾')
  expect(editorInputs[1].history).toContain('replace_scene')
})
it('reuses extraction blocks, fact ledgers and drafts after a harness change instead of re-reading the transcript', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  const failing: NovelModel = async (prompt, v, signal) => {
    if ((v as any).draft) throw new Error('novel_model_failed')
    return good(prompt, v, signal)
  }
  await startNovelJob(meetingId, requestId, 'table', failing); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('failed')
  // A harness edit changes every instruction hash. Sticky source steps keep their paid work.
  const dir = join(home, 'meetings', meetingId, 'novel-jobs', requestId)
  for (const name of ['extract-0', 'canon-0', 'write-0']) {
    const path = join(dir, `${name}.json`), step = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...step, inputHash: 'f'.repeat(64) }))
  }
  good.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(good.mock.calls.some(([, v]) => (v as any).owned)).toBe(false)
  expect(good.mock.calls.some(([, v]) => (v as any).rows && !(v as any).scene)).toBe(false)
  expect(good.mock.calls.some(([, v]) => (v as any).scene && !(v as any).draft && !(v as any).manuscript)).toBe(false)
  expect(good.mock.calls.some(([, v]) => (v as any).draft)).toBe(true)
})
it('deletes one artifact and rebuilds only that artifact on resume', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  const dir = join(home, 'meetings', meetingId, 'novel-jobs', requestId)
  const before = JSON.parse(await readFile(join(dir, 'canon-0.json'), 'utf8'))
  const controls = (await getNovelWorkbench(meetingId, requestId, 'table')).controls
  const result = await updateNovelArtifact(meetingId, requestId, 'table', { action: 'delete', name: 'canon-0', revision: controls.revision })
  expect(result.controls.revision).toBe(controls.revision + 1)
  await expect(getNovelArtifact(meetingId, requestId, 'table', 'canon-0')).rejects.toMatchObject({ status: 404 })
  // The removed version stays inspectable from history.
  expect((await getNovelArtifact(meetingId, requestId, 'table', 'canon-0', before.inputHash)).artifact.value).toEqual(before.value)
  good.mockClear()
  await resumeNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(good.mock.calls.filter(([, v]) => (v as any).rows && !(v as any).scene)).toHaveLength(1)
  expect(good.mock.calls.some(([, v]) => (v as any).owned)).toBe(false)
})
it('regenerates one artifact through the explicit reset action and guards reset requests', async () => {
  const { requestId } = await prepareRecap(input, 'table')
  const good = modelFixture()
  await startNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
  const controls = (await getNovelWorkbench(meetingId, requestId, 'table')).controls
  await expect(updateNovelArtifact(meetingId, requestId, 'table', { action: 'delete', name: 'nope', revision: controls.revision })).rejects.toMatchObject({ status: 400 })
  await expect(updateNovelArtifact(meetingId, requestId, 'table', { action: 'burn', name: 'canon-0', revision: controls.revision })).rejects.toMatchObject({ status: 400 })
  await expect(updateNovelArtifact(meetingId, requestId, 'table', { action: 'delete', name: 'canon-0', revision: controls.revision + 5 })).rejects.toMatchObject({ status: 409 })
  await expect(updateNovelArtifact(meetingId, requestId, 'table', { action: 'delete', name: 'canon-9', revision: controls.revision })).rejects.toMatchObject({ status: 404 })
  good.mockClear()
  await updateNovelArtifact(meetingId, requestId, 'table', { action: 'regenerate', name: 'write-0', revision: controls.revision }, good)
  await waitForNovelJob(meetingId, requestId)
  expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
  expect(good.mock.calls.some(([, v]) => (v as any).scene && !(v as any).draft && !(v as any).manuscript)).toBe(true)
})

describe('harness correctness fixes', () => {
  it('rebuilds downstream prose when the fact ledger it consumed actually changed', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const good = modelFixture()
    await startNovelJob(meetingId, requestId, 'table', good); await waitForNovelJob(meetingId, requestId)
    const controls = (await getNovelWorkbench(meetingId, requestId, 'table')).controls
    await updateNovelArtifact(meetingId, requestId, 'table', { action: 'delete', name: 'canon-0', revision: controls.revision })
    // Same shape, different fact: the cached draft was written against the old ledger, so it must
    // not be reused (the previous sticky behaviour paired a new ledger with old prose silently).
    const changed = vi.fn<NovelModel>(async (instructions, raw) => {
      const v = raw as any
      if (v.rows && !v.scene && !v.owned) return JSON.stringify({
        events: [{ kind: 'confirmed', fact: '跳跃失败，井底另有血迹。', evidence: v.rows.map((r: any) => ({ index: r.index, quote: r.text })) }],
        omitted: [], updates: [{ entity: '银月', attribute: 'location', value: '井底', evidence: [{ index: v.rows[0].index, quote: v.rows[0].text }] }],
      })
      return good(instructions, raw)
    })
    await resumeNovelJob(meetingId, requestId, 'table', changed); await waitForNovelJob(meetingId, requestId)
    expect((await getNovelJob(meetingId, requestId, 'table')).status).toBe('completed')
    const write = changed.mock.calls.find(([, v]) => { const x = v as any; return x.scene && !x.draft && !x.manuscript && !x.auditFeedback })
    expect(write).toBeTruthy()
    expect((write![1] as any).canon.events[0].fact).toContain('血迹')
    // Extraction is still never re-bought: only the changed ledger and what depends on it rebuild.
    expect(changed.mock.calls.some(([, v]) => (v as any).owned)).toBe(false)
  })

  it('never stalls a scene because the review model omitted dialogue bookkeeping', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const good = modelFixture()
    const model = vi.fn<NovelModel>(async (instructions, raw) => {
      const v = raw as any
      // Extraction claims two dialogue lines; the review reports none of them.
      if (v.owned) return JSON.stringify({ segments: [{ ...v.owned, kind: 'story', title: '井底', facts: '跳跃失败，落井。', dialogueIndices: [v.owned.from, v.owned.to] }], corrections: [], memory: '' })
      if (v.draft) return JSON.stringify({ body: proseFor(v.targetChars), continuity: '银月在井底', warnings: [], covered: [] })
      if (v.manuscript) return JSON.stringify({ coverage: v.canon.events.map((e: any) => ({ eventId: e.id, quote: '井壁将声音送回耳畔。' })), issues: [] })
      if (v.scenes || v.plans) return JSON.stringify({ title: '井底回声', guide: '保留对白与失败裁决。' })
      return good(instructions, raw)
    })
    await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    const job = await getNovelJob(meetingId, requestId, 'table')
    expect(job.status).toBe('completed')
    // The omission is surfaced, not silently swallowed, and the audit still runs.
    expect(job.warnings.join('\n')).toContain('对白索引')
    expect(model.mock.calls.some(([, v]) => (v as any).manuscript)).toBe(true)
  })

  it('does not re-buy a step that exhausted its attempts with unchanged inputs', async () => {
    const { requestId } = await prepareRecap(input, 'table')
    const good = modelFixture()
    const model = vi.fn<NovelModel>(async (instructions, raw) => {
      const v = raw as any
      if (v.draft) return '这不是 JSON'
      return good(instructions, raw)
    })
    await startNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    const failed = await getNovelJob(meetingId, requestId, 'table')
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('novel_invalid_output')
    expect(failed.blocked?.step).toBe('review-0')
    expect(model.mock.calls.filter(([, v]) => (v as any).draft)).toHaveLength(4)
    const total = model.mock.calls.length
    await resumeNovelJob(meetingId, requestId, 'table', model); await waitForNovelJob(meetingId, requestId)
    expect(model).toHaveBeenCalledTimes(total)
    expect((await getNovelJob(meetingId, requestId, 'table')).error).toBe('novel_step_blocked')
  })
})
