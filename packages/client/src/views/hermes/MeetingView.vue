<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NTag, NTooltip, NInput, NPopconfirm, NModal, NSelect, NRadio, NRadioGroup, NPopover } from 'naive-ui'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { MeetingSession, TranscriptSentence } from '@/stores/hermes/meeting'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const meetingStore = useMeetingStore()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()

// --- 侧边栏状态 ---
const showSidebar = ref(true)

// --- 创建会议对话框 ---
const showCreateModal = ref(false)
const newMeetingTitle = ref('')
const newMeetingAnalysisMode = ref<'hermes' | 'custom'>('hermes')
const newMeetingHermesProfile = ref('')
const newMeetingCustomProvider = ref('')
const newMeetingCustomModel = ref('')

// --- ASR 配置 ---
const asrApiKey = ref(meetingStore.asrConfig.dashscopeApiKey)

// --- 当前会议状态 ---
const isRecording = ref(false)
const isLoading = ref(false)
const isConnecting = ref(false)
const statusText = ref('')
const partialText = ref('')
const finalSentences = ref<TranscriptSentence[]>([])
const speakerMap = ref<Record<string, string>>({})
const useDiarize = ref(false)
const speakerCount = ref(0) // 0 = auto
const errorMessage = ref('')

// --- 说话人数选项 ---
const speakerCountOptions = computed(() => [
  { label: t('meeting.speakerCountAuto'), value: 0 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
])

// --- 说话人重命名 ---
const renamingKey = ref<string | null>(null)  // 格式: "speakerId:index"
const renameInput = ref('')

// --- 配置 ---
const ASR_URL = 'ws://localhost:8000/ws/asr'
const DIARIZE_URL = 'ws://localhost:8001/ws/diarize'
const API_BASE = 'http://localhost:8000'

// --- WebSocket & Audio ---
let ws: WebSocket | null = null
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let analyser: AnalyserNode | null = null
let animationFrameId: number | null = null

// --- 音频录制 ---
let mediaRecorder: MediaRecorder | null = null
const audioChunks = ref<Blob[]>([])
const recordingStartTime = ref(0)
const audioBlob = ref<Blob | null>(null)
const audioUrl = ref('')
const isPlaying = ref(false)
const playbackTime = ref(0)
const playbackDuration = ref(0)

// --- 分析相关 ---
const analysisResult = ref<any>(null)
const htmlContent = ref('')
const isAnalyzing = ref(false)
const analysisInterval = ref(30)
const showReport = ref(false)

// --- 右侧面板 ---
const showRightPanel = ref(true)
const rightPanelWidth = ref(360)
const RIGHT_PANEL_MIN_WIDTH = 280
const RIGHT_PANEL_MAX_WIDTH = 600
const RIGHT_PANEL_STORAGE_KEY = 'hermes.meeting.rightPanelWidth'
let resizeStart: { x: number; width: number } | null = null

// 加载保存的面板宽度
function loadRightPanelWidth(): number {
  try {
    const saved = localStorage.getItem(RIGHT_PANEL_STORAGE_KEY)
    if (saved) {
      const width = parseInt(saved, 10)
      if (!isNaN(width) && width >= RIGHT_PANEL_MIN_WIDTH && width <= RIGHT_PANEL_MAX_WIDTH) {
        return width
      }
    }
  } catch {}
  return 360
}

rightPanelWidth.value = loadRightPanelWidth()

function startRightPanelResize(e: PointerEvent) {
  resizeStart = { x: e.clientX, width: rightPanelWidth.value }
  document.addEventListener('pointermove', onRightPanelResize)
  document.addEventListener('pointerup', stopRightPanelResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onRightPanelResize(e: PointerEvent) {
  if (!resizeStart) return
  const delta = resizeStart.x - e.clientX
  const newWidth = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, resizeStart.width + delta))
  rightPanelWidth.value = newWidth
}

function stopRightPanelResize() {
  resizeStart = null
  document.removeEventListener('pointermove', onRightPanelResize)
  document.removeEventListener('pointerup', stopRightPanelResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  try {
    localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(rightPanelWidth.value))
  } catch {}
}

const rightPanelStyle = computed(() => ({
  width: `${rightPanelWidth.value}px`,
}))

// --- 模型选择相关 ---
const profileOptions = computed(() => {
  return profilesStore.profiles.map(p => ({
    label: p.name,
    value: p.name,
  }))
})

const providerOptions = computed(() => {
  return modelsStore.providers
    .filter(g => g.models.length > 0)
    .map(g => ({
      label: g.label || g.provider,
      value: g.provider,
    }))
})

const modelOptions = computed(() => {
  if (!newMeetingCustomProvider.value) return []
  const group = modelsStore.providers.find(g => g.provider === newMeetingCustomProvider.value)
  if (!group) return []
  return group.models.map(m => ({
    label: m,
    value: m,
  }))
})

// --- 会议管理 ---
function openCreateModal() {
  newMeetingTitle.value = `会议 ${new Date().toLocaleString('zh-CN')}`
  newMeetingAnalysisMode.value = 'hermes'
  newMeetingHermesProfile.value = profilesStore.activeProfileName || 'default'
  newMeetingCustomProvider.value = ''
  newMeetingCustomModel.value = ''
  asrApiKey.value = meetingStore.asrConfig.dashscopeApiKey
  showCreateModal.value = true
}

function handleCreateMeeting() {
  if (!newMeetingTitle.value.trim()) return
  if (!asrApiKey.value.trim() && !meetingStore.hasASRConfig) return
  
  // 保存 ASR API Key（如果有更新）
  if (asrApiKey.value.trim()) {
    meetingStore.updateASRConfig({ dashscopeApiKey: asrApiKey.value.trim() })
  }
  
  meetingStore.createSession({
    title: newMeetingTitle.value.trim(),
    analysisMode: newMeetingAnalysisMode.value,
    hermesProfile: newMeetingAnalysisMode.value === 'hermes' ? newMeetingHermesProfile.value : undefined,
    customProvider: newMeetingAnalysisMode.value === 'custom' ? newMeetingCustomProvider.value : undefined,
    customModel: newMeetingAnalysisMode.value === 'custom' ? newMeetingCustomModel.value : undefined,
  })
  
  resetMeetingState()
  showCreateModal.value = false
}

function loadMeeting(session: MeetingSession) {
  if (isRecording.value) {
    stopRecording()
  }
  meetingStore.setActiveSession(session.id)
  finalSentences.value = [...session.sentences]
  analysisResult.value = session.analysisResult
  htmlContent.value = session.htmlContent
  speakerMap.value = { ...session.speakerMap }
  useDiarize.value = session.useDiarize
  partialText.value = ''
  errorMessage.value = ''
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 加载音频数据（异步，从 IndexedDB）
  loadAudioForSession(session.id)
}

async function loadAudioForSession(sessionId: string) {
  const blob = await meetingStore.getAudioBlob(sessionId)
  if (blob) {
    audioBlob.value = blob
    audioUrl.value = URL.createObjectURL(blob)
  } else {
    audioBlob.value = null
    audioUrl.value = ''
  }
}

function deleteMeeting(id: string) {
  meetingStore.deleteSession(id)
  if (meetingStore.activeSessionId === id) {
    resetMeetingState()
  }
}

function resetMeetingState() {
  finalSentences.value = []
  analysisResult.value = null
  htmlContent.value = ''
  speakerMap.value = {}
  partialText.value = ''
  errorMessage.value = ''
  isRecording.value = false
  isConnecting.value = false
  statusText.value = ''
  highlightedSentenceIndex.value = -1
  renamingKey.value = null
  stopAudio()
}

function saveCurrentMeeting() {
  if (!meetingStore.activeSessionId) return
  meetingStore.updateSession(meetingStore.activeSessionId, {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
    status: isRecording.value ? 'recording' : 'completed',
  })
}

// --- 说话人重命名 ---
function startRenameSpeaker(speakerId: string | undefined, index: number) {
  if (!speakerId || !meetingStore.activeSession) return
  renamingKey.value = `${speakerId}:${index}`
  const displayName = meetingStore.getSpeakerDisplayName(meetingStore.activeSession, speakerId)
  renameInput.value = displayName
}

function confirmRenameSpeaker() {
  // 从 renamingKey 中提取 speakerId
  const speakerId = renamingKey.value?.split(':')[0]
  if (!speakerId || !renameInput.value.trim() || !meetingStore.activeSessionId) return
  meetingStore.renameSpeaker(meetingStore.activeSessionId, speakerId, renameInput.value.trim())
  // 更新本地 finalSentences
  const session = meetingStore.activeSession
  if (session) {
    finalSentences.value = [...session.sentences]
  }
  renamingKey.value = null
  renameInput.value = ''
}

function cancelRenameSpeaker() {
  renamingKey.value = null
  renameInput.value = ''
}

// --- 计算属性 ---
const sentences = computed(() => finalSentences.value)

// --- 生命周期 ---
onMounted(async () => {
  // 加载模型和配置
  await profilesStore.fetchProfiles()
  await modelsStore.fetchProviders()
  
  // 如果没有活跃会议，打开创建对话框
  if (!meetingStore.activeSession) {
    openCreateModal()
  } else {
    loadMeeting(meetingStore.activeSession)
  }
})

onUnmounted(() => {
  stopRecording()
  stopAnalysis()
})

// --- 音频处理 ---
async function startRecording() {
  try {
    errorMessage.value = ''
    isConnecting.value = true
    statusText.value = t('meeting.connecting')

    // 获取麦克风权限
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })

    // 创建音频上下文
    audioContext = new AudioContext({ sampleRate: 16000 })

    // 如果采样率不是16000，需要重采样
    if (audioContext.sampleRate !== 16000) {
      console.log(`Browser sample rate: ${audioContext.sampleRate}, will resample to 16000`)
    }

    const source = audioContext.createMediaStreamSource(mediaStream)

    // 创建分析节点用于可视化
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256

    // 创建 ScriptProcessorNode 用于音频数据处理
    const bufferSize = 4096
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1)

    source.connect(analyser)
    analyser.connect(processor)
    processor.connect(audioContext.destination)

    // 开始录制音频用于保存
    audioChunks.value = []
    recordingStartTime.value = Date.now()
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.value.push(e.data)
      }
    }
    mediaRecorder.start(1000) // 每秒收集一次数据

    // 连接 WebSocket
    const wsUrl = useDiarize.value ? DIARIZE_URL : ASR_URL
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      console.log('WebSocket connected')
      isConnecting.value = false
      isRecording.value = true
      statusText.value = t('meeting.recording')

      // 发送开始消息
      const startMsg = useDiarize.value
        ? { type: 'start', sample_rate: 16000, speaker_count: speakerCount.value || 'auto' }
        : { type: 'start' }
      ws?.send(JSON.stringify(startMsg))
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handleWsMessage(data)
      } catch (e) {
        console.error('Failed to parse WS message:', e)
      }
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      errorMessage.value = t('meeting.connectionError')
      stopRecording()
    }

    ws.onclose = () => {
      console.log('WebSocket closed')
      if (isRecording.value) {
        stopRecording()
      }
    }

    // 处理音频数据
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      const inputData = e.inputBuffer.getChannelData(0)

      // 重采样到 16000 Hz（如果需要）
      let resampledData: Float32Array
      if (audioContext!.sampleRate !== 16000) {
        const ratio = audioContext!.sampleRate / 16000
        const newLength = Math.round(inputData.length / ratio)
        resampledData = new Float32Array(newLength)
        for (let i = 0; i < newLength; i++) {
          resampledData[i] = inputData[Math.round(i * ratio)]
        }
      } else {
        resampledData = inputData
      }

      // 转换为 Int16 PCM
      const int16Data = new Int16Array(resampledData.length)
      for (let i = 0; i < resampledData.length; i++) {
        const s = Math.max(-1, Math.min(1, resampledData[i]))
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }

      ws.send(int16Data.buffer)
    }

    // 开始可视化
    drawWaveform()

  } catch (error: any) {
    console.error('Failed to start recording:', error)
    errorMessage.value = error.message || t('meeting.microphoneError')
    isConnecting.value = false
  }
}

