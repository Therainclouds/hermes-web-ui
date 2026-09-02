<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NSelect, NSwitch, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOmniRealtime, type OmniDialogToolCall } from '@/composables/useOmniRealtime'
import OmniVisualizer from '@/components/hermes/chat/OmniVisualizer.vue'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { executeOmniTool, PRACTICE_REALTIME_TOOLS } from '@/api/hermes/omni-tools'
import { savePracticeReport } from '@/api/hermes/practice-report'
import { getDownloadUrl } from '@/api/hermes/download'
import { uid, useChatStore, type Message } from '@/stores/hermes/chat'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import {
  buildRealtimeInstructions,
  serializeChatHistory,
  countUserTurns,
  CONTEXT_WARNING_RATIO,
} from '@/utils/realtime-instructions'
import {
  buildPracticeInstructionBlock,
  buildPracticeReportMarkdown,
  formatPracticeCountdown,
  practiceReportFileStem,
  PRACTICE_COACH_SOUL,
  PRACTICE_DIFFICULTY_LABELS,
  PRACTICE_LANGUAGE_LABELS,
  type PracticeFeedbackRecord,
  type PracticeSessionConfig,
  type PracticeTurnRecord,
} from '@/utils/practice-mode'

/**
 * 口语对练舞台（Chat 侧全屏）。
 *
 * 复用与实时对话（OmniRealtimeStage）完全相同的 Omni-Realtime 音频链路
 * （/ws/omni-realtime → Qwen-Omni-Realtime），差异点：
 *   - 会话指令 = buildRealtimeInstructions(soul, { scenario: 对练守则 })，
 *     模型扮演目标语言口语教练，围绕用户填写的练习方向引导对话；
 *   - 工具集 = PRACTICE_REALTIME_TOOLS：既有工作台工具全部保留（含
 *     query_hermes_agent 的 Agent 能力），并追加 submit_practice_feedback——
 *     模型每轮用户发言后调用它提交结构化打分（1-10 分）；
 *   - 右侧评分卡实时展示「最新一轮打分」，历史轮次累积；
 *   - 结束后可把「逐轮评分 + 点评 + 完整对话」保存为 Markdown 分析报告
 *     （服务端落盘 + 下载链接），分析内容不再只留在会话里。
 */

