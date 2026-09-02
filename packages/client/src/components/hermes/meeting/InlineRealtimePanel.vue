<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NTag, NTooltip, NEmpty, NAlert, NSelect, NInput, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOmniRealtime } from '@/composables/useOmniRealtime'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { fetchMemory } from '@/api/hermes/skills'
import { buildRealtimeInstructions } from '@/utils/realtime-instructions'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'

/**
 * 会议侧栏的实时语音对话面板（OmniRealtimeStage 的 inline 薄包装变体）。
 *
 * 与 Chat 侧全屏舞台共享同一条 `useOmniRealtime` 音频链路（/ws/omni-realtime、
 * 双路 barge-in、服务端 VAD 分轮），但按会议场景定制：
 *  - inline 布局填充 MeetingRightPanel 的 #realtime 槽，非全屏遮罩；
 *  - 按键说话（push-to-talk）为主交互，避免免提抢话打断会议进行；
 *  - 会议上下文（标题 / 时间 / 逐字稿）经 buildRealtimeInstructions 的同一条
 *    追加路径注入 instructions；
 *  - 人格继承当前激活 profile 的 SOUL.md（fetchMemory 并行拉取，失败兜底）；
 *  - 不写 chatStore——会议语音对话即开即用，不落入聊天会话历史。
 */

const props = defineProps<{
  /** Used to surface a friendly error if no DashScope key has been configured. */
  hasDashscopeKey: boolean
  /**
   * 会议上下文（标题 / 开始时间 / 发言人 / 带时间戳逐字稿）。由 MeetingView
   * 在对应会议下计算并注入，开启会话时拼进 instructions，让 AI 结合当前会议回答。
   */
  meetingContext?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

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

const selectedVoice = ref<string>('Tina')
// Apply the default voice configured in the Realtime model panel.
selectedVoice.value = realtimeModelStore.config.voice || 'Tina'

/**
 * 用户追加的自定义指令（可选）。人格与语音行为约束由 SOUL.md + 补充指令
 * 自动提供，这里只承载用户想额外追加的会议特定要求；留空则不追加。
 */
const extraInstructions = ref<string>('')

const omni = useOmniRealtime({
  onError: (msg) => {
    // errors are surfaced via errorMessage below; no extra toast needed
    console.warn('[omni-realtime] error:', msg)
  },
})

// Destructure so refs auto-unwrap in the template. We keep the full object
// reachable as `omni` for the few places that need it (e.g. pushStart).
const {
  phase,
  errorMessage,
  turns,
  liveUserText,
  liveAssistantText,
  inputLevel,
} = omni

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'idle': return t('meeting.realtime.phase.idle')
    case 'connecting': return t('meeting.realtime.phase.connecting')
    case 'ready': return t('meeting.realtime.phase.ready')
    case 'listening': return t('meeting.realtime.phase.listening')
    case 'speaking': return t('meeting.realtime.phase.speaking')
    case 'error': return t('meeting.realtime.phase.error')
    case 'closed': return t('meeting.realtime.phase.closed')
    default: return ''
  }
})

const phaseTagType = computed(() => {
  switch (phase.value) {
    case 'ready': return 'success'
    case 'listening': return 'info'
    case 'speaking': return 'warning'
    case 'error': return 'error'
    case 'connecting': return 'info'
    default: return 'default'
  }
})

const canStart = computed(() => props.hasDashscopeKey && phase.value === 'idle')
const isActive = computed(() => phase.value !== 'idle' && phase.value !== 'closed')
const hasMeetingContext = computed(() => Boolean(props.meetingContext?.trim()))