function stopRecording() {
  isRecording.value = false
  isConnecting.value = false
  statusText.value = ''

  // 停止可视化
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  // 停止媒体录制器
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  mediaRecorder = null

  // 发送停止消息
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }))
    setTimeout(() => ws?.close(), 500)
  }
  ws = null

  // 停止音频
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  analyser = null

  // 保存音频数据到 IndexedDB
  if (audioChunks.value.length > 0 && meetingStore.activeSessionId) {
    audioBlob.value = new Blob(audioChunks.value, { type: 'audio/webm' })
    audioUrl.value = URL.createObjectURL(audioBlob.value)
    
    // 保存会议数据（包括音频到 IndexedDB）
    saveCurrentMeeting()
    meetingStore.saveAudioData(meetingStore.activeSessionId)
  }
}

function handleWsMessage(data: any) {
  switch (data.type) {
    case 'ready':
      console.log('Session ready:', data.session_id || data.task_id)
      break
    case 'started':
      statusText.value = t('meeting.recording')
      break
    case 'partial':
      partialText.value = data.text || ''
      break
    case 'final':
      if (data.text) {
        const sentence: TranscriptSentence = {
          text: data.text,
          timestamp: Date.now(),
          startTime: data.begin_time,
          endTime: data.end_time,
        }
        finalSentences.value.push(sentence)
        partialText.value = ''
        
        // 保存到 store
        if (meetingStore.activeSessionId) {
          meetingStore.addSentence(meetingStore.activeSessionId, sentence)
        }
        
        // 自动滚动到底部
        nextTick(() => {
          const container = document.getElementById('transcript-container')
          if (container) container.scrollTop = container.scrollHeight
        })
      }
      break
    case 'transcript':
      // 说话人分离结果
      if (data.sentences) {
        for (const sentence of data.sentences) {
          const speakerId = String(sentence.speaker_id || 'unknown')
          if (!speakerMap.value[speakerId]) {
            speakerMap.value[speakerId] = `说话人 ${Object.keys(speakerMap.value).length + 1}`
          }
          // 检查是否有已注册的显示名称
          const session = meetingStore.activeSession
          const registeredName = session?.speakers.find(s => s.id === speakerId)?.displayName
          const speakerName = registeredName || speakerMap.value[speakerId]
          
          const sentenceObj: TranscriptSentence = {
            text: sentence.text,
            timestamp: Date.now(),
            startTime: sentence.begin_ms,
            endTime: sentence.end_ms,
            speaker: speakerName,
            speakerId: speakerId,
          }
          finalSentences.value.push(sentenceObj)
          
          // 保存到 store
          if (meetingStore.activeSessionId) {
            meetingStore.addSentence(meetingStore.activeSessionId, sentenceObj)
          }
        }
        nextTick(() => {
          const container = document.getElementById('transcript-container')
          if (container) container.scrollTop = container.scrollHeight
        })
      }
      break
    case 'error':
      errorMessage.value = data.message || t('meeting.unknownError')
      stopRecording()
      break
    case 'stopped':
      stopRecording()
      break
  }
}

