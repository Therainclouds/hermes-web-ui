<script setup lang="ts">
// 演讲评分 · 评估报告区：生成/下载逐字稿/导出/渲染。
// 纯展示组件：报告状态由面板提供，动作以事件回传。
import { useI18n } from 'vue-i18n'
import { NButton, NSpin } from 'naive-ui'
import { defineAsyncComponent } from 'vue'
import MeetingExportDropdown from '@/components/hermes/meeting/MeetingExportDropdown.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const props = defineProps<{
  reportMarkdown: string
  reportError: string | null
  isGeneratingReport: boolean
  /** 是否具备生成条件（有逐字稿） */
  canGenerate: boolean
  exportTitle: string
}>()

const emit = defineEmits<{
  (e: 'generate'): void
  (e: 'download-verbatim'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="report-generate-row">
    <NButton type="primary" size="small" :loading="props.isGeneratingReport" :disabled="!props.canGenerate" @click="emit('generate')">
      {{ t('meeting.speechEval.generateReport') }}
    </NButton>
    <NButton size="small" :disabled="!props.canGenerate" @click="emit('download-verbatim')">
      {{ t('meeting.speechEval.downloadVerbatim') }}
    </NButton>
  </div>

  <div v-if="props.reportError" class="report-error">{{ props.reportError }}</div>

  <div v-if="props.isGeneratingReport && !props.reportMarkdown" class="report-loading">
    <NSpin size="small" />
    <span>{{ t('meeting.speechEval.generating') }}</span>
  </div>

  <div v-if="props.reportMarkdown" class="report-content">
    <div class="report-actions">
      <MeetingExportDropdown
        :markdown="props.reportMarkdown"
        :title="props.exportTitle"
        scope="speechEval"
      />
    </div>
    <MarkdownRenderer :content="props.reportMarkdown" />
  </div>
</template>

<style scoped lang="scss">
// --- 评估报告（自 SpeechEvaluationPanel 原样搬出） ---
.report-generate-row { display: flex; gap: 8px; }
.report-generate-row .n-button { flex: 1; }
.report-error { font-size: 12px; color: #d03050; padding: 6px 8px; background: rgba(208, 48, 80, 0.08); border-radius: 6px; }
.report-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--n-text-color3, #888); }
.report-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.report-content { font-size: 13px; line-height: 1.6; }
</style>
