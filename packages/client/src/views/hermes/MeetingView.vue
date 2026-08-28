<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NTag, NTooltip, NInput, NPopconfirm, NModal, NSelect, NRadio, NRadioGroup, NSteps, NStep, NAlert } from 'naive-ui'
import MeetingAgentPanel from '@/components/hermes/meeting/MeetingAgentPanel.vue'
import SpeechEvaluationPanel from '@/components/hermes/meeting/SpeechEvaluationPanel.vue'
import SceneTemplatePicker from '@/components/hermes/meeting/SceneTemplatePicker.vue'
import WaveformCanvas from '@/components/hermes/meeting/WaveformCanvas.vue'
import MeetingSidebar, { type SidebarSession } from '@/components/hermes/meeting/MeetingSidebar.vue'
import CreateMeetingDialog from '@/components/hermes/meeting/CreateMeetingDialog.vue'
import MeetingTopBar from '@/components/hermes/meeting/MeetingTopBar.vue'
import MeetingRightPanel from '@/components/hermes/meeting/MeetingRightPanel.vue'
import TranscriptList from '@/components/hermes/meeting/TranscriptList.vue'
import type { SceneId } from '@/components/hermes/meeting/scene-templates'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { MeetingSession, TranscriptSentence, AgentConfig } from '@/stores/hermes/meeting'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { getApiKey } from '@/api/client'
import { useMessage } from '@/composables/useAppMessage'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { buildReportHtml } from '@/utils/report-html'
import { getProfileDisplayName } from '@/utils/hermes/profile-display'

const { t } = useI18n()
const message = useMessage()
const meetingStore = useMeetingStore()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()

// --- 侧边栏状态 ---
const showSidebar = ref(true)

// 把 store 数据压扁成 MeetingSidebar 期望的最小结构（避免组件依赖 store 内部类型）
const sidebarSessions = computed<SidebarSession[]>(() =>
  meetingStore.sortedSessions.map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    sentencesCount: s.sentences.length,
    hasAnalysis: s.analysisResult !== null && s.analysisResult !== undefined,
  })),
)

// --- 创建会议对话框 ---
const showCreateModal = ref(false)
const newMeetingTitle = ref('')
const newMeetingAnalysisMode = ref<'hermes' | 'custom'>('hermes')
const newMeetingHermesProfile = ref('')
const newMeetingCustomProvider = ref('')
const newMeetingCustomModel = ref('')
const newMeetingSceneTemplate = ref<SceneId>('general')

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
const newMeetingAsrModel = ref('paraformer-v2')

// ASR 模型选项
const asrModelOptions = computed(() => [
  { 
    label: 'Paraformer V2', 
    value: 'paraformer-v2',
    description: t('meeting.asrModelParaformerDesc')
  },
  { 
    label: 'Fun-ASR', 
    value: 'fun-asr',
    description: t('meeting.asrModelFunAsrDesc')
  },
  { 
    label: 'Fun-ASR MTL', 
    value: 'fun-asr-mtl',
    description: t('meeting.asrModelFunAsrMtlDesc')
  },
])

// --- 当前会议状态 ---
const isRecording = ref(false)
const isLoading = ref(false)
const isConnecting = ref(false)
const statusText = ref('')
const partialText = ref('')
const finalSentences = ref<TranscriptSentence[]>([])
const speakerMap = ref<Record<string, string>>({})
/** 隐藏说话人分离功能（产品需求：会议只显示 agent 对话，不展示说话人分离）。
 *  置 true 时：工具栏不显示 diarize 开关/节省模式/说话人数选择，且强制关闭
 *  说话人分离（转写不再带说话人标签）。改回 false 可恢复。 */
const HIDE_SPEAKER_DIARIZATION = true
const useDiarize = ref(false)
const saveMode = ref(true)  // 节省模式：只走说话人分离，不走实时ASR
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
let diarizeWs: WebSocket | null = null  // 说话人分离专用WebSocket
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
const analyser = ref<AnalyserNode | null>(null)

// --- 音频录制 ---
let mediaRecorder: MediaRecorder | null = null
const audioChunks = ref<Blob[]>([])
const recordingStartTime = ref(0)
const audioBlob = ref<Blob | null>(null)
const audioUrl = ref('')
const isPlaying = ref(false)
const playbackTime = ref(0)
const playbackDuration = ref(0)

watch(audioUrl, (url) => {
  if (url) {
    const tempAudio = new Audio(url)
    tempAudio.onloadedmetadata = () => {
      if (isFinite(tempAudio.duration)) {
        playbackDuration.value = tempAudio.duration
      } else {
        tempAudio.currentTime = 1e10
        tempAudio.ondurationchange = () => {
          if (isFinite(tempAudio.duration)) {
            playbackDuration.value = tempAudio.duration
            tempAudio.ondurationchange = null
          }
        }
      }
    }
  } else {
    playbackDuration.value = 0
  }
})

// --- 分析相关 ---
const analysisResult = ref<any>(null)
const htmlContent = ref('')
const isAnalyzing = ref(false)
const analysisInterval = ref(30)
const analysisTriggerMode = ref<'sentences' | 'time' | 'both'>('sentences')
const analysisIntervalSentences = ref(10)
const agentStartAnalysisTrigger = ref(0)
const showReport = ref(false)
const showAnalysisConfig = ref(false)

// --- Agent 分析相关 ---
const showAgentPanel = ref(false)
const assistPanelRef = ref<InstanceType<typeof MeetingAgentPanel> | null>(null)

// 当前活动会议
const activeSession = computed(() => meetingStore.activeSession)

// 演讲评分场景：右侧面板切换为专用评估面板（计时员/赘语记录员/语法官）
const isSpeechScene = computed(() => activeSession.value?.sceneTemplate === 'speech')

// 报告生成完成回调
function onReportGenerated(markdown: string) {
  if (meetingStore.activeSessionId) {
    meetingStore.updateSession(meetingStore.activeSessionId, { htmlContent: markdown })
  }
}

