<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NTag, NTooltip, NInput, NPopconfirm, NModal, NSelect, NRadio, NRadioGroup, NPopover, NSteps, NStep, NAlert } from 'naive-ui'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import MeetingAgentPanel from '@/components/hermes/meeting/MeetingAgentPanel.vue'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { MeetingSession, TranscriptSentence, AgentConfig } from '@/stores/hermes/meeting'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { useMessage } from '@/composables/useAppMessage'
import { meetingStorageApi } from '@/utils/meeting-storage-api'

const { t } = useI18n()
const message = useMessage()
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

// --- Agent 配置 ---
const newMeetingAgentType = ref<'hermes' | 'claude-code' | 'codex'>('hermes')
const newMeetingCodingAgentMode = ref<'scoped' | 'global'>('scoped')

// Agent 类型选项
const agentTypeOptions = computed(() => [
  { label: 'Hermes Agent', value: 'hermes', description: t('meeting.agentTypeHermesDesc') },
  { label: 'Claude Code', value: 'claude-code', description: t('meeting.agentTypeClaudeCodeDesc') },
  { label: 'Codex', value: 'codex', description: t('meeting.agentTypeCodexDesc') },
])

// Coding Agent 模式选项
const codingAgentModeOptions = computed(() => [
  { label: t('meeting.codingAgentModeScoped'), value: 'scoped', description: t('meeting.codingAgentModeScopedDesc') },
  { label: t('meeting.codingAgentModeGlobal'), value: 'global', description: t('meeting.codingAgentModeGlobalDesc') },
])

// --- ASR 配置 ---
const asrApiKey = ref(meetingStore.asrConfig.dashscopeApiKey)
const llmApiKey = ref(meetingStore.asrConfig.llmApiKey)
const llmBaseUrl = ref(meetingStore.asrConfig.llmBaseUrl)
const llmModel = ref(meetingStore.asrConfig.llmModel)
const asrWizardStep = ref(1) // 1=DashScope, 2=LLM, 3=Review

// --- OSS 配置（说话人分离模式必填）---
const ossBucket = ref(meetingStore.asrConfig.ossBucket)
const ossAccessKeyId = ref(meetingStore.asrConfig.ossAccessKeyId)
const ossAccessKeySecret = ref(meetingStore.asrConfig.ossAccessKeySecret)
const ossEndpoint = ref(meetingStore.asrConfig.ossEndpoint)
const ossPathPrefix = ref(meetingStore.asrConfig.ossPathPrefix)

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

const sentences = computed(() => finalSentences.value)

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
// WebSocket goes through the Node server proxy (/ws/asr, /ws/diarize) so the
// browser uses the same origin (wss://host:6060) — no Mixed Content, no
// self-signed cert issues. The proxy forwards plaintext to the Python backend.
const ASR_URL = '/ws/asr'
const DIARIZE_URL = '/ws/diarize'



// --- ASR 服务状态 ---
const asrServiceStatus = ref({
  isRunning: false,
  asrPort: null as number | null,
  diarizePort: null as number | null,
  pid: null as number | null,
  uptime: null as number | null,
  error: null as string | null,
})
const isStartingASR = ref(false)
const asrServiceError = ref('')

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

// --- Agent 分析相关 ---
const showAgentPanel = ref(false)
const agentStartAnalysisTrigger = ref(0)

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
  newMeetingAgentType.value = 'hermes'
  newMeetingCodingAgentMode.value = 'scoped'
  asrApiKey.value = meetingStore.asrConfig.dashscopeApiKey
  llmApiKey.value = meetingStore.asrConfig.llmApiKey
  llmBaseUrl.value = meetingStore.asrConfig.llmBaseUrl
  llmModel.value = meetingStore.asrConfig.llmModel
  ossBucket.value = meetingStore.asrConfig.ossBucket
  ossAccessKeyId.value = meetingStore.asrConfig.ossAccessKeyId
  ossAccessKeySecret.value = meetingStore.asrConfig.ossAccessKeySecret
  ossEndpoint.value = meetingStore.asrConfig.ossEndpoint
  ossPathPrefix.value = meetingStore.asrConfig.ossPathPrefix
  asrWizardStep.value = meetingStore.hasASRConfig && meetingStore.hasLLMConfig ? 3 : 1
  showCreateModal.value = true
}

