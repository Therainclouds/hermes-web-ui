// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest'
import { installClientPlugins, meetingPanels, sceneTemplateContributions, _resetForTesting } from '../../packages/client/src/plugins/registry'
import plugin from '../../packages/client/src/plugins/trpg'
import { reactive } from 'vue'
import { recentTranscript, snapshotCampaign, emptyCampaign, scopedSentences, scopedTranscript, buildParagraphs, mergeSegments, normalizeCampaign, defaultAsrScope } from '../../packages/client/src/plugins/trpg/storage'
import { messages } from '../../packages/client/src/plugins/trpg/messages'
beforeEach(() => { localStorage.clear(); _resetForTesting() })
describe('TRPG plugin', () => {
  it('registers only an enabled, lazy meeting panel', async () => {
    const i18n = { global: { getLocaleMessage: () => ({}), setLocaleMessage: () => {} } }
    const routes: any[] = []
    const router = { addRoute: (route: any) => routes.push(route) }
    await installClientPlugins({} as any, router as any, i18n, [{ plugin, enabledByDefault: false }])
    expect(meetingPanels).toHaveLength(0)
    expect(sceneTemplateContributions).toHaveLength(0)
    await installClientPlugins({} as any, router as any, i18n, [{ plugin, enabledByDefault: true }])
    expect(meetingPanels.map(p => p.id)).toEqual(['trpg'])
    expect(sceneTemplateContributions.map(s => s.id)).toEqual(['trpg'])
    await installClientPlugins({} as any, router as any, i18n, [{ plugin, enabledByDefault: true }])
    expect(meetingPanels).toHaveLength(1)
    expect(sceneTemplateContributions).toHaveLength(1)
    // The chronicle reader is a standalone document, not a SPA route.
    expect(routes).toHaveLength(0)
  })
  it('contributes the trpg scene with i18n keys and an svg icon', async () => {
    const i18n = { global: { getLocaleMessage: () => ({}), setLocaleMessage: () => {} } }
    await installClientPlugins({} as any, { addRoute: () => {} } as any, i18n, [{ plugin, enabledByDefault: true }])
    const scene = sceneTemplateContributions[0]
    expect(scene).toMatchObject({
      id: 'trpg',
      labelKey: 'trpg.sceneLabel',
      descriptionKey: 'trpg.sceneDesc',
    })
    expect(scene.iconSvg).toMatch(/<polygon/)
  })
  it('uses the recent finalized transcript within bounded context', () => {
    const text = recentTranscript(Array.from({ length: 100 }, (_, i) => ({ text: `line ${i}`, speaker: 'GM' })))
    expect(text).toContain('[GM] line 99')
    expect(text).not.toContain('line 39')
    expect(recentTranscript([{ text: 'a'.repeat(15000) }])).toHaveLength(12000)
  })
  it('resolves ASR scopes to sentences: all, recent N, and picked paragraphs', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => ({ text: `第${i}句。`, speaker: i % 2 ? 'GM' : '银月', timestamp: i * 1000 }))
    expect(scopedSentences(sentences, defaultAsrScope('all'))).toHaveLength(12)
    expect(scopedSentences(sentences, defaultAsrScope('recent', 3)).map(s => s.text)).toEqual(['第9句。', '第10句。', '第11句。'])
    const picked = scopedSentences(sentences, { mode: 'segments', recentCount: 60, segments: [{ from: 2, to: 3 }, { from: 8, to: 9 }] })
    expect(picked.map(s => s.text)).toEqual(['第2句。', '第3句。', '第8句。', '第9句。'])
    // Recent count larger than the transcript simply keeps everything.
    expect(scopedSentences(sentences, defaultAsrScope('recent', 999))).toHaveLength(12)
    expect(scopedSentences([], defaultAsrScope('recent', 5))).toEqual([])
  })
  it('merges overlapping or adjacent segments and clamps them to the transcript', () => {
    expect(mergeSegments([{ from: 3, to: 5 }, { from: 6, to: 8 }, { from: 1, to: 2 }], 10)).toEqual([{ from: 1, to: 8 }])
    expect(mergeSegments([{ from: -4, to: 99 }], 5)).toEqual([{ from: 0, to: 4 }])
    expect(mergeSegments([{ from: 9, to: 2 }], 5)).toEqual([])
    expect(mergeSegments([{ from: 1.7, to: 3.2 }], 5)).toEqual([{ from: 1, to: 3 }])
  })
  it('caps the scoped transcript from the end so the latest narration survives', () => {
    const sentences = [{ text: 'a'.repeat(9000) }, { text: 'b'.repeat(9000) }]
    const text = scopedTranscript(sentences, defaultAsrScope('all'), 12000)
    expect(text).toHaveLength(12000)
    expect(text.endsWith('b'.repeat(3000))).toBe(true)
  })
  it('groups sentences into paragraphs on speaker change, pause and length', () => {
    const sentences = [
      { text: '一', speaker: 'GM', timestamp: 0 },
      { text: '二', speaker: 'GM', timestamp: 1000 },
      { text: '三', speaker: '银月', timestamp: 2000 },
      { text: '四', speaker: '银月', timestamp: 90000 },
    ]
    const paragraphs = buildParagraphs(sentences, { maxSentences: 8, timeGapMs: 45000 })
    expect(paragraphs.map(p => ({ from: p.from, to: p.to, speaker: p.speaker }))).toEqual([
      { from: 0, to: 1, speaker: 'GM' },
      { from: 2, to: 2, speaker: '银月' },
      { from: 3, to: 3, speaker: '银月' },
    ])
    expect(paragraphs[0].id).toBe('0-1')
    expect(buildParagraphs([], {})).toEqual([])
  })
  it('normalizes campaign records and persists ASR settings through snapshots', () => {
    const normalized = normalizeCampaign(emptyCampaign())
    expect(normalized.asrSettings).toEqual({ highlight: { mode: 'recent', recentCount: 60, segments: [] }, recap: { mode: 'all', recentCount: 60, segments: [] } })
    const value = emptyCampaign()
    value.asrSettings = { highlight: { mode: 'segments', recentCount: 10, segments: [{ from: 0, to: 2 }] }, recap: { mode: 'recent', recentCount: 40, segments: [] } }
    const snapshot = snapshotCampaign(value)
    expect(snapshot.asrSettings).toEqual(value.asrSettings)
    // A copied snapshot must not share (and later mutate) the segment objects.
    snapshot.asrSettings!.highlight.segments[0].to = 9
    expect(value.asrSettings.highlight.segments[0].to).toBe(2)
  })
  it('persists a manually uploaded highlight image name', () => {
    const value = emptyCampaign()
    value.highlights.push({ id: 'h1', prompt: 'p', createdAt: 1, transcript: '', image: new Blob(), imageName: 'dragon.png', imageModel: 'trpg.manualUpload', actions: [] })
    const snapshot = snapshotCampaign(value)
    expect(snapshot.highlights[0]).toMatchObject({ imageName: 'dragon.png', imageModel: 'trpg.manualUpload' })
  })
  it('serializes filtered reactive cards into plain storage records', () => {
    const value = reactive(emptyCampaign())
    value.characters.push({ id: '1', name: 'A', player: '', appearance: '', card: '' })
    value.characters = value.characters.filter(() => true)
    expect(() => structuredClone(snapshotCampaign(value))).not.toThrow()
  })
  it('provides every message for every supported locale', () => {
    expect(Object.keys(messages)).toHaveLength(11)
    for (const value of Object.values(messages)) expect(Object.keys(value).sort()).toEqual(Object.keys(messages.en).sort())
    expect(messages.en).toHaveProperty('sceneLabel')
    expect(messages.en).toHaveProperty('sceneDesc')
    expect(messages.zh).toHaveProperty('sceneLabel')
    expect(messages.zh).toHaveProperty('sceneDesc')
  })
})