// --- 音频播放 ---
const audioElement = ref<HTMLAudioElement | null>(null)

function playAudio() {
  if (!audioUrl.value) return
  
  // 如果已经有 Audio 实例，直接继续播放
  if (audioElement.value) {
    audioElement.value.play()
    isPlaying.value = true
    return
  }
  
  audioElement.value = new Audio(audioUrl.value)
  audioElement.value.play()
  isPlaying.value = true
  
  audioElement.value.ontimeupdate = () => {
    if (!audioElement.value) return
    playbackTime.value = audioElement.value.currentTime
    
    // 检查是否到达句子结束时间
    if (playEndAt.value !== null && audioElement.value.currentTime >= playEndAt.value) {
      audioElement.value.pause()
      isPlaying.value = false
      playEndAt.value = null
      return
    }
    
    // 根据播放时间高亮对应的字幕
    highlightCurrentSentence(audioElement.value.currentTime)
  }
  
  audioElement.value.onended = () => {
    isPlaying.value = false
    playbackTime.value = 0
    audioElement.value = null
    highlightedSentenceIndex.value = -1
    playEndAt.value = null
  }
  
  audioElement.value.onloadedmetadata = () => {
    if (audioElement.value) {
      playbackDuration.value = audioElement.value.duration
    }
  }
}

function pauseAudio() {
  if (audioElement.value) {
    audioElement.value.pause()
    isPlaying.value = false
  }
}

function togglePlayPause() {
  if (isPlaying.value) {
    pauseAudio()
  } else {
    playAudio()
  }
}

function stopAudio() {
  if (audioElement.value) {
    audioElement.value.pause()
    audioElement.value.currentTime = 0
    audioElement.value = null
  }
  isPlaying.value = false
  playbackTime.value = 0
  highlightedSentenceIndex.value = -1
  playEndAt.value = null
}

function seekTo(seconds: number) {
  if (!audioElement.value) return
  audioElement.value.currentTime = Math.max(0, Math.min(seconds, playbackDuration.value))
  playbackTime.value = audioElement.value.currentTime
}

// 播放到指定句子结束时停止
const playEndAt = ref<number | null>(null)

function seekToSentence(index: number) {
  const sentence = finalSentences.value[index]
  if (!sentence?.startTime || !audioUrl.value) return
  // startTime 是毫秒，需要转换为秒
  const startTimeSec = sentence.startTime / 1000
  const endTimeSec = sentence.endTime ? sentence.endTime / 1000 : null

  // 设置结束时间
  playEndAt.value = endTimeSec

  seekTo(startTimeSec)
  if (!isPlaying.value) {
    playAudio()
  }
}

// --- 进度条 ---
const isDraggingProgress = ref(false)

const progressPercent = computed(() => {
  if (playbackDuration.value <= 0) return 0
  return (playbackTime.value / playbackDuration.value) * 100
})

function seekToPosition(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const time = percent * playbackDuration.value
  playEndAt.value = null  // 用户手动拖拽时取消句子结束限制
  seekTo(time)
}

function startProgressDrag(event: MouseEvent) {
  isDraggingProgress.value = true
  playEndAt.value = null  // 用户手动拖拽时取消句子结束限制
  seekToPosition(event)
  document.addEventListener('mousemove', onProgressDrag)
  document.addEventListener('mouseup', stopProgressDrag)
}

function onProgressDrag(event: MouseEvent) {
  if (!isDraggingProgress.value) return
  const target = document.querySelector('.progress-track') as HTMLElement
  if (!target) return
  const rect = target.getBoundingClientRect()
  const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const time = percent * playbackDuration.value
  seekTo(time)
}

function stopProgressDrag() {
  isDraggingProgress.value = false
  document.removeEventListener('mousemove', onProgressDrag)
  document.removeEventListener('mouseup', stopProgressDrag)
}

// 高亮当前播放的字幕
const highlightedSentenceIndex = ref(-1)

function highlightCurrentSentence(currentTimeSec: number) {
  const session = meetingStore.activeSession
  if (!session || session.sentences.length === 0) return
  
  const currentTimeMs = currentTimeSec * 1000
  
  // 使用 startTime 匹配（相对于音频开始的时间）
  for (let i = session.sentences.length - 1; i >= 0; i--) {
    const sentence = session.sentences[i]
    if (sentence.startTime && sentence.startTime <= currentTimeMs) {
      if (highlightedSentenceIndex.value !== i) {
        highlightedSentenceIndex.value = i
        
        // 自动滚动到当前字幕
        nextTick(() => {
          const element = document.querySelector(`.sentence-item[data-index="${i}"]`)
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        })
      }
      break
    }
  }
}