// 手动请求生成报告
function onRequestReport() {
  const session = meetingStore.activeSession
  console.log('[report] onRequestReport:', {
    hasSession: !!session,
    sentencesCount: session?.sentences.length ?? 0,
    hasPanelRef: !!assistPanelRef.value,
  })
  if (session && session.sentences.length > 0 && assistPanelRef.value) {
    const transcript = session.sentences
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')
    console.log('[report] calling generateReport, transcript length:', transcript.length)
    assistPanelRef.value.generateReport(transcript)
  } else {
    console.warn('[report] guard failed, report not generated')
  }
}

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
    label: getProfileDisplayName(p),
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
  newMeetingSceneTemplate.value = 'general'
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
  
  // 分析模式：默认 Agent（hermes）直接调用 Hermes Agent 的 Agent 功能生成
  // 会议纪要、关键要点、待办事项，无需额外 LLM 配置；自定义模式（custom）
  // 走下方填写的 LLM API Key / Base URL / 模型
  const analysisMode = newMeetingAnalysisMode.value
  // 使用默认 Agent 时固定用 Hermes Agent（默认配置），不受 Agent 类型选择影响
  const effectiveAgentType = analysisMode === 'hermes' ? 'hermes' : newMeetingAgentType.value
  
  // 构建 Agent 配置
  const agentConfig: AgentConfig = {
    agentType: effectiveAgentType,
    codingAgentMode: newMeetingCodingAgentMode.value,
  }
  
  // 根据 Agent 类型设置配置
  if (effectiveAgentType === 'hermes') {
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
    asrModel: newMeetingAsrModel.value,
    analysisMode,
    hermesProfile: effectiveAgentType === 'hermes' ? (newMeetingHermesProfile.value || 'default') : undefined,
    customProvider: effectiveAgentType !== 'hermes' && newMeetingCodingAgentMode.value === 'scoped' ? newMeetingCustomProvider.value : undefined,
    customModel: effectiveAgentType !== 'hermes' && newMeetingCodingAgentMode.value === 'scoped' ? newMeetingCustomModel.value : undefined,
    agentConfig,
    sceneTemplate: newMeetingSceneTemplate.value,
  })

  resetMeetingState()
  showCreateModal.value = false
}

// MeetingSidebar 只传 sessionId；这里把它查回 store 中的完整 session，再走原 loadMeeting。
function selectMeetingById(sessionId: string) {
  const session = meetingStore.sortedSessions.find((s) => s.id === sessionId)
  if (session) loadMeeting(session)
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
      useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : (serverData.useDiarize || false)
    } else {
      // 如果服务器没有数据，使用本地数据
      finalSentences.value = [...session.sentences]
      analysisResult.value = session.analysisResult
      htmlContent.value = session.htmlContent
      speakerMap.value = { ...session.speakerMap }
      useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : session.useDiarize
    }
  } catch (err) {
    console.error('Failed to load meeting from server:', err)
    // 回退到本地数据
    finalSentences.value = [...session.sentences]
    analysisResult.value = session.analysisResult
    htmlContent.value = session.htmlContent
    speakerMap.value = { ...session.speakerMap }
    useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : session.useDiarize
  }
  
  // 同步句子到 store（供 Agent 面板读取）
  meetingStore.updateSession(session.id, {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
  })
  
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
// TranscriptList 负责 UI state（弹窗开合/输入框），这里只做持久化。
function onTranscriptRename(speakerId: string, name: string) {
  if (!meetingStore.activeSessionId) return
  meetingStore.renameSpeaker(meetingStore.activeSessionId, speakerId, name)
  const session = meetingStore.activeSession
  if (session) {
    finalSentences.value = [...session.sentences]
    speakerMap.value = { ...session.speakerMap }
  }
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
  // Check both the persisted store AND the current wizard input refs — when
  // the browser origin changes (different dev port, incognito, etc.)
  // localStorage is empty but the user may have just re-entered OSS config
  // in the wizard. Without checking the local refs we'd skip restart and
  // keep using the already-running (OSS-less) service.
  const hasOSS =
    meetingStore.asrConfig.ossBucket || ossBucket.value.trim() ||
    meetingStore.asrConfig.ossAccessKeyId || ossAccessKeyId.value.trim() ||
    meetingStore.asrConfig.ossAccessKeySecret || ossAccessKeySecret.value.trim()
  if (asrServiceStatus.value.isRunning && !hasOSS) return true

  isStartingASR.value = true
  asrServiceError.value = ''
  // Reflect the most useful startup hint we have before the call returns.
  // The service exposes finer-grained phases (venv / pip_install / starting)
  // via /status, but those update asynchronously after this coroutine yields,
  // so we pick a phase copy that stays accurate for the full call window.
  statusText.value = t('meeting.startup.starting')

  try {
    // Get ASR config from meeting store and current session
    const activeSession = meetingStore.activeSession
    const config: Record<string, unknown> = {
      dashscopeApiKey: meetingStore.asrConfig.dashscopeApiKey || asrApiKey.value,
      asrModel: activeSession?.asrModel || 'paraformer-v2',
    }
    // Pass LLM config if user provided it, so backend has it from the start.
    if (meetingStore.asrConfig.llmApiKey || llmApiKey.value) {
      config.llmApiKey = meetingStore.asrConfig.llmApiKey || llmApiKey.value
      config.llmBaseUrl = meetingStore.asrConfig.llmBaseUrl || llmBaseUrl.value
      config.llmModel = meetingStore.asrConfig.llmModel || llmModel.value
    }
    // Pass OSS config if user configured it (speaker diarization chunk flow).
    // Fallback to local refs (current modal input) when the persisted store
    // is empty — without this, edits made in the wizard that haven't yet been
    // flushed via updateASRConfig() would silently get dropped on the wire.
    const store = meetingStore.asrConfig
    const ossBucketValue = store.ossBucket || ossBucket.value.trim()
    const ossAccessKeyIdValue = store.ossAccessKeyId || ossAccessKeyId.value.trim()
    const ossAccessKeySecretValue = store.ossAccessKeySecret || ossAccessKeySecret.value.trim()
    if (ossBucketValue || ossAccessKeyIdValue || ossAccessKeySecretValue) {
      config.ossBucket = ossBucketValue
      config.ossAccessKeyId = ossAccessKeyIdValue
      config.ossAccessKeySecret = ossAccessKeySecretValue
      config.ossEndpoint = store.ossEndpoint || ossEndpoint.value.trim() || 'oss-cn-beijing.aliyuncs.com'
      config.ossPathPrefix = store.ossPathPrefix || ossPathPrefix.value.trim() || 'meeting-asr-uploads/'
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
      asrServiceError.value = result.error || t('meeting.startup.error')
      console.error('[meeting] ASR service failed to start:', asrServiceError.value)
      message.error(asrServiceError.value)
      return false
    }
  } catch (err: any) {
    // Backend annotates hot-config push failures with a "config push failed:"
    // prefix (see MeetingASRService.start). Detect that distinctly so the user
    // knows their updated key did not take effect — previously this was
    // swallowed and the wrong key kept being used.
    const raw = err?.message || String(err)
    if (raw.includes('config push failed')) {
      asrServiceError.value = t('meeting.errorConfigUpdateFailed')
    } else if (/not running|not ready|timeout/i.test(raw)) {
      asrServiceError.value = t('meeting.errorServiceNotReady')
    } else {
      asrServiceError.value = raw || t('meeting.startup.error')
    }
    console.error('[meeting] ASR service start error:', err)
    message.error(asrServiceError.value)
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

  // 同步服务端会议列表 (触摸屏设备端创建的会议, 合并进侧边栏)
  await meetingStore.syncSessionsFromServer()
  
  // 如果有活跃会议，加载它
  if (meetingStore.activeSession) {
    loadMeeting(meetingStore.activeSession)
  }
  // 不再默认打开新建会议弹窗，用户需要点击"新建会议"按钮
})

onUnmounted(() => {
  stopRecording()
  // Note: We don't stop the ASR service on unmount as it should persist across page navigations
})