const props = defineProps<{
  /** 与会议实时对话一致：未配置 DashScope Key 时提示先去配置。 */
  hasDashscopeKey: boolean
  /** 新建对话抽屉里手动填写的练习配置（语言 / 方向 / 难度）。 */
  config: PracticeSessionConfig
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

const chatStore = useChatStore()
const meetingStore = useMeetingStore()
const realtimeModelStore = useRealtimeModelStore()

// Voices verified against the DashScope Qwen-Omni-Realtime catalogue.
// The same voice IDs are accepted by every qwen3.5-omni-* / qwen3-omni-*
// model — see OmniRealtimeStage.vue for the registry comment.
const voiceOptions: SelectOption[] = [
  { label: 'Tina (女声 · 中文 · 默认)', value: 'Tina' },
  { label: 'Serena (女声 · 中文)', value: 'Serena' },
  { label: 'Ethan (男声 · 中文)', value: 'Ethan' },
  { label: 'Jennifer (女声 · 中文)', value: 'Jennifer' },
  { label: 'Ryan (男声 · 中文)', value: 'Ryan' },
]
const selectedVoice = ref('Tina')
selectedVoice.value = realtimeModelStore.config.voice || 'Tina'

const languageLabel = computed(() =>
  PRACTICE_LANGUAGE_LABELS[props.config.language] || props.config.language,
)
const difficultyLabel = computed(() =>
  PRACTICE_DIFFICULTY_LABELS[props.config.difficulty] || props.config.difficulty,
)

const omni = useOmniRealtime({
  handsFree: true,
  autoBargeIn: true,
  tools: PRACTICE_REALTIME_TOOLS,
  onToolCall: handlePracticeTool,
  onError: () => undefined,
})

const phase = omni.phase
const isActive = computed(() => phase.value !== 'idle' && phase.value !== 'closed')
const canStart = computed(() => props.hasDashscopeKey && !isActive.value && !ended.value)

const preparing = ref(false)
const backendError = ref('')

// --- 摄像头（可选）：开启后模型「看得到」用户，评分维度会加入肢体语言 ---

const cameraEnabled = ref(false)
const cameraStream = ref<MediaStream | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const cameraNotice = ref('')
const FRAME_INTERVAL_MS = 1000
const MAX_FRAME_DIM = 640
let captureTimer: number | null = null
let framesCaptured = 0

async function startCamera(): Promise<void> {
  if (cameraStream.value || typeof navigator.mediaDevices?.getUserMedia !== 'function') return
  try {
    cameraStream.value = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch {
    cameraNotice.value = t('omniRealtime.cameraFailed')
    cameraEnabled.value = false
    setTimeout(() => { cameraNotice.value = '' }, 4000)
  }
}

function stopCamera(): void {
  cameraStream.value?.getTracks().forEach(track => track.stop())
  cameraStream.value = null
}

function captureAndSendFrame(): void {
  const video = videoRef.value
  if (!video || !cameraStream.value) return
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return
  const scale = Math.min(1, MAX_FRAME_DIM / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.translate(width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, width, height)
  try {
    framesCaptured += 1
    if (framesCaptured === 1) {
      console.log(`[speech-practice] camera capture started (${width}x${height})`)
    }
    omni.sendImage(canvas.toDataURL('image/jpeg', 0.6))
  } catch {
    // canvas tainted or toDataURL unavailable — keep the voice session going
  }
}

function startFrameCapture(): void {
  stopFrameCapture()
  captureTimer = window.setInterval(captureAndSendFrame, FRAME_INTERVAL_MS)
}

function stopFrameCapture(): void {
  if (captureTimer !== null) {
    window.clearInterval(captureTimer)
    captureTimer = null
  }
}

/** 会话已结束（disconnect 完成），展示总结 / 报告面板。 */
const ended = ref(false)
const sessionStartedAt = ref(0)
const sessionEndedAt = ref(0)

// --- 练习时长 / 倒计时（定时练习：到点自动结束并生成报告） ----------------

/** 配置的练习时长（毫秒）；0 = 不限时。 */
const durationTotalMs = computed(() => {
  const minutes = Number(props.config.durationMinutes) || 0
  return minutes > 0 ? minutes * 60_000 : 0
})
/** 剩余毫秒（仅在定时练习且会话进行中持续更新）。 */
const timeLeftMs = ref(0)
/** 本次会话是被倒计时自动结束的（结束时自动保存报告）。 */
const autoFinished = ref(false)
const countdownActive = computed(() => durationTotalMs.value > 0 && isActive.value && !ended.value)
const countdownText = computed(() => formatPracticeCountdown(timeLeftMs.value))
const countdownWarning = computed(() => countdownActive.value && timeLeftMs.value <= 60_000)

let countdownHandle: number | null = null
let countdownDeadline = 0

function stopCountdown(): void {
  if (countdownHandle !== null) {
    window.clearTimeout(countdownHandle)
    countdownHandle = null
  }
}

function startCountdown(): void {
  stopCountdown()
  if (durationTotalMs.value <= 0) {
    timeLeftMs.value = 0
    return
  }
  countdownDeadline = Date.now() + durationTotalMs.value
  const tick = (): void => {
    const left = countdownDeadline - Date.now()
    timeLeftMs.value = Math.max(0, left)
    if (left <= 0) {
      stopCountdown()
      autoFinishByTimer()
      return
    }
    countdownHandle = window.setTimeout(tick, 250)
  }
  tick()
}

/** 倒计时到点：结束会话并自动生成 / 保存分析报告。 */
function autoFinishByTimer(): void {
  if (ended.value) return
  autoFinished.value = true
  endSession()
  void handleSaveReport()
}

/** 模型经 submit_practice_feedback 提交的逐轮评分（过程数据，报告来源）。 */
const feedbacks = ref<PracticeFeedbackRecord[]>([])
const latestFeedback = computed(() => {
  const list = feedbacks.value
  return list.length > 0 ? list[list.length - 1] : null
})

// --- 会话标题 / 上下文告警 ------------------------------------------------

const sessionTitle = computed(() => {
  const sessionTitleText = chatStore.activeSession?.title?.trim()
  if (sessionTitleText) return sessionTitleText
  const direction = (props.config.direction || '').trim()
  return direction ? `${t('speechPractice.entry')} · ${direction}` : t('speechPractice.entry')
})

const usedUserTurns = computed(() => countUserTurns(omni.turns.value))
const contextLimitTotal = computed(() => realtimeModelStore.limits?.audioTurns ?? null)
const nearContextLimit = computed(() => {
  const total = contextLimitTotal.value
  if (!total) return false
  return usedUserTurns.value >= Math.floor(total * CONTEXT_WARNING_RATIO)
})

const statusLabel = computed(() => t(`meeting.realtime.phase.${phase.value}`))

const orbPhase = computed(() => {
  switch (phase.value) {
    case 'connecting': return 'connecting'
    case 'listening': return 'listening'
    case 'speaking': return 'speaking'
    case 'error': return 'error'
    default: return 'idle'
  }
})

// --- 气泡层（与 OmniRealtimeStage 相同，最近几条 + live 文本） -----------

interface StageBubble {
  key: string
  role: 'user' | 'assistant'
  text: string
  live: boolean
}

const bubbles = computed<StageBubble[]>(() => {
  const turns = [...omni.turns.value]
  const liveAssistant = omni.liveAssistantText.value.trim()
  if (liveAssistant) {
    const last = turns[turns.length - 1]
    if (last && last.role === 'assistant' && last.text.trim() === liveAssistant) {
      turns.pop()
    }
  }
  const list: StageBubble[] = turns.slice(-3).map(turn => ({
    key: `${turn.role}:${turn.timestamp}`,
    role: turn.role,
    text: turn.text,
    live: false,
  }))
  if (omni.liveUserText.value) {
    list.push({ key: 'live-user', role: 'user', text: omni.liveUserText.value, live: true })
  }
  if (liveAssistant) {
    list.push({ key: 'live-assistant', role: 'assistant', text: liveAssistant, live: true })
  }
  return list.slice(-4)
})

const caption = computed(() => {
  if (backendError.value) return backendError.value
  if (displayError.value) return displayError.value
  if (omni.isOutputPlaying.value) return ''
  if (phase.value === 'speaking') return ''
  if (phase.value === 'idle' || phase.value === 'closed') return t('speechPractice.liveHint')
  return t('speechPractice.handsFreeHint')
})

const displayError = computed(() => {
  const raw = omni.errorMessage.value
  if (!raw) return ''
  if (/realtime session error/i.test(raw)) return t('omniRealtime.sessionError')
  return raw
})

// --- 工具执行：对练评分工具本地处理，其余工具保留原 Agent 能力 ----------

const PRACTICE_TOOL_NAME = 'submit_practice_feedback'

function toScore(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(1, Math.min(10, Math.round(n)))
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 600) : ''
}

function recordPracticeFeedback(args: Record<string, unknown>): string {
  // 归属到「当前正在被点评」的用户轮次：工具调用通常紧随该轮 user 转写提交，
  // 以此刻已提交的 user 轮次数作为轮次号（从 1 起）；无 user 轮次时记 0（不归属）。
  const userTurnCount = omni.turns.value.filter(turn => turn.role === 'user').length
  const round = userTurnCount

  const record: PracticeFeedbackRecord = {
    round,
    overall: toScore(args.overall) ?? 0,
    fluency: toScore(args.fluency),
    pronunciation: toScore(args.pronunciation),
    grammar: toScore(args.grammar),
    vocabulary: toScore(args.vocabulary),
    content: toScore(args.content),
    // 摄像头开启时模型才会提交 bodyLanguage；关摄像头时即便模型误填也忽略，
    // 避免“看不见却打分”的编造。
    bodyLanguage: cameraEnabled.value ? toScore(args.bodyLanguage) : null,
    comment: cleanText(args.comment),
    strengths: cleanText(args.strengths),
    improvements: cleanText(args.improvements),
    example: cleanText(args.example),
    at: Date.now(),
  }
  feedbacks.value = [...feedbacks.value, record]

  const scored = record.overall > 0
  const when = round > 0 ? t('speechPractice.scoredRound', { n: round }) : t('speechPractice.scoredUnattached')
  return `${when}，${scored ? t('speechPractice.scoredOverall', { score: record.overall }) : t('speechPractice.scoredNoOverall')}`
}

async function handlePracticeTool(name: string, argsJson: string): Promise<string> {
  if (name !== PRACTICE_TOOL_NAME) {
    // 保留既有 Agent 能力：记忆 / 技能 / 会话 / 任务 / query_hermes_agent 等
    return executeOmniTool(name, argsJson)
  }
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = argsJson ? JSON.parse(argsJson) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    return JSON.stringify({ error: '无效的工具参数 JSON' })
  }
  try {
    return recordPracticeFeedback(args)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return JSON.stringify({ error: message })
  }
}

// 最新一次工具调用的 inline 提示（正在评分 / 已完成）
const latestToolCall = computed<OmniDialogToolCall | null>(() => {
  const list = omni.toolCalls.value
  return list.length > 0 ? list[list.length - 1] : null
})

const toolPillText = computed(() => {
  const call = latestToolCall.value
  if (!call) return ''
  const isScoring = call.name === PRACTICE_TOOL_NAME
  if (call.status === 'running') {
    return isScoring
      ? t('speechPractice.scoringRunning')
      : t('omniRealtime.toolRunningInline', { tool: call.name })
  }
  if (call.status === 'error') {
    return isScoring
      ? t('speechPractice.scoringFailed')
      : t('omniRealtime.toolFailedInline', { tool: call.name })
  }
  if (isScoring) return t('speechPractice.scoringDone')
  const snippet = (call.output || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  return snippet ? `${t('omniRealtime.toolCompletedInline', { tool: call.name })} · ${snippet}` : t('omniRealtime.toolCompletedInline', { tool: call.name })
})

// --- 会话建立 / 结束 -------------------------------------------------------

async function ensureBackendAvailable(timeoutMs = 30_000): Promise<boolean> {
  try {
    const status = await meetingASRApi.getStatus()
    if (status.isRunning) return true
    await meetingASRApi.start({
      dashscopeApiKey: meetingStore.asrConfig.dashscopeApiKey || realtimeModelStore.config.apiKey || undefined,
    })
  } catch {
    // fall through to polling — status/start failures are surfaced below
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 800))
    try {
      const status = await meetingASRApi.getStatus()
      if (status.isRunning) return true
    } catch {
      // keep polling until the deadline
    }
  }
  return false
}