function downloadAudio() {
  if (!audioBlob.value) return
  const url = URL.createObjectURL(audioBlob.value)
  const a = document.createElement('a')
  a.href = url
  a.download = `${meetingStore.activeSession?.title || 'meeting'}.webm`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function downloadTranscript() {
  if (!meetingStore.activeSession) return
  const session = meetingStore.activeSession
  const content = session.sentences.map((s, i) => {
    const time = s.startTime ? formatDuration(s.startTime / 1000) : new Date(s.timestamp).toLocaleTimeString('zh-CN')
    const speaker = s.speaker ? `[${s.speaker}] ` : ''
    return `${i + 1}. ${time} ${speaker}${s.text}`
  }).join('\n')
  
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${session.title || 'meeting'}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function downloadJson() {
  if (!meetingStore.activeSession) return
  const session = meetingStore.activeSession
  
  const jsonData = {
    title: session.title,
    createdAt: new Date(session.createdAt).toISOString(),
    duration: session.audioDuration,
    speakers: session.speakers,
    sentences: session.sentences.map((s, i) => ({
      index: i + 1,
      text: s.text,
      startTimeMs: s.startTime,
      endTimeMs: s.endTime,
      speakerId: s.speakerId,
      speakerName: s.speaker || null,
      timestamp: new Date(s.timestamp).toISOString(),
    })),
    analysis: session.analysisResult,
  }
  
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${session.title || 'meeting'}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function downloadReport() {
  if (!htmlContent.value) return
  const blob = new Blob([htmlContent.value], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${meetingStore.activeSession?.title || 'meeting'}_report.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// --- Hermes Agent 分析 ---
async function analyzeWithHermesAgent() {
  if (!meetingStore.activeSession) return
  
  const session = meetingStore.activeSession
  
  // 构建带说话人信息的转写内容
  const transcriptLines = session.sentences.map(s => {
    const speaker = s.speaker ? `[${s.speaker}] ` : ''
    return `${speaker}${s.text}`
  })
  const transcript = transcriptLines.join('\n')
  
  if (!transcript.trim()) {
    errorMessage.value = t('meeting.noTranscript')
    return
  }
  
  isLoading.value = true
  errorMessage.value = ''
  
  try {
    // 使用 Hermes Agent 进行分析
    const profile = session.hermesProfile || 'default'
    
    // 构建说话人信息
    let speakerInfo = ''
    if (session.speakers.length > 0) {
      speakerInfo = `\n说话人信息：\n${session.speakers.map(s => `- ${s.id}: ${s.displayName}`).join('\n')}\n`
    }
    
    // 构建分析提示词
    const prompt = `请分析以下会议转写内容，生成会议纪要，包括：
1. 会议摘要
2. 关键要点
3. 待办事项
4. 会议主题
5. 参与人员关系（如果有）
${speakerInfo}
转写内容（格式为 [说话人名称] 发言内容）：
${transcript}

请以 JSON 格式返回分析结果，格式如下：
{
  "summary": "会议摘要",
  "key_points": ["要点1", "要点2"],
  "action_items": ["待办1", "待办2"],
  "topics": ["主题1", "主题2"],
  "people_mentioned": ["人员1", "人员2"],
  "relationships": [{"source": "人员1", "target": "人员2", "relation": "关系"}]
}`

    // 获取 API Key
    const apiKey = localStorage.getItem('hermes_api_key') || ''
    
    // 调用 Hermes Web UI 的 chat-run API
    const response = await fetch('/api/chat-run/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: prompt,
        profile,
        timeout_ms: 60000,
      }),
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.error || 'Analysis failed')
    }
    
    const result = await response.json()
    
    // 解析分析结果
    try {
      // 尝试从输出中提取 JSON
      const output = result.output || ''
      const jsonMatch = output.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0])
        analysisResult.value = analysis
        
        // 保存分析结果
        meetingStore.updateAnalysis(session.id, analysis)
        
        // 生成 HTML 报告
        generateHtmlReport(analysis)
      } else {
        // 如果不是 JSON 格式，直接显示文本
        analysisResult.value = { summary: output }
      }
    } catch (e) {
      // 如果解析失败，直接显示文本
      analysisResult.value = { summary: result.output || 'Analysis completed' }
    }
    
  } catch (error: any) {
    console.error('Hermes Agent analysis failed:', error)
    errorMessage.value = error.message || t('meeting.analysisError')
  } finally {
    isLoading.value = false
  }
}

function generateHtmlReport(analysis: any) {
  const session = meetingStore.activeSession
  if (!session) return
  
  const genTime = new Date().toLocaleString('zh-CN')
  
  const topicsHtml = (analysis.topics || []).map((t: string) => 
    `<span class="topic-tag">${t}</span>`
  ).join('')
  
  const keyPointsHtml = (analysis.key_points || []).map((p: string, i: number) => 
    `<div class="key-point-card">
      <div class="key-point-number">${i + 1}</div>
      <div class="key-point-text">${p}</div>
    </div>`
  ).join('')
  
  const actionItemsHtml = (analysis.action_items || []).map((item: string) =>
    `<div class="action-item">
      <input type="checkbox" class="action-checkbox">
      <span class="action-text">${item}</span>
    </div>`
  ).join('')
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${session.title} - 会议分析报告</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    .header {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
    }
    .header h1 { font-size: 28px; color: #1a1a2e; margin-bottom: 10px; }
    .header .meta { color: #666; font-size: 14px; }
    .summary-box {
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      border-radius: 12px;
      padding: 20px;
      margin-top: 15px;
      font-size: 16px;
      line-height: 1.6;
      color: #333;
    }
    .topics-container { margin-top: 15px; display: flex; flex-wrap: wrap; gap: 8px; }
    .topic-tag {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 14px;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
    }
    .card h2 {
      font-size: 20px;
      color: #1a1a2e;
      margin-bottom: 20px;
    }
    .key-point-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      background: #f8f9fa;
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .key-point-number {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      flex-shrink: 0;
    }
    .key-point-text { font-size: 15px; line-height: 1.5; color: #333; }
    .action-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: #fff3cd;
      border-radius: 8px;
      margin-bottom: 10px;
      border-left: 4px solid #ffc107;
    }
    .action-checkbox { width: 20px; height: 20px; cursor: pointer; }
    .action-text { font-size: 15px; color: #333; }
    .footer { text-align: center; color: rgba(255, 255, 255, 0.8); font-size: 14px; padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${session.title}</h1>
      <div class="meta">生成时间：${genTime}</div>
      <div class="summary-box">
        <strong>摘要：</strong>${analysis.summary || '暂无摘要'}
      </div>
      ${topicsHtml ? `<div class="topics-container">${topicsHtml}</div>` : ''}
    </div>
    <div class="card">
      <h2>关键要点</h2>
      ${keyPointsHtml || '<p>暂无关键要点</p>'}
    </div>
    <div class="card">
      <h2>待办事项</h2>
      ${actionItemsHtml || '<p>暂无待办事项</p>'}
    </div>
    <div class="footer">会议分析报告 · 由 Hermes Agent 生成</div>
  </div>
</body>
</html>`

  htmlContent.value = html
  meetingStore.updateHtmlContent(session.id, html)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// --- 可视化 ---
const canvasRef = ref<HTMLCanvasElement | null>(null)

function drawWaveform() {
  const canvas = canvasRef.value
  if (!canvas || !analyser) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.width
  const height = canvas.height
  const bufferLength = analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)

  function draw() {
    animationFrameId = requestAnimationFrame(draw)
    analyser!.getByteFrequencyData(dataArray)

    if (!ctx) return
    
    ctx.fillStyle = 'rgb(15, 23, 42)'
    ctx.fillRect(0, 0, width, height)

    const barWidth = (width / bufferLength) * 2.5
    let x = 0

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * height * 0.8

      const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height)
      gradient.addColorStop(0, '#8b5cf6')
      gradient.addColorStop(1, '#6366f1')

      ctx.fillStyle = gradient
      ctx.fillRect(x, height - barHeight, barWidth, barHeight)

      x += barWidth + 1
    }
  }

  draw()
}

// --- 分析功能 ---
async function startAnalysis() {
  const session = meetingStore.activeSession
  if (!session) return
  
  // Hermes Agent 模式下不使用后端自动分析
  if (session.analysisMode === 'hermes') {
    isAnalyzing.value = true
    errorMessage.value = ''
    // Hermes Agent 模式下，用户手动触发分析
    return
  }
  
  // 自定义模型模式下，调用后端自动分析
  try {
    isAnalyzing.value = true
    const response = await fetch(`${API_BASE}/api/analysis/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: analysisInterval.value }),
    })
    const result = await response.json()
    console.log('Analysis started:', result)

    // 开始轮询结果
    pollAnalysisResult()
  } catch (error) {
    console.error('Failed to start analysis:', error)
    errorMessage.value = t('meeting.analysisStartError')
  }
}