// --- 录音中关页/刷新兜底：把内存里的音频块落库到 IndexedDB ---
// 音频只在 stopRecording 一次性正式落库，但用户在录音中直接刷新或关闭页面时，
// 组件不会走 onUnmounted（浏览器通常跳过 beforeunload 之后的清理），此时内存中的
// audioChunks 会全部丢失。这里用 pagehide/beforeunload 把尚未落库的块写成
// IndexedDB 备份——注意 IndexedDB 事务在页面卸载进程中是非阻塞的，即便耗时也能完成写入。
//
// 不再监听 unload：嵌入到 iframe / in-app browser 容器时 Permissions-Policy 会拒绝
// 'unload' 事件，浏览器只打违规日志并不会调用回调，所以 unload 监听是个无效冗余；
// pagehide 在 SPA 切页 / 移动端 / 嵌入容器里都会触发，覆盖更全。
let beforeUnloadHandlerAttached = false

function attachBeforeUnloadAudioBackup() {
  if (beforeUnloadHandlerAttached) return
  beforeUnloadHandlerAttached = true

  const backup = () => {
    const sessionId = meetingStore.activeSessionId
    if (!isRecording.value || !sessionId || audioChunks.value.length === 0) return
    try {
      const blob = new Blob(audioChunks.value, { type: 'audio/webm' })
      meetingStore.saveAudioData(sessionId, blob)
    } catch (err) {
      console.error('[meeting] Failed to backup audio on unload:', err)
    }
  }

  window.addEventListener('beforeunload', backup)
  window.addEventListener('pagehide', backup)
}

function detachBeforeUnloadAudioBackup() {
  if (!beforeUnloadHandlerAttached) return
  beforeUnloadHandlerAttached = false
  const noop = () => {}
  window.removeEventListener('beforeunload', noop)
  window.removeEventListener('pagehide', noop)
}

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
  // 没有活动会议时，先引导用户新建会议
  if (!meetingStore.activeSessionId) {
    openCreateModal()
    return
  }

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

    // 检查并启动 ASR 服务（服务已运行时也会调用，确保 OSS 配置变更后重启进程）
    statusText.value = t('meeting.startingASRService')
    console.log('[meeting] Ensuring ASR service is running with current config...')
    const started = await startASRService()
    if (!started) {
      const errorMsg = asrServiceError.value || t('meeting.asrServiceStartError')
      console.error('[meeting] Failed to start ASR service:', errorMsg)
      errorMessage.value = errorMsg
      isConnecting.value = false
      return
    }
    console.log('[meeting] ASR service ready, ports:', asrServiceStatus.value.asrPort, asrServiceStatus.value.diarizePort)
    
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
    analyser.value = audioContext.createAnalyser()
    analyser.value.fftSize = 256

    // AudioWorklet 替代 deprecated ScriptProcessorNode，跑在 audio 线程不抢主线程。
    // JS 副本在 public/audio/pcm-worklet.js（源文件 src/audio/pcm-worklet.ts）。
    await audioContext.audioWorklet.addModule('/audio/pcm-worklet.js')
    const pcmNode = new AudioWorkletNode(audioContext, 'pcm-processor')
    source.connect(analyser.value)
    analyser.value.connect(pcmNode)
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

    // 录音开始后，挂载关页/刷新兜底（把内存音频块落库到 IndexedDB）
    attachBeforeUnloadAudioBackup()

    // 根据模式决定连接哪些 WebSocket
    const isSaveMode = useDiarize.value && saveMode.value
    
    if (isSaveMode) {
      // 节省模式：只连接 Diarize WebSocket，不走实时ASR
      console.log('[meeting] Save mode: only connecting to Diarize WebSocket:', DIARIZE_URL)
      diarizeWs = new WebSocket(DIARIZE_URL)

      diarizeWs.onopen = () => {
        console.log('Diarize WebSocket connected (save mode)')
        isConnecting.value = false
        isRecording.value = true
        statusText.value = t('meeting.recording')
        diarizeWs?.send(JSON.stringify({ 
          type: 'start', 
          sample_rate: 16000, 
          speaker_count: speakerCount.value || 'auto' 
        }))
      }

      diarizeWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleWsMessage(data, 'diarize')
        } catch (e) {
          console.error('Failed to parse Diarize WS message:', e)
        }
      }

      diarizeWs.onerror = (error) => {
        console.error('Diarize WebSocket error:', error)
        errorMessage.value = t('meeting.connectionError')
        stopRecording()
      }

      diarizeWs.onclose = () => {
        console.log('Diarize WebSocket closed')
        if (isRecording.value) {
          stopRecording()
        }
      }

      // 音频统一由下方共享的 AudioWorklet handler 发送
    } else if (useDiarize.value) {
      // 启用说话人分离的正常模式：连接 ASR + Diarize 两个 WebSocket
      console.log('[meeting] Diarize mode: connecting to both ASR and Diarize WebSockets')
      
      // 连接 ASR WebSocket (实时转写)
      console.log('[meeting] Connecting to ASR WebSocket:', ASR_URL)
      ws = new WebSocket(ASR_URL)

      ws.onopen = () => {
        console.log('ASR WebSocket connected')
        isConnecting.value = false
        isRecording.value = true
        statusText.value = t('meeting.recording')
        ws?.send(JSON.stringify({ type: 'start' }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleWsMessage(data, 'asr')
        } catch (e) {
          console.error('Failed to parse ASR WS message:', e)
        }
      }

      ws.onerror = (error) => {
        console.error('ASR WebSocket error:', error)
        errorMessage.value = t('meeting.connectionError')
        stopRecording()
      }

      ws.onclose = () => {
        console.log('ASR WebSocket closed')
        if (isRecording.value) {
          stopRecording()
        }
      }

      // 同时连接 Diarize WebSocket (说话人分离)
      console.log('[meeting] Connecting to Diarize WebSocket:', DIARIZE_URL)
      diarizeWs = new WebSocket(DIARIZE_URL)

      diarizeWs.onopen = () => {
        console.log('Diarize WebSocket connected')
        diarizeWs?.send(JSON.stringify({ 
          type: 'start', 
          sample_rate: 16000, 
          speaker_count: speakerCount.value || 'auto' 
        }))
      }

      diarizeWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleWsMessage(data, 'diarize')
        } catch (e) {
          console.error('Failed to parse Diarize WS message:', e)
        }
      }

      diarizeWs.onerror = (error) => {
        console.error('Diarize WebSocket error:', error)
      }

      diarizeWs.onclose = () => {
        console.log('Diarize WebSocket closed')
      }

      // 音频由下方共享的 AudioWorklet handler 同时发给 ASR 和 Diarize
    } else {
      // 仅 ASR 模式：只连接 ASR WebSocket（不启用说话人分离）
      console.log('[meeting] ASR only mode: connecting to ASR WebSocket only')
      
      const asrUrl = ASR_URL
      console.log('[meeting] Connecting to ASR WebSocket:', asrUrl)
      ws = new WebSocket(asrUrl)

      ws.onopen = () => {
        console.log('ASR WebSocket connected')
        isConnecting.value = false
        isRecording.value = true
        statusText.value = t('meeting.recording')
        ws?.send(JSON.stringify({ type: 'start' }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleWsMessage(data, 'asr')
        } catch (e) {
          console.error('Failed to parse ASR WS message:', e)
        }
      }

      ws.onerror = (error) => {
        console.error('ASR WebSocket error:', error)
        errorMessage.value = t('meeting.connectionError')
        stopRecording()
      }

      ws.onclose = () => {
        console.log('ASR WebSocket closed')
        if (isRecording.value) {
          stopRecording()
        }
      }
    }

    // 处理音频数据：通过 AudioWorklet 接收 Float32 buffer，主线程 resample + Int16 转换，
    // 再分发给当前已打开的 socket（ASR / Diarize）
    pcmNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sourceSampleRate: number }>) => {
      const wsOpen = !!ws && ws.readyState === WebSocket.OPEN
      const diarizeOpen = !!diarizeWs && diarizeWs.readyState === WebSocket.OPEN
      if (!wsOpen && !diarizeOpen) return
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

      if (wsOpen) ws!.send(int16Data.buffer)
      if (diarizeOpen) diarizeWs!.send(int16Data.buffer)
    }

    // 声浪可视化由 WaveformCanvas 组件监听 analyser 自动起停，无需手动调用。

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