function buildHistoryContext(): string {
  const session = chatStore.activeSession
  if (!session?.messages?.length) return ''
  return serializeChatHistory(session.messages)
}

async function connectWithCoachPersona(): Promise<boolean> {
  // 不注入用户 Agent 的 SOUL.md——工作台助理人格与「目标语言口语教练」
  // 人格直接冲突（中文回复 vs 全程目标语言、助理行为 vs 陪练行为）。对练
  // 用固定教练人格作为 soul 位输入，工具守则/历史摘要/对练守则照常叠加。
  const ready = await ensureBackendAvailable()
  if (!ready) {
    backendError.value = t('omniRealtime.backendUnavailable')
    return false
  }
  // 摄像头在连接前打开，模型从第一轮起就能看到用户画面
  if (cameraEnabled.value) await startCamera()
  await omni.connect({
    voice: selectedVoice.value,
    model: realtimeModelStore.config.model || undefined,
    instructions: buildRealtimeInstructions(PRACTICE_COACH_SOUL, {
      history: buildHistoryContext(),
      scenario: buildPracticeInstructionBlock(props.config, { cameraOn: cameraEnabled.value }),
    }),
  })
  // 音频流已开始推流后（DashScope 要求先有音频再补图像），启动取帧
  if (cameraStream.value) startFrameCapture()
  return true
}

async function startSession(): Promise<void> {
  if (!canStart.value || preparing.value) return
  // 用户手势内预建播放 AudioContext：ws.onopen 时后端可能仍在启动，浏览器
  // 自动播放策略会拒绝在非手势回调里恢复音频 → AI 无声。见
  // useOmniRealtime.prearmPlayback。
  void omni.prearmPlayback()
  writtenTurnIds.clear()
  writtenToolCallIds.clear()
  backendError.value = ''
  ended.value = false
  autoFinished.value = false
  feedbacks.value = []
  preparing.value = true
  try {
    const ok = await connectWithCoachPersona()
    if (ok) {
      sessionStartedAt.value = Date.now()
      startCountdown()
    }
  } finally {
    preparing.value = false
  }
}

async function resumeSession(): Promise<void> {
  if (phase.value !== 'error' || preparing.value || ended.value) return
  void omni.prearmPlayback()
  backendError.value = ''
  preparing.value = true
  try {
    await connectWithCoachPersona()
  } finally {
    preparing.value = false
  }
}

function endSession(): void {
  if (ended.value) return
  ended.value = true
  sessionEndedAt.value = Date.now()
  stopCountdown()
  timeLeftMs.value = 0
  stopFrameCapture()
  stopCamera()
  omni.disconnect()
  flushPendingPersistence()
}

function handleClose(): void {
  if (isActive.value) {
    endSession()
    return
  }
  stopEverything()
  emit('close')
}

function stopEverything(): void {
  stopCountdown()
  stopFrameCapture()
  stopCamera()
  flushPendingPersistence()
  omni.disconnect()
}

function toggleMute(): void {
  omni.setMicStreaming(!omni.isPushing.value)
}
const isMuted = computed(() => !omni.isPushing.value && isActive.value)

// 摄像头预览流绑定到 <video>（flush post：等 v-if 挂载完成）
watch(cameraStream, (stream) => {
  const el = videoRef.value
  if (el) el.srcObject = stream ?? null
}, { flush: 'post' })

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') handleClose()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  stopEverything()
})

// --- 逐轮 / 工具调用持久化到当前 chat 会话（与 OmniRealtimeStage 同款） ---

function turnToMessage(turn: { role: 'user' | 'assistant'; text: string; timestamp: number }): Message {
  return {
    id: uid(),
    role: turn.role === 'user' ? 'user' : 'assistant',
    content: turn.text,
    timestamp: turn.timestamp,
  }
}