async function stopAnalysis() {
  const session = meetingStore.activeSession
  if (!session) return
  
  isAnalyzing.value = false
  
  // 自定义模型模式下，调用后端停止分析
  if (session.analysisMode === 'custom') {
    try {
      await fetch(`${API_BASE}/api/analysis/stop`, { method: 'POST' })
    } catch (error) {
      console.error('Failed to stop analysis:', error)
    }
  }
}

async function triggerAnalysis() {
  const session = meetingStore.activeSession
  if (!session) return
  
  // 根据分析模式选择分析方式
  if (session.analysisMode === 'hermes') {
    await analyzeWithHermesAgent()
  } else {
    // 使用自定义模型分析（通过 meeting_asr_cloud 后端）
    try {
      isLoading.value = true
      const response = await fetch(`${API_BASE}/api/analysis/trigger`, { method: 'POST' })
      const result = await response.json()
      console.log('Analysis triggered:', result)
      await pollAnalysisResult()
    } catch (error) {
      console.error('Failed to trigger analysis:', error)
      errorMessage.value = t('meeting.analysisError')
    } finally {
      isLoading.value = false
    }
  }
}

async function pollAnalysisResult() {
  try {
    const response = await fetch(`${API_BASE}/api/analysis/result`)
    if (response.ok) {
      const result = await response.json()
      if (result) {
        analysisResult.value = result
      }
    }
  } catch (error) {
    console.error('Failed to fetch analysis result:', error)
  }
}

async function clearTranscript() {
  try {
    await fetch(`${API_BASE}/api/transcript/clear`, { method: 'POST' })
  } catch (error) {
    console.error('Failed to clear transcript on backend:', error)
  }
  finalSentences.value = []
  partialText.value = ''
  analysisResult.value = null
  htmlContent.value = ''
  showReport.value = false
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 清空 store 中的数据
  if (meetingStore.activeSessionId) {
    meetingStore.clearSession(meetingStore.activeSessionId)
  }
}
</script>