function handleCreateMeeting() {
  if (!newMeetingTitle.value.trim()) return
  if (!asrApiKey.value.trim() && !meetingStore.hasASRConfig) return
  
  // 保存 ASR API Key（如果有更新）
  if (asrApiKey.value.trim()) {
    meetingStore.updateASRConfig({ dashscopeApiKey: asrApiKey.value.trim() })
  }
  // 保存 LLM 配置（可选 — 没填也不阻塞创建）
  if (llmApiKey.value.trim() || llmBaseUrl.value.trim() || llmModel.value.trim()) {
    meetingStore.updateASRConfig({
      llmApiKey: llmApiKey.value.trim(),
      llmBaseUrl: llmBaseUrl.value.trim() || 'https://api.deepseek.com',
      llmModel: llmModel.value.trim() || 'deepseek-chat',
    })
  }
  // 保存 OSS 配置（说话人分离用，可选）
  if (ossBucket.value.trim() || ossAccessKeyId.value.trim() || ossAccessKeySecret.value.trim()) {
    meetingStore.updateASRConfig({
      ossBucket: ossBucket.value.trim(),
      ossAccessKeyId: ossAccessKeyId.value.trim(),
      ossAccessKeySecret: ossAccessKeySecret.value.trim(),
      ossEndpoint: ossEndpoint.value.trim() || 'oss-cn-beijing.aliyuncs.com',
      ossPathPrefix: ossPathPrefix.value.trim() || 'meeting-asr-uploads/',
    })
  }
  
  // 构建 Agent 配置
  const agentConfig: AgentConfig = {
    agentType: newMeetingAgentType.value,
    codingAgentMode: newMeetingCodingAgentMode.value,
  }
  
  // 根据 Agent 类型设置配置
  if (newMeetingAgentType.value === 'hermes') {
    agentConfig.profile = newMeetingHermesProfile.value || 'default'
  } else {
    // Coding Agent (claude-code, codex)
    if (newMeetingCodingAgentMode.value === 'scoped') {
      agentConfig.provider = newMeetingCustomProvider.value
      agentConfig.model = newMeetingCustomModel.value
    }
  }
  
  meetingStore.createSession({
    title: newMeetingTitle.value.trim(),
    analysisMode: newMeetingAgentType.value === 'hermes' ? 'hermes' : 'custom',
    hermesProfile: newMeetingAgentType.value === 'hermes' ? (newMeetingHermesProfile.value || 'default') : undefined,
    customProvider: newMeetingAgentType.value !== 'hermes' && newMeetingCodingAgentMode.value === 'scoped' ? newMeetingCustomProvider.value : undefined,
    customModel: newMeetingAgentType.value !== 'hermes' && newMeetingCodingAgentMode.value === 'scoped' ? newMeetingCustomModel.value : undefined,
    agentConfig,
  })
  
  resetMeetingState()
  showCreateModal.value = false
}

async function loadMeeting(session: MeetingSession) {
  if (isRecording.value) {
    stopRecording()
  }
  meetingStore.setActiveSession(session.id)
  
  // 从服务器加载数据
  try {
    const serverData = await meetingStorageApi.getMeeting(session.id)
    if (serverData) {
      finalSentences.value = serverData.sentences || []
      analysisResult.value = serverData.analysisResult
      htmlContent.value = serverData.htmlContent || ''
      speakerMap.value = serverData.speakerMap || {}
      useDiarize.value = serverData.useDiarize || false
    } else {
      // 如果服务器没有数据，使用本地数据
      finalSentences.value = [...session.sentences]
      analysisResult.value = session.analysisResult
      htmlContent.value = session.htmlContent
      speakerMap.value = { ...session.speakerMap }
      useDiarize.value = session.useDiarize
    }
  } catch (err) {
    console.error('Failed to load meeting from server:', err)
    // 回退到本地数据
    finalSentences.value = [...session.sentences]
    analysisResult.value = session.analysisResult
    htmlContent.value = session.htmlContent
    speakerMap.value = { ...session.speakerMap }
    useDiarize.value = session.useDiarize
  }
  
  partialText.value = ''
  errorMessage.value = ''
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 加载音频数据
  await loadAudioForSession(session.id)
}

async function loadAudioForSession(sessionId: string) {
  try {
    // 从服务器加载音频
    const blob = await meetingStorageApi.downloadAudio(sessionId)
    if (blob) {
      audioBlob.value = blob
      audioUrl.value = URL.createObjectURL(blob)
      return
    }
  } catch (err) {
    console.error('Failed to load audio from server:', err)
  }
  
  // 回退到 IndexedDB
  const blob = await meetingStore.getAudioBlob(sessionId)
  if (blob) {
    audioBlob.value = blob
    audioUrl.value = URL.createObjectURL(blob)
  } else {
    audioBlob.value = null
    audioUrl.value = ''
  }
}