function toolCallToMessage(call: OmniDialogToolCall): Message {
  const startedAt = call.startedAt
  const finishedAt = call.finishedAt || Date.now()
  const durationMs = Math.max(0, finishedAt - startedAt)
  let preview = ''
  try {
    const parsed = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
    preview = JSON.stringify(parsed).slice(0, 220)
  } catch {
    preview = (call.argsJson || '').slice(0, 220)
  }
  const resultSnippet = (call.output || '').slice(0, 280)
  return {
    id: uid(),
    role: 'tool',
    content: '',
    timestamp: startedAt,
    toolName: call.name,
    toolCallId: call.callId,
    toolArgs: safeParseJson(call.argsJson),
    toolResult: resultSnippet,
    toolPreview: preview,
    toolStatus: call.status,
    toolDuration: Math.round((durationMs / 1000) * 10) / 10,
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function persistMessage(message: Message): void {
  const sessionId = chatStore.activeSessionId
  if (!sessionId) return
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (!session) return
  if (session.messages.some(existing => existing.id === message.id)) return
  chatStore.addMessage(sessionId, message)
  session.updatedAt = Date.now()
}

function touchSession(): void {
  const sessionId = chatStore.activeSessionId
  if (!sessionId) return
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (session) session.updatedAt = Date.now()
}

const writtenTurnIds = new Set<string>()
const writtenToolCallIds = new Set<string>()

watch(() => omni.turns.value, (turns) => {
  if (!chatStore.activeSessionId) return
  for (const turn of turns) {
    const key = `${turn.role}:${turn.timestamp}:${turn.text}`
    if (writtenTurnIds.has(key)) continue
    writtenTurnIds.add(key)
    persistMessage(turnToMessage(turn))
  }
}, { deep: true })

watch(() => omni.toolCalls.value, (calls) => {
  if (!chatStore.activeSessionId) return
  for (const call of calls) {
    if (call.status === 'running') {
      if (writtenToolCallIds.has(call.callId)) continue
      writtenToolCallIds.add(call.callId)
      persistMessage(toolCallToMessage(call))
    } else if (!writtenToolCallIds.has(call.callId + ':done')) {
      writtenToolCallIds.add(call.callId + ':done')
      persistMessage(toolCallToMessage(call))
    } else {
      touchSession()
    }
  }
}, { deep: true })

function flushPendingPersistence(): void {
  if (!chatStore.activeSessionId) return
  for (const turn of omni.turns.value) {
    const key = `${turn.role}:${turn.timestamp}:${turn.text}`
    if (writtenTurnIds.has(key)) continue
    writtenTurnIds.add(key)
    persistMessage(turnToMessage(turn))
  }
  for (const call of omni.toolCalls.value) {
    const flag = call.status === 'running' ? '' : ':done'
    if (writtenToolCallIds.has(call.callId + flag)) continue
    writtenToolCallIds.add(call.callId + flag)
    persistMessage(toolCallToMessage(call))
  }
}

// --- 评分汇总（结束面板 / 报告共用） --------------------------------------

const SCORE_DIMENSION_KEYS = [
  'overall', 'fluency', 'pronunciation', 'grammar', 'vocabulary', 'content',
] as const

/** 最新反馈卡里逐条展示的五个细分维度（不含 overall）。 */
const detailDimKeys = ['fluency', 'pronunciation', 'grammar', 'vocabulary', 'content'] as const

/** 是否有任意一轮填了肢体语言分（摄像头开启时才会有）。 */
const hasBodyLanguageScores = computed(() =>
  feedbacks.value.some(f => f.bodyLanguage != null),
)

function dimensionLabel(key: string): string {
  const map: Record<string, string> = {
    overall: t('speechPractice.score.overall'),
    fluency: t('speechPractice.score.fluency'),
    pronunciation: t('speechPractice.score.pronunciation'),
    grammar: t('speechPractice.score.grammar'),
    vocabulary: t('speechPractice.score.vocabulary'),
    content: t('speechPractice.score.content'),
    bodyLanguage: t('speechPractice.score.bodyLanguage'),
  }
  return map[key] || key
}

interface ScoreSummaryRow {
  key: string
  label: string
  avg: number | null
  max: string
  min: string
}

function averageOf(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  return Math.round((nums.reduce((acc, n) => acc + n, 0) / nums.length) * 10) / 10
}

type PracticeScoreKey = 'overall' | 'fluency' | 'pronunciation' | 'grammar' | 'vocabulary' | 'content' | 'bodyLanguage'

function summaryRow(key: PracticeScoreKey): ScoreSummaryRow {
  const samples = feedbacks.value.map(f => f[key])
  const nums = samples.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return {
    key,
    label: dimensionLabel(key),
    avg: averageOf(samples),
    max: nums.length ? String(Math.max(...nums)) : '—',
    min: nums.length ? String(Math.min(...nums)) : '—',
  }
}

const scoreSummary = computed<ScoreSummaryRow[]>(() => {
  const rows = [...SCORE_DIMENSION_KEYS].map(key => summaryRow(key))
  // 肢体语言只有在「至少一轮填了分」（摄像头开启）时才进入汇总表
  if (hasBodyLanguageScores.value) rows.push(summaryRow('bodyLanguage'))
  return rows
})

const avgOverall = computed(() => {
  const samples = feedbacks.value.filter(f => f.overall > 0).map(f => f.overall)
  return samples.length ? Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10 : null
})

function scoreTone(score: number | null | undefined): string {
  if (score == null || score <= 0) return 'none'
  if (score >= 8) return 'good'
  if (score >= 6) return 'ok'
  return 'weak'
}

function fmtScore(value: number | null | undefined): string {
  return value && value > 0 ? String(value) : '—'
}

// 对话轮次数（用于统计展示）
const dialogueTurns = computed(() => {
  const userCount = omni.turns.value.filter(t => t.role === 'user').length
  const assistantCount = omni.turns.value.filter(t => t.role === 'assistant').length
  return { userCount, assistantCount }
})

// --- 报告：生成 / 保存 / 复制 ----------------------------------------------

const reportMarkdown = computed(() =>
  buildPracticeReportMarkdown({
    config: props.config,
    startedAt: sessionStartedAt.value || Date.now(),
    endedAt: sessionEndedAt.value || Date.now(),
    turns: omni.turns.value as PracticeTurnRecord[],
    feedback: feedbacks.value,
  }),
)

const savingReport = ref(false)
const saveError = ref('')
const savedReport = ref<{ fileName: string; path: string; url: string } | null>(null)
const copied = ref(false)

async function handleSaveReport(): Promise<void> {
  if (savingReport.value) return
  savingReport.value = true
  saveError.value = ''
  savedReport.value = null
  try {
    const suggestedName = practiceReportFileStem(props.config, Date.now())
    const result = await savePracticeReport(reportMarkdown.value, suggestedName)
    if (!result.ok || !result.path || !result.fileName) {
      saveError.value = result.error || t('speechPractice.saveFailed')
      return
    }
    savedReport.value = {
      fileName: result.fileName,
      path: result.path,
      url: getDownloadUrl(result.path, result.fileName),
    }
  } catch (cause) {
    saveError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    savingReport.value = false
  }
}

async function handleCopyMarkdown(): Promise<void> {
  copied.value = false
  try {
    await navigator.clipboard.writeText(reportMarkdown.value)
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // 剪贴板不可用（非安全上下文）时忽略
  }
}
</script>

<template>
  <section
    class="practice-stage"
    :class="[`practice-stage--${orbPhase}`, { 'practice-stage--ended': ended }]"
    role="dialog"
    aria-modal="true"
    :aria-label="t('speechPractice.title')"
    data-testid="speech-practice-stage"
  >
    <div class="practice-stage__wash practice-stage__wash--top" aria-hidden="true" />
    <div class="practice-stage__wash practice-stage__wash--bottom" aria-hidden="true" />

    <header class="practice-stage__header">
      <button class="practice-stage__back" type="button" :aria-label="t('speechPractice.back')" @click="handleClose">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <div class="practice-stage__identity">
        <strong>{{ sessionTitle }}</strong>
        <span data-testid="speech-practice-subtitle">
          {{ languageLabel }} · {{ difficultyLabel }}
          <template v-if="(config.direction || '').trim()">· {{ config.direction.trim() }}</template>
        </span>
      </div>
      <div class="practice-stage__header-right">
        <span
          v-if="countdownActive"
          class="practice-stage__timer"
          :class="{ 'practice-stage__timer--warning': countdownWarning }"
          :aria-label="`${t('speechPractice.timeRemaining')} ${countdownText}`"
          data-testid="speech-practice-timer"
        >⏱ {{ countdownText }}</span>
        <span v-if="!ended" class="practice-stage__phase" data-testid="speech-practice-phase">{{ statusLabel }}</span>
      </div>
    </header>

    <main class="practice-stage__main">
      <!-- 设置卡 -->
      <section v-if="!isActive && !ended" class="practice-stage__setup" data-testid="speech-practice-setup">
        <NAlert v-if="!hasDashscopeKey" type="warning" :show-icon="false" class="practice-stage__alert">
          {{ t('meeting.realtime.needApiKey') }}
        </NAlert>
        <NAlert v-if="backendError" type="error" :show-icon="false" class="practice-stage__alert" data-testid="speech-practice-backend-error">
          {{ backendError }}
        </NAlert>
        <NAlert
          v-if="nearContextLimit && contextLimitTotal"
          type="warning"
          :show-icon="false"
          class="practice-stage__alert"
        >
          {{ t('omniRealtime.contextNearLimit', { used: usedUserTurns, total: contextLimitTotal }) }}
        </NAlert>
        <div class="practice-stage__card">
          <h2>{{ t('speechPractice.title') }}</h2>
          <p class="practice-stage__card-sub">{{ t('speechPractice.subtitle') }}</p>
          <p class="practice-stage__card-meta" data-testid="speech-practice-config">
            <span class="practice-stage__chip">{{ languageLabel }}</span>
            <span class="practice-stage__chip">{{ difficultyLabel }}</span>
            <span
              v-if="durationTotalMs > 0"
              class="practice-stage__chip practice-stage__chip--duration"
              data-testid="speech-practice-duration-chip"
            >⏱ {{ t('speechPractice.timedMinutes', { minutes: config.durationMinutes }) }}</span>
            <span v-if="(config.direction || '').trim()" class="practice-stage__chip practice-stage__chip--direction">
              {{ config.direction.trim() }}
            </span>
          </p>
          <p class="practice-stage__card-hint">{{ t('speechPractice.setupHint') }}</p>
          <div class="practice-stage__field">
            <label>{{ t('meeting.realtime.voice') }}</label>
            <NSelect v-model:value="selectedVoice" :options="voiceOptions" size="small" />
          </div>
          <div class="practice-stage__field practice-stage__field--row">
            <label>{{ t('omniRealtime.camera') }}</label>
            <NSwitch
              v-model:value="cameraEnabled"
              size="small"
              :disabled="!canStart"
              data-testid="speech-practice-camera"
            />
          </div>
          <p v-if="cameraEnabled" class="practice-stage__card-hint" data-testid="speech-practice-camera-hint">
            {{ t('speechPractice.cameraHint') }}
          </p>
          <p v-else-if="cameraNotice" class="practice-stage__card-hint practice-stage__card-hint--error">{{ cameraNotice }}</p>
          <NButton
            type="primary"
            block
            :disabled="!canStart"
            :loading="preparing"
            data-testid="speech-practice-start"
            @click="startSession"
          >
            {{ preparing ? t('meeting.realtime.phase.connecting') : t('speechPractice.startSession') }}
          </NButton>
        </div>
      </section>

      <!-- 结束面板：总结 + 保存报告 -->
      <section v-else-if="ended" class="practice-stage__ended" data-testid="speech-practice-ended">
        <div class="practice-stage__ended-card">
          <h2>{{ t('speechPractice.endedTitle') }}</h2>
          <NAlert
            v-if="autoFinished"
            type="info"
            :show-icon="false"
            class="practice-stage__alert practice-stage__alert--timeup"
            data-testid="speech-practice-timeup-notice"
          >
            {{ t('speechPractice.timeUpNotice') }}
          </NAlert>
          <p class="practice-stage__card-sub">
            {{ t('speechPractice.endedSummary', { user: dialogueTurns.userCount, assistant: dialogueTurns.assistantCount, scored: feedbacks.length }) }}
          </p>

          <div class="practice-stage__avg">
            <span class="practice-stage__avg-score" :data-tone="scoreTone(avgOverall)">
              {{ avgOverall != null ? `${avgOverall}/10` : '—' }}
            </span>
            <span class="practice-stage__avg-label">{{ t('speechPractice.avgOverall') }}</span>
          </div>

          <table class="practice-stage__table">
            <thead>
              <tr>
                <th>{{ t('speechPractice.tableDimension') }}</th>
                <th>{{ t('speechPractice.tableAvg') }}</th>
                <th>{{ t('speechPractice.tableMax') }}</th>
                <th>{{ t('speechPractice.tableMin') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in scoreSummary" :key="row.key">
                <td>{{ row.label }}</td>
                <td :data-tone="scoreTone(row.avg)">{{ row.avg != null ? `${row.avg}/10` : '—' }}</td>
                <td>{{ row.max }}</td>
                <td>{{ row.min }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="feedbacks.length === 0" class="practice-stage__no-data">
            {{ t('speechPractice.noFeedback') }}
          </div>

          <NAlert v-if="saveError" type="error" :show-icon="false" class="practice-stage__alert">
            {{ saveError }}
          </NAlert>

          <div v-if="savedReport" class="practice-stage__saved" data-testid="speech-practice-saved">
            <strong>{{ t('speechPractice.reportSaved') }}</strong>
            <span class="practice-stage__saved-name">{{ savedReport.fileName }}</span>
            <a
              class="practice-stage__download-link"
              :href="savedReport.url"
              :download="savedReport.fileName"
              data-testid="speech-practice-download"
            >{{ t('speechPractice.download') }}</a>
          </div>

          <div class="practice-stage__actions">
            <NButton
              type="primary"
              :loading="savingReport"
              :disabled="dialogueTurns.userCount === 0 && feedbacks.length === 0"
              data-testid="speech-practice-save-report"
              @click="handleSaveReport"
            >
              {{ t('speechPractice.saveReport') }}
            </NButton>
            <NButton :disabled="reportMarkdown.length === 0" @click="handleCopyMarkdown">
              {{ copied ? t('speechPractice.copied') : t('speechPractice.copyMarkdown') }}
            </NButton>
            <NButton quaternary @click="emit('close')">
              {{ t('speechPractice.close') }}
            </NButton>
          </div>
        </div>
      </section>

      <!-- 进行中：舞台 + 右侧评分卡 -->
      <section v-else class="practice-stage__live" data-testid="speech-practice-live">
        <div class="practice-stage__body">
          <div class="practice-stage__stage">
            <div
              v-if="cameraStream"
              class="practice-stage__camera"
              data-testid="speech-practice-camera-preview"
            >
              <video ref="videoRef" autoplay playsinline muted />
            </div>
            <NAlert
              v-if="nearContextLimit && contextLimitTotal"
              type="warning"
              :show-icon="false"
              class="practice-stage__alert practice-stage__alert--live"
            >
              {{ t('omniRealtime.contextNearLimit', { used: usedUserTurns, total: contextLimitTotal }) }}
            </NAlert>

            <div class="practice-stage__visualizer-zone">
              <OmniVisualizer
                :phase="orbPhase"
                :input-level="omni.inputLevel.value"
                :output-level="omni.outputLevel.value"
                class="practice-stage__visualizer"
              />
            </div>

            <TransitionGroup name="practice-bubble" tag="div" class="practice-stage__bubbles" aria-live="polite">
              <div
                v-for="b in bubbles"
                :key="b.key"
                class="practice-stage__bubble"
                :class="[`practice-stage__bubble--${b.role}`, { 'practice-stage__bubble--live': b.live }]"
              >{{ b.text }}</div>
            </TransitionGroup>

            <p
              class="practice-stage__caption"
              aria-live="polite"
              aria-atomic="true"
              data-testid="speech-practice-caption"
            >{{ caption }}</p>

            <div
              v-if="latestToolCall"
              class="practice-stage__tool-inline"
              aria-live="polite"
              data-testid="speech-practice-tool-calls"
            >
              <span
                class="practice-stage__tool-indicator"
                :class="`practice-stage__tool-indicator--${latestToolCall.status}`"
                aria-hidden="true"
              >
                <span
                  v-if="latestToolCall.status === 'running'"
                  class="practice-stage__tool-spinner"
                />
                <svg v-else-if="latestToolCall.status === 'error'" viewBox="0 0 20 20">
                  <path d="m6.5 6.5 7 7m0-7-7 7" />
                </svg>
                <svg v-else viewBox="0 0 20 20">
                  <path d="m5.5 10.2 2.8 2.8 6.2-6.2" />
                </svg>
              </span>
              <span class="practice-stage__tool-inline-copy">{{ toolPillText }}</span>
            </div>

            <NButton
              v-if="phase === 'error'"
              type="primary"
              size="small"
              :loading="preparing"
              data-testid="speech-practice-resume"
              @click="resumeSession"
            >
              {{ t('speechPractice.resume') }}
            </NButton>

            <div class="practice-stage__controls">
              <button
                class="practice-stage__control"
                type="button"
                :class="{ 'practice-stage__control--muted': isMuted }"
                :aria-pressed="isMuted"
                :aria-label="isMuted ? t('omniRealtime.unmute') : t('omniRealtime.mute')"
                data-testid="speech-practice-mute"
                @click="toggleMute"
              >
                <svg v-if="!isMuted" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
                  <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
                </svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
                  <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
                  <path d="m4 4 16 16" />
                </svg>
              </button>

              <button
                class="practice-stage__control practice-stage__control--interrupt"
                type="button"
                :disabled="phase !== 'speaking'"
                :aria-label="t('meeting.realtime.bargeIn')"
                data-testid="speech-practice-interrupt"
                @click="omni.interrupt()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>

              <button
                class="practice-stage__control practice-stage__control--end"
                type="button"
                :aria-label="t('speechPractice.endSession')"
                data-testid="speech-practice-end"
                @click="endSession"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                  <rect x="2" y="13" width="6" height="8" rx="2" />
                  <rect x="16" y="13" width="6" height="8" rx="2" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 右侧逐轮评分卡 -->
          <aside class="practice-stage__scores" data-testid="speech-practice-scores">
            <header class="practice-stage__scores-header">
              <strong>{{ t('speechPractice.scoreBoard') }}</strong>
              <span v-if="feedbacks.length > 0" class="practice-stage__scores-count">{{ feedbacks.length }}</span>
            </header>

            <div v-if="!latestFeedback" class="practice-stage__scores-empty">
              {{ t('speechPractice.scoresEmpty') }}
            </div>

            <template v-else>
              <div class="practice-stage__feedback-card" data-testid="speech-practice-latest-feedback">
                <div class="practice-stage__feedback-round">
                  {{ latestFeedback.round > 0 ? t('speechPractice.roundLabel', { n: latestFeedback.round }) : t('speechPractice.unattachedRound') }}
                </div>
                <div class="practice-stage__feedback-score-row">
                  <span class="practice-stage__feedback-overall" :data-tone="scoreTone(latestFeedback.overall)">
                    {{ fmtScore(latestFeedback.overall) }}/10
                  </span>
                  <span class="practice-stage__feedback-overall-label">{{ t('speechPractice.score.overall') }}</span>
                </div>
                <div class="practice-stage__feedback-dims">
                  <span
                    v-for="key in detailDimKeys"
                    :key="key"
                    class="practice-stage__dim"
                    :data-tone="scoreTone(latestFeedback[key])"
                  >
                    <i>{{ dimensionLabel(key) }}</i>
                    <b>{{ fmtScore(latestFeedback[key]) }}</b>
                  </span>
                  <span
                    v-if="latestFeedback.bodyLanguage != null"
                    class="practice-stage__dim"
                    :data-tone="scoreTone(latestFeedback.bodyLanguage)"
                    data-testid="speech-practice-bodylanguage-chip"
                  >
                    <i>{{ dimensionLabel('bodyLanguage') }}</i>
                    <b>{{ fmtScore(latestFeedback.bodyLanguage) }}</b>
                  </span>
                </div>
                <p v-if="latestFeedback.comment" class="practice-stage__feedback-comment">{{ latestFeedback.comment }}</p>
                <p v-if="latestFeedback.strengths" class="practice-stage__feedback-line">
                  <em>✨ {{ t('speechPractice.strengths') }}</em> {{ latestFeedback.strengths }}
                </p>
                <p v-if="latestFeedback.improvements" class="practice-stage__feedback-line">
                  <em>💡 {{ t('speechPractice.improvements') }}</em> {{ latestFeedback.improvements }}
                </p>
                <p v-if="latestFeedback.example" class="practice-stage__feedback-line practice-stage__feedback-line--example">
                  <em>✍️ {{ t('speechPractice.example') }}</em> {{ latestFeedback.example }}
                </p>
              </div>

              <div v-if="feedbacks.length > 1" class="practice-stage__history">
                <template v-for="(item, index) in feedbacks.slice(0, -1).slice(-20).reverse()" :key="`${item.at}-${index}`">
                  <div class="practice-stage__history-row">
                    <span class="practice-stage__history-round">
                      {{ item.round > 0 ? t('speechPractice.roundLabel', { n: item.round }) : t('speechPractice.unattachedRound') }}
                    </span>
                    <span class="practice-stage__history-score" :data-tone="scoreTone(item.overall)">
                      {{ fmtScore(item.overall) }}/10
                    </span>
                    <span class="practice-stage__history-comment">{{ item.comment || '—' }}</span>
                  </div>
                </template>
              </div>
            </template>
          </aside>
        </div>
      </section>
    </main>
  </section>
</template>

<style scoped>
/* 口语对练舞台——沿用 Omni 实时对话的设计语言：
 * 不透明 var(--bg-primary) 底 + accent 紫蓝低透明渐变氛围 + 玻璃拟态
 * 面板（--glass-realtime-* 令牌），全部颜色跟随 light/dark 主题。
 * 评分语义色（good/ok/weak）保留，但改用 --success/--warning/--error
 * 主题令牌，两种主题下都做柔化处理。 */
.practice-stage {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  isolation: isolate;
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-primary);
}

.practice-stage__wash {
  position: absolute;
  inset-inline: 0;
  height: 26vh;
  z-index: -1;
  pointer-events: none;
}

.practice-stage__wash--top { background: linear-gradient(rgba(var(--accent-primary-rgb), 0.07), transparent); }
.practice-stage__wash--bottom { background: linear-gradient(transparent, rgba(var(--accent-primary-rgb), 0.05)); }

.practice-stage__header {
  z-index: 3;
  height: 72px;
  padding: env(safe-area-inset-top, 0) clamp(16px, 4vw, 48px) 0;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--glass-realtime-border);
  background: var(--glass-realtime-bg-subtle);
  -webkit-backdrop-filter: var(--glass-realtime-blur);
  backdrop-filter: var(--glass-realtime-blur);
}

.practice-stage__back {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 12px;
  background: var(--glass-realtime-bg);
  color: inherit;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}

.practice-stage__back:hover { background: var(--glass-realtime-bg-strong); border-color: rgba(var(--text-primary-rgb), 0.4); }
.practice-stage__back svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }

.practice-stage__identity { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.practice-stage__identity strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.practice-stage__identity span {
  overflow: hidden;
  color: rgba(var(--text-primary-rgb), 0.58);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.practice-stage__phase {
  padding: 5px 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.34);
  border-radius: 999px;
  color: var(--text-primary);
  background: rgba(var(--accent-primary-rgb), 0.14);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.practice-stage__header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}

.practice-stage__timer {
  padding: 5px 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.34);
  border-radius: 999px;
  color: var(--text-primary);
  background: rgba(var(--accent-primary-rgb), 0.14);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.practice-stage__timer--warning {
  border-color: rgba(var(--warning-rgb), 0.55);
  color: rgb(var(--warning-rgb));
  background: rgba(var(--warning-rgb), 0.12);
  animation: practice-pulse 1.1s ease-in-out infinite;
}

@keyframes practice-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.practice-stage__chip--duration {
  background: rgba(var(--accent-primary-rgb), 0.2);
  border-color: rgba(var(--accent-primary-rgb), 0.4);
}

.practice-stage__alert--timeup { width: 100%; }

.practice-stage__main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  padding: 20px;
}

.practice-stage__setup {
  width: min(460px, calc(100% - 32px));
  margin: 0 auto;
}

.practice-stage__alert { margin-bottom: 14px; }
.practice-stage__alert--live { max-width: 720px; margin: 0 auto 14px; }

.practice-stage__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
  padding: 26px 24px;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 20px;
  background: var(--glass-realtime-bg-strong);
  -webkit-backdrop-filter: var(--glass-realtime-blur-strong);
  backdrop-filter: var(--glass-realtime-blur-strong);
  box-shadow: var(--glass-realtime-shadow);
}

.practice-stage__card h2 { margin: 0; font-size: 18px; font-weight: 620; }
.practice-stage__card-sub { margin: -8px 0 0; color: rgba(var(--text-primary-rgb), 0.62); font-size: 12px; text-align: center; }

.practice-stage__card-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 0;
}

