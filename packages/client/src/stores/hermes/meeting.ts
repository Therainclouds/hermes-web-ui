import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { saveAudioChunks, loadAudioChunks, deleteAudioChunks } from '@/utils/audio-db'

export interface MeetingSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  useDiarize: boolean
  sentences: TranscriptSentence[]
  analysisResult: AnalysisResult | null
  htmlContent: string
  speakerMap: Record<string, string>
  speakers: SpeakerEntry[]
  status: 'idle' | 'recording' | 'paused' | 'completed'
  // 分析模型配置
  analysisMode: 'hermes' | 'custom'
  hermesProfile?: string
  customProvider?: string
  customModel?: string
  // 音频时长（音频数据存 IndexedDB）
  audioDuration: number
}

export interface TranscriptSentence {
  text: string
  timestamp: number
  startTime?: number
  endTime?: number
  speaker?: string
  speakerId?: string
}

export interface AudioChunk {
  data: string // base64 encoded
  timestamp: number
  duration: number
}

export interface AnalysisResult {
  summary?: string
  key_points?: string[]
  action_items?: string[]
  topics?: string[]
  people_mentioned?: string[]
  relationships?: Array<{
    source: string
    target: string
    relation: string
  }>
  timestamp?: number
  html_content?: string
}

export interface ASRConfig {
  dashscopeApiKey: string
  paraformerWsUrl: string
  paraformerModel: string
  sampleRate: number
  languageHints: string
}

export interface SpeakerEntry {
  id: string
  displayName: string
}

const STORAGE_KEY = 'hermes.meeting.sessions'
const ASR_CONFIG_KEY = 'hermes.meeting.asrConfig'