<template>
  <div class="meeting-view">
    <!-- 左侧边栏背景遮罩 -->
    <div
      class="sidebar-backdrop"
      :class="{ active: showSidebar }"
      @click="showSidebar = false"
    />

    <!-- 左侧边栏 -->
    <aside class="meeting-sidebar" :class="{ collapsed: !showSidebar }">
      <div v-if="showSidebar" class="page-sidebar-top">
        <PageSidebarNav
          active="meeting"
          :primary-label="t('meeting.newMeeting')"
          @primary="openCreateModal"
        />
        <div class="meeting-list">
          <div v-if="meetingStore.sortedSessions.length === 0" class="meeting-list-empty">
            {{ t('meeting.noMeetings') }}
          </div>
          <button
            v-for="session in meetingStore.sortedSessions"
            :key="session.id"
            class="meeting-list-item"
            :class="{ active: session.id === meetingStore.activeSessionId }"
            @click="loadMeeting(session)"
          >
            <div class="meeting-item-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
                <path d="M8 12l3 3 5-5"/>
              </svg>
            </div>
            <div class="meeting-item-content">
              <div class="meeting-item-title">{{ session.title }}</div>
              <div class="meeting-item-meta">
                {{ new Date(session.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}
                · {{ session.sentences.length }} {{ t('meeting.sentences') }}
                <span v-if="session.analysisResult" class="meeting-item-badge">AI</span>
              </div>
            </div>
            <NPopconfirm @positive-click.stop="deleteMeeting(session.id)">
              <template #trigger>
                <button
                  class="meeting-item-delete"
                  @click.stop
                  :title="t('common.delete')"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </template>
              {{ t('meeting.deleteConfirm') }}
            </NPopconfirm>
          </button>
        </div>
      </div>
      <PageSidebarFooter v-if="showSidebar" />
    </aside>

    <!-- 主内容区 -->
    <div class="meeting-main">
      <!-- 顶部标题栏 -->
      <div class="meeting-header">
        <div class="meeting-title">
          <button
            class="header-avatar-toggle"
            @click="showSidebar = !showSidebar"
            :title="showSidebar ? t('sidebar.collapse') : t('sidebar.expand')"
          >
            <img src="/logo.png" alt="QuantHermes" class="header-logo" />
          </button>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
            <path d="M8 12l3 3 5-5"/>
          </svg>
          <h1>{{ t('meeting.title') }}</h1>
        </div>
        <div class="meeting-controls">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                size="small"
                :type="useDiarize ? 'primary' : 'default'"
                @click="useDiarize = !useDiarize"
                :disabled="isRecording"
              >
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                </template>
                {{ t('meeting.diarize') }}
              </NButton>
            </template>
            {{ t('meeting.diarizeHint') }}
          </NTooltip>

          <NSelect
            v-if="useDiarize"
            v-model:value="speakerCount"
            :options="speakerCountOptions"
            size="small"
            style="width: 120px"
            :disabled="isRecording"
            :placeholder="t('meeting.speakerCount')"
          />

          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                size="small"
                type="error"
                @click="clearTranscript"
                :disabled="isRecording || sentences.length === 0"
              >
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </template>
                {{ t('meeting.clear') }}
              </NButton>
            </template>
            {{ t('meeting.clearHint') }}
          </NTooltip>
        </div>
      </div>

      <!-- 主内容区 -->
      <div class="meeting-content">
      <!-- 左侧：转写区域 -->
      <div class="transcript-panel">
        <!-- 可视化区域 -->
        <div class="waveform-container">
          <canvas ref="canvasRef" width="600" height="100"></canvas>
          <div v-if="isConnecting" class="connecting-overlay">
            <NSpin size="small" />
            <span>{{ t('meeting.connecting') }}</span>
          </div>
        </div>

        <!-- 状态栏 -->
        <div class="status-bar">
          <div class="status-indicator" :class="{ active: isRecording }">
            <span class="status-dot"></span>
            <span>{{ statusText || t('meeting.idle') }}</span>
          </div>
          <div v-if="errorMessage" class="error-message">
            {{ errorMessage }}
          </div>
          <div class="status-actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <button
                  class="panel-toggle-btn"
                  :class="{ active: showRightPanel }"
                  @click="showRightPanel = !showRightPanel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="15" y1="3" x2="15" y2="21"/>
                  </svg>
                </button>
              </template>
              {{ showRightPanel ? t('meeting.hidePanel') : t('meeting.showPanel') }}
            </NTooltip>
          </div>
        </div>

        <!-- 转写内容 -->
        <div id="transcript-container" class="transcript-content">
          <div v-if="sentences.length === 0 && !partialText" class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
              <path d="M8 12l3 3 5-5"/>
            </svg>
            <p>{{ t('meeting.emptyState') }}</p>
          </div>

          <div 
            v-for="(sentence, index) in sentences" 
            :key="index" 
            :data-index="index"
            class="sentence-item"
            :class="{ 
              highlighted: highlightedSentenceIndex === index,
              clickable: sentence.startTime && !isRecording
            }"
            @click="sentence.startTime && !isRecording ? seekToSentence(index) : undefined"
          >
            <span class="sentence-index">{{ index + 1 }}</span>
            <div class="sentence-body">
              <NPopover
                v-if="sentence.speakerId"
                trigger="click"
                placement="top"
                :show="renamingKey === `${sentence.speakerId}:${index}`"
                @update:show="(val: boolean) => { if (!val) cancelRenameSpeaker() }"
              >
                <template #trigger>
                  <span 
                    class="sentence-speaker"
                    @click.stop="startRenameSpeaker(sentence.speakerId, index)"
                    :title="t('meeting.renameSpeaker')"
                  >
                    {{ sentence.speaker }}
                  </span>
                </template>
                <div class="speaker-rename-popover">
                  <div class="speaker-rename-title">{{ t('meeting.renameSpeaker') }}</div>
                  <NInput
                    v-model:value="renameInput"
                    size="small"
                    :placeholder="t('meeting.speakerPlaceholder')"
                    @keyup.enter="confirmRenameSpeaker"
                    autofocus
                  />
                  <div class="speaker-rename-actions">
                    <NButton size="tiny" @click="cancelRenameSpeaker">{{ t('common.cancel') }}</NButton>
                    <NButton size="tiny" type="primary" @click="confirmRenameSpeaker">{{ t('common.confirm') }}</NButton>
                  </div>
                </div>
              </NPopover>
              <span class="sentence-text">{{ sentence.text }}</span>
            </div>
          </div>

          <div v-if="partialText" class="partial-text">
            <span class="partial-indicator">{{ t('meeting.partial') }}</span>
            {{ partialText }}
          </div>
        </div>

        <!-- 录音按钮 -->
        <div class="record-button-container">
          <button
            class="record-button"
            :class="{ recording: isRecording, connecting: isConnecting }"
            @click="isRecording ? stopRecording() : startRecording()"
            :disabled="isConnecting"
          >
            <svg v-if="!isRecording && !isConnecting" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <svg v-else-if="isRecording" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <NSpin v-else size="small" />
          </button>
          <span class="record-label">
            {{ isRecording ? t('meeting.stop') : (isConnecting ? t('meeting.connecting') : t('meeting.start')) }}
          </span>
        </div>
      </div>

      <!-- 右侧：分析面板（可调整大小） -->
      <aside
        v-if="showRightPanel"
        class="right-panel"
        :style="rightPanelStyle"
      >
        <div
          class="right-panel-resize-handle"
          @pointerdown="startRightPanelResize"
        />
        <div class="right-panel-inner">
          <div class="right-panel-header">
            <h2>{{ t('meeting.analysis') }}</h2>
            <div class="right-panel-actions">
              <NButton
                size="tiny"
                :type="isAnalyzing ? 'warning' : 'primary'"
                @click="isAnalyzing ? stopAnalysis() : startAnalysis()"
              >
                {{ isAnalyzing ? t('meeting.stopAnalysis') : t('meeting.startAnalysis') }}
              </NButton>
              <NButton
                size="tiny"
                @click="triggerAnalysis"
                :loading="isLoading"
                :disabled="sentences.length === 0"
              >
                {{ t('meeting.triggerAnalysis') }}
              </NButton>
              <button
                class="panel-close-btn"
                @click="showRightPanel = false"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- 分析结果 -->
          <div v-if="analysisResult" class="right-panel-content">
            <!-- 音频播放和下载 -->
            <div v-if="audioUrl" class="audio-section">
              <div class="audio-player">
                <button class="audio-play-btn" @click="togglePlayPause()">
                  <svg v-if="!isPlaying" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                  <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                  </svg>
                </button>
                <div class="audio-info">
                  <span class="audio-time">{{ formatDuration(playbackTime) }}</span>
                  <div class="progress-track" @click="seekToPosition" @mousedown="startProgressDrag">
                    <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
                    <div class="progress-thumb" :style="{ left: progressPercent + '%' }"></div>
                  </div>
                  <span class="audio-time">{{ formatDuration(playbackDuration) }}</span>
                </div>
              </div>
              <div class="audio-actions">
                <NButton size="tiny" @click="downloadAudio" :disabled="isRecording">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadAudio') }}
                </NButton>
                <NButton size="tiny" @click="downloadTranscript" :disabled="isRecording">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadTranscript') }}
                </NButton>
                <NButton size="tiny" @click="downloadJson" :disabled="isRecording">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadJson') }}
                </NButton>
              </div>
            </div>

            <div v-if="analysisResult.summary" class="result-section">
              <h3>{{ t('meeting.summary') }}</h3>
              <p>{{ analysisResult.summary }}</p>
            </div>

            <div v-if="analysisResult.key_points?.length" class="result-section">
              <h3>{{ t('meeting.keyPoints') }}</h3>
              <ul>
                <li v-for="(point, i) in analysisResult.key_points" :key="i">{{ point }}</li>
              </ul>
            </div>

            <div v-if="analysisResult.action_items?.length" class="result-section">
              <h3>{{ t('meeting.actionItems') }}</h3>
              <ul class="action-list">
                <li v-for="(item, i) in analysisResult.action_items" :key="i">
                  <input type="checkbox" />
                  <span>{{ item }}</span>
                </li>
              </ul>
            </div>

            <div v-if="analysisResult.topics?.length" class="result-section">
              <h3>{{ t('meeting.topics') }}</h3>
              <div class="topic-tags">
                <NTag v-for="(topic, i) in analysisResult.topics" :key="i" type="info" size="small">
                  {{ topic }}
                </NTag>
              </div>
            </div>

            <div class="result-section result-actions">
              <NButton type="primary" @click="showReport = true" block size="small" :disabled="!htmlContent">
                {{ t('meeting.viewReport') }}
              </NButton>
              <NButton v-if="htmlContent" @click="downloadReport" block size="small">
                {{ t('meeting.downloadReport') }}
              </NButton>
            </div>
          </div>

          <div v-else class="right-panel-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            <p>{{ t('meeting.analysisEmpty') }}</p>
          </div>
        </div>
      </aside>
      </div>
    </div>

    <!-- 创建会议对话框 -->
    <NModal
      v-model:show="showCreateModal"
      preset="card"
      :title="t('meeting.createMeeting')"
      :style="{ width: '520px' }"
      :bordered="false"
      :mask-closable="false"
    >
      <div class="create-meeting-form">
        <div class="form-item">
          <label class="form-label">{{ t('meeting.meetingName') }}</label>
          <NInput
            v-model:value="newMeetingTitle"
            :placeholder="t('meeting.meetingNamePlaceholder')"
            maxlength="50"
          />
        </div>

        <div class="form-section">
          <div class="form-section-title">{{ t('meeting.asrConfig') }}</div>
          <div class="form-item">
            <label class="form-label">
              {{ t('meeting.dashscopeApiKey') }}
              <span v-if="meetingStore.hasASRConfig" class="form-label-badge">{{ t('meeting.configured') }}</span>
            </label>
            <NInput
              v-model:value="asrApiKey"
              type="password"
              show-password-on="click"
              :placeholder="meetingStore.hasASRConfig ? t('meeting.apiKeySaved') : t('meeting.dashscopeApiKeyPlaceholder')"
            />
            <div class="form-hint">{{ t('meeting.dashscopeApiKeyHint') }}</div>
          </div>
        </div>
        
        <div class="form-section">
          <div class="form-section-title">{{ t('meeting.analysisMode') }}</div>
          <NRadioGroup v-model:value="newMeetingAnalysisMode">
            <NRadio value="hermes">
              <div class="radio-content">
                <span class="radio-title">{{ t('meeting.hermesAgent') }}</span>
                <span class="radio-desc">{{ t('meeting.hermesAgentDesc') }}</span>
              </div>
            </NRadio>
            <NRadio value="custom">
              <div class="radio-content">
                <span class="radio-title">{{ t('meeting.customModel') }}</span>
                <span class="radio-desc">{{ t('meeting.customModelDesc') }}</span>
              </div>
            </NRadio>
          </NRadioGroup>
        </div>

        <div v-if="newMeetingAnalysisMode === 'hermes'" class="form-item">
          <label class="form-label">{{ t('meeting.selectProfile') }}</label>
          <NSelect
            v-model:value="newMeetingHermesProfile"
            :options="profileOptions"
            :placeholder="t('meeting.selectProfilePlaceholder')"
          />
        </div>

        <template v-if="newMeetingAnalysisMode === 'custom'">
          <div class="form-item">
            <label class="form-label">{{ t('meeting.selectProvider') }}</label>
            <NSelect
              v-model:value="newMeetingCustomProvider"
              :options="providerOptions"
              :placeholder="t('meeting.selectProviderPlaceholder')"
              @update:value="newMeetingCustomModel = ''"
            />
          </div>
          <div v-if="newMeetingCustomProvider" class="form-item">
            <label class="form-label">{{ t('meeting.selectModel') }}</label>
            <NSelect
              v-model:value="newMeetingCustomModel"
              :options="modelOptions"
              :placeholder="t('meeting.selectModelPlaceholder')"
            />
          </div>
        </template>
      </div>
      
      <template #action>
        <NButton @click="showCreateModal = false">{{ t('common.cancel') }}</NButton>
        <NButton
          type="primary"
          :disabled="!newMeetingTitle.trim() || !asrApiKey.trim() && !meetingStore.hasASRConfig || (newMeetingAnalysisMode === 'custom' && !newMeetingCustomModel)"
          @click="handleCreateMeeting"
        >
          {{ t('meeting.create') }}
        </NButton>
      </template>
    </NModal>

    <!-- HTML 报告弹窗 -->
    <div v-if="showReport" class="report-modal" @click.self="showReport = false">
      <div class="report-container">
        <div class="report-header">
          <h2>{{ t('meeting.report') }}</h2>
          <button class="close-button" @click="showReport = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <iframe :srcdoc="htmlContent" class="report-iframe"></iframe>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.meeting-view {
  display: flex;
  height: calc(100 * var(--vh));
  background: $bg-primary;
  color: $text-primary;
  overflow: hidden;
}