.practice-stage__chip {
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.26);
  color: var(--text-primary);
  font-size: 12px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.practice-stage__chip--direction { background: rgba(var(--accent-primary-rgb), 0.2); border-color: rgba(var(--accent-primary-rgb), 0.4); }

.practice-stage__card-hint { margin: -6px 0 0; color: rgba(var(--text-primary-rgb), 0.52); font-size: 12px; }

.practice-stage__field {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.practice-stage__field--row { flex-direction: row; align-items: center; justify-content: center; gap: 12px; }
.practice-stage__field label { color: rgba(var(--text-primary-rgb), 0.72); font-size: 12px; }
.practice-stage__field :deep(.n-select) { width: 100%; max-width: 320px; }
.practice-stage__card-hint--error { color: rgba(var(--error-rgb), 0.9); }

.practice-stage__live { flex: 1; min-height: 0; display: flex; }
.practice-stage__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  gap: 18px;
  align-items: stretch;
}

.practice-stage__stage {
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
}

.practice-stage__visualizer-zone { position: relative; width: min(46vw, 420px); aspect-ratio: 1; margin: 6px 0 0; }
.practice-stage__visualizer { position: absolute; inset: 0; }

.practice-stage__camera {
  position: absolute;
  top: 14px;
  right: 14px;
  width: min(210px, 28vw);
  aspect-ratio: 16 / 10;
  border: 1px solid var(--glass-realtime-border-strong);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--glass-realtime-shadow);
  z-index: 4;
}