function generateId(): string {
  return `meeting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function loadSessions(): MeetingSession[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const sessions = JSON.parse(saved) as MeetingSession[]
      // 兼容旧数据：补全 speakers 字段，移除 audioChunks
      return sessions.map(s => ({
        ...s,
        speakers: s.speakers || [],
        audioChunks: undefined,
      }))
    }
  } catch {}
  return []
}

function saveSessions(sessions: MeetingSession[]) {
  try {
    // 不保存 audioChunks（已移除）和 speakers 到 localStorage
    const toSave = sessions.map(({ ...rest }) => rest)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
  } catch {}
}

function loadASRConfig(): ASRConfig {
  try {
    const saved = localStorage.getItem(ASR_CONFIG_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch {}
  return {
    dashscopeApiKey: '',
    paraformerWsUrl: 'wss://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
    paraformerModel: 'paraformer-realtime-v2',
    sampleRate: 16000,
    languageHints: 'zh,en',
  }
}

function saveASRConfig(config: ASRConfig) {
  try {
    localStorage.setItem(ASR_CONFIG_KEY, JSON.stringify(config))
  } catch {}
}

export const useMeetingStore = defineStore('meeting', () => {
  const sessions = ref<MeetingSession[]>(loadSessions())
  const activeSessionId = ref<string | null>(null)

  const activeSession = computed(() => {
    if (!activeSessionId.value) return null
    return sessions.value.find(s => s.id === activeSessionId.value) || null
  })

  const sortedSessions = computed(() => {
    return [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)
  })

  function createSession(options?: {
    title?: string
    analysisMode?: 'hermes' | 'custom'
    hermesProfile?: string
    customProvider?: string
    customModel?: string
  }): MeetingSession {
    const now = Date.now()
    const session: MeetingSession = {
      id: generateId(),
      title: options?.title || `会议 ${new Date().toLocaleString('zh-CN')}`,
      createdAt: now,
      updatedAt: now,
      useDiarize: false,
      sentences: [],
      analysisResult: null,
      htmlContent: '',
      speakerMap: {},
      speakers: [],
      status: 'idle',
      analysisMode: options?.analysisMode || 'hermes',
      hermesProfile: options?.hermesProfile,
      customProvider: options?.customProvider,
      customModel: options?.customModel,
      audioDuration: 0,
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    saveSessions(sessions.value)
    return session
  }

  function updateSession(id: string, updates: Partial<MeetingSession>) {
    const index = sessions.value.findIndex(s => s.id === id)
    if (index === -1) return
    sessions.value[index] = {
      ...sessions.value[index],
      ...updates,
      updatedAt: Date.now(),
    }
    saveSessions(sessions.value)
  }

  function deleteSession(id: string) {
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id || null
    }
    saveSessions(sessions.value)
    // 清理 IndexedDB 音频数据
    deleteAudioChunks(id).catch(() => {})
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id
  }

  function addSentence(sessionId: string, sentence: string | TranscriptSentence) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const newSentence: TranscriptSentence = typeof sentence === 'string'
      ? { text: sentence, timestamp: Date.now() }
      : sentence
    session.sentences.push(newSentence)
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function updateAnalysis(sessionId: string, result: AnalysisResult) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.analysisResult = result
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function updateHtmlContent(sessionId: string, html: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.htmlContent = html
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function updateSpeakerMap(sessionId: string, speakerMap: Record<string, string>) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.speakerMap = speakerMap
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function updateStatus(sessionId: string, status: MeetingSession['status']) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.status = status
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function clearSession(sessionId: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.sentences = []
    session.analysisResult = null
    session.htmlContent = ''
    session.speakerMap = {}
    session.speakers = []
    session.status = 'idle'
    session.audioDuration = 0
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
    // 清理 IndexedDB 音频数据
    deleteAudioChunks(sessionId).catch(() => {})
  }

  // --- 音频 IndexedDB 操作 ---

  let audioChunkBuffer: Map<string, AudioChunk[]> = new Map()

  function addAudioChunk(sessionId: string, chunk: AudioChunk) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.audioDuration += chunk.duration
    session.updatedAt = Date.now()

    // 缓存到内存，批量写入 IndexedDB
    if (!audioChunkBuffer.has(sessionId)) {
      audioChunkBuffer.set(sessionId, [])
    }
    audioChunkBuffer.get(sessionId)!.push(chunk)

    // 每 10 个 chunk 批量写入一次
    const buffer = audioChunkBuffer.get(sessionId)!
    if (buffer.length >= 10) {
      flushAudioChunks(sessionId)
    }
  }

  async function flushAudioChunks(sessionId: string) {
    const buffer = audioChunkBuffer.get(sessionId)
    if (!buffer || buffer.length === 0) return

    // 加载已有数据，追加后保存
    const existing = await loadAudioChunks(sessionId)
    const combined = [...existing, ...buffer]
    await saveAudioChunks(sessionId, combined)
    audioChunkBuffer.set(sessionId, [])
  }

  async function saveAudioData(sessionId: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    await flushAudioChunks(sessionId)
    saveSessions(sessions.value)
  }

  async function getAudioBlob(sessionId: string): Promise<Blob | null> {
    // 先刷新缓冲区
    await flushAudioChunks(sessionId)

    const chunks = await loadAudioChunks(sessionId)
    if (chunks.length === 0) return null

    const audioData = chunks.map(chunk => {
      const binary = atob(chunk.data)
      const array = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i)
      }
      return array
    })

    return new Blob(audioData, { type: 'audio/webm' })
  }

  // --- 说话人管理 ---

  function renameSpeaker(sessionId: string, speakerId: string, displayName: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return

    // 更新 speakers 列表
    const existing = session.speakers.find(s => String(s.id) === String(speakerId))
    if (existing) {
      existing.displayName = displayName
    } else {
      session.speakers.push({ id: speakerId, displayName })
    }

    // 更新所有使用该 speakerId 的句子的 speaker 字段
    for (const sentence of session.sentences) {
      if (String(sentence.speakerId) === String(speakerId)) {
        sentence.speaker = displayName
      }
    }

    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function getSpeakerDisplayName(session: MeetingSession, speakerId: string): string {
    const entry = session.speakers.find(s => String(s.id) === String(speakerId))
    return entry?.displayName || speakerId
  }

  // ASR 配置
  const asrConfig = ref<ASRConfig>(loadASRConfig())

  const hasASRConfig = computed(() => {
    return !!asrConfig.value.dashscopeApiKey
  })

  function updateASRConfig(config: Partial<ASRConfig>) {
    asrConfig.value = { ...asrConfig.value, ...config }
    saveASRConfig(asrConfig.value)
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    sortedSessions,
    asrConfig,
    hasASRConfig,
    createSession,
    updateSession,
    deleteSession,
    setActiveSession,
    addSentence,
    updateAnalysis,
    updateHtmlContent,
    updateSpeakerMap,
    updateStatus,
    clearSession,
    addAudioChunk,
    saveAudioData,
    getAudioBlob,
    renameSpeaker,
    getSpeakerDisplayName,
    updateASRConfig,
  }
})