// 推送句子到实时辅助服务（fire-and-forget）
function pushSentenceToAssist(sessionId: string, sentence: TranscriptSentence) {
  fetch('/api/meeting-asr/assist/sentence', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
    },
    body: JSON.stringify({
      sessionId,
      speaker: sentence.speaker,
      text: sentence.text,
      timestamp: sentence.timestamp,
    }),
  }).catch(() => { /* best effort */ })
}

async function stopRecording() {
  isRecording.value = false
  isConnecting.value = false
  statusText.value = ''

  // 声浪可视化由 WaveformCanvas 监听 analyser 自动停止，这里只清空引用。
  analyser.value = null

  // 停止媒体录制器
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  mediaRecorder = null

  // 录音结束，移除关页/刷新兜底监听（正式落库由下方 saveAudioData 完成）
  detachBeforeUnloadAudioBackup()

  // 发送停止消息给 ASR（ASR 已在录音过程中流式返回结果，500ms 后安全关闭）
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }))
    setTimeout(() => ws?.close(), 500)
  }
  ws = null

  // 发送停止消息给 Diarize
  if (diarizeWs && diarizeWs.readyState === WebSocket.OPEN) {
    diarizeWs.send(JSON.stringify({ type: 'stop' }))
    setTimeout(() => diarizeWs?.close(), 500)
  }
  diarizeWs = null

  // 停止音频 + 关闭 worklet
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close().catch(() => { /* best effort */ })
    audioContext = null
  }
  analyser.value = null

  // 保存音频（会议结束一次性落库）。录音期间 audioChunks 只累积在内存，
  // MediaRecorder 每 1000ms 切一块，这里统一合成整段 webm 落库：
  //  - 服务器：优先写，失败时 IndexedDB 仍兜底保留本机数据
  //  - IndexedDB：直接存 Blob，作为离线备份
  if (audioChunks.value.length > 0 && meetingStore.activeSessionId) {
    audioBlob.value = new Blob(audioChunks.value, { type: 'audio/webm' })
    audioUrl.value = URL.createObjectURL(audioBlob.value)

    const meetingId = meetingStore.activeSessionId
    const meeting = meetingStore.activeSession

    // 先落会议数据（含 transcript），再上传音频，两件事互相隔离
    saveCurrentMeeting()

    // 上传音频到服务器（失败不阻断 IndexedDB 本地备份）
    await meetingStorageApi
      .uploadAudio(meetingId, audioBlob.value)
      .then(() => console.log('Audio saved to server'))
      .catch(err => {
        console.error('Failed to save audio to server:', err)
        message.error(t('meeting.errorUploadAudioFailed'))
      })

    // 保存到 IndexedDB 作为本机备份（直接存 Blob，避免 base64 编码 33% 膨胀）
    try {
      await meetingStore.saveAudioData(meetingId, audioBlob.value)
    } catch (err) {
      console.error('Failed to save audio to IndexedDB:', err)
    }

    // 完成落库后，清空内存引用让 GC 回收，避免大会议残留内存
    audioChunks.value = []
    if (meeting) {
      meetingStore.updateSession(meetingId, { audioDuration: meeting.audioDuration })
    }
  }

  // 录音停止后自动触发报告生成
  const session = meetingStore.activeSession
  if (session && session.sentences.length > 0 && assistPanelRef.value) {
    const transcript = session.sentences
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')
    assistPanelRef.value.generateReport(transcript)
  }
}