// 左侧边栏样式
.sidebar-backdrop {
  display: none;

  @media (max-width: 768px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 99;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.meeting-sidebar {
  width: 260px;
  min-width: 260px;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid $border-color;
  background: $bg-card;
  overflow: hidden;
  transition: width 0.2s ease, min-width 0.2s ease;

  &.collapsed {
    width: 0;
    min-width: 0;
    border-right: none;
  }

  @media (max-width: 768px) {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 100;
    transform: translateX(-100%);
    transition: transform 0.2s ease;

    &:not(.collapsed) {
      transform: translateX(0);
    }

    &.collapsed {
      width: 260px;
      min-width: 260px;
    }
  }
}

.page-sidebar-top {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 12px;
  gap: 8px;
}

.meeting-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meeting-list-empty {
  padding: 16px;
  text-align: center;
  color: $text-secondary;
  font-size: 13px;
}

.meeting-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.2s ease;
  text-align: left;
  width: 100%;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.meeting-item-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
}

.meeting-item-content {
  flex: 1;
  min-width: 0;
}

.meeting-item-title {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meeting-item-meta {
  font-size: 11px;
  color: $text-secondary;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.meeting-item-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba($accent-primary, 0.15);
  color: $accent-primary;
  font-size: 10px;
  font-weight: 600;
}

.meeting-item-delete {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s ease;

  .meeting-list-item:hover & {
    opacity: 1;
  }

  &:hover {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }
}

.meeting-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.header-avatar-toggle {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.2s ease;
  overflow: hidden;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
    transform: scale(1.05);
  }

  &:active {
    transform: scale(0.95);
  }
}

.header-logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.meeting-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  background: $bg-card;
  flex-shrink: 0;
}