async function deleteMeeting(id: string) {
  try {
    // 删除服务器端数据
    await meetingStorageApi.deleteMeeting(id)
  } catch (err) {
    console.error('Failed to delete meeting from server:', err)
  }
  
  // 删除本地数据
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

async function saveCurrentMeeting() {
  if (!meetingStore.activeSessionId) return
  
  const sessionData = {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
    status: isRecording.value ? 'recording' as const : 'completed' as const,
  }
  
  // 保存到本地 store
  meetingStore.updateSession(meetingStore.activeSessionId, sessionData)
  
  // 保存到服务器
  try {
    const meetingId = meetingStore.activeSessionId
    const meeting = meetingStore.activeSession
    
    if (meeting) {
      await meetingStorageApi.saveMeeting(meetingId, {
        ...meeting,
        ...sessionData,
      })
      
      // 保存转写内容
      if (finalSentences.value.length > 0) {
        await meetingStorageApi.saveTranscript(meetingId, finalSentences.value)
      }
    }
  } catch (err) {
    console.error('Failed to save meeting to server:', err)
  }
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

// --- ASR 服务管理 ---
async function checkASRServiceStatus() {
  try {
    const status = await meetingASRApi.getStatus()
    asrServiceStatus.value = status
    return status
  } catch (err) {
    console.error('Failed to check ASR service status:', err)
    return null
  }
}

async function startASRService() {
  const hasOSS = meetingStore.asrConfig.ossBucket || meetingStore.asrConfig.ossAccessKeyId || meetingStore.asrConfig.ossAccessKeySecret
  if (asrServiceStatus.value.isRunning && !hasOSS) return true

  isStartingASR.value = true
  asrServiceError.value = ''

  try {
    // Get ASR config from meeting store
    const config: Record<string, unknown> = {
      dashscopeApiKey: meetingStore.asrConfig.dashscopeApiKey || asrApiKey.value,
    }
    // Pass LLM config if user provided it, so backend has it from the start.
    if (meetingStore.asrConfig.llmApiKey || llmApiKey.value) {
      config.llmApiKey = meetingStore.asrConfig.llmApiKey || llmApiKey.value
      config.llmBaseUrl = meetingStore.asrConfig.llmBaseUrl || llmBaseUrl.value
      config.llmModel = meetingStore.asrConfig.llmModel || llmModel.value
    }
    // Pass OSS config if user configured it (speaker diarization chunk flow).
    const store = meetingStore.asrConfig
    if (store.ossBucket || store.ossAccessKeyId || store.ossAccessKeySecret) {
      config.ossBucket = store.ossBucket
      config.ossAccessKeyId = store.ossAccessKeyId
      config.ossAccessKeySecret = store.ossAccessKeySecret
      config.ossEndpoint = store.ossEndpoint
      config.ossPathPrefix = store.ossPathPrefix
    }

    console.log('[meeting] Calling ASR start API with config:', { ...config, dashscopeApiKey: config.dashscopeApiKey ? '***' : 'not set' })
    const result = await meetingASRApi.start(config)
    console.log('[meeting] ASR start result:', result)

    if (result.status === 'started' || result.status === 'already_running') {
      asrServiceStatus.value = {
        isRunning: true,
        asrPort: result.asrPort,
        diarizePort: result.diarizePort,
        pid: result.pid,
        uptime: result.uptime,
        error: null,
      }
      return true
    } else {
      asrServiceError.value = result.error || 'Failed to start ASR service'
      console.error('[meeting] ASR service failed to start:', asrServiceError.value)
      return false
    }
  } catch (err: any) {
    asrServiceError.value = err.message || 'Failed to start ASR service'
    console.error('[meeting] ASR service start error:', err)
    return false
  } finally {
    isStartingASR.value = false
  }
}

// --- 生命周期 ---
onMounted(async () => {
  // 加载模型和配置
  await profilesStore.fetchProfiles()
  await modelsStore.fetchProviders()
  
  // 检查 ASR 服务状态
  await checkASRServiceStatus()
  
  // 如果有活跃会议，加载它
  if (meetingStore.activeSession) {
    loadMeeting(meetingStore.activeSession)
  }
  // 不再默认打开新建会议弹窗，用户需要点击"新建会议"按钮
})

onUnmounted(() => {
  stopRecording()
  stopAnalysis()
  // Note: We don't stop the ASR service on unmount as it should persist across page navigations
})

// --- 麦克风检测（仅做浏览器兼容性检查，不阻断 getUserMedia） ---
async function checkMicrophoneAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    // 某些浏览器在 HTTP 非安全上下文中直接隐藏 navigator.mediaDevices，
    // 此时应提示 HTTPS 访问而非"浏览器不支持"，给用户一条可操作的路径。
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return { available: false, reason: 'micInsecureContext' }
    }
    return { available: false, reason: 'micUnsupported' }
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const hasAudioInput = devices.some(d => d.kind === 'audioinput')
    if (hasAudioInput) return { available: true }
  } catch {
    // enumerateDevices 失败不阻断，让 getUserMedia 自己处理
  }

  // enumerateDevices 在 HTTP 局域网 IP 下可能返回空数组
  // 不做硬阻断，继续走 getUserMedia，让浏览器弹出权限请求或抛出 NotFoundError
  return { available: true }
}

