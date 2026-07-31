import { ref, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '@/api/client'

export interface AnalysisRound {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  analysis: string
  timestamp: number
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
