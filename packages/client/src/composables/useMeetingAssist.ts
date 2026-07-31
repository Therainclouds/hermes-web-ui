import { ref, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '@/api/client'

export interface AssistHint {
  id: string
  type: 'prediction' | 'atmosphere' | 'risk' | 'suggestion'
  level: 'info' | 'warning' | 'critical'
  text: string
  timestamp: number
}

export function useMeetingAssist(sessionId: string) {
  const hints = ref<AssistHint[]>([])
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

    socket.on('hints', (newHints: AssistHint[]) => {
      hints.value.push(...newHints)
      // Keep max 100 hints in memory
      if (hints.value.length > 100) {
        hints.value = hints.value.slice(-100)
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
    hints.value = []
    error.value = null
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    hints,
    isConnected,
    isAnalyzing,
    error,
    connect,
    disconnect,
    clear,
  }
}
