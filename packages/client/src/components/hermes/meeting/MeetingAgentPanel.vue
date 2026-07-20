<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin, NTooltip, NModal } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useMeetingAgent } from '@/composables/useMeetingAgent'

const props = withDefaults(defineProps<{
  sessionId: string
  startTrigger?: number
}>(), {
  startTrigger: 0
})

const emit = defineEmits<{
  (e: 'update:analysisResult', result: any): void
  (e: 'update:reportHtml', html: string): void
}>()

const { t } = useI18n()
const meetingStore = useMeetingStore()

// 使用 useMeetingAgent composable
const {
  messages,
  isRunning,
  error,
  analysisResult,
  reportHtml,
  agentConfig,
  promptTemplate,
  sendMessage,
  startAnalysis,
  abortRun,
  clearAll,
  savePromptTemplate,
  resetPromptTemplate,
} = useMeetingAgent(props.sessionId)

// 输入框（用于用户追问）
const inputText = ref('')
const messagesContainer = ref<HTMLElement | null>(null)

// 提示词模板编辑
const showPromptEditor = ref(false)
const editingTemplate = ref('')

// 当前会议
const session = computed(() => {
  return meetingStore.sessions.find(s => s.id === props.sessionId)
})

// Agent 类型显示
const agentTypeLabel = computed(() => {
  switch (agentConfig.value?.agentType) {
    case 'hermes': return 'Hermes Agent'
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'Codex'
    default: return 'Agent'
  }
})