.practice-stage__camera video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.practice-stage__bubbles {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: min(560px, 92%);
  margin-top: 6px;
  min-height: 0;
  overflow: hidden;
}

.practice-stage__bubble {
  max-width: 100%;
  padding: 10px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.55;
  background: var(--glass-realtime-bg-subtle);
  border: 1px solid var(--glass-realtime-border);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  backdrop-filter: blur(16px) saturate(160%);
  color: var(--text-primary);
  word-break: break-word;
}

/* 用户气泡：与 Omni 舞台一致的单一 accent 渐变胶囊。 */
.practice-stage__bubble--user {
  align-self: flex-end;
  background: linear-gradient(135deg,
    rgba(var(--accent-primary-rgb), 0.22),
    rgba(var(--accent-primary-rgb), 0.10));
  border-color: rgba(var(--accent-primary-rgb), 0.34);
}
.practice-stage__bubble--assistant {
  align-self: flex-start;
  background: var(--glass-realtime-bg-strong);
  border-color: var(--glass-realtime-border-strong);
}
.practice-stage__bubble--live {
  border-style: dashed;
  animation: practice-live-pulse 2.2s ease-in-out infinite;
}

@keyframes practice-live-pulse {
  0%, 100% { border-color: var(--glass-realtime-border); }
  50% { border-color: var(--glass-realtime-border-strong); }
}

