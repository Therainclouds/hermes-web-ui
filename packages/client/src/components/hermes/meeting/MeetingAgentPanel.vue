<script setup lang="ts">
import { ref, computed, watch, nextTick, defineAsyncComponent, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NEmpty } from 'naive-ui'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { request, getApiKey } from '@/api/client'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const props = withDefaults(defineProps<{
  sessionId: string
  sceneTemplate?: string
  isRecording?: boolean
}>(), {
  sceneTemplate: 'general',
  isRecording: false,
})

const emit = defineEmits<{
  (e: 'report-generated', markdown: string): void
}>()

const { t } = useI18n()

// Realtime assist composable
const {
  rounds,
  isConnected,
  isAnalyzing,
  error,
  connect,
  disconnect,
  clear,
} = useMeetingAssist(props.sessionId)

// Report state
const reportMarkdown = ref('')
const isGeneratingReport = ref(false)
const reportError = ref<string | null>(null)

// Rounds container ref for auto-scroll
const roundsContainer = ref<HTMLElement | null>(null)

// Scene label
const sceneLabel = computed(() => {
  const map: Record<string, string> = {
    general: t('meeting.scene.general'),
    legal: t('meeting.scene.legal'),
    business: t('meeting.scene.business'),
    medical: t('meeting.scene.medical'),
    interview: t('meeting.scene.interview'),
  }
  return map[props.sceneTemplate] || map.general
})

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Auto-scroll to bottom when new rounds arrive
function scrollToBottom() {
  nextTick(() => {
    if (roundsContainer.value) {
      roundsContainer.value.scrollTop = roundsContainer.value.scrollHeight
    }
  })
}

watch(rounds, scrollToBottom, { deep: true })

// Start/stop assist based on recording state
watch(() => props.isRecording, async (recording) => {
  if (recording) {
    clear()
    reportMarkdown.value = ''
    reportError.value = null
    connect()
    // Notify server to start assist session
    try {
      await request('/api/meeting-asr/assist/start', {
        method: 'POST',
        body: JSON.stringify({ sessionId: props.sessionId, sceneTemplate: props.sceneTemplate }),
      })
    } catch { /* best effort */ }
  } else {
    // Stop assist
    try {
      await request('/api/meeting-asr/assist/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: props.sessionId }),
      })
    } catch { /* best effort */ }
    disconnect()
  }
}, { immediate: true })