// --- 音频处理 ---
async function startRecording() {
  try {
    errorMessage.value = ''
    isConnecting.value = true
    statusText.value = t('meeting.connecting')

    // 第 1 阶段：麦克风检测
    const micCheck = await checkMicrophoneAvailability()
    if (!micCheck.available) {
      errorMessage.value = t(`meeting.${micCheck.reason}`)
      isConnecting.value = false
      return
    }

    // 检查并启动 ASR 服务
    if (!asrServiceStatus.value.isRunning) {
      statusText.value = t('meeting.startingASRService')
      console.log('[meeting] Starting ASR service...')
      const started = await startASRService()
      if (!started) {
        const errorMsg = asrServiceError.value || t('meeting.asrServiceStartError')
        console.error('[meeting] Failed to start ASR service:', errorMsg)
        errorMessage.value = errorMsg
        isConnecting.value = false
        return
      }
      console.log('[meeting] ASR service started, ports:', asrServiceStatus.value.asrPort, asrServiceStatus.value.diarizePort)
      
      // 等待服务完全就绪并验证
      statusText.value = t('meeting.connecting')
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // 验证服务是否真的启动了
      try {
        const healthCheck = await meetingASRApi.healthCheck()
        console.log('[meeting] ASR service health check:', healthCheck)
        if (healthCheck.status !== 'ok') {
          throw new Error('ASR service health check failed')
        }
      } catch (err) {
        console.error('[meeting] ASR service health check failed:', err)
        errorMessage.value = t('meeting.asrServiceStartError')
        isConnecting.value = false
        return
      }
    }

    // 获取麦克风权限。
    // 注意：sampleRate 和 channelCount 不在此处约束（精确约束会触发 NotReadableError），
    // 而是在下游 worklet handler 中做重采样到 16kHz / 转 Int16。
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
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

    // AudioWorklet 替代 deprecated ScriptProcessorNode，跑在 audio 线程不抢主线程。
    // JS 副本在 public/audio/pcm-worklet.js（源文件 src/audio/pcm-worklet.ts）。
    await audioContext.audioWorklet.addModule('/audio/pcm-worklet.js')
    const pcmNode = new AudioWorkletNode(audioContext, 'pcm-processor')
    source.connect(analyser)
    analyser.connect(pcmNode)
    // 注意：worklet node 不能 connect 到 destination（会回声）。仅做 passthrough 处理。

    // 开始录制音频用于保存。timeslice=1000ms 切分，避免长会议占满内存。
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
    console.log('[meeting] Connecting to WebSocket:', wsUrl)
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

    // 处理音频数据：通过 AudioWorklet 接收 Float32 buffer，主线程 resample + Int16 转换
    pcmNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sourceSampleRate: number }>) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const { samples, sourceSampleRate } = event.data

      // 重采样到 16000 Hz（如果需要）
      let resampledData: Float32Array
      if (sourceSampleRate !== 16000) {
        const ratio = sourceSampleRate / 16000
        const newLength = Math.round(samples.length / ratio)
        resampledData = new Float32Array(newLength)
        for (let i = 0; i < newLength; i++) {
          resampledData[i] = samples[Math.round(i * ratio)]
        }
      } else {
        resampledData = samples
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
    console.error('[meeting] Failed to start recording:', error)

    // 按 DOMException.name 区分错误类型
    switch (error.name) {
      case 'NotFoundError':
        errorMessage.value = t('meeting.micNotFound')
        break
      case 'NotAllowedError':
        errorMessage.value = window.isSecureContext
          ? t('meeting.micPermissionDenied')
          : t('meeting.micInsecureContext')
        break
      case 'NotReadableError':
        errorMessage.value = t('meeting.micPermissionDenied')
        break
      default:
        errorMessage.value = error.message || t('meeting.microphoneError')
    }
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
    if (!useDiarize.value) {
      // 非说话人分离模式：主 ASR 已在录音过程中流式返回结果，500ms 后安全关闭
      setTimeout(() => ws?.close(), 500)
    }
    // 说话人分离模式：不主动关闭，等服务器处理完 PCM 后发回 transcript + stopped
    // 由 handleWsMessage('stopped') 中的 stopRecording() 关闭
  }
  if (!useDiarize.value) ws = null

  // 停止音频 + 关闭 worklet
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close().catch(() => { /* best effort */ })
    audioContext = null
  }
  analyser = null

  // 保存音频数据
  if (audioChunks.value.length > 0 && meetingStore.activeSessionId) {
    audioBlob.value = new Blob(audioChunks.value, { type: 'audio/webm' })
    audioUrl.value = URL.createObjectURL(audioBlob.value)
    
    // 保存会议数据
    saveCurrentMeeting()
    
    // 保存音频到服务器
    const meetingId = meetingStore.activeSessionId
    meetingStorageApi.uploadAudio(meetingId, audioBlob.value)
      .then(() => console.log('Audio saved to server'))
      .catch(err => {
        console.error('Failed to save audio to server:', err)
        message.error(t('meeting.errorUploadAudioFailed'))
      })
    
    // 同时保存到 IndexedDB 作为备份（直接存 Blob，避免 base64 编码 33% 膨胀）
    meetingStore.saveAudioData(meetingId, audioBlob.value)
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
      // 说话人分离模式下，服务器已处理完 PCM 并回传结果，关闭 WS
      if (ws) { ws.close(); ws = null }
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

async function downloadAudio() {
  if (!meetingStore.activeSessionId) return
  
  try {
    // 尝试从服务器下载
    const blob = await meetingStorageApi.downloadAudio(meetingStore.activeSessionId)
    if (blob) {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${meetingStore.activeSession?.title || 'meeting'}.webm`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
  } catch (err) {
    console.error('Failed to download audio from server:', err)
  }
  
  // 回退到本地 blob
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

async function downloadTranscript() {
  if (!meetingStore.activeSessionId || !meetingStore.activeSession) return
  
  try {
    // 尝试从服务器下载
    const sentences = await meetingStorageApi.getTranscript(meetingStore.activeSessionId)
    if (sentences && sentences.length > 0) {
      const content = sentences.map((s: any, i: number) => {
        const time = s.startTime ? formatDuration(s.startTime / 1000) : new Date(s.timestamp).toLocaleTimeString('zh-CN')
        const speaker = s.speaker ? `[${s.speaker}] ` : ''
        return `${i + 1}. ${time} ${speaker}${s.text}`
      }).join('\n')
      
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${meetingStore.activeSession.title || 'meeting'}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
  } catch (err) {
    console.error('Failed to download transcript from server:', err)
  }
  
  // 回退到本地数据
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

async function downloadJson() {
  if (!meetingStore.activeSessionId || !meetingStore.activeSession) return
  
  try {
    // 尝试从服务器下载
    const data = await meetingStorageApi.downloadJsonReport(meetingStore.activeSessionId)
    if (data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${meetingStore.activeSession.title || 'meeting'}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
  } catch (err) {
    console.error('Failed to download JSON from server:', err)
  }
  
  // 回退到本地数据
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

async function downloadReport() {
  if (!meetingStore.activeSessionId) return
  
  try {
    // 尝试从服务器下载
    const html = await meetingStorageApi.downloadHtmlReport(meetingStore.activeSessionId)
    if (html) {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${meetingStore.activeSession?.title || 'meeting'}_report.html`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
  } catch (err) {
    console.error('Failed to download report from server:', err)
  }
  
  // 回退到本地数据
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

// --- Agent 面板事件处理 ---
function onAgentAnalysisResult(result: any) {
  analysisResult.value = result
  // 保存到 store
  if (meetingStore.activeSessionId) {
    meetingStore.updateAnalysis(meetingStore.activeSessionId, result)
  }
}

function onAgentReportHtml(html: string) {
  htmlContent.value = html
  // 保存到 store
  if (meetingStore.activeSessionId) {
    meetingStore.updateHtmlContent(meetingStore.activeSessionId, html)
  }
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
  
  // 切换到 Agent 面板
  showAgentPanel.value = true
  
  // 等待面板渲染后启动分析
  await nextTick()
  
  // 通过事件触发 Agent 面板的分析
  agentStartAnalysisTrigger.value++
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
  
  // 检查是否有逐字稿
  if (sentences.value.length === 0) {
    errorMessage.value = t('meeting.noTranscript')
    return
  }
  
  // Hermes Agent 模式下，切换到 Agent 面板并启动分析
  if (session.analysisMode === 'hermes') {
    await analyzeWithHermesAgent()
    return
  }
  
  // 自定义模型模式下，调用后端自动分析
  try {
    isAnalyzing.value = true
    const result = await meetingASRApi.startAnalysis(analysisInterval.value)
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
      await meetingASRApi.stopAnalysis()
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
      const result = await meetingASRApi.triggerAnalysis()
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
    const result = await meetingASRApi.getAnalysisResult()
    if (result) {
      analysisResult.value = result
    }
  } catch (error) {
    console.error('Failed to fetch analysis result:', error)
  }
}

async function clearTranscript() {
  // Backend transcript endpoint removed in v0.7.6 (audit #17). Local store
  // already holds the canonical transcript; just clear the UI.
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
          <!-- Agent 切换按钮 -->
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                size="small"
                :type="showAgentPanel ? 'primary' : 'default'"
                @click="showAgentPanel = !showAgentPanel"
              >
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
                    <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z"/>
                  </svg>
                </template>
                {{ t('meeting.agentChat') }}
              </NButton>
            </template>
            {{ t('meeting.showAgentChat') }}
          </NTooltip>

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
            <h2>{{ showAgentPanel ? t('meeting.agentChat') : t('meeting.analysis') }}</h2>
            <div class="right-panel-actions">
              <!-- Agent 切换按钮 -->
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    size="tiny"
                    :type="showAgentPanel ? 'primary' : 'default'"
                    @click="showAgentPanel = !showAgentPanel"
                  >
                    <template #icon>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
                        <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z"/>
                      </svg>
                    </template>
                  </NButton>
                </template>
                {{ showAgentPanel ? t('meeting.showAnalysis') : t('meeting.showAgentChat') }}
              </NTooltip>

              <!-- 分析按钮（仅在非 Agent 面板时显示） -->
              <template v-if="!showAgentPanel">
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
              </template>

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

          <!-- Agent 面板 -->
          <template v-if="showAgentPanel">
            <MeetingAgentPanel
              v-if="meetingStore.activeSessionId"
              :session-id="meetingStore.activeSessionId"
              :start-trigger="agentStartAnalysisTrigger"
              @update:analysis-result="onAgentAnalysisResult"
              @update:report-html="onAgentReportHtml"
            />
          </template>

          <!-- 分析和下载面板 -->
          <template v-else>
            <div class="right-panel-content">
              <!-- 下载区域 - 始终显示 -->
              <div class="download-section">
                <h3>{{ t('meeting.downloads') }}</h3>
                <!-- 音频播放器 -->
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
                </div>
                <!-- 下载按钮 -->
                <div class="download-actions">
                  <NButton size="small" @click="downloadAudio" :disabled="isRecording || !audioUrl">
                    <template #icon>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </template>
                    {{ t('meeting.downloadAudio') }}
                  </NButton>
                  <NButton size="small" @click="downloadTranscript" :disabled="isRecording || sentences.length === 0">
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
                  <NButton size="small" @click="downloadJson" :disabled="isRecording || sentences.length === 0">
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
                  <NButton v-if="htmlContent" size="small" @click="downloadReport" :disabled="isRecording">
                    <template #icon>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                    </template>
                    {{ t('meeting.downloadReport') }}
                  </NButton>
                </div>
              </div>

              <!-- 分析结果区域 - 只在有分析结果时显示 -->
              <template v-if="analysisResult">
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
              </template>

              <!-- 提示区域 - 当有转写内容但没有分析结果时显示 -->
              <div v-if="!analysisResult && sentences.length > 0" class="analysis-hint">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4"/>
                  <path d="M12 8h.01"/>
                </svg>
                <p>{{ t('meeting.analysisHint') }}</p>
              </div>

              <!-- 空状态 -->
              <div v-if="sentences.length === 0" class="right-panel-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
                <p>{{ t('meeting.emptyState') }}</p>
              </div>
            </div>
          </template>
        </div>
      </aside>
      </div>
    </div>

    <!-- 创建会议对话框 -->
    <NModal
      v-model:show="showCreateModal"
      preset="card"
      :title="t('meeting.createMeeting')"
      :style="{ width: '580px' }"
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
          <NSteps :current="asrWizardStep" size="small" status="process" class="asr-wizard-steps">
            <NStep :title="t('meeting.wizardStepAsr')" :description="meetingStore.hasASRConfig ? t('meeting.configured') : ''" />
            <NStep :title="t('meeting.wizardStepLlm')" :description="meetingStore.hasLLMConfig ? t('meeting.configured') : t('meeting.optional')" />
            <NStep :title="t('meeting.wizardStepReview')" />
          </NSteps>

          <!-- Step 1: DashScope API Key (required) -->
          <div v-if="asrWizardStep === 1" class="form-item">
            <label class="form-label">
              {{ t('meeting.dashscopeApiKey') }}
              <a
                href="https://dashscope.aliyun.com/"
                target="_blank"
                rel="noopener noreferrer"
                class="form-tutorial-link"
                @click.stop
              >{{ t('meeting.howToGetApiKey') }}</a>
              <span v-if="meetingStore.hasASRConfig" class="form-label-badge">{{ t('meeting.configured') }}</span>
            </label>
            <NInput
              v-model:value="asrApiKey"
              type="password"
              show-password-on="click"
              :placeholder="meetingStore.hasASRConfig ? t('meeting.apiKeySaved') : t('meeting.dashscopeApiKeyPlaceholder')"
            />
            <div class="form-hint">{{ t('meeting.dashscopeApiKeyHint') }}</div>

            <!-- OSS 配置（说话人分离必填，可折叠） -->
            <details class="oss-config-details">
              <summary class="oss-config-summary">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                  <line x1="12" y1="22.08" x2="12" y2="12"/>
                </svg>
                {{ t('meeting.ossConfig') }}
                <span v-if="meetingStore.asrConfig.ossBucket" class="form-label-badge">{{ t('meeting.configured') }}</span>
              </summary>
              <div class="oss-config-body">
                <NAlert type="info" :show-icon="false" closable style="margin-bottom: 12px">
                  {{ t('meeting.ossConfigHint') }}
                </NAlert>
                <label class="form-label">{{ t('meeting.ossBucket') }}</label>
                <NInput v-model:value="ossBucket" :placeholder="t('meeting.ossBucketPlaceholder')" />
                <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossAccessKeyId') }}</label>
                <NInput v-model:value="ossAccessKeyId" type="password" show-password-on="click" :placeholder="t('meeting.ossAccessKeyIdPlaceholder')" />
                <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossAccessKeySecret') }}</label>
                <NInput v-model:value="ossAccessKeySecret" type="password" show-password-on="click" :placeholder="t('meeting.ossAccessKeySecretPlaceholder')" />
                <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossEndpoint') }}</label>
                <NInput v-model:value="ossEndpoint" :placeholder="t('meeting.ossEndpointPlaceholder')" />
                <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossPathPrefix') }}</label>
                <NInput v-model:value="ossPathPrefix" :placeholder="t('meeting.ossPathPrefixPlaceholder')" />
              </div>
            </details>

            <div class="wizard-actions">
              <NButton type="primary" size="small" @click="asrWizardStep = 2">
                {{ t('meeting.wizardNext') }}
              </NButton>
            </div>
          </div>

          <!-- Step 2: LLM Analysis Config (optional but recommended) -->
          <div v-if="asrWizardStep === 2" class="form-item">
            <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
              {{ t('meeting.llmOptionalHint') }}
            </NAlert>
            <label class="form-label">{{ t('meeting.llmApiKey') }}</label>
            <NInput
              v-model:value="llmApiKey"
              type="password"
              show-password-on="click"
              :placeholder="t('meeting.llmApiKeyPlaceholder')"
            />
            <label class="form-label" style="margin-top: 12px">{{ t('meeting.llmBaseUrl') }}</label>
            <NInput v-model:value="llmBaseUrl" :placeholder="t('meeting.llmBaseUrlPlaceholder')" />
            <label class="form-label" style="margin-top: 12px">{{ t('meeting.llmModel') }}</label>
            <NInput v-model:value="llmModel" :placeholder="t('meeting.llmModelPlaceholder')" />
            <div class="wizard-actions">
              <NButton size="small" @click="asrWizardStep = 1">{{ t('meeting.wizardBack') }}</NButton>
              <NButton type="primary" size="small" @click="asrWizardStep = 3">
                {{ t('meeting.wizardNext') }}
              </NButton>
            </div>
          </div>

          <!-- Step 3: Review -->
          <div v-if="asrWizardStep === 3" class="form-item">
            <NAlert v-if="!meetingStore.hasASRConfig && !asrApiKey" type="warning" :show-icon="true" style="margin-bottom: 8px">
              {{ t('meeting.wizardWarnMissingAsr') }}
            </NAlert>
            <NAlert v-if="!meetingStore.hasLLMConfig && !llmApiKey" type="info" :show-icon="false" style="margin-bottom: 8px">
              {{ t('meeting.wizardWarnMissingLlm') }}
            </NAlert>
            <ul class="wizard-review-list">
              <li>
                <span class="wizard-review-label">{{ t('meeting.wizardStepAsr') }}:</span>
                <span class="wizard-review-value">{{ (asrApiKey || meetingStore.asrConfig.dashscopeApiKey) ? '✓ ' + t('meeting.configured') : '— ' + t('meeting.notConfigured') }}</span>
              </li>
              <li>
                <span class="wizard-review-label">{{ t('meeting.wizardStepLlm') }}:</span>
                <span class="wizard-review-value">{{ (llmApiKey || meetingStore.asrConfig.llmApiKey) ? '✓ ' + t('meeting.configured') : '— ' + t('meeting.notConfigured') }}</span>
              </li>
            </ul>
            <div class="wizard-actions">
              <NButton size="small" @click="asrWizardStep = 2">{{ t('meeting.wizardBack') }}</NButton>
              <NButton size="small" @click="asrWizardStep = 1">{{ t('meeting.wizardRestart') }}</NButton>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">{{ t('meeting.agentConfig') }}</div>
          <div class="form-item">
            <label class="form-label">{{ t('meeting.agentType') }}</label>
            <NSelect
              v-model:value="newMeetingAgentType"
              :options="agentTypeOptions"
              :placeholder="t('meeting.selectAgentType')"
            />
          </div>

          <!-- Hermes Agent 配置 -->
          <template v-if="newMeetingAgentType === 'hermes'">
            <div class="form-item">
              <label class="form-label">{{ t('meeting.selectProfile') }}</label>
              <NSelect
                v-model:value="newMeetingHermesProfile"
                :options="profileOptions"
                :placeholder="t('meeting.selectProfilePlaceholder')"
              />
            </div>
          </template>

          <!-- Coding Agent 配置 -->
          <template v-if="newMeetingAgentType === 'claude-code' || newMeetingAgentType === 'codex'">
            <div class="form-item">
              <label class="form-label">{{ t('meeting.codingAgentMode') }}</label>
              <NRadioGroup v-model:value="newMeetingCodingAgentMode">
                <NRadio v-for="option in codingAgentModeOptions" :key="option.value" :value="option.value">
                  <div class="radio-content">
                    <span class="radio-title">{{ option.label }}</span>
                    <span class="radio-desc">{{ option.description }}</span>
                  </div>
                </NRadio>
              </NRadioGroup>
            </div>
            <template v-if="newMeetingCodingAgentMode === 'scoped'">
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
          </template>
        </div>
      </div>
      
      <template #action>
        <NButton @click="showCreateModal = false">{{ t('common.cancel') }}</NButton>
        <NButton
          type="primary"
          :disabled="!newMeetingTitle.trim() || (!asrApiKey.trim() && !meetingStore.hasASRConfig)"
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

.download-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  margin-bottom: 16px;
  
  h3 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0 0 12px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.download-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.analysis-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  gap: 12px;
  color: $text-secondary;
  
  p {
    font-size: 13px;
    text-align: center;
  }
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

.form-tutorial-link {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-primary, #667eea);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
}

.form-tutorial-link:hover {
  opacity: 1;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.oss-config-details {
  margin-top: 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.15);
  border-radius: $radius-sm;
  overflow: hidden;
}

.oss-config-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  cursor: pointer;
  user-select: none;
  background: rgba(var(--accent-primary-rgb), 0.03);
  transition: background 0.2s;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }

  svg {
    flex-shrink: 0;
    color: $accent-primary;
  }

  &::-webkit-details-marker {
    display: none;
  }
}

.oss-config-body {
  padding: 10px;
  border-top: 1px solid rgba(var(--accent-primary-rgb), 0.1);
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

// Agent 分析相关样式
.agent-analysis-section {
  border-bottom: 1px solid $border-color;
  background: rgba($accent-primary, 0.02);
}

.agent-analysis-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  transition: background 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.05);
  }

  svg {
    transition: transform 0.2s ease;
    color: $accent-primary;
  }
}