.practice-bubble-enter-active, .practice-bubble-leave-active { transition: all 0.32s ease; }
.practice-bubble-enter-from { opacity: 0; transform: translateY(10px) scale(0.98); }
.practice-bubble-leave-to { opacity: 0; transform: translateY(-8px) scale(0.98); }

.practice-stage__caption {
  margin: 8px 0 0;
  min-height: 18px;
  color: rgba(var(--text-primary-rgb), 0.62);
  font-size: 12px;
  text-align: center;
}

.practice-stage__tool-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--glass-realtime-bg-subtle);
  border: 1px solid var(--glass-realtime-border);
  -webkit-backdrop-filter: var(--glass-realtime-blur);
  backdrop-filter: var(--glass-realtime-blur);
  font-size: 12px;
  color: rgba(var(--text-primary-rgb), 0.85);
}

.practice-stage__tool-indicator { width: 14px; height: 14px; display: grid; place-items: center; }
.practice-stage__tool-indicator svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
/* 与 Omni 舞台一致：running 用 accent 紫蓝，done/error 用 ink 灰——不再红/绿。 */
.practice-stage__tool-indicator--running { color: rgb(var(--accent-primary-rgb)); }
.practice-stage__tool-indicator--done { color: rgba(var(--text-primary-rgb), 0.55); }
.practice-stage__tool-indicator--error { color: rgba(var(--text-primary-rgb), 0.4); }
.practice-stage__tool-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(var(--accent-primary-rgb), 0.3);
  border-top-color: rgb(var(--accent-primary-rgb));
  animation: practice-spin 0.8s linear infinite;
}
@keyframes practice-spin { to { transform: rotate(360deg); } }

.practice-stage__controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin-top: 16px;
}