// Generate report after recording stops
async function generateReport(transcript: string) {
  if (!transcript || isGeneratingReport.value) return

  isGeneratingReport.value = true
  reportError.value = null
  reportMarkdown.value = ''

  try {
    const params = new URLSearchParams({
      sessionId: props.sessionId,
      sceneTemplate: props.sceneTemplate,
      transcript,
    })

    const response = await fetch(`/api/meeting-asr/report/stream?${params.toString()}`, {
      headers: {
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') break

        try {
          const chunk = JSON.parse(payload)
          if (chunk.error) throw new Error(chunk.error)
          if (chunk.text) reportMarkdown.value += chunk.text
        } catch (e) {
          if (e instanceof SyntaxError) continue
          throw e
        }
      }
    }

    emit('report-generated', reportMarkdown.value)
  } catch (err) {
    reportError.value = err instanceof Error ? err.message : String(err)
  } finally {
    isGeneratingReport.value = false
  }
}

// Export report as markdown download
function exportReportHtml() {
  if (!reportMarkdown.value) return
  const blob = new Blob([reportMarkdown.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `meeting-report-${props.sessionId}.md`
  a.click()
  URL.revokeObjectURL(url)
}

// Expose generateReport for parent component
defineExpose({ generateReport })

onUnmounted(() => {
  disconnect()
})
</script>

<template>
  <div class="assist-panel">
    <!-- Header -->
    <div class="assist-header">
      <div class="assist-header-left">
        <span class="scene-badge">{{ sceneLabel }}</span>
        <span class="status-indicator" :class="{ active: isConnected && isRecording, analyzing: isAnalyzing }">
          <span class="status-dot" />
          <span class="status-text">
            <template v-if="isAnalyzing">{{ t('meeting.assist.analyzing') }}</template>
            <template v-else-if="isConnected && isRecording">{{ t('meeting.assist.listening') }}</template>
            <template v-else>{{ t('meeting.assist.idle') }}</template>
          </span>
        </span>
      </div>
      <NButton v-if="rounds.length > 0" size="tiny" quaternary @click="clear()">
        {{ t('meeting.assist.clearHints') }}
      </NButton>
    </div>

    <!-- Analysis rounds stream -->
    <div ref="roundsContainer" class="assist-rounds-area">
      <!-- Empty state -->
      <div v-if="rounds.length === 0 && !isGeneratingReport && !reportMarkdown" class="assist-empty">
        <NEmpty :description="isRecording ? t('meeting.assist.waitingForHints') : t('meeting.assist.notRecording')" size="small" />
      </div>

      <!-- Analysis round cards -->
      <TransitionGroup name="round-fade">
        <div
          v-for="round in rounds"
          :key="round.id"
          class="round-card"
          :class="`priority-${round.priority}`"
        >
          <!-- Time + priority badge -->
          <div class="round-meta">
            <span class="round-time">{{ formatTime(round.timestamp) }}</span>
            <span v-if="round.priority === 'urgent'" class="priority-badge urgent">紧急</span>
            <span v-else-if="round.priority === 'attention'" class="priority-badge attention">注意</span>
          </div>

          <!-- Context quote (original text) -->
          <div v-if="round.context" class="round-context">
            <span class="context-quote">「{{ round.context }}」</span>
          </div>

          <!-- Analysis body -->
          <div class="round-analysis">{{ round.analysis }}</div>
        </div>
      </TransitionGroup>

      <!-- Analyzing indicator -->
      <div v-if="isAnalyzing" class="analyzing-indicator">
        <NSpin size="small" />
        <span>{{ t('meeting.assist.thinking') }}</span>
      </div>
    </div>

    <!-- Report section (shown after recording stops) -->
    <div v-if="!isRecording && (reportMarkdown || isGeneratingReport || reportError)" class="assist-report-section">
      <div class="report-header">
        <span class="report-title">{{ t('meeting.reportPanel.title') }}</span>
        <div class="report-actions">
          <NButton v-if="reportMarkdown && !isGeneratingReport" size="tiny" @click="exportReportHtml">
            {{ t('meeting.reportPanel.export') }}
          </NButton>
        </div>
      </div>

      <div v-if="reportError" class="report-error">{{ reportError }}</div>

      <div v-if="isGeneratingReport && !reportMarkdown" class="report-loading">
        <NSpin size="small" />
        <span>{{ t('meeting.reportPanel.generating') }}</span>
      </div>

      <div v-if="reportMarkdown" class="report-content">
        <MarkdownRenderer :content="reportMarkdown" />
      </div>
    </div>

    <!-- Error -->
    <div v-if="error" class="assist-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.assist-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.assist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--n-border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
}

.assist-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scene-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(24, 160, 88, 0.15);
  color: #18a058;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #555;
  transition: background 0.3s;
}

.status-indicator.active .status-dot {
  background: #18a058;
  animation: pulse 2s infinite;
}

.status-indicator.analyzing .status-dot {
  background: #f0a020;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 12px;
  color: var(--n-text-color3, #888);
}

.assist-rounds-area {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.assist-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* --- Analysis Round Card --- */
.round-card {
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--n-card-color, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--n-border-color, rgba(255, 255, 255, 0.06));
  border-left: 3px solid rgba(99, 99, 99, 0.3);
  transition: all 0.3s ease;
}

.round-card.priority-normal {
  border-left-color: rgba(99, 140, 200, 0.5);
}

.round-card.priority-attention {
  border-left-color: #f0a020;
  background: rgba(240, 160, 32, 0.04);
}

.round-card.priority-urgent {
  border-left-color: #d03050;
  background: rgba(208, 48, 80, 0.06);
}

.round-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.round-time {
  font-size: 11px;
  color: var(--n-text-color3, #777);
  font-variant-numeric: tabular-nums;
}

.priority-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  letter-spacing: 0.5px;
}

.priority-badge.attention {
  background: rgba(240, 160, 32, 0.15);
  color: #f0a020;
}

.priority-badge.urgent {
  background: rgba(208, 48, 80, 0.15);
  color: #d03050;
}

/* Context quote - references original speech */
.round-context {
  margin-bottom: 8px;
}

.context-quote {
  font-size: 12px;
  color: var(--n-text-color3, #999);
  font-style: italic;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Main analysis text */
.round-analysis {
  font-size: 13px;
  line-height: 1.7;
  color: var(--n-text-color1, #e0e0e0);
  word-break: break-word;
}

/* --- Analyzing indicator --- */
.analyzing-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--n-text-color3, #888);
}

/* --- Report section --- */
.assist-report-section {
  border-top: 1px solid var(--n-border-color, rgba(255, 255, 255, 0.08));
  max-height: 50%;
  overflow-y: auto;
  padding: 14px;
  flex-shrink: 0;
}

.report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.report-title {
  font-size: 13px;
  font-weight: 600;
}

.report-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--n-text-color3, #888);
}

.report-error {
  font-size: 12px;
  color: #d03050;
  margin-bottom: 8px;
}

.report-content {
  font-size: 13px;
  line-height: 1.6;
}

.assist-error {
  padding: 8px 14px;
  font-size: 12px;
  color: #d03050;
  border-top: 1px solid rgba(208, 48, 80, 0.2);
}

/* --- Transition --- */
.round-fade-enter-active {
  transition: all 0.4s ease;
}

.round-fade-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
</style>