.meeting-title {
  display: flex;
  align-items: center;
  gap: 8px;

  h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  svg {
    color: $accent-primary;
  }
}

.meeting-controls {
  display: flex;
  gap: 8px;
}

.meeting-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.transcript-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-right: 1px solid $border-color;
  min-width: 0;
}

.waveform-container {
  height: 100px;
  background: rgb(15, 23, 42);
  position: relative;
  overflow: hidden;

  canvas {
    width: 100%;
    height: 100%;
  }

  .connecting-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(0, 0, 0, 0.5);
    color: white;
    font-size: 14px;
  }
}

.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background: $bg-card;
}

.status-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-toggle-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.1);
    color: $accent-primary;
  }

  &.active {
    color: $accent-primary;
  }
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: $text-secondary;

  &.active {
    color: $accent-primary;

    .status-dot {
      background: #ef4444;
      animation: pulse 1.5s infinite;
    }
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: $text-secondary;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.error-message {
  color: #ef4444;
  font-size: 12px;
}

.transcript-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: $text-secondary;

  p {
    font-size: 14px;
  }
}

.sentence-item {
  display: flex;
  gap: 12px;
  padding: 8px;
  border-bottom: 1px solid rgba($border-color, 0.5);
  border-radius: 4px;
  transition: background-color 0.2s ease;

  &:last-child {
    border-bottom: none;
  }

  &.highlighted {
    background: rgba($accent-primary, 0.15);
    border-left: 3px solid $accent-primary;
  }

  &.clickable {
    cursor: pointer;

    &:hover {
      background: rgba($accent-primary, 0.06);
    }
  }
}

.sentence-index {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
}

.sentence-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.sentence-speaker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  width: fit-content;

  &:hover {
    background: rgba($accent-primary, 0.2);
  }
}

.sentence-text {
  font-size: 14px;
  line-height: 1.6;
}

.speaker-rename-popover {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}

.speaker-rename-title {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
}

.speaker-rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.partial-text {
  padding: 8px 0;
  color: $text-secondary;
  font-style: italic;
  font-size: 14px;
}

.partial-indicator {
  display: inline-block;
  padding: 2px 6px;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 4px;
  font-size: 11px;
  font-style: normal;
  margin-right: 8px;
}

.record-button-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
  gap: 8px;
}

.record-button {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: none;
  background: $accent-primary;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  box-shadow: 0 4px 12px rgba($accent-primary, 0.3);

  &:hover:not(:disabled) {
    transform: scale(1.05);
    box-shadow: 0 6px 16px rgba($accent-primary, 0.4);
  }

  &:active:not(:disabled) {
    transform: scale(0.95);
  }

  &.recording {
    background: #ef4444;
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
    animation: pulse-button 1.5s infinite;
  }

  &.connecting {
    opacity: 0.7;
    cursor: not-allowed;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

@keyframes pulse-button {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.record-label {
  font-size: 12px;
  color: $text-secondary;
}

// 右侧面板样式
.right-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 280px;
  max-width: 100%;
  background: $bg-card;
  border-left: 1px solid $border-color;
  display: flex;
  min-height: 0;
  overflow: visible;
}

.right-panel-resize-handle {
  position: absolute;
  left: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    left: 6px;
    top: 0;
    bottom: 0;
    width: 1px;
    background:
      linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    transition: background $transition-fast;
    z-index: 1;
  }

  &::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 50%;
    width: 12px;
    height: 38px;
    transform: translateY(-50%);
    border-radius: 6px;
    background:
      linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
      $bg-card;
    border: 1px solid $border-color;
    opacity: 0.9;
    transition: all $transition-fast;
    z-index: 2;
  }

  &:hover::after {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) bottom / 1px calc(50% - 26px) no-repeat;
  }

  &:hover::before {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
      $bg-card;
    border-color: var(--accent-primary);
    opacity: 1;
  }
}

.right-panel-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.right-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;

  h2 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
}

.right-panel-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.panel-close-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }
}

.right-panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.right-panel-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: $text-secondary;
  padding: 40px;

  p {
    font-size: 14px;
    text-align: center;
  }
}

.result-section {
  margin-bottom: 20px;

  h3 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0 0 8px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  p {
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }

  ul {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 4px;
    }
  }
}

.action-list {
  list-style: none;
  padding: 0;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: rgba(255, 193, 7, 0.1);
    border-radius: 6px;
    margin-bottom: 8px;
    border-left: 3px solid #ffc107;

    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
  }
}

.topic-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

// 音频播放器样式
.audio-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  margin-bottom: 16px;
}

.audio-player {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.audio-play-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: $accent-primary;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;

  &:hover {
    transform: scale(1.05);
    opacity: 0.9;
  }
}

.audio-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.audio-time {
  font-size: 12px;
  color: $text-secondary;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.progress-track {
  flex: 1;
  height: 6px;
  background: rgba($border-color, 0.8);
  border-radius: 3px;
  position: relative;
  cursor: pointer;
  transition: height 0.15s ease;

  &:hover {
    height: 8px;

    .progress-thumb {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, $accent-primary, rgba($accent-primary, 0.8));
  border-radius: 3px;
  transition: width 0.1s linear;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.8);
  width: 14px;
  height: 14px;
  background: $accent-primary;
  border: 2px solid white;
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  opacity: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
  pointer-events: none;
}

.audio-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.result-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.report-container {
  width: 100%;
  height: 100%;
  max-width: 1200px;
  max-height: 90vh;
  background: white;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.report-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;

  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: #1f2937;
  }
}

.close-button {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: #6b7280;

  &:hover {
    background: #f3f4f6;
  }
}

.report-iframe {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
}

// 创建会议对话框样式
.create-meeting-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}

.form-section-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 12px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-label-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
  font-size: 11px;
  font-weight: 600;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 14px;
  font-weight: 500;
  color: $text-primary;
}

.radio-desc {
  font-size: 12px;
  color: $text-secondary;
}
</style>
