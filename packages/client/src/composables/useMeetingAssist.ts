import { ref, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '@/api/client'

export interface FillerWord {
  word: string
  count: number
  /** 说话人（转写带 [姓名] 标注时尽量带上，做到按发言人区分） */
  speaker?: string
}

export interface GoldenQuote {
  /** 金句原文（定义：有观点、有感染力、能让人记住、可单独引用的一句话） */
  quote: string
  speaker?: string
  reason?: string
}

export interface GrammarIssue {
  quote: string
  issue: string
  speaker?: string
}

export interface AnalysisRound {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  keyPoint: string
  analysis: string
  timestamp: number
  // 演讲评分场景（Toastmasters 风格）附加字段
  fillerWords?: FillerWord[]
  goldenQuotes?: GoldenQuote[]
  grammarIssues?: GrammarIssue[]
  wotdUsed?: boolean
  score?: Record<string, number>
  timeNote?: string
  // 增量评价模式：AI 判断本段是否出现新的评价点
  hasNewPoint?: boolean
  highlights?: string[]
  improvements?: string[]
  topics?: string[]
  // 法律沟通场景（legal）结构化字段
  riskItems?: Array<{ level: 'high' | 'medium' | 'low'; text: string; quote?: string; lawHint?: string }>
  positions?: Array<{ party: string; stance: string }>
  lawRefs?: Array<{ name: string; article?: string; note?: string; verified?: boolean }>
}

export function useMeetingAssist(sessionId: string) {
  const rounds = ref<AnalysisRound[]>([])
  const isConnected = ref(false)
  const isAnalyzing = ref(false)
  const error = ref<string | null>(null)

  let socket: Socket | null = null

  function connect() {
    if (socket?.connected) return

    socket = io(`${getBaseUrlValue()}/meeting-assist`, {
      auth: { token: getApiKey() },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 15000,
    })

    socket.on('connect', () => {
      isConnected.value = true
      socket?.emit('join', sessionId)
    })

    socket.on('disconnect', () => {
      isConnected.value = false
    })

    socket.on('analysis', (round: AnalysisRound) => {
      rounds.value.push(round)
      // Keep max 50 rounds in memory
      if (rounds.value.length > 50) {
        rounds.value = rounds.value.slice(-50)
      }
    })

    socket.on('analyzing', (analyzing: boolean) => {
      isAnalyzing.value = analyzing
    })

    socket.on('error', (msg: string) => {
      error.value = msg
    })
  }

  function disconnect() {
    if (socket) {
      socket.emit('leave', sessionId)
      socket.disconnect()
      socket = null
    }
    isConnected.value = false
    isAnalyzing.value = false
  }

  function clear() {
    rounds.value = []
    error.value = null
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    rounds,
    isConnected,
    isAnalyzing,
    error,
    connect,
    disconnect,
    clear,
  }
}
