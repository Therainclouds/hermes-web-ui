import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
vi.mock('../../packages/server/src/services/scanner/ocr', async importOriginal => ({ ...await importOriginal<any>(), resolveScannerDashScopeKey: vi.fn(async () => 'test-key') }))
import { readSubmission, readSettings, writeSettings, gradingDirectory } from '../../packages/server/src/services/grading/store'
import { capture, step, validateResults, validateWords } from '../../packages/server/src/services/grading/pipeline'
import { applyEdits, summarize } from '../../packages/server/src/services/grading/annotation-engine'
import { gradingRequest } from '../../packages/server/src/controllers/grading'
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'grading-test-'))
  // 批改目录复用 Hermes profile 工作区（HERMES_HOME），因此 stub 它而不是 Web UI 状态目录。
  vi.stubEnv('HERMES_HOME', home)
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }) })
const words = [{ text: '1. 2 + 2 = 5', cx: 100, cy: 50, w: 150, h: 25, angle: 0 }]
const questions = [{ qid: 'q1', wordRange: [0,1] as [number,number], bbox: [25,37.5,150,25] as [number,number,number,number], text: words[0]!.text, fullMark: 5 }]
const results = [{ qid: 'q1', score: 0, fullMark: 5, confidence: .6, feedback: '2 + 2 = 4', diffOps: [{ type: 'mark' as const, range: [0,1] as [number,number], mark: 'circle' as const }] }]
describe('teacher grading', () => {
  it('stores scans in a per-profile Hermes workspace folder and keeps profiles isolated (no SQL)', async () => {
    expect(gradingDirectory('one').startsWith(home)).toBe(true)
    expect(gradingDirectory('one')).not.toBe(gradingDirectory('two'))
    writeSettings('one', { enabled: true }); expect(readSettings('two').enabled).toBe(false)
  })
  it('OCR is cached and later model requests contain text only', async () => {
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).png().toBuffer()
    const { scanId } = await capture('one', { image: `data:image/png;base64,${png.toString('base64')}`, studentName: 'Student' })
    expect(() => readSubmission('two', scanId)).toThrow('not found')
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      const body = JSON.parse(options.body); calls.push(body)
      if (body.input) return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ ocr_result: { words_info: [{ text: words[0]!.text, rotate_rect: [100,50,150,25,0] }] } }] } }] } }))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(calls.length === 2 ? { questions } : { results }) } }] }))
    }))
    await step('one', scanId, 'ocr'); await step('one', scanId, 'ocr')
    await step('one', scanId, 'detect_questions', { rubric: 'q1: 4, 5 points' })
    await step('one', scanId, 'grade', { rubric: 'q1: 4, 5 points' })
    const annotated = await step('one', scanId, 'apply_edits')
    expect(calls).toHaveLength(3)
    expect(calls.slice(1).every(call => call.messages.every((message: any) => typeof message.content === 'string'))).toBe(true)
    expect(JSON.stringify(calls.slice(1))).not.toContain('data:image/')
    expect(annotated).not.toHaveProperty('image')
    expect(annotated.status).toBe('review')
    expect(annotated.annotations.some(a => a.kind === 'circle')).toBe(true)
    expect(summarize([annotated]).wrongRank[0]?.wrongCount).toBe(1)
  })
  it('rejects incomplete scores, non-finite OCR and out-of-question edits', () => {
    expect(() => validateResults([], questions)).toThrow()
    expect(() => validateResults([{ ...results[0], score: 100 }], questions)).toThrow()
    expect(() => validateWords([{ text: 'x', rotate_rect: [NaN,0,5,5,0] }], 100,100)).toThrow()
    expect(() => applyEdits(words, questions, [{ ...results[0]!, diffOps: [{ type: 'delete', range: [0,2] }] }])).toThrow('range')
    expect(summarize([])).toMatchObject({ total: 0, average: 0, passRate: 0 })
  })
  it('denies disabled plugins and unauthorized profile access', async () => {
    const ctx: any = { state: { user: { id: 1, role: 'admin', profiles: ['one'] } }, params: { action: 'list' }, query: {}, request: { body: {} }, get: () => 'two' }
    await gradingRequest(ctx); expect(ctx.status).toBe(403)
    ctx.get = () => 'one'; await gradingRequest(ctx); expect(ctx.body.error).toContain('Enable')
  })
})
