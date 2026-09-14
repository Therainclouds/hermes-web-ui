// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { useDiarizeMerge } from '@/composables/useDiarizeMerge'
import { useMeetingStore, type TranscriptSentence } from '@/stores/hermes/meeting'

function setup() {
  const store = useMeetingStore()
  const session = store.createSession({ title: 'file transcription' })
  const finalSentences = ref<TranscriptSentence[]>([])
  const speakerMap = ref<Record<string, string>>({})
  const pushSentenceToAssist = vi.fn()
  const merge = useDiarizeMerge({ finalSentences, speakerMap, pushSentenceToAssist })
  return { store, session, finalSentences, speakerMap, pushSentenceToAssist, ...merge }
}

describe('useDiarizeMerge.applyFileTranscriptionResult', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('writes a fresh transcript with speaker labels when diarization is on', async () => {
    const { finalSentences, speakerMap, store, applyFileTranscriptionResult } = setup()

    const changed = applyFileTranscriptionResult([
      { text: '大家好', begin_ms: 0, end_ms: 1000, speaker_id: 1 },
      { text: '开始吧', begin_ms: 1200, end_ms: 2400, speaker_id: 2 },
    ], { diarize: true })
    await nextTick()

    expect(changed).toBe(2)
    expect(finalSentences.value).toHaveLength(2)
    expect(finalSentences.value[0].speaker).toBe('说话人 1')
    expect(finalSentences.value[0].speakerId).toBe('1')
    expect(finalSentences.value[1].speaker).toBe('说话人 2')
    expect(speakerMap.value).toEqual({ '1': '说话人 1', '2': '说话人 2' })
    // the store copy must be in sync so autosave persists the speakers
    expect(store.activeSession?.sentences).toHaveLength(2)
  })

  it('never invents a speaker when diarization is off', async () => {
    const { finalSentences, speakerMap, applyFileTranscriptionResult } = setup()

    const changed = applyFileTranscriptionResult([
      { text: '一整段', begin_ms: 0, end_ms: 5000, speaker_id: -1 },
    ], { diarize: false })
    await nextTick()

    expect(changed).toBe(1)
    expect(finalSentences.value[0].speaker).toBeUndefined()
    expect(finalSentences.value[0].speakerId).toBeUndefined()
    expect(speakerMap.value).toEqual({})
  })

  it('backfills speakers onto an existing realtime transcript instead of duplicating it', async () => {
    const { finalSentences, applyFileTranscriptionResult } = setup()
    finalSentences.value = [
      { text: '大家好', timestamp: 1, startTime: 0, endTime: 1000 },
      { text: '开始吧', timestamp: 2, startTime: 1200, endTime: 2400 },
    ]

    const changed = applyFileTranscriptionResult([
      { text: '大家好', begin_ms: 50, end_ms: 1050, speaker_id: 1 },
      { text: '开始吧', begin_ms: 1250, end_ms: 2450, speaker_id: 2 },
    ], { diarize: true })
    await nextTick()

    expect(changed).toBe(2)
    expect(finalSentences.value).toHaveLength(2)
    expect(finalSentences.value.map(s => s.speakerId)).toEqual(['1', '2'])
  })

  it('appends genuinely new sentences from the whole-file pass', async () => {
    const { finalSentences, applyFileTranscriptionResult } = setup()
    finalSentences.value = [
      { text: '大家好', timestamp: 1, startTime: 0, endTime: 1000 },
    ]

    const changed = applyFileTranscriptionResult([
      { text: '大家好', begin_ms: 0, end_ms: 1000, speaker_id: 1 },
      { text: '这句实时没识别到', begin_ms: 30_000, end_ms: 32_000, speaker_id: 2 },
    ], { diarize: true })
    await nextTick()

    expect(changed).toBe(2)
    expect(finalSentences.value.map(s => s.text)).toEqual(['大家好', '这句实时没识别到'])
    expect(finalSentences.value[1].speakerId).toBe('2')
  })

  it('skips duplicate text at the same timestamp', async () => {
    const { finalSentences, applyFileTranscriptionResult } = setup()
    finalSentences.value = [
      { text: '重复句', timestamp: 1, startTime: 0, endTime: 1000 },
    ]

    const changed = applyFileTranscriptionResult([
      { text: '重复句', begin_ms: 100, end_ms: 1100, speaker_id: 1 },
    ], { diarize: false })
    await nextTick()

    expect(changed).toBe(0)
    expect(finalSentences.value).toHaveLength(1)
  })
})
