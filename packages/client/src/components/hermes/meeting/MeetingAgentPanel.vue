<script setup lang="ts">
import { ref, computed, watch, nextTick, defineAsyncComponent, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NEmpty } from 'naive-ui'
import { useMeetingAssist, type AssistHint } from '@/composables/useMeetingAssist'
import { request } from '@/api/client'

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
  hints,
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

// Hint container ref for auto-scroll
const hintsContainer = ref<HTMLElement | null>(null)

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

// Hint type config
function hintTypeIcon(type: AssistHint['type']): string {
  switch (type) {
    case 'prediction': return '🔮'
    case 'atmosphere': return '🌡️'
    case 'risk': return '⚠️'
    case 'suggestion': return '💡'
    default: return '📌'
  }
}

function hintTypeLabel(type: AssistHint['type']): string {
  switch (type) {
    case 'prediction': return t('meeting.assist.prediction')
    case 'atmosphere': return t('meeting.assist.atmosphere')
    case 'risk': return t('meeting.assist.risk')
    case 'suggestion': return t('meeting.assist.suggestion')
    default: return type
  }
}

function hintLevelClass(level: AssistHint['level']): string {
  return `level-${level}`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Auto-scroll to bottom when new hints arrive
function scrollToBottom() {
  nextTick(() => {
    if (hintsContainer.value) {
      hintsContainer.value.scrollTop = hintsContainer.value.scrollHeight
    }
  })
}

watch(hints, scrollToBottom, { deep: true })

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

    const response = await fetch(`/api/meeting-asr/report/stream?${params.toString()}`)
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

// Export report as HTML download
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
        <span class="status-dot" :class="{ active: isConnected && isRecording, analyzing: isAnalyzing }" />
        <span class="status-text">
          <template v-if="isAnalyzing">{{ t('meeting.assist.analyzing') }}</template>
          <template v-else-if="isConnected && isRecording">{{ t('meeting.assist.listening') }}</template>
          <template v-else>{{ t('meeting.assist.idle') }}</template>
        </span>
      </div>
      <NButton v-if="hints.length > 0" size="tiny" quaternary @click="clear()">
        {{ t('meeting.assist.clearHints') }}
      </NButton>
    </div>

    <!-- Hints stream -->
    <div ref="hintsContainer" class="assist-hints-area">
      <!-- Empty state -->
      <div v-if="hints.length === 0 && !isGeneratingReport && !reportMarkdown" class="assist-empty">
        <NEmpty :description="isRecording ? t('meeting.assist.waitingForHints') : t('meeting.assist.notRecording')" size="small" />
      </div>

      <!-- Hint cards -->
      <TransitionGroup name="hint-fade">
        <div
          v-for="hint in hints"
          :key="hint.id"
          class="hint-card"
          :class="[hintLevelClass(hint.level), `type-${hint.type}`]"
        >
          <div class="hint-card-header">
            <span class="hint-icon">{{ hintTypeIcon(hint.type) }}</span>
            <span class="hint-type-label">{{ hintTypeLabel(hint.type) }}</span>
            <span class="hint-time">{{ formatTime(hint.timestamp) }}</span>
          </div>
          <div class="hint-card-body">{{ hint.text }}</div>
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
  padding: 8px 12px;
  border-bottom: 1px solid var(--n-border-color, #e8e8e8);
  flex-shrink: 0;
}

.assist-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scene-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--n-color-primary, #18a058);
  color: #fff;
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #999;
  transition: background 0.3s;
}

.status-dot.active {
  background: #18a058;
  animation: pulse 2s infinite;
}

.status-dot.analyzing {
  background: #f0a020;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 12px;
  color: var(--n-text-color3, #999);
}

.assist-hints-area {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.assist-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.hint-card {
  border-radius: 8px;
  padding: 10px 12px;
  border-left: 3px solid #ccc;
  background: var(--n-card-color, #fafafa);
  transition: all 0.3s ease;
}

.hint-card.level-info { border-left-color: #2080f0; }
.hint-card.level-warning { border-left-color: #f0a020; }
.hint-card.level-critical { border-left-color: #d03050; }

.hint-card.type-prediction { background: rgba(32, 128, 240, 0.05); }
.hint-card.type-atmosphere { background: rgba(240, 160, 32, 0.05); }
.hint-card.type-risk { background: rgba(208, 48, 80, 0.05); }
.hint-card.type-suggestion { background: rgba(24, 160, 88, 0.05); }

.hint-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.hint-icon {
  font-size: 14px;
}

.hint-type-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--n-text-color2, #666);
}

.hint-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--n-text-color3, #999);
}

.hint-card-body {
  font-size: 13px;
  line-height: 1.5;
  color: var(--n-text-color1, #333);
}

.analyzing-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--n-text-color3, #999);
}

.assist-report-section {
  border-top: 1px solid var(--n-border-color, #e8e8e8);
  max-height: 50%;
  overflow-y: auto;
  padding: 12px;
  flex-shrink: 0;
}

.report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
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
  color: var(--n-text-color3, #999);
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
  padding: 8px 12px;
  font-size: 12px;
  color: #d03050;
  border-top: 1px solid rgba(208, 48, 80, 0.2);
}

/* Transition */
.hint-fade-enter-active {
  transition: all 0.3s ease;
}

.hint-fade-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
</style>