/**
 * The Omni-Realtime WebSocket is relayed through the meeting ASR Python
 * backend. When it is not running the upgrade fails and the client only sees
 * a generic connection error — so make sure the service is up (starting it
 * with the stored meeting config, falling back to the unified Qwen API key
 * configured in the Realtime model panel) before opening the session.
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

const preparing = ref(false)
const backendError = ref('')

async function startSession() {
  if (!props.hasDashscopeKey) return
  preparing.value = true
  backendError.value = ''
  try {
    // 后端就绪与 SOUL.md 读取并行（后端启动最多轮询 30s，人格读取不能
    // 串行叠加）；记忆读取失败不阻断会话，buildRealtimeInstructions 内部
    // 会落到通用人格兜底。
    const [ready, memory] = await Promise.all([
      ensureBackendAvailable(),
      fetchMemory().catch(() => null),
    ])
    if (!ready) {
      backendError.value = t('omniRealtime.backendUnavailable')
      return
    }
    const baseInstructions = buildRealtimeInstructions(String(memory?.soul || ''), {
      meetingContext: hasMeetingContext.value && props.meetingContext ? props.meetingContext : '',
    })
    const extra = extraInstructions.value.trim()
    const instructions = extra ? `${baseInstructions}\n\n——\n${extra}` : baseInstructions
    await omni.connect({
      voice: selectedVoice.value,
      model: realtimeModelStore.config.model || undefined,
      instructions,
    })
  } finally {
    preparing.value = false
  }
}

function stopSession() {
  omni.disconnect()
}

function togglePush(e: PointerEvent) {
  e.preventDefault()
  if (phase.value !== 'ready' && phase.value !== 'listening' && phase.value !== 'speaking') return
  omni.pushStart()
}

function releasePush(e: PointerEvent) {
  e.preventDefault()
  omni.pushStop()
}

function abort() {
  omni.abortResponse()
}

const scrollContainer = ref<HTMLDivElement | null>(null)
watch(
  () => turns.value.length,
  () => {
    nextTick(() => {
      if (scrollContainer.value) {
        scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
      }
    })
  },
)
watch(
  () => [liveUserText.value, liveAssistantText.value],
  () => {
    nextTick(() => {
      if (scrollContainer.value) {
        scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
      }
    })
  },
)
</script>

<template>
  <div class="realtime-dialog-panel">
    <div class="realtime-header">
      <div class="realtime-title">
        <span class="realtime-title-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z" />
            <path d="M3 19a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z" />
          </svg>
        </span>
        <div>
          <h3>{{ t('meeting.realtime.title') }}</h3>
          <p class="realtime-subtitle">{{ t('meeting.realtime.subtitle') }}</p>
        </div>
      </div>
      <div class="realtime-header-actions">
        <NTag :type="phaseTagType" size="small" round>{{ phaseLabel }}</NTag>
        <NTooltip>
          <template #trigger>
            <NButton size="tiny" quaternary @click="emit('close')">{{ t('sidebar.collapse') }}</NButton>
          </template>
          {{ t('meeting.realtime.closeHint') }}
        </NTooltip>
      </div>
    </div>

    <NAlert v-if="!hasDashscopeKey" type="warning" :show-icon="false" style="margin-bottom: 12px;">
      {{ t('meeting.realtime.needApiKey') }}
    </NAlert>

    <div v-if="backendError" class="realtime-error">
      {{ backendError }}
    </div>

    <div v-if="errorMessage" class="realtime-error">
      {{ errorMessage }}
    </div>

    <div v-if="!isActive" class="realtime-config">
      <div v-if="hasMeetingContext" class="realtime-context-hint">
        {{ t('meeting.realtime.contextLoaded') }}
      </div>
      <div class="realtime-config-row">
        <label>{{ t('meeting.realtime.voice') }}</label>
        <NSelect
          v-model:value="selectedVoice"
          :options="voiceOptions"
          size="small"
          :disabled="isActive"
        />
      </div>
      <div class="realtime-config-row">
        <label>{{ t('meeting.realtime.instructions') }}</label>
        <NInput
          v-model:value="extraInstructions"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          size="small"
          :placeholder="t('meeting.realtime.instructionsPlaceholder')"
          :disabled="isActive"
        />
      </div>
      <div class="realtime-config-actions">
        <NButton
          type="primary"
          size="small"
          :disabled="!canStart"
          :loading="preparing"
          @click="startSession"
        >
          {{ t('meeting.realtime.startSession') }}
        </NButton>
      </div>
    </div>

    <div v-else class="realtime-active">
      <div ref="scrollContainer" class="realtime-transcript">
        <NEmpty v-if="turns.length === 0 && !liveUserText && !liveAssistantText" :description="t('meeting.realtime.emptyHint')">
          <template #icon>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </template>
        </NEmpty>

        <div v-for="(turn, idx) in turns" :key="`${turn.timestamp}-${idx}`" class="realtime-turn" :class="`realtime-turn-${turn.role}`">
          <div class="realtime-turn-role">
            {{ turn.role === 'user' ? t('meeting.realtime.you') : t('meeting.realtime.assistant') }}
          </div>
          <div class="realtime-turn-text">{{ turn.text }}</div>
        </div>

        <div v-if="liveUserText" class="realtime-turn realtime-turn-user realtime-turn-live">
          <div class="realtime-turn-role">{{ t('meeting.realtime.you') }} · {{ t('meeting.realtime.live') }}</div>
          <div class="realtime-turn-text">{{ liveUserText }}</div>
        </div>
        <div v-if="liveAssistantText" class="realtime-turn realtime-turn-assistant realtime-turn-live">
          <div class="realtime-turn-role">{{ t('meeting.realtime.assistant') }} · {{ t('meeting.realtime.live') }}</div>
          <div class="realtime-turn-text">{{ liveAssistantText }}</div>
        </div>
      </div>

      <div class="realtime-controls">
        <div class="realtime-meter" :data-active="inputLevel > 0.02">
          <div class="realtime-meter-bar" :style="{ width: `${Math.min(100, inputLevel * 300)}%` }" />
        </div>

        <NTooltip>
          <template #trigger>
            <button
              class="realtime-push"
              :class="{ active: omni.isPushing.value }"
              @pointerdown="togglePush"
              @pointerup="releasePush"
              @pointerleave="releasePush"
              @pointercancel="releasePush"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path v-if="!omni.isPushing.value" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>
                <path v-if="!omni.isPushing.value" d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
                <rect v-else x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
            </button>
          </template>
          {{ omni.isPushing.value ? t('meeting.realtime.releaseToSend') : t('meeting.realtime.pushToTalk') }}
        </NTooltip>

        <div class="realtime-secondary-actions">
          <NButton size="tiny" @click="abort" :disabled="phase !== 'speaking'">{{ t('meeting.realtime.bargeIn') }}</NButton>
          <NButton size="tiny" @click="omni.clearHistory()">{{ t('meeting.realtime.clear') }}</NButton>
          <NButton size="tiny" type="error" @click="stopSession">{{ t('meeting.realtime.endSession') }}</NButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.realtime-dialog-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 14px;
  background: var(--realtime-panel-bg, #0f1217);
  color: var(--realtime-panel-fg, #e5e7eb);
  border-radius: 10px;
}

.realtime-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.realtime-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.realtime-title-icon {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.16);
  color: #818cf8;
  border-radius: 8px;
}

.realtime-title h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.realtime-subtitle {
  margin: 0;
  font-size: 11px;
  color: #9ca3af;
}

.realtime-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.realtime-error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.5);
  color: #fecaca;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  margin-bottom: 10px;
}

.realtime-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}

.realtime-context-hint {
  font-size: 11px;
  line-height: 1.5;
  color: #86efac;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.35);
  border-radius: 6px;
  padding: 6px 8px;
}

.realtime-config-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.realtime-config-row label {
  font-size: 12px;
  color: #9ca3af;
}

.realtime-config-actions {
  display: flex;
  justify-content: flex-end;
}

.realtime-active {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.realtime-transcript {
  flex: 1;
  overflow-y: auto;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}

.realtime-turn {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.55;
}

.realtime-turn-user {
  background: rgba(59, 130, 246, 0.16);
}

.realtime-turn-assistant {
  background: rgba(99, 102, 241, 0.16);
}

.realtime-turn-live {
  opacity: 0.85;
  border: 1px dashed rgba(255, 255, 255, 0.15);
}

.realtime-turn-role {
  font-size: 11px;
  color: #9ca3af;
  margin-bottom: 4px;
}

.realtime-turn-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.realtime-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.realtime-meter {
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  overflow: hidden;
  transition: background 120ms;
}

.realtime-meter[data-active="true"] {
  background: rgba(99, 102, 241, 0.32);
}

.realtime-meter-bar {
  height: 100%;
  background: linear-gradient(90deg, #818cf8, #c084fc);
  transition: width 50ms linear;
}

.realtime-push {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: rgba(99, 102, 241, 0.22);
  border: 1px solid rgba(99, 102, 241, 0.5);
  color: #c7d2fe;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 120ms, transform 120ms;
  user-select: none;
}

.realtime-push:hover {
  background: rgba(99, 102, 241, 0.36);
}

.realtime-push.active {
  background: rgba(239, 68, 68, 0.28);
  border-color: rgba(239, 68, 68, 0.6);
  color: #fecaca;
  transform: scale(1.06);
}

.realtime-secondary-actions {
  display: flex;
  gap: 6px;
  width: 100%;
  justify-content: center;
}
</style>