.practice-stage__control {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--glass-realtime-border-strong);
  background: var(--glass-realtime-bg);
  -webkit-backdrop-filter: var(--glass-realtime-blur);
  backdrop-filter: var(--glass-realtime-blur);
  color: inherit;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
  box-shadow: var(--glass-realtime-shadow);
}
.practice-stage__control svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }
.practice-stage__control:hover { background: var(--glass-realtime-bg-strong); border-color: rgba(var(--text-primary-rgb), 0.4); }
/* 静音 = ink 灰表达"非激活"；挂断 = accent 紫蓝强调（同 Omni 舞台）。 */
.practice-stage__control--muted {
  border-color: rgba(var(--text-primary-rgb), 0.55);
  background: rgba(var(--text-primary-rgb), 0.10);
  color: rgba(var(--text-primary-rgb), 0.6);
}
.practice-stage__control--end {
  border-color: rgba(var(--accent-primary-rgb), 0.5);
  background: rgba(var(--accent-primary-rgb), 0.18);
}
.practice-stage__control--end:hover { background: rgba(var(--accent-primary-rgb), 0.3); }
.practice-stage__control:disabled { opacity: 0.35; cursor: not-allowed; }

/* 右侧评分卡 */
.practice-stage__scores {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 18px;
  background: var(--glass-realtime-bg-strong);
  -webkit-backdrop-filter: var(--glass-realtime-blur-strong);
  backdrop-filter: var(--glass-realtime-blur-strong);
  box-shadow: var(--glass-realtime-shadow);
}

.practice-stage__scores-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--glass-realtime-border);
}

.practice-stage__scores-count {
  min-width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.18);
  font-size: 11px;
}

.practice-stage__scores-empty {
  padding: 26px 18px;
  text-align: center;
  color: rgba(var(--text-primary-rgb), 0.5);
  font-size: 12px;
  line-height: 1.7;
}

.practice-stage__feedback-card {
  overflow-y: auto;
  padding: 14px 16px;
}

.practice-stage__feedback-round {
  font-size: 11px;
  color: rgba(var(--text-primary-rgb), 0.62);
}

.practice-stage__feedback-score-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 6px 0 10px;
}

.practice-stage__feedback-overall { font-size: 30px; font-weight: 700; line-height: 1; }
.practice-stage__feedback-overall-label { font-size: 12px; color: rgba(var(--text-primary-rgb), 0.68); }

/* 评分语义色：good/ok/weak 保留红绿黄的"反馈可读性"，但改用主题令牌
 * 并降低饱和——水墨底上不刺眼，light/dark 都可读。 */
[data-tone='good'] { color: rgb(var(--success-rgb)); }
[data-tone='ok'] { color: rgb(var(--warning-rgb)); }
[data-tone='weak'] { color: rgb(var(--error-rgb)); }
[data-tone='none'] { color: rgba(var(--text-primary-rgb), 0.55); }

.practice-stage__feedback-dims {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.practice-stage__dim {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.06);
  font-size: 11px;
}
.practice-stage__dim i { font-style: normal; color: rgba(var(--text-primary-rgb), 0.72); }
.practice-stage__dim b { font-weight: 650; }

.practice-stage__feedback-comment {
  margin: 4px 0 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
}

.practice-stage__feedback-line {
  margin: 4px 0;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(var(--text-primary-rgb), 0.82);
}
.practice-stage__feedback-line em { font-style: normal; color: rgb(var(--success-rgb)); }
.practice-stage__feedback-line--example em { color: rgb(var(--warning-rgb)); }

.practice-stage__history {
  border-top: 1px solid var(--glass-realtime-border);
  overflow-y: auto;
  padding: 6px 16px 14px;
}

.practice-stage__history-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  font-size: 12px;
  border-bottom: 1px dashed var(--glass-realtime-border);
}

.practice-stage__history-round { color: rgba(var(--text-primary-rgb), 0.6); white-space: nowrap; }
.practice-stage__history-score { font-weight: 650; white-space: nowrap; }
.practice-stage__history-comment {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(var(--text-primary-rgb), 0.8);
}

/* 结束面板 */
.practice-stage__ended {
  width: min(560px, calc(100% - 32px));
  margin: 0 auto;
  overflow-y: auto;
}

.practice-stage__ended-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 28px 26px;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 20px;
  background: var(--glass-realtime-bg-strong);
  -webkit-backdrop-filter: var(--glass-realtime-blur-strong);
  backdrop-filter: var(--glass-realtime-blur-strong);
  box-shadow: var(--glass-realtime-shadow);
  text-align: center;
}

.practice-stage__ended-card h2 { margin: 0; font-size: 18px; font-weight: 620; }

.practice-stage__avg {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin: 4px 0;
}

.practice-stage__avg-score { font-size: 42px; font-weight: 750; line-height: 1; }
.practice-stage__avg-label { font-size: 12px; color: rgba(var(--text-primary-rgb), 0.62); }

.practice-stage__table {
  width: 100%;
  max-width: 440px;
  border-collapse: collapse;
  font-size: 13px;
}

.practice-stage__table th, .practice-stage__table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--glass-realtime-border);
}

.practice-stage__table th { color: rgba(var(--text-primary-rgb), 0.6); font-weight: 500; font-size: 12px; }
.practice-stage__table td { color: var(--text-primary); }

.practice-stage__no-data {
  padding: 10px 0;
  color: rgba(var(--text-primary-rgb), 0.55);
  font-size: 12px;
}

.practice-stage__saved {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: rgba(var(--accent-primary-rgb), 0.1);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.3);
  font-size: 13px;
}

.practice-stage__saved-name { color: rgba(var(--text-primary-rgb), 0.72); font-size: 12px; word-break: break-all; }

.practice-stage__download-link {
  padding: 6px 16px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.16);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.42);
  color: rgb(var(--accent-primary-rgb));
  font-size: 13px;
  text-decoration: none;
}

.practice-stage__download-link:hover { background: rgba(var(--accent-primary-rgb), 0.28); }

.practice-stage__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}

/* light 主题（日间）补充：与 Omni 舞台一致——控件实底白 + 深描边 +
 * 投影保证白底对比度；AI 气泡玻璃增强描边。 */
html:not(.dark) .practice-stage__control {
  background: rgba(255, 255, 255, 0.90);
  border-color: rgba(26, 26, 26, 0.16);
  box-shadow: 0 2px 14px rgba(26, 26, 26, 0.10);
}

html:not(.dark) .practice-stage__control:hover {
  background: #ffffff;
  border-color: rgba(26, 26, 26, 0.42);
}

html:not(.dark) .practice-stage__control--muted {
  border-color: rgba(26, 26, 26, 0.44);
  background: rgba(26, 26, 26, 0.08);
}

html:not(.dark) .practice-stage__bubble--assistant {
  background: rgba(255, 255, 255, 0.92);
  border-color: rgba(26, 26, 26, 0.14);
  box-shadow: 0 2px 16px rgba(26, 26, 26, 0.08);
}

@media (max-width: 960px) {
  .practice-stage__body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
    overflow-y: auto;
  }

  .practice-stage__stage { min-height: 480px; }

  .practice-stage__scores {
    max-height: 320px;
    border-radius: 16px;
  }
}
</style>