// 发送用户消息（追问）
async function handleSend() {
  if (!inputText.value.trim() || isRunning.value) return
  const text = inputText.value
  inputText.value = ''
  
  // 添加用户消息到显示
  messages.value.push({
    id: `user-${Date.now()}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
    status: 'sent'
  })
  
  await sendMessage(text)
}

// 开始分析
async function handleStartAnalysis() {
  if (!session.value?.sentences.length) return
  await startAnalysis(session.value.sentences)
}

// 键盘事件
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

// 自动滚动到底部
function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// 监听消息变化，自动滚动
watch(messages, scrollToBottom, { deep: true })

// 监听分析结果变化，通知父组件
watch(analysisResult, (newResult) => {
  if (newResult) {
    emit('update:analysisResult', newResult)
  }
}, { deep: true })

watch(reportHtml, (newHtml) => {
  if (newHtml) {
    emit('update:reportHtml', newHtml)
  }
})

// 监听外部触发的开始分析
watch(() => props.startTrigger, async (newVal) => {
  if (newVal > 0 && session.value?.sentences.length && !isRunning.value) {
    await handleStartAnalysis()
  }
})

// 打开提示词编辑器
function openPromptEditor() {
  editingTemplate.value = promptTemplate.value
  showPromptEditor.value = true
}

// 保存提示词
function handleSavePrompt() {
  savePromptTemplate(editingTemplate.value)
  showPromptEditor.value = false
}

// 重置提示词
function handleResetPrompt() {
  resetPromptTemplate()
  editingTemplate.value = promptTemplate.value
}

// 格式化工具名称
function formatToolName(name: string | undefined): string {
  if (!name) return 'tool'
  // 将 snake_case 或 camelCase 转换为可读格式
  return name
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim()
}

// 格式化工具内容
function formatToolContent(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') {
    // 尝试解析 JSON
    try {
      const parsed = JSON.parse(content)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return content
    }
  }
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

// 截断长文本
function truncate(text: string, max: number = 100): string {
  if (!text || text.length <= max) return text
  return text.slice(0, max) + '...'
}

// 格式化执行时长
function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  return `${seconds.toFixed(1)}s`
}
</script>

<template>
  <div class="agent-panel">
    <!-- 头部 -->
    <div class="agent-panel-header">
      <div class="agent-info">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
          <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z"/>
        </svg>
        <span class="agent-type">{{ agentTypeLabel }}</span>
        <span v-if="agentConfig?.profile" class="agent-profile">{{ agentConfig.profile }}</span>
      </div>
      <div class="agent-actions">
        <!-- 编辑提示词 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" @click="openPromptEditor">
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </template>
            </NButton>
          </template>
          {{ t('meeting.editPrompt') }}
        </NTooltip>

        <!-- 开始分析 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              size="tiny"
              type="primary"
              :disabled="!session?.sentences.length || isRunning"
              @click="handleStartAnalysis"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </template>
              {{ t('meeting.startAnalysis') }}
            </NButton>
          </template>
          {{ t('meeting.startAnalysisHint') }}
        </NTooltip>

        <!-- 中止 -->
        <NButton
          v-if="isRunning"
          size="tiny"
          type="error"
          @click="abortRun"
        >
          {{ t('meeting.abort') }}
        </NButton>

        <!-- 清空 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" @click="clearAll" :disabled="isRunning">
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </template>
            </NButton>
          </template>
          {{ t('meeting.clearChat') }}
        </NTooltip>
      </div>
    </div>

    <!-- 内容区域 -->
    <div ref="messagesContainer" class="agent-content-area">
      <!-- 空状态 -->
      <div v-if="messages.length === 0 && !analysisResult && !isRunning" class="agent-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
          <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z"/>
        </svg>
        <p>{{ t('meeting.agentEmpty') }}</p>
        <p class="agent-empty-hint">{{ t('meeting.agentEmptyHint') }}</p>
      </div>

      <!-- 分析过程（工具调用和思考） -->
      <div v-if="messages.length > 0" class="agent-process">
        <div v-for="msg in messages" :key="msg.id" class="agent-message" :class="[`role-${msg.role}`]">
          <!-- 用户消息（追问） -->
          <div v-if="msg.role === 'user'" class="user-message">
            <div class="user-bubble">{{ msg.content }}</div>
          </div>

          <!-- Thinking/Reasoning -->
          <div v-if="msg.reasoning" class="agent-thinking">
            <div class="thinking-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <span>{{ t('meeting.thinking') }}</span>
            </div>
            <div class="thinking-content">{{ msg.reasoning }}</div>
          </div>

          <!-- Tool 调用（可折叠） -->
          <div v-if="msg.role === 'tool'" class="agent-tool" :class="{ 'tool-expanded': msg._expanded }">
            <div class="tool-header" @click="msg._expanded = !msg._expanded">
              <div class="tool-header-left">
                <!-- 状态图标 -->
                <svg v-if="msg.toolStatus === 'running'" width="14" height="14" viewBox="0 0 24 24" class="tool-spinner">
                  <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="30 70"/>
                </svg>
                <svg v-else-if="msg.toolStatus === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tool-done">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <svg v-else-if="msg.toolStatus === 'error'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tool-error">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <!-- 工具图标 -->
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>
                <!-- 工具名称 -->
                <span class="tool-name">{{ formatToolName(msg.toolName) }}</span>
                <!-- 工具预览 -->
                <span v-if="msg.toolPreview && !msg._expanded" class="tool-preview">{{ truncate(msg.toolPreview) }}</span>
                <!-- 错误标记 -->
                <span v-if="msg.toolStatus === 'error'" class="tool-error-badge">{{ t('meeting.toolFailed') }}</span>
                <!-- 执行时长 -->
                <span v-if="msg.toolDuration" class="tool-duration">{{ formatDuration(msg.toolDuration) }}</span>
              </div>
              <div class="tool-header-right">
                <!-- 展开/折叠图标 -->
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tool-chevron" :class="{ rotated: msg._expanded }">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            </div>
            <!-- 展开的详细信息 -->
            <div v-if="msg._expanded" class="tool-details">
              <!-- 工具参数 -->
              <div v-if="msg.toolArgs" class="tool-detail-section">
                <div class="tool-detail-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  {{ t('meeting.toolArgs') }}
                </div>
                <pre class="tool-detail-content">{{ formatToolContent(msg.toolArgs) }}</pre>
              </div>
              <!-- 工具结果 -->
              <div v-if="msg.toolResult" class="tool-detail-section">
                <div class="tool-detail-title">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                  {{ t('meeting.toolResult') }}
                </div>
                <pre class="tool-detail-content" :class="{ 'tool-error-content': msg.toolStatus === 'error' }">{{ formatToolContent(msg.toolResult) }}</pre>
              </div>
            </div>
          </div>

          <!-- Assistant 消息（分析内容） -->
          <div v-if="msg.role === 'assistant'" class="agent-assistant">
            <div class="assistant-content">{{ msg.content }}</div>
          </div>

          <!-- System 消息（错误） -->
          <div v-if="msg.role === 'system'" class="agent-system">
            <div class="system-content">{{ msg.content }}</div>
          </div>
        </div>
      </div>

      <!-- 分析报告 -->
      <div v-if="analysisResult && !isRunning" class="agent-report">
        <div class="report-header">
          <h3>{{ t('meeting.analysisReport') }}</h3>
        </div>
        
        <div v-if="analysisResult.summary" class="report-section">
          <h4>{{ t('meeting.summary') }}</h4>
          <p>{{ analysisResult.summary }}</p>
        </div>

        <div v-if="analysisResult.key_points?.length" class="report-section">
          <h4>{{ t('meeting.keyPoints') }}</h4>
          <ul>
            <li v-for="(point, i) in analysisResult.key_points" :key="i">{{ point }}</li>
          </ul>
        </div>

        <div v-if="analysisResult.action_items?.length" class="report-section">
          <h4>{{ t('meeting.actionItems') }}</h4>
          <ul class="action-list">
            <li v-for="(item, i) in analysisResult.action_items" :key="i">
              <input type="checkbox" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <div v-if="analysisResult.topics?.length" class="report-section">
          <h4>{{ t('meeting.topics') }}</h4>
          <div class="topic-tags">
            <span v-for="(topic, i) in analysisResult.topics" :key="i" class="topic-tag">{{ topic }}</span>
          </div>
        </div>

        <!-- 查看完整报告 -->
        <div v-if="reportHtml" class="report-actions">
          <NButton size="small" type="primary" @click="showReportModal = true">
            {{ t('meeting.viewFullReport') }}
          </NButton>
        </div>
      </div>

      <!-- Loading 状态 -->
      <div v-if="isRunning" class="agent-loading">
        <NSpin size="small" />
        <span>{{ t('meeting.agentThinking') }}</span>
      </div>

      <!-- 错误提示 -->
      <div v-if="error" class="agent-error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span>{{ error }}</span>
      </div>
    </div>

    <!-- 输入框（用于追问） -->
    <div class="agent-input">
      <NInput
        v-model:value="inputText"
        type="textarea"
        :placeholder="t('meeting.agentInputPlaceholder')"
        :autosize="{ minRows: 1, maxRows: 3 }"
        :disabled="isRunning"
        @keydown="handleKeydown"
      />
      <NButton
        type="primary"
        :disabled="!inputText.trim() || isRunning"
        @click="handleSend"
      >
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </template>
      </NButton>
    </div>

    <!-- 提示词编辑对话框 -->
    <NModal
      v-model:show="showPromptEditor"
      preset="card"
      :title="t('meeting.editPromptTemplate')"
      :style="{ width: '600px' }"
      :bordered="false"
    >
      <div class="prompt-editor">
        <NInput
          v-model:value="editingTemplate"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 20 }"
          :placeholder="t('meeting.promptPlaceholder')"
        />
      </div>
      <template #action>
        <NButton @click="handleResetPrompt">{{ t('meeting.resetToDefault') }}</NButton>
        <NButton @click="showPromptEditor = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" @click="handleSavePrompt">{{ t('common.save') }}</NButton>
      </template>
    </NModal>

    <!-- 完整报告对话框 -->
    <NModal
      v-model:show="showReportModal"
      preset="card"
      :title="t('meeting.analysisReport')"
      :style="{ width: '90%', maxWidth: '1000px' }"
      :bordered="false"
    >
      <iframe :srcdoc="reportHtml" class="report-iframe"></iframe>
    </NModal>
  </div>
</template>

<script lang="ts">
// 需要额外声明 showReportModal
export default {
  data() {
    return {
      showReportModal: false
    }
  }
}
</script>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.agent-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid $border-color;
  background: $bg-card;
  flex-shrink: 0;
}

.agent-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: $text-primary;
  font-size: 13px;

  svg {
    color: $accent-primary;
  }
}

.agent-type {
  font-weight: 600;
}

.agent-profile {
  padding: 1px 6px;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 4px;
  font-size: 11px;
}

.agent-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.agent-content-area {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.agent-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: $text-secondary;

  p {
    font-size: 14px;
    margin: 0;
  }

  .agent-empty-hint {
    font-size: 12px;
    opacity: 0.7;
  }
}

.agent-process {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-message {
  &.role-user {
    display: flex;
    justify-content: flex-end;
  }
}

.user-message {
  display: flex;
  justify-content: flex-end;
}

.user-bubble {
  max-width: 80%;
  padding: 8px 12px;
  background: $accent-primary;
  color: white;
  border-radius: 12px;
  border-bottom-right-radius: 4px;
  font-size: 13px;
}

.agent-thinking {
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
  background: $bg-card;
  border: 1px solid $border-color;
  border-radius: 8px;
  overflow: hidden;
  transition: all 0.2s ease;

  &:hover {
    border-color: rgba($accent-primary, 0.3);
  }

  &.tool-expanded {
    border-color: $accent-primary;
  }
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.02);
  }
}

.tool-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.tool-header-right {
  flex-shrink: 0;
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
  font-size: 13px;
}

.tool-preview {
  color: $text-secondary;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-error-badge {
  padding: 2px 6px;
  background: rgba(#ef4444, 0.1);
  color: #ef4444;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.tool-duration {
  color: $text-secondary;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tool-chevron {
  color: $text-secondary;
  transition: transform 0.2s ease;
  flex-shrink: 0;

  &.rotated {
    transform: rotate(90deg);
  }
}

.tool-details {
  border-top: 1px solid $border-color;
  padding: 12px;
  background: rgba(0, 0, 0, 0.01);
}

.tool-detail-section {
  margin-bottom: 12px;

  &:last-child {
    margin-bottom: 0;
  }
}

.tool-detail-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: $text-secondary;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;

  svg {
    opacity: 0.7;
  }
}

.tool-detail-content {
  font-size: 12px;
  font-family: 'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace;
  background: rgba(0, 0, 0, 0.03);
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.5;
  color: $text-primary;

  &.tool-error-content {
    background: rgba(#ef4444, 0.05);
    color: #ef4444;
  }
}

.agent-assistant {
  padding: 10px 12px;
  background: $bg-card;
  border: 1px solid $border-color;
  border-radius: 8px;
}

.assistant-content {
  font-size: 13px;
  line-height: 1.6;
  color: $text-primary;
  white-space: pre-wrap;
}

.agent-system {
  padding: 8px 12px;
  background: rgba(#ef4444, 0.1);
  border-radius: 6px;
  border-left: 3px solid #ef4444;
}

.system-content {
  font-size: 12px;
  color: #ef4444;
}

.agent-report {
  padding: 16px;
  background: $bg-card;
  border: 1px solid $border-color;
  border-radius: 8px;
  margin-top: 8px;
}

.report-header {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid $border-color;

  h3 {
    font-size: 16px;
    font-weight: 600;
    color: $text-primary;
    margin: 0;
  }
}

.report-section {
  margin-bottom: 16px;

  h4 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 8px 0;
  }

  p {
    font-size: 14px;
    line-height: 1.6;
    color: $text-primary;
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

.topic-tag {
  padding: 4px 10px;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 12px;
  font-size: 12px;
}

.report-actions {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.agent-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: $text-secondary;
  font-size: 13px;
}

.agent-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(#ef4444, 0.1);
  color: #ef4444;
  font-size: 12px;
  border-radius: 6px;
}

.agent-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid $border-color;
  background: $bg-card;
  flex-shrink: 0;

  :deep(.n-input) {
    flex: 1;
  }
}

.prompt-editor {
  :deep(.n-input) {
    font-family: monospace;
  }
}

.report-iframe {
  width: 100%;
  height: 70vh;
  border: none;
  border-radius: 4px;
}
</style>