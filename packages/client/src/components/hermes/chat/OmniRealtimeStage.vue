<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NSelect, NSwitch, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOmniRealtime } from '@/composables/useOmniRealtime'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { executeOmniTool, OMNI_REALTIME_TOOLS } from '@/api/hermes/omni-tools'
import { uid, useChatStore } from '@/stores/hermes/chat'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'

/**
 * GPT-Realtime 风格的单聊实时对话舞台。
 *
 * 复用会议模式的 Omni-Realtime 通道（/ws/omni-realtime，Qwen3.5-Omni-Flash-Realtime）：
 *   - 免提：麦克风持续推流，服务端 VAD 负责分轮；
 *   - 打断：用户开口时自动停止本地播放并取消上游响应（barge-in）；
 *   - 摄像头：开始前可选择开启本地预览；
 *   - 结束：把逐轮对话写回当前聊天会话的消息列表。
 */

const props = defineProps<{
  /** 与会议实时对话一致：未配置 DashScope Key 时提示先去配置。 */
  hasDashscopeKey: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

const chatStore = useChatStore()
const meetingStore = useMeetingStore()
const realtimeModelStore = useRealtimeModelStore()

// Voices verified against the DashScope `qwen3.5-omni-flash-realtime`
// catalogue (default model for this stage). `Cherry`, `Chelsie`, and `Adam`
// are NOT valid for that model — DashScope closes the WS with 1007
// `Voice 'X' is not supported.` if any of them is sent upstream.
const voiceOptions: SelectOption[] = [
  { label: 'Tina (女声 · 中文 · 默认)', value: 'Tina' },
  { label: 'Serena (女声 · 中文)', value: 'Serena' },
  { label: 'Ethan (男声 · 中文)', value: 'Ethan' },
  { label: 'Jennifer (女声 · 中文)', value: 'Jennifer' },
  { label: 'Ryan (男声 · 中文)', value: 'Ryan' },
]

const selectedVoice = ref('Tina')
// Apply the default voice configured in the Realtime model panel.
selectedVoice.value = realtimeModelStore.config.voice || 'Tina'
const cameraEnabled = ref(false)
const cameraStream = ref<MediaStream | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const cameraNotice = ref('')
const backendError = ref('')
const preparing = ref(false)
let transcriptSaved = false

// Camera frame capture: DashScope's Omni-Realtime API sees the world through
// `input_image_buffer.append` — base64 JPEG frames (≤256 KB, ~1 fps
// recommended). The camera stream alone is only a local preview, so we
// sample the preview video into a canvas at 1 fps and push each frame
// through the composable; without this the multimodal model never "sees"
// the user at all.
const FRAME_INTERVAL_MS = 1000
const MAX_FRAME_DIM = 640
let captureTimer: number | null = null
let framesCaptured = 0

/**
 * 会话提示词：在默认人设之上告知模型它可以调用的工作台工具
 * （定义通过 OMNI_REALTIME_TOOLS 随 start 帧下发），以及调用守则。
 */
const REALTIME_INSTRUCTIONS = [
  '你是"小合"，用户的中文语音助手，贯穿 Hermes 工作台。回答口语化、简洁自然（通常两三句话），适合直接朗读。',
  '',
  '你可以调用以下工具查询工作台的实时事实：',
  '- query_agent_memory：查询 Agent 的长期记忆（memory 记忆 / user 用户画像 / soul 人格）。用户问到"还记得吗、我是谁、我的偏好、之前聊过什么"时必须先查记忆再回答。',
  '- list_agent_skills：列出 Agent 已配置的技能。用户问"你能做什么、有哪些技能"时调用。',
  '- read_skill_detail：查看某个技能的详细说明（参数 category、skill）。',
  '- list_recent_sessions：查看最近的对话会话列表。用户问"最近聊了什么"时调用。',
  '- list_jobs：查看当前的定时任务与自动化任务。用户问"有哪些定时任务、自动化在跑什么"时调用。',
  '',
  '工具使用守则：',
  '1. 涉及上述工作台数据时必须调用工具获取事实，禁止凭空编造。',
  '2. 拿到结果后用口语总结关键信息；结果为空或出错时如实说明。',
  '3. 一次只调用一个必要的工具；回答完再考虑是否需要下一个。',
].join('\n')

const omni = useOmniRealtime({
  handsFree: true,
  autoBargeIn: true,
  tools: OMNI_REALTIME_TOOLS,
  onToolCall: executeOmniTool,
  onError: () => undefined,
})

const phase = omni.phase
const isActive = computed(() => phase.value !== 'idle' && phase.value !== 'closed')
const canStart = computed(() => props.hasDashscopeKey && !isActive.value)

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

const orbStyle = computed(() => {
  let energy = 0.18
  if (phase.value === 'listening') energy = Math.min(1, 0.3 + omni.inputLevel.value * 1.7)
  else if (phase.value === 'speaking') energy = 0.68
  else if (phase.value === 'connecting') energy = 0.3
  return { '--omni-energy': energy.toFixed(3) }
})

const caption = computed(() => {
  if (backendError.value) return backendError.value
  if (displayError.value) return displayError.value
  if (omni.activeTool.value) return t('omniRealtime.toolRunning', { tool: omni.activeTool.value })
  if (cameraNotice.value) return cameraNotice.value
  if (phase.value === 'listening' && omni.liveUserText.value) return omni.liveUserText.value
  if (omni.liveAssistantText.value) return omni.liveAssistantText.value
  // Hide the hint whenever audio is still playing through the speakers.
  // `phase` flips back to 'ready' the moment upstream emits `response_done`,
  // which is well before the last queued buffer actually finishes, so we
  // can't rely on phase alone — `isOutputPlaying` tracks the live state.
  if (omni.isOutputPlaying.value) return ''
  if (phase.value === 'speaking') return ''
  if (cameraStream.value) return t('omniRealtime.cameraActive')
  if (phase.value === 'idle' || phase.value === 'closed') return t('meeting.realtime.emptyHint')
  return t('omniRealtime.handsFreeHint')
})

// The composable only sees a raw WebSocket failure; translate the generic
// message into something actionable in this stage.
const displayError = computed(() => {
  const raw = omni.errorMessage.value
  if (!raw) return ''
  if (/realtime session error/i.test(raw)) return t('omniRealtime.sessionError')
  return raw
})

const sessionTitle = computed(() => chatStore.activeSession?.title?.trim() || t('realtimeVoice.untitledSession'))

watch(cameraStream, (stream) => {
  const el = videoRef.value
  if (el) el.srcObject = stream ?? null
}, { flush: 'post' })

async function startCamera(): Promise<void> {
  if (cameraStream.value || typeof navigator.mediaDevices?.getUserMedia !== 'function') return
  try {
    cameraStream.value = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch {
    cameraNotice.value = t('omniRealtime.cameraFailed')
    setTimeout(() => { cameraNotice.value = '' }, 4000)
  }
}

function stopCamera(): void {
  cameraStream.value?.getTracks().forEach(track => track.stop())
  cameraStream.value = null
}

/**
 * Draw the current camera frame onto a canvas and send it as a JPEG to the
 * model. Frames are capped at MAX_FRAME_DIM on the long edge so the base64
 * payload stays comfortably under DashScope's 256 KB per-image limit, and
 * mirrored so the model sees the same selfie orientation as the user.
 */
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
      // Debug aid: the very first frame proves the canvas → JPEG capture
      // path works. Subsequent per-frame logs come from omni.sendImage.
      console.log(`[omni-realtime] camera capture started (${width}x${height})`)
    }
    omni.sendImage(canvas.toDataURL('image/jpeg', 0.6))
  } catch {
    // canvas tainted or toDataURL unavailable — keep the voice session going
  }
}

/** Start sampling camera frames at 1 fps (audio is already streaming by then). */
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

/**
 * The Omni-Realtime WebSocket is relayed through the meeting ASR Python
 * backend. When it is not running the upgrade fails and the client only sees
 * a generic connection error — so make sure the service is up (starting it
 * with the stored meeting config if needed) before opening the session.
 */
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

async function startSession(): Promise<void> {
  if (!canStart.value || preparing.value) return
  transcriptSaved = false
  cameraNotice.value = ''
  backendError.value = ''
  preparing.value = true
  try {
    const ready = await ensureBackendAvailable()
    if (!ready) {
      backendError.value = t('omniRealtime.backendUnavailable')
      return
    }
    if (cameraEnabled.value) await startCamera()
    await omni.connect({
      voice: selectedVoice.value,
      model: realtimeModelStore.config.model || undefined,
      instructions: REALTIME_INSTRUCTIONS,
    })
    // Once the session is live the mic feed is already flowing upstream
    // (DashScope requires audio before image frames), so we can start
    // sampling camera frames for the model.
    if (cameraStream.value) startFrameCapture()
  } finally {
    preparing.value = false
  }
}

function writeTranscriptToChat(): void {
  if (transcriptSaved) return
  transcriptSaved = true
  const sessionId = chatStore.activeSessionId
  const turns = omni.turns.value
  if (!sessionId || turns.length === 0) return
  for (const turn of turns) {
    chatStore.addMessage(sessionId, {
      id: uid(),
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: turn.text,
      timestamp: turn.timestamp,
    })
  }
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (session) session.updatedAt = Date.now()
}

function endSession(): void {
  stopFrameCapture()
  omni.disconnect()
  writeTranscriptToChat()
  stopCamera()
  emit('close')
}

function closeStage(): void {
  if (isActive.value) {
    endSession()
    return
  }
  stopFrameCapture()
  stopCamera()
  emit('close')
}

function toggleMute(): void {
  omni.setMicStreaming(!omni.isPushing.value)
}

const isMuted = computed(() => !omni.isPushing.value && isActive.value)

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeStage()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  omni.disconnect()
  stopFrameCapture()
  stopCamera()
})
</script>

<template>
  <section
    class="omni-stage"
    :class="[`omni-stage--${orbPhase}`]"
    role="dialog"
    aria-modal="true"
    :aria-label="t('meeting.realtime.title')"
    data-testid="omni-realtime-stage"
  >
    <div class="omni-stage__wash omni-stage__wash--top" aria-hidden="true" />
    <div class="omni-stage__wash omni-stage__wash--bottom" aria-hidden="true" />

    <header class="omni-stage__header">
      <button class="omni-stage__back" type="button" :aria-label="t('realtimeVoice.back')" @click="closeStage">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <div class="omni-stage__identity">
        <strong>{{ sessionTitle }}</strong>
        <span>{{ t('omniRealtime.modelNote') }}</span>
      </div>
      <span class="omni-stage__phase" data-testid="omni-realtime-phase">{{ statusLabel }}</span>
    </header>

    <main class="omni-stage__main">
      <div
        v-if="cameraStream"
        class="omni-stage__camera"
        data-testid="omni-realtime-camera"
      >
        <video ref="videoRef" autoplay playsinline muted />
      </div>

      <section v-if="!isActive" class="omni-stage__setup">
        <NAlert v-if="!hasDashscopeKey" type="warning" :show-icon="false" class="omni-stage__alert">
          {{ t('meeting.realtime.needApiKey') }}
        </NAlert>
        <NAlert v-if="backendError" type="error" :show-icon="false" class="omni-stage__alert" data-testid="omni-realtime-backend-error">
          {{ backendError }}
        </NAlert>

        <div class="omni-stage__card">
          <h2>{{ t('meeting.realtime.title') }}</h2>
          <p class="omni-stage__card-sub">{{ t('meeting.realtime.subtitle') }}</p>
          <p class="omni-stage__card-sub omni-stage__card-tools">{{ t('omniRealtime.toolsHint') }}</p>

          <div class="omni-stage__field">
            <label>{{ t('meeting.realtime.voice') }}</label>
            <NSelect v-model:value="selectedVoice" :options="voiceOptions" size="small" />
          </div>

          <div class="omni-stage__field omni-stage__field--row">
            <label>{{ t('omniRealtime.camera') }}</label>
            <NSwitch v-model:value="cameraEnabled" size="small" :disabled="!canStart" />
          </div>

          <NButton
            type="primary"
            block
            :disabled="!canStart"
            :loading="preparing"
            data-testid="omni-realtime-start"
            @click="startSession"
          >
            {{ preparing ? t('meeting.realtime.phase.connecting') : t('meeting.realtime.startSession') }}
          </NButton>
        </div>
      </section>

      <section v-else class="omni-stage__live">
        <div class="omni-stage__orb-wrap" :style="orbStyle">
          <div class="omni-stage__halo" aria-hidden="true" />
          <div class="omni-stage__orb" data-testid="omni-realtime-orb">
            <span class="omni-stage__sheen" aria-hidden="true" />
          </div>
        </div>

        <p
          class="omni-stage__caption"
          aria-live="polite"
          aria-atomic="true"
          data-testid="omni-realtime-caption"
        >{{ caption }}</p>

        <div class="omni-stage__controls">
          <button
            class="omni-stage__control"
            type="button"
            :class="{ 'omni-stage__control--muted': isMuted }"
            :aria-pressed="isMuted"
            :aria-label="isMuted ? t('omniRealtime.unmute') : t('omniRealtime.mute')"
            data-testid="omni-realtime-mute"
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
            class="omni-stage__control omni-stage__control--interrupt"
            type="button"
            :disabled="phase !== 'speaking'"
            :aria-label="t('meeting.realtime.bargeIn')"
            data-testid="omni-realtime-interrupt"
            @click="omni.interrupt()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>

          <button
            class="omni-stage__control omni-stage__control--end"
            type="button"
            :aria-label="t('meeting.realtime.endSession')"
            data-testid="omni-realtime-end"
            @click="endSession"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
              <rect x="2" y="13" width="6" height="8" rx="2" />
              <rect x="16" y="13" width="6" height="8" rx="2" />
            </svg>
          </button>
        </div>
      </section>
    </main>
  </section>
</template>

<style scoped>
.omni-stage {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  isolation: isolate;
  overflow: hidden;
  color: #f4fbff;
  background:
    radial-gradient(circle at 50% 42%, rgba(88, 101, 242, 0.16), transparent 34%),
    linear-gradient(150deg, #05070d 0%, #0a0f1e 50%, #04060c 100%);
}

.omni-stage__wash {
  position: absolute;
  inset-inline: 0;
  height: 30vh;
  z-index: -1;
  pointer-events: none;
}

.omni-stage__wash--top { top: 0; background: linear-gradient(rgba(112, 244, 255, 0.06), transparent); }
.omni-stage__wash--bottom { bottom: 0; background: linear-gradient(transparent, rgba(128, 109, 255, 0.08)); }

.omni-stage__header {
  z-index: 3;
  height: 72px;
  padding: env(safe-area-inset-top, 0) clamp(16px, 4vw, 48px) 0;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid rgba(154, 215, 255, 0.1);
  background: rgba(3, 7, 14, 0.42);
  backdrop-filter: blur(22px);
}

.omni-stage__back {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(171, 224, 255, 0.14);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
  color: inherit;
  cursor: pointer;
}

.omni-stage__back:hover { background: rgba(112, 244, 255, 0.09); border-color: rgba(112, 244, 255, 0.34); }
.omni-stage__back svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }

.omni-stage__identity { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.omni-stage__identity strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.omni-stage__identity span {
  overflow: hidden;
  color: rgba(183, 224, 247, 0.55);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.omni-stage__phase {
  padding: 5px 12px;
  border: 1px solid rgba(112, 244, 255, 0.22);
  border-radius: 999px;
  color: rgba(130, 245, 255, 0.85);
  background: rgba(9, 19, 33, 0.52);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.omni-stage__main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.omni-stage__camera {
  position: absolute;
  top: 18px;
  right: 18px;
  width: min(220px, 30vw);
  aspect-ratio: 16 / 10;
  border: 1px solid rgba(171, 224, 255, 0.22);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  z-index: 4;
}

.omni-stage__camera video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.omni-stage__setup { width: min(400px, calc(100% - 32px)); }

.omni-stage__alert { margin-bottom: 14px; }

.omni-stage__card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 26px 24px;
  border: 1px solid rgba(171, 224, 255, 0.14);
  border-radius: 20px;
  background: rgba(9, 16, 32, 0.62);
  backdrop-filter: blur(18px);
}

.omni-stage__card h2 { margin: 0; font-size: 18px; font-weight: 620; }
.omni-stage__card-sub { margin: -10px 0 0; color: rgba(183, 224, 247, 0.6); font-size: 12px; }
.omni-stage__card-tools { margin-top: -8px; color: rgba(130, 245, 255, 0.66); }

.omni-stage__field { display: flex; flex-direction: column; gap: 6px; }
.omni-stage__field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.omni-stage__field label { color: rgba(200, 231, 250, 0.72); font-size: 12px; }

.omni-stage__live {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(22px, 4vh, 40px);
  width: 100%;
}

.omni-stage__orb-wrap {
  position: relative;
  width: min(300px, 62vw);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
}

.omni-stage__halo {
  position: absolute;
  inset: -12%;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(99, 132, 255, 0.28), transparent 66%);
  filter: blur(30px);
  opacity: calc(0.4 + var(--omni-energy) * 0.6);
  transition: opacity 160ms linear;
}

.omni-stage__orb {
  position: relative;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(circle at 34% 28%, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0) 26%),
    radial-gradient(circle at 66% 74%, rgba(56, 189, 248, 0.55), rgba(56, 189, 248, 0) 58%),
    conic-gradient(from 210deg, #22d3ee, #6366f1, #a855f7, #38bdf8, #22d3ee);
  box-shadow:
    0 0 calc(28px + var(--omni-energy) * 70px) rgba(99, 132, 255, calc(0.22 + var(--omni-energy) * 0.3)),
    inset 0 0 44px rgba(255, 255, 255, 0.22);
  animation:
    omni-breathe 3.4s ease-in-out infinite,
    omni-morph 10s ease-in-out infinite;
  transform: scale(calc(1 + var(--omni-energy) * 0.12));
  transition: transform 90ms linear;
}

.omni-stage__sheen {
  position: absolute;
  inset: 12%;
  border-radius: inherit;
  background: linear-gradient(125deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0) 46%);
  mix-blend-mode: screen;
}

.omni-stage--speaking .omni-stage__orb {
  animation:
    omni-breathe 1.5s ease-in-out infinite,
    omni-morph 6s ease-in-out infinite;
}

.omni-stage--connecting .omni-stage__orb,
.omni-stage--idle .omni-stage__orb { filter: saturate(0.55) brightness(0.82); animation-duration: 4.6s, 12s; }

.omni-stage--error .omni-stage__orb { filter: saturate(0.4) hue-rotate(-60deg) brightness(0.9); }

.omni-stage__caption {
  max-width: min(560px, calc(100% - 40px));
  min-height: 3.2em;
  margin: 0;
  color: rgba(233, 246, 255, 0.92);
  font-size: 16px;
  line-height: 1.6;
  text-align: center;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.omni-stage__controls {
  display: flex;
  align-items: center;
  gap: 22px;
}

.omni-stage__control {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(171, 224, 255, 0.2);
  border-radius: 50%;
  color: #eaf7ff;
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}

.omni-stage__control:hover { background: rgba(112, 244, 255, 0.14); transform: scale(1.05); }
.omni-stage__control svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

.omni-stage__control--muted { border-color: rgba(248, 113, 113, 0.55); background: rgba(239, 68, 68, 0.16); }

.omni-stage__control--interrupt:disabled { opacity: 0.35; cursor: default; transform: none; }

.omni-stage__control--end {
  width: 66px;
  height: 66px;
  border-color: rgba(239, 68, 68, 0.6);
  background: rgba(239, 68, 68, 0.24);
}

.omni-stage__control--end:hover { background: rgba(239, 68, 68, 0.38); }

@keyframes omni-breathe {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.16); }
}

@keyframes omni-morph {
  0%, 100% { border-radius: 52% 48% 55% 45% / 48% 52% 45% 55%; }
  33% { border-radius: 45% 55% 48% 52% / 55% 45% 52% 48%; }
  66% { border-radius: 55% 45% 52% 48% / 45% 55% 48% 52%; }
}
</style>