.agent-status {
  margin-left: auto;
  font-size: 12px;
  color: $accent-primary;
  font-weight: normal;
}

.agent-messages-container {
  max-height: 300px;
  overflow-y: auto;
  padding: 0 16px 12px;
}

.agent-message {
  margin-bottom: 8px;
  
  &.role-tool {
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.03);
    border-radius: 6px;
    border-left: 3px solid $accent-primary;
  }
}

.agent-thinking {
  margin-bottom: 8px;
  padding: 8px 10px;
  background: rgba($accent-primary, 0.05);
  border-radius: 6px;
  border-left: 3px solid $accent-primary;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $accent-primary;
  margin-bottom: 4px;
}

.thinking-content {
  font-size: 12px;
  color: $text-secondary;
  white-space: pre-wrap;
  line-height: 1.5;
}

.agent-tool {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.tool-spinner {
  animation: spin 1s linear infinite;
  color: $accent-primary;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-done {
  color: #22c55e;
}

.tool-error {
  color: #ef4444;
}

.tool-name {
  font-weight: 600;
  color: $text-primary;
}

.tool-error-text {
  color: #ef4444;
  font-size: 11px;
}

.agent-content {
  font-size: 13px;
  line-height: 1.6;
  color: $text-primary;
  white-space: pre-wrap;
}
</style>