function handleWsMessage(data: any, source: 'asr' | 'diarize' = 'asr') {
  switch (data.type) {
    case 'ready':
      console.log(`[${source}] Session ready:`, data.session_id || data.task_id)
      break
    case 'started':
      if (source === 'asr') {
        statusText.value = t('meeting.recording')
      }
      break
    case 'partial':
      if (source === 'asr') {
        partialText.value = data.text || ''
      }
      break
    case 'final':
      // ASR实时转写结果 - 无说话人标签
      if (source === 'asr' && data.text) {
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
        
        // 推送到实时辅助服务
        if (meetingStore.activeSessionId) {
          pushSentenceToAssist(meetingStore.activeSessionId, sentence)
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
      if (source === 'diarize' && data.sentences) {
        const offsetSec = data.offset_sec || 0
        const isSaveMode = useDiarize.value && saveMode.value
        
        if (isSaveMode) {
          // 节省模式：直接添加结果（带说话人标签）
          addDiarizeResultDirectly(data.sentences, offsetSec)
        } else {
          // 正常模式：匹配回填到已有ASR句子
          matchAndMergeDiarizeResult(data.sentences, offsetSec)
        }
      }
      break
    case 'chunk_queued':
    case 'chunk_submitted':
      // 说话人分离进度提示（可选显示）
      if (source === 'diarize') {
        console.log(`[diarize] Chunk ${data.chunk_index} processing...`)
      }
      break
    case 'error':
      if (source === 'asr') {
        // 后端 ASR 服务目前只 emit 错误文本（realtime-assist.ts:200），所以 data
        // 经常是字符串而不是对象；这里三种形态都兼容：字符串本身、空字符串、
        // { message: '' }。空 message 多半是 ASR 进程崩溃 / 未启动，此时让用户看到
        // 'service not ready' 比 'unknown error' 更可操作。
        const rawMessage =
          typeof data === 'string'
            ? data
            : (data?.message as string | undefined) ?? ''
        const trimmed = rawMessage.trim()
        errorMessage.value = trimmed || t('meeting.errorServiceNotReady')
        stopRecording()
      } else {
        // Diarize错误只记录日志，不中断录音
        console.error('[diarize] Error:', data.message)
      }
      break
    case 'stopped':
      if (source === 'asr') {
        stopRecording()
      }
      break
  }
}

function addDiarizeResultDirectly(diarizeSentences: any[], offsetSec: number = 0) {
  // 节省模式：直接添加 Diarize 结果（带说话人标签）
  console.log('[diarize-save] Adding', diarizeSentences.length, 'sentences directly')
  
  for (const diarizeSent of diarizeSentences) {
    const diarizeStartMs = offsetSec * 1000 + (diarizeSent.begin_ms || 0)
    const diarizeEndMs = offsetSec * 1000 + (diarizeSent.end_ms || 0)
    const speakerId = String(diarizeSent.speaker_id || 'unknown')
    
    // 获取或创建说话人显示名称
    if (!speakerMap.value[speakerId]) {
      speakerMap.value[speakerId] = `说话人 ${Object.keys(speakerMap.value).length + 1}`
    }
    const session = meetingStore.activeSession
    const registeredName = session?.speakers.find(s => s.id === speakerId)?.displayName
    const speakerName = registeredName || speakerMap.value[speakerId]
    
    // 检查是否是重复的文本（避免overlap导致的重复）
    const isDuplicate = finalSentences.value.some(s => 
      s.text === diarizeSent.text && 
      Math.abs((s.startTime || 0) - diarizeStartMs) < 2000
    )
    
    if (!isDuplicate && diarizeSent.text) {
      const sentenceObj: TranscriptSentence = {
        text: diarizeSent.text,
        timestamp: Date.now(),
        startTime: diarizeStartMs,
        endTime: diarizeEndMs,
        speaker: speakerName,
        speakerId: speakerId,
      }
      finalSentences.value.push(sentenceObj)
      
      if (meetingStore.activeSessionId) {
        meetingStore.addSentence(meetingStore.activeSessionId, sentenceObj)
        // 推送到实时辅助服务
        pushSentenceToAssist(meetingStore.activeSessionId, sentenceObj)
      }
    }
  }
  
  // 按时间戳排序
  finalSentences.value.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
  
  // 自动滚动到底部
  nextTick(() => {
    const container = document.getElementById('transcript-container')
    if (container) container.scrollTop = container.scrollHeight
  })
}

function matchAndMergeDiarizeResult(diarizeSentences: any[], offsetSec: number = 0) {
  // 将说话人分离结果与已有的ASR句子按时间戳匹配
  // offsetSec: chunk在整个音频中的偏移量（秒）
  const timeThreshold = 2000 // 2秒容差（考虑ASR和Diarize的时间戳差异）
  
  console.log('[diarize] Processing', diarizeSentences.length, 'sentences with offset', offsetSec, 'sec')
  
  for (const diarizeSent of diarizeSentences) {
    // 计算绝对时间（毫秒）
    const diarizeStartMs = offsetSec * 1000 + (diarizeSent.begin_ms || 0)
    const diarizeEndMs = offsetSec * 1000 + (diarizeSent.end_ms || 0)
    const speakerId = String(diarizeSent.speaker_id || 'unknown')
    
    // 获取或创建说话人显示名称
    if (!speakerMap.value[speakerId]) {
      speakerMap.value[speakerId] = `说话人 ${Object.keys(speakerMap.value).length + 1}`
    }
    const session = meetingStore.activeSession
    const registeredName = session?.speakers.find(s => s.id === speakerId)?.displayName
    const speakerName = registeredName || speakerMap.value[speakerId]
    
    console.log('[diarize] Sentence:', diarizeSent.text?.substring(0, 20), 'speaker:', speakerName, 'time:', diarizeStartMs, '-', diarizeEndMs)
    
    // 查找匹配的ASR句子
    let matched = false
    for (const asrSent of finalSentences.value) {
      // 如果ASR句子已经有说话人标签，跳过
      if (asrSent.speakerId) continue
      
      // 按时间戳匹配
      const asrStartMs = asrSent.startTime || 0
      const asrEndMs = asrSent.endTime || 0
      
      // 计算时间差
      const startDiff = Math.abs(asrStartMs - diarizeStartMs)
      const endDiff = Math.abs(asrEndMs - diarizeEndMs)
      
      if (startDiff < timeThreshold && endDiff < timeThreshold) {
        // 匹配成功，回填说话人信息
        asrSent.speaker = speakerName
        asrSent.speakerId = speakerId
        matched = true
        console.log('[diarize] Matched ASR sentence:', asrSent.text?.substring(0, 20))
        
        // 同步更新到 store
        if (meetingStore.activeSessionId) {
          meetingStore.updateSentence(meetingStore.activeSessionId, asrSent)
        }
        break
      }
    }
    
    // 如果没有匹配到已有句子，可能是新的句子（边界情况）
    if (!matched && diarizeSent.text) {
      // 检查是否是重复的文本（避免overlap导致的重复）
      const isDuplicate = finalSentences.value.some(s => 
        s.text === diarizeSent.text && 
        Math.abs((s.startTime || 0) - diarizeStartMs) < timeThreshold
      )
      
      if (!isDuplicate) {
        const sentenceObj: TranscriptSentence = {
          text: diarizeSent.text,
          timestamp: Date.now(),
          startTime: diarizeStartMs,
          endTime: diarizeEndMs,
          speaker: speakerName,
          speakerId: speakerId,
        }
        finalSentences.value.push(sentenceObj)
        console.log('[diarize] Added new sentence from diarize:', diarizeSent.text?.substring(0, 20))
        
        if (meetingStore.activeSessionId) {
          meetingStore.addSentence(meetingStore.activeSessionId, sentenceObj)
        }
      }
    }
  }
  
  // 按时间戳排序
  finalSentences.value.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
  
  // 自动滚动到底部
  nextTick(() => {
    const container = document.getElementById('transcript-container')
    if (container) container.scrollTop = container.scrollHeight
  })
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
    if (audioElement.value && isFinite(audioElement.value.duration)) {
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

  let content = ''
  let source = 'server'
  try {
    // 尝试从服务器下载
    content = (await meetingStorageApi.downloadHtmlReport(meetingStore.activeSessionId)) || ''
  } catch (err) {
    console.error('Failed to download report from server:', err)
  }

  // 回退到本地数据（store 是报告生成后的权威来源，局部 ref 可能未同步）
  if (!content) {
    source = 'local'
    content = meetingStore.activeSession?.htmlContent || htmlContent.value
  }
  console.log('[downloadReport] 内容来源:', source, '长度:', content.length)
  if (!content) return

  const title = meetingStore.activeSession?.title || '会议报告'
  const html = toPrettyReportHtml(content, title)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title}_report.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// 报告内容若为 Markdown（实时辅助生成）则转换为精美 HTML 页面；若已是 HTML（Agent 生成）则直接包装
function toPrettyReportHtml(content: string, title: string): string {
  const trimmed = content.trim()
  const looksLikeHtml = /^<(!doctype|html|div|h[1-6]|p\b)/i.test(trimmed)
  console.log('[downloadReport] looksLikeHtml:', looksLikeHtml, '内容开头:', JSON.stringify(trimmed.slice(0, 40)))
  if (looksLikeHtml) return content
  return buildReportHtml(trimmed, title)
}

function onAgentCompleted() {
  // 分析完成后自动切换到报告视图
  if (htmlContent.value) {
    showAgentPanel.value = false
  }
}

function onAgentCorrected(corrected: any[]) {
  // 更新本地字幕
  finalSentences.value = [...corrected]
}

// --- Agent 面板事件处理（meeting 分支合并） ---
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
  
  // 切换到 Agent 面板并触发报告生成
  showAgentPanel.value = true
  await nextTick()
  if (assistPanelRef.value) {
    assistPanelRef.value.generateReport(transcript)
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// --- Action item formatters (support both string and object forms) ---
function formatActionItem(item: any): string {
  if (item == null) return ''
  if (typeof item === 'string') return item
  return item.task || item.text || ''
}

function formatActionAssignee(item: any): string {
  if (item && typeof item === 'object') return item.assignee || ''
  return ''
}

function formatActionDeadline(item: any): string {
  if (item && typeof item === 'object') return item.deadline || ''
  return ''
}

// 声浪可视化已迁移到 <WaveformCanvas>，本组件只保留 analyser ref 与录音控制。

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
    const config = {
      interval_seconds: analysisInterval.value,
      interval_sentences: analysisIntervalSentences.value,
      trigger_mode: analysisTriggerMode.value,
    }
    const result = await meetingASRApi.startAnalysis(config)
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

async function triggerAnalysis() {
  await analyzeWithHermesAgent()
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
    <!-- 左侧边栏（拆分自 MeetingView 主体） -->
    <MeetingSidebar
      v-model:expanded="showSidebar"
      :sessions="sidebarSessions"
      :active-id="meetingStore.activeSessionId"
      @create="openCreateModal"
      @select="selectMeetingById"
    >
      <template #item-actions="{ session }">
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
      </template>
    </MeetingSidebar>

    <!-- 主内容区 -->
    <div class="meeting-main">
      <!-- 顶部标题栏 -->
      <!-- 顶部控制条（拆分自 MeetingView 主体） -->
      <MeetingTopBar
        :sidebar-expanded="showSidebar"
        :show-agent-panel="showAgentPanel"
        :use-diarize="useDiarize"
        :save-mode="saveMode"
        :speaker-count="speakerCount"
        :speaker-count-options="speakerCountOptions"
        :is-recording="isRecording"
        :has-sentences="sentences.length > 0"
        :hide-speaker-diarization="HIDE_SPEAKER_DIARIZATION"
        @toggle-sidebar="showSidebar = !showSidebar"
        @toggle-agent-panel="showAgentPanel = !showAgentPanel"
        @toggle-diarize="useDiarize = !useDiarize"
        @toggle-save-mode="saveMode = !saveMode"
        @update:speaker-count="speakerCount = $event"
        @clear-transcript="clearTranscript"
      />

      <!-- 主内容区 -->
      <div class="meeting-content">
      <!-- 左侧：转写区域 -->
      <div class="transcript-panel">
        <!-- 可视化区域 -->
        <WaveformCanvas :analyser="analyser" :connecting="isConnecting" />

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

        <!-- 转写内容（拆分自 MeetingView 主体） -->
        <TranscriptList
          :sentences="sentences"
          :partial-text="partialText"
          :highlighted-index="highlightedSentenceIndex"
          :is-recording="isRecording"
          :hide-speaker-diarization="HIDE_SPEAKER_DIARIZATION"
          @seek="seekToSentence"
          @rename="onTranscriptRename"
        />

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

      <!-- 右侧：分析面板（壳已拆出 MeetingRightPanel） -->
      <MeetingRightPanel
        :visible="showRightPanel"
        :is-speech-scene="isSpeechScene"
        :show-agent-panel="showAgentPanel"
        :resize-style="rightPanelStyle"
        @close="showRightPanel = false"
        @resize-start="startRightPanelResize"
      >
        <template #toolbar>
          <div class="toolbar-actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  type="primary"
                  :loading="isLoading && !isAnalyzing"
                  :disabled="sentences.length === 0"
                  @click="triggerAnalysis"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </template>
                  {{ t('meeting.triggerAnalysis') }}
                </NButton>
              </template>
              {{ sentences.length === 0 ? t('meeting.noTranscript') : '' }}
            </NTooltip>

            <NButton
              size="tiny"
              type="primary"
              @click="triggerAnalysis"
              :loading="isLoading"
              :disabled="sentences.length === 0"
            >
              {{ t('meeting.generateReport') }}
            </NButton>

            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  :type="isAnalyzing ? 'warning' : 'default'"
                  :disabled="sentences.length === 0"
                  @click="isAnalyzing ? stopAnalysis() : startAnalysis()"
                >
                  <template #icon>
                    <svg v-if="!isAnalyzing" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="6" y="4" width="4" height="16"/>
                      <rect x="14" y="4" width="4" height="16"/>
                    </svg>
                  </template>
                  {{ isAnalyzing ? t('meeting.stopAnalysis') : t('meeting.startAnalysis') }}
                </NButton>
              </template>
            </NTooltip>

            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  @click="showAnalysisConfig = true"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t('meeting.analysisTriggerConfig') }}
            </NTooltip>

            <!-- Agent 切换：靠右 -->
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
          </div>
        </template>

        <template #speech>
          <SpeechEvaluationPanel
            v-if="meetingStore.activeSessionId"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #agent>
          <MeetingAgentPanel
            v-if="meetingStore.activeSessionId"
            ref="assistPanelRef"
            :session-id="meetingStore.activeSessionId"
            :scene-template="activeSession?.sceneTemplate || 'general'"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
            @request-report="onRequestReport"
            :start-trigger="agentStartAnalysisTrigger"
            @update:analysis-result="onAgentAnalysisResult"
            @update:report-html="onAgentReportHtml"
            @completed="onAgentCompleted"
            @corrected="onAgentCorrected"
          />
        </template>

        <template #analysis>
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
                    <div class="action-body">
                      <span class="action-text">{{ formatActionItem(item) }}</span>
                      <span v-if="formatActionAssignee(item)" class="action-assignee">
                        👤 {{ formatActionAssignee(item) }}
                      </span>
                      <span v-if="formatActionDeadline(item)" class="action-deadline">
                        📅 {{ formatActionDeadline(item) }}
                      </span>
                    </div>
                  </li>
                </ul>
              </div>

              <div v-if="analysisResult.decisions?.length" class="result-section">
                <h3>{{ t('meeting.decisions') }}</h3>
                <ol class="decision-list">
                  <li v-for="(d, i) in analysisResult.decisions" :key="i">{{ d }}</li>
                </ol>
              </div>

              <div v-if="analysisResult.risks?.length" class="result-section">
                <h3>{{ t('meeting.risks') }}</h3>
                <ul>
                  <li v-for="(r, i) in analysisResult.risks" :key="i">{{ r }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.learnings?.length" class="result-section">
                <h3>{{ t('meeting.learnings') }}</h3>
                <ul>
                  <li v-for="(l, i) in analysisResult.learnings" :key="i">{{ l }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.feedback?.positive?.length || analysisResult.feedback?.negative?.length" class="result-section">
                <h3>{{ t('meeting.feedback') }}</h3>
                <div class="feedback-grid">
                  <div v-if="analysisResult.feedback.positive?.length" class="feedback-positive">
                    <h4>{{ t('meeting.feedbackPositive') }}</h4>
                    <ul>
                      <li v-for="(f, i) in analysisResult.feedback.positive" :key="i">{{ f }}</li>
                    </ul>
                  </div>
                  <div v-if="analysisResult.feedback.negative?.length" class="feedback-negative">
                    <h4>{{ t('meeting.feedbackNegative') }}</h4>
                    <ul>
                      <li v-for="(f, i) in analysisResult.feedback.negative" :key="i">{{ f }}</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div v-if="analysisResult.people_mentioned?.length" class="result-section">
                <h3>{{ t('meeting.peopleMentioned') }}</h3>
                <div class="people-container">
                  <NTag v-for="(p, i) in analysisResult.people_mentioned" :key="i" type="info" size="small">
                    {{ p }}
                  </NTag>
                </div>
              </div>

              <div v-if="analysisResult.relationships?.length" class="result-section">
                <h3>{{ t('meeting.relationships') }}</h3>
                <div class="relationship-list">
                  <div v-for="(r, i) in analysisResult.relationships" :key="i" class="relationship-item">
                    <span class="rel-source">{{ r.source }}</span>
                    <span class="rel-arrow">→</span>
                    <span class="rel-target">{{ r.target }}</span>
                    <span class="rel-desc">{{ r.relation }}</span>
                  </div>
                </div>
              </div>

              <div v-if="analysisResult.meeting_type" class="result-section meeting-type">
                <NTag type="primary" size="small">{{ analysisResult.meeting_type }}</NTag>
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
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <p>{{ t('meeting.analysisHint') }}</p>
              <NButton
                type="primary"
                size="small"
                :loading="isLoading && !isAnalyzing"
                :disabled="sentences.length === 0"
                @click="triggerAnalysis"
              >
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                </template>
                {{ t('meeting.triggerAnalysis') }}
              </NButton>
            </div>

            <!-- 报告预览：有 htmlContent 时直接渲染，HTML 内容始终可见 -->
            <div v-if="htmlContent" class="report-preview-section">
              <div class="report-preview-header">
                <h3>{{ t('meeting.reportPreview') }}</h3>
                <div class="report-preview-actions">
                  <NButton size="tiny" @click="showReport = true">
                    {{ t('meeting.openReport') }}
                  </NButton>
                  <NButton size="tiny" @click="downloadReport" :disabled="isRecording">
                    {{ t('meeting.downloadReport') }}
                  </NButton>
                </div>
              </div>
              <iframe :srcdoc="htmlContent" class="report-preview-iframe"></iframe>
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
      </MeetingRightPanel>
      </div>
    </div>

<!-- 创建会议对话框（外壳已拆出 CreateMeetingDialog） -->
    <CreateMeetingDialog
      v-model:visible="showCreateModal"
      :create-disabled="!newMeetingTitle.trim() || (!asrApiKey.trim() && !meetingStore.hasASRConfig)"
      @create="handleCreateMeeting"
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

        <div class="form-item">
          <label class="form-label">{{ t('meeting.scene.label') }}</label>
          <SceneTemplatePicker v-model="newMeetingSceneTemplate" />
          <div class="form-hint">{{ t('meeting.scene.hint') }}</div>
        </div>

        <div class="form-section">
          <div class="form-section-title">{{ t('meeting.asrConfig') }}</div>
          <NSteps :current="asrWizardStep" size="small" status="process" class="asr-wizard-steps">
            <NStep :title="t('meeting.wizardStepAsr')" :description="meetingStore.hasASRConfig ? t('meeting.configured') : ''" />
            <NStep :title="t('meeting.wizardStepLlm')" :description="newMeetingAnalysisMode === 'hermes' ? t('meeting.hermesAgent') : (meetingStore.hasLLMConfig ? t('meeting.configured') : t('meeting.optional'))" />
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

            <!-- OSS 配置（说话人分离必填，可折叠）——隐藏说话人分离时一并隐藏 -->
            <details v-if="!HIDE_SPEAKER_DIARIZATION" class="oss-config-details">
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

          <!-- Step 2: 智能分析（可选 — 默认直接使用 Hermes Agent，无需 LLM 配置） -->
          <div v-if="asrWizardStep === 2" class="form-item">
            <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
              {{ t('meeting.llmOptionalHint') }}
            </NAlert>
            <label class="form-label">{{ t('meeting.analysisMode') }}</label>
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
            <!-- 自定义 LLM 配置（仅在选择自定义模式时显示） -->
            <template v-if="newMeetingAnalysisMode === 'custom'">
              <label class="form-label" style="margin-top: 12px">{{ t('meeting.llmApiKey') }}</label>
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
            </template>
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
            <NAlert v-if="newMeetingAnalysisMode === 'custom' && !meetingStore.hasLLMConfig && !llmApiKey" type="info" :show-icon="false" style="margin-bottom: 8px">
              {{ t('meeting.wizardWarnMissingLlm') }}
            </NAlert>
            <ul class="wizard-review-list">
              <li>
                <span class="wizard-review-label">{{ t('meeting.wizardStepAsr') }}:</span>
                <span class="wizard-review-value">{{ (asrApiKey || meetingStore.asrConfig.dashscopeApiKey) ? '✓ ' + t('meeting.configured') : '— ' + t('meeting.notConfigured') }}</span>
              </li>
              <li>
                <span class="wizard-review-label">{{ t('meeting.wizardStepLlm') }}:</span>
                <span class="wizard-review-value">{{ newMeetingAnalysisMode === 'hermes' ? '✓ ' + t('meeting.hermesAgent') : ((llmApiKey || meetingStore.asrConfig.llmApiKey) ? '✓ ' + t('meeting.configured') : '— ' + t('meeting.notConfigured')) }}</span>
              </li>
            </ul>
            <div class="wizard-actions">
              <NButton size="small" @click="asrWizardStep = 2">{{ t('meeting.wizardBack') }}</NButton>
              <NButton size="small" @click="asrWizardStep = 1">{{ t('meeting.wizardRestart') }}</NButton>
            </div>
          </div>
          <div class="form-item">
            <label class="form-label">{{ t('meeting.asrModel') }}</label>
            <NSelect
              v-model:value="newMeetingAsrModel"
              :options="asrModelOptions"
              :placeholder="t('meeting.selectAsrModel')"
            />
            <div class="form-hint">{{ t('meeting.asrModelHint') }}</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">{{ t('meeting.agentConfig') }}</div>
          <!-- 默认 Agent 模式：固定使用 Hermes Agent，仅需选择 Agent 配置（profile） -->
          <template v-if="newMeetingAnalysisMode === 'hermes'">
            <div class="form-item">
              <label class="form-label">{{ t('meeting.selectProfile') }}</label>
              <NSelect
                v-model:value="newMeetingHermesProfile"
                :options="profileOptions"
                :placeholder="t('meeting.selectProfilePlaceholder')"
              />
            </div>
          </template>

          <!-- 自定义 LLM 模式：可选择 Hermes Agent 或 Coding Agent -->
          <template v-else>
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
          </template>
        </div>
      </div>
    </CreateMeetingDialog>

    <!-- 分析触发配置弹窗 -->
    <NModal
      v-model:show="showAnalysisConfig"
      :title="t('meeting.analysisTriggerConfig')"
      preset="dialog"
      :positive-text="t('common.confirm')"
      :negative-text="t('common.cancel')"
      @positive-click="showAnalysisConfig = false"
    >
      <div class="analysis-config-form">
        <div class="config-field">
          <label>{{ t('meeting.triggerMode') }}</label>
          <select v-model="analysisTriggerMode" class="config-select">
            <option value="sentences">{{ t('meeting.triggerModeSentences') }}</option>
            <option value="time">{{ t('meeting.triggerModeTime') }}</option>
            <option value="both">{{ t('meeting.triggerModeBoth') }}</option>
          </select>
        </div>
        
        <div class="config-field" v-if="analysisTriggerMode !== 'time'">
          <label>{{ t('meeting.intervalSentences') }}</label>
          <div class="config-input-group">
            <input 
              type="number" 
              v-model="analysisIntervalSentences" 
              :min="1" 
              :max="100"
              class="config-input"
            />
            <span class="config-unit">{{ t('meeting.sentencesUnit') }}</span>
          </div>
          <span class="config-hint">{{ t('meeting.intervalSentencesHint') }}</span>
        </div>
        
        <div class="config-field" v-if="analysisTriggerMode !== 'sentences'">
          <label>{{ t('meeting.intervalSeconds') }}</label>
          <div class="config-input-group">
            <input 
              type="number" 
              v-model="analysisInterval" 
              :min="10" 
              :max="600"
              class="config-input"
            />
            <span class="config-unit">{{ t('meeting.secondsUnit') }}</span>
          </div>
          <span class="config-hint">{{ t('meeting.intervalSecondsHint') }}</span>
        </div>
      </div>
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

// 左侧边栏布局（容器+删除按钮样式由父级提供；列表项内层样式已迁入 MeetingSidebar）
:deep(.sidebar-backdrop) {
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

:deep(.meeting-sidebar) {
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

:deep(.page-sidebar-top) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 12px;
  gap: 8px;
}

:deep(.meeting-list) {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:deep(.meeting-list-item) {
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

:deep(.meeting-item-icon) {
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

:deep(.meeting-item-content) {
  flex: 1;
  min-width: 0;
}

// 删除按钮由父级 slot 渲染（包 NPopconfirm），故其样式留在父级
:deep(.meeting-item-delete) {
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

  &:hover {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }
}

// 让 hover 父级（列表项）时显示删除按钮——拆成独立规则，因为 SCSS 嵌套 + :deep + & 不能正确编译。
:deep(.meeting-list-item:hover) .meeting-item-delete {
  opacity: 1;
}

.meeting-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

:deep(.header-avatar-toggle) {
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

:deep(.header-logo) {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

// 顶部控制条样式（MeetingTopBar 子组件内部 DOM，scoped 需用 :deep 穿透）
:deep(.meeting-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  background: $bg-card;
  flex-shrink: 0;
}

:deep(.meeting-title) {
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

:deep(.meeting-controls) {
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

// .waveform-container / .connecting-overlay 已迁入 WaveformCanvas 组件。

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

// 转写内容样式（.transcript-content/.empty-state/.sentence-item/.sentence-speaker/
// .partial-text 等）已迁入 TranscriptList.vue scoped 样式。

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

// 右侧面板：chrome 已迁入 MeetingRightPanel.vue
// 父组件只保留分析内容区域的样式（result-section / download-section / ...）

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

// 新增分析结果样式
.decision-list {
  margin: 0;
  padding-left: 24px;

  li {
    font-size: 14px;
    line-height: 1.7;
    margin-bottom: 6px;
    color: #2e7d32;
  }
}

.feedback-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
}

.feedback-positive,
.feedback-negative {
  padding: 12px;
  border-radius: 8px;

  h4 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  ul {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 4px;
    }
  }
}

.feedback-positive {
  background: rgba(76, 175, 80, 0.1);
  border-left: 3px solid #4caf50;

  h4 { color: #2e7d32; }
  li { color: #2e7d32; }
}

.feedback-negative {
  background: rgba(244, 67, 54, 0.1);
  border-left: 3px solid #f44336;

  h4 { color: #c62828; }
  li { color: #c62828; }
}

.people-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.relationship-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.relationship-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(156, 39, 176, 0.05);
  border-radius: 8px;
  flex-wrap: wrap;
}

.rel-source,
.rel-target {
  font-weight: 600;
  color: #6a1b9a;
  font-size: 13px;
}

.rel-arrow {
  color: #9c27b0;
}

.rel-desc {
  color: $text-secondary;
  font-size: 12px;
  flex: 1;
  min-width: 100px;
}

.action-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.action-assignee,
.action-deadline {
  font-size: 11px;
  color: #856404;
}

.meeting-type {
  display: flex;
  justify-content: flex-start;
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
  padding: 24px 16px;
  gap: 12px;
  color: $text-secondary;

  p {
    font-size: 13px;
    text-align: center;
    line-height: 1.5;
    margin: 0;
  }
}

// 报告预览：直接内嵌 iframe 渲染已生成的 HTML
.report-preview-section {
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.2);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 16px;
  background: $bg-card;
}

.report-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(var(--accent-primary-rgb), 0.04);
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;

  h3 {
    font-size: 12px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.report-preview-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.report-preview-iframe {
  width: 100%;
  height: 480px;
  border: none;
  background: white;
  display: block;
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

// 分析配置弹窗表单样式
.analysis-config-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label {
    font-size: 13px;
    font-weight: 500;
    color: $text-primary;
  }
}

.config-select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: 6px;
  font-size: 14px;
  background: $bg-primary;
  color: $text-primary;
  cursor: pointer;

  &:focus {
    outline: none;
    border-color: $accent-primary;
  }
}

.config-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: 6px;
  font-size: 14px;
  background: $bg-primary;
  color: $text-primary;

  &:focus {
    outline: none;
    border-color: $accent-primary;
  }
}

.config-unit {
  font-size: 14px;
  color: $text-secondary;
  white-space: nowrap;
}

.config-hint {
  font-size: 12px;
  color: $text-secondary;
  opacity: 0.8;
}
</style>
