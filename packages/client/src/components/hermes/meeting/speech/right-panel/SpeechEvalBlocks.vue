<script setup lang="ts">
// 演讲评分 · AI 实时点评累积区：亮点/可提升点/主题 + 仅新评价点弹出的点评卡。
// 纯展示组件：数据由 SpeechEvaluationPanel 经 useSpeechAiAggregation 提供。
import { useI18n } from 'vue-i18n'
import { NTag } from 'naive-ui'
import type { AnalysisRound } from '@/composables/useMeetingAssist'

const props = defineProps<{
  highlights: string[]
  improvements: string[]
  topics: string[]
  newPointRounds: AnalysisRound[]
}>()

const { t } = useI18n()
</script>

<template>
  <!-- 累积亮点 -->
  <div v-if="props.highlights.length" class="eval-block">
    <div class="eval-block-title">✨ {{ t('meeting.speechEval.highlights') }}</div>
    <div class="eval-tags">
      <NTag v-for="(h, i) in props.highlights" :key="i" size="small" type="success" :bordered="false">✓ {{ h }}</NTag>
    </div>
  </div>

  <!-- 累积可提升的点（3+1：只给最重要的一个可落地提升点） -->
  <div v-if="props.improvements.length" class="eval-block">
    <div class="eval-block-title">💡 {{ t('meeting.speechEval.topImprovement') }}</div>
    <div class="eval-tags">
      <NTag v-for="(imp, i) in props.improvements" :key="i" size="small" type="warning" :bordered="false">↗ {{ imp }}</NTag>
    </div>
  </div>

  <!-- 累积主题 -->
  <div v-if="props.topics.length" class="eval-block">
    <div class="eval-block-title">🏷️ {{ t('meeting.speechEval.topics') }}</div>
    <div class="eval-tags">
      <NTag v-for="(tp, i) in props.topics" :key="i" size="small" type="info" :bordered="false">{{ tp }}</NTag>
    </div>
  </div>

  <!-- 仅 AI 判断出现新的评价点时才弹出的点评卡 -->
  <div v-if="props.newPointRounds.length" class="eval-block">
    <div class="eval-block-title">🆕 {{ t('meeting.speechEval.newPoints') }}</div>
    <TransitionGroup name="round-fade">
      <div v-for="round in props.newPointRounds" :key="round.id" class="round-card" :class="`priority-${round.priority}`">
        <div class="round-meta">
          <span class="round-time">{{ new Date(round.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
          <span v-if="round.priority === 'urgent'" class="priority-badge urgent">{{ t('meeting.assist.urgent') }}</span>
          <span v-else-if="round.priority === 'attention'" class="priority-badge attention">{{ t('meeting.assist.attention') }}</span>
        </div>

        <div v-if="round.keyPoint" class="round-keypoint" :class="`priority-${round.priority}`">{{ round.keyPoint }}</div>
        <div v-if="round.context" class="round-context">「{{ round.context }}」</div>
        <div v-if="round.analysis" class="round-analysis">{{ round.analysis }}</div>
        <div v-if="round.timeNote" class="round-timenote">⏱️ {{ round.timeNote }}</div>

        <div v-if="round.fillerWords?.length" class="round-chips">
          <NTag v-for="f in round.fillerWords" :key="f.word" size="small" type="warning" :bordered="false">
            {{ f.word }} ×{{ f.count }}<template v-if="f.speaker"> · {{ f.speaker }}</template>
          </NTag>
        </div>

        <div v-if="round.goldenQuotes?.length" class="round-lists">
          <div class="round-list-title">✨ {{ t('meeting.speechEval.goldenQuotes') }}</div>
          <div v-for="(q, i) in round.goldenQuotes" :key="i" class="round-list-item">
            「{{ q.quote }}」<template v-if="q.speaker"><span class="quote-speaker">—— {{ q.speaker }}</span></template>
            <div v-if="q.reason" class="quote-reason">{{ q.reason }}</div>
          </div>
        </div>

        <div v-if="round.grammarIssues?.length" class="round-lists">
          <div class="round-list-title">⚠️ {{ t('meeting.speechEval.grammarIssues') }}</div>
          <div v-for="(g, i) in round.grammarIssues" :key="i" class="round-list-item">
            「{{ g.quote }}」— {{ g.issue }}<template v-if="g.speaker"><span class="quote-speaker">（{{ g.speaker }}）</span></template>
          </div>
        </div>

        <div v-if="round.wotdUsed" class="round-wotd">📖 {{ t('meeting.speechEval.wotdUsedFlag') }}</div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped lang="scss">
// --- 累积评价块 + 点评卡（自 SpeechEvaluationPanel 原样搬出） ---
.eval-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}

.eval-block-title { font-size: 12px; font-weight: 600; color: var(--n-text-color3, #bbb); }

.eval-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

// --- AI 点评轮次 ---
.round-card {
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-left: 3px solid rgba(99, 99, 99, 0.3);
  display: flex;
  flex-direction: column;
  gap: 6px;

  &.priority-attention { border-left-color: #f0a020; }
  &.priority-urgent { border-left-color: #d03050; }
}

.round-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.round-time { font-size: 11px; color: var(--n-text-color3, #777); font-variant-numeric: tabular-nums; }

.priority-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;

  &.attention { background: rgba(240, 160, 32, 0.15); color: #f0a020; }
  &.urgent { background: rgba(208, 48, 80, 0.15); color: #d03050; }
}

.round-keypoint {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  padding: 4px 8px;
  border-radius: 6px;

  &.priority-normal { color: #63e2b7; background: rgba(99, 226, 183, 0.08); }
  &.priority-attention { color: #f0a020; background: rgba(240, 160, 32, 0.1); }
  &.priority-urgent { color: #ff4d4f; background: rgba(255, 77, 79, 0.15); }
}

.round-context {
  font-size: 12px;
  color: #9fd4f0;
  padding-left: 8px;
  border-left: 2px solid #70c0e8;
}

.round-analysis { font-size: 12px; color: #c8c8c8; line-height: 1.6; }
.round-timenote { font-size: 12px; color: #f0a020; }

.round-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.round-lists { display: flex; flex-direction: column; gap: 3px; }
.round-list-title { font-size: 11px; color: var(--n-text-color3, #888); }
.round-list-item { font-size: 12px; color: #c8c8c8; line-height: 1.5; }

.round-wotd { font-size: 12px; color: #63e2b7; }

.quote-speaker { color: #9fd4f0; font-size: 11px; }
.quote-reason { font-size: 11px; color: var(--n-text-color3, #999); padding-left: 4px; }
</style>
