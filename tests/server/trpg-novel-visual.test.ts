import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { analyzeNovelVisual, parseVisualInput } from '../../packages/server/src/services/trpg/novel-visual'
import type { Snapshot } from '../../packages/server/src/services/trpg/recap'
import type { NovelModel } from '../../packages/server/src/services/trpg/novel-model'
let dir: string, image: string
beforeEach(async () => {
  dir = await mkdtemp('/tmp/trpg-visual-')
  image = `data:image/png;base64,${(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#778899' } }).png().toBuffer()).toString('base64')}`
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const source = { sentences: [{ text: '你们在酒馆喝酒。' }, { text: '银月来到断桥，桥面塌了一半。', timestamp: 12000 }], options: {} } as unknown as Snapshot
const layout = [{ index: 0, scenes: [{ index: 0, from: 0, to: 0, title: '酒馆' }] }, { index: 1, scenes: [{ index: 1, from: 1, to: 1, title: '断桥' }] }]
const settings = { stages: { vision: { provider: 'vision-provider', model: 'vision-model' } } }
it('sends actual pixels to vision and grounds global chapter/ASR/prose matches in source quotes', async () => {
  await writeFile(join(dir, 'review-1.json'), JSON.stringify({ inputHash: 'test', value: { body: '【银月】驻足，眼前的桥面已塌了一半。' } }))
  for (const name of ['canon-1', 'extract-0']) await writeFile(join(dir, `${name}.json`), JSON.stringify({ inputHash: 'a'.repeat(64), value: {} }))
  const model = vi.fn<NovelModel>(async (_p, raw, _signal, _route, pixels) => {
    if (pixels) return JSON.stringify({ description: '画面有一座断桥和银发人物', anchors: ['断桥', '银发'], uncertainties: ['身份未确认'] })
    expect((raw as any).candidates).toHaveLength(2)
    return JSON.stringify({ matches: [{ scene: 1, score: 0.9, reason: '断桥环境对应', evidence: [{ index: 1, quote: '桥面塌了一半。' }], prose: { paragraph: 0, quote: '眼前的桥面已塌了一半。' } }] })
  })
  const result = await analyzeNovelVisual(source, layout, dir, 'table', { image, prompt: '断桥画面', transcript: '' }, settings, model)
  expect(model.mock.calls[0][4]).toMatch(/^data:image\/jpeg;base64,/)
  expect(model.mock.calls[0][1]).not.toHaveProperty('prompt') // image perception isn't conditioned on a possibly misleading prompt
  expect(model.mock.calls.every(call => call[3]?.model === 'vision-model')).toBe(true)
  expect(result.matches[0]).toMatchObject({ chapter: 1, scene: 1, prose: { paragraph: 0 } })
  expect(result.matches[0].artifacts).toEqual({ canon: { name: 'canon-1', version: 'a'.repeat(64) }, material: { name: 'extract-0', version: 'a'.repeat(64) } })
  expect(result.uncertainties).toEqual(['身份未确认'])
})
it('does not accept fabricated ASR or manuscript locations', async () => {
  const model: NovelModel = async (_p, _v, _s, _r, pixels) => pixels ? JSON.stringify({ description: '断桥', anchors: ['断桥'], uncertainties: [] }) : JSON.stringify({ matches: [{ scene: 1, score: 1, reason: '相符', evidence: [{ index: 0, quote: '桥面塌了一半。' }] }] })
  await expect(analyzeNovelVisual(source, layout, dir, 'table', { image }, settings, model)).rejects.toMatchObject({ message: 'novel_visual_invalid_output', status: 502 })
})
it('allows no reliable match and rejects fake image data and arbitrary URLs', async () => {
  await expect(parseVisualInput({ image: 'https://example.com/private.png' })).rejects.toMatchObject({ status: 400 })
  await expect(parseVisualInput({ image: 'data:image/png;base64,bm90LWltYWdl' })).rejects.toMatchObject({ status: 400 })
  const model: NovelModel = async (_p, _v, _s, _r, pixels) => pixels ? JSON.stringify({ description: '无关的海边', anchors: ['海'], uncertainties: [] }) : '{"matches":[]}'
  expect((await analyzeNovelVisual(source, layout, dir, 'table', { image }, settings, model)).matches).toEqual([])
})
it('resolves a current artifact fingerprint as well as historical versions', async () => {
  const { readArtifact } = await import('../../packages/server/src/services/trpg/novel-harness')
  const hash = 'a'.repeat(64)
  await writeFile(join(dir, 'review-1.json'), JSON.stringify({ inputHash: hash, value: { body: '正文' } }))
  expect((await readArtifact(dir, 'review-1', hash)).value).toEqual({ body: '正文' })
})
