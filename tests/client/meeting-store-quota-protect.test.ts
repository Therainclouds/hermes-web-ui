// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/utils/audio-db', () => ({
  saveAudioChunks: vi.fn(),
  loadAudioChunks: vi.fn().mockResolvedValue([]),
  deleteAudioChunks: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/utils/meeting-storage-api', () => ({
  meetingStorageApi: {
    listMeetings: vi.fn().mockResolvedValue([]),
    getMeeting: vi.fn(),
    saveMeeting: vi.fn(),
    saveTranscript: vi.fn(),
    uploadAudio: vi.fn(),
    deleteMeeting: vi.fn(),
    downloadAudio: vi.fn(),
  },
}))

function makeSentences(n: number) {
  return Array.from({ length: n }, (_, i) => ({ text: `s${i}`, timestamp: i }))
}

/**
 * 回归覆盖：localStorage quota 超限时 archiveOldSessions 的截断兜底
 * 必须保护当前活跃会话（录音中正在累积的转写），只截断旧会话。
 * 真实故障路径：quota 截断 store 副本 + 录音中用户重命名说话人
 * （MeetingView.onTranscriptRename 会用 store 副本覆盖视图副本）
 * → 屏幕上正在显示的转写被截到 50 句。
 *
 * 注意：jsdom 的 localStorage 无法通过 spyOn(Storage.prototype) 拦截，
 * 必须用 stubGlobal 注入可控 storage，并在注入之后动态导入 store。
 */
describe('meeting store quota protection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('trims old sessions but keeps the active session intact when quota is exceeded', async () => {
    const backing = new Map<string, string>()
    let armed = true
    const quotaErr = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (armed && key === 'hermes.meeting.sessions') {
          armed = false
          throw quotaErr
        }
        backing.set(key, value)
      },
      removeItem: (key: string) => { backing.delete(key) },
      clear: () => { backing.clear() },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
      get length() { return backing.size },
    })

    const { useMeetingStore } = await import('@/stores/hermes/meeting')
    const store = useMeetingStore()

    const oldSession = store.createSession({ title: 'old' })
    oldSession.updatedAt = Date.now() - 60_000
    const activeSession = store.createSession({ title: 'active' })

    oldSession.sentences = makeSentences(80)
    activeSession.sentences = makeSentences(80)

    // 活跃会话新增一句 → saveSessions → quota 异常 → archiveOldSessions
    // （arm 必须放在 addSentence 之前：createSession 内部也会 saveSessions，
    //   提前武装会让 quota 异常被空会话的保存消耗掉）
    armed = true
    store.addSentence(activeSession.id, { text: 'live', timestamp: 999 })

    expect(armed).toBe(false)

    const persistedOld = store.sessions.find(s => s.id === oldSession.id)!
    const persistedActive = store.sessions.find(s => s.id === activeSession.id)!
    // 旧会话被截到 50 句
    expect(persistedOld.sentences).toHaveLength(50)
    // 活跃会话 81 句（80 原有 + 1 新增）完整保留
    expect(persistedActive.sentences).toHaveLength(81)
    expect(persistedActive.sentences[persistedActive.sentences.length - 1]?.text).toBe('live')
    // 兜底重试写入成功，活跃会话完整落库
    const persisted = JSON.parse(backing.get('hermes.meeting.sessions') || '[]')
    const persistedActiveFromStorage = persisted.find((s: { id: string }) => s.id === activeSession.id)
    expect(persistedActiveFromStorage.sentences).toHaveLength(81)
  })
})
