<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin, NTag } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { SpeechEvalState } from '@/stores/hermes/meeting'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { useSpeechAiAggregation } from '@/composables/useSpeechAiAggregation'
import { provideSpeechTimer } from './speech/speechTimerContext'
import { useSpeechFillerCounter } from '@/composables/useSpeechFillerCounter'
import { request, getApiKey } from '@/api/client'
import LiveScoreCard from './speech/right-panel/LiveScoreCard.vue'
import SpeechEvalBlocks from './speech/right-panel/SpeechEvalBlocks.vue'
import SpeechTimerCard from './speech/right-panel/SpeechTimerCard.vue'
import SpeechTimerSettingsDialog from './speech/right-panel/SpeechTimerSettingsDialog.vue'
import SpeechEvalReportSection from './speech/right-panel/SpeechEvalReportSection.vue'

const props = withDefaults(defineProps<{
  sessionId: string
  isRecording?: boolean
}>(), {
  isRecording: false,
})

const emit = defineEmits<{
  (e: 'report-generated', markdown: string): void
}>()

const { t } = useI18n()
const meetingStore = useMeetingStore()

// ---------- 实时 AI 分析（Socket.IO） ----------

const {
  rounds,
  isConnected,
  isAnalyzing,
  error: assistError,
  connect,
  disconnect,
  clear,
} = useMeetingAssist(props.sessionId)

// ---------- 状态读写（持久化到 session.speechEval） ----------

const session = computed(() => meetingStore.sessions.find(s => s.id === props.sessionId))

const DEFAULT_EVAL: SpeechEvalState = {
  timerDurationSec: 180,
  yellowAtSec: 30,
  redAtSec: 10,
  timerRecords: [],
  // 赘语词表不再预置：由 AI 实时分析检测并汇总（手动 +1 仅作补充修正）
  fillerWords: {},
  wordOfTheDay: '',
  wotdUsedCount: 0,
  goodPhrases: [],
  grammarNotes: [],
  // 肢体语言与台风：AI 看不到画面，由人工观察记录，报告据此点评
  bodyNotes: [],
  // 计时声音提醒（黄牌/红牌/时间到 语音播报），默认开启
  voiceAlert: true,
}

// 合并默认值：旧会话持久化数据缺少新增字段时也能拿到默认值
const evalState = computed<SpeechEvalState>(() => ({
  ...DEFAULT_EVAL,
  ...(session.value?.speechEval || {}),
}))

function persist(patch: Partial<SpeechEvalState>) {
  meetingStore.updateSession(props.sessionId, { speechEval: { ...evalState.value, ...patch } })
}

// ---------- 计时员 (Timer) ----------
// 共享计时器（单例）：与左侧波形/转写区同步显示；面板层（环节/串场记录、
// 设置、语音提醒）经 deps 启用——timerMode/串场/TTS 已收编进 composable。
// 共享计时器唯一实例（reactive 化供子组件经上下文注入；面板自身经 timer.* 访问）
const timer = provideSpeechTimer({ evalState, persist })

// 阈值变更时同步共享计时器（时长/黄牌/红牌剩余秒数）
watch(() => ({
  durationSec: evalState.value.timerDurationSec,
  yellowAtSec: evalState.value.yellowAtSec,
  redAtSec: evalState.value.redAtSec,
}), (v) => {
  timer.setThresholds({ durationSec: v.durationSec, yellowAtSec: v.yellowAtSec, redAtSec: v.redAtSec })
}, { immediate: true })

// ---------- 演讲上下文（注入 AI 提示词：计时/每日一词） ----------

function buildSpeechContext() {
  return {
    wordOfTheDay: evalState.value.wordOfTheDay || undefined,
    timerDurationSec: evalState.value.timerDurationSec,
    yellowAtSec: evalState.value.yellowAtSec,
    redAtSec: evalState.value.redAtSec,
    timerRecords: evalState.value.timerRecords || [],
    // 倒计时状态始终上报（含暂停/超时），让 AI 的评分以实际时间情况为依据
    currentRemainingSec: Math.max(0, timer.timerRemainingMs / 1000),
    currentPhase: timer.phase,
  }
}

// 上下文变更（计时记录/每日一词）时同步给服务端，后续自动分析会带上最新数据。
let contextPushTimer: number | null = null
watch(() => JSON.stringify({
  wordOfTheDay: evalState.value.wordOfTheDay,
  timerRecords: evalState.value.timerRecords,
  timerDurationSec: evalState.value.timerDurationSec,
  yellowAtSec: evalState.value.yellowAtSec,
  redAtSec: evalState.value.redAtSec,
}), () => {
  if (!props.isRecording) return
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  contextPushTimer = window.setTimeout(() => {
    request('/api/meeting-asr/assist/context', {
      method: 'POST',
      body: JSON.stringify({ sessionId: props.sessionId, speechContext: buildSpeechContext() }),
    }).catch(() => {})
  }, 400)
})

// 录音开始/停止：连接 assist 会话（与其他模式一致）
watch(() => props.isRecording, async (recording) => {
  if (recording) {
    connect()
    try {
      await request('/api/meeting-asr/assist/start', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: props.sessionId,
          sceneTemplate: 'speech',
          profile: session.value?.hermesProfile || undefined,
          speechContext: buildSpeechContext(),
        }),
      })
    } catch { /* best effort */ }
  } else {
    try {
      await request('/api/meeting-asr/assist/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: props.sessionId }),
      })
    } catch { /* best effort */ }
    disconnect()
  }
}, { immediate: true })

// 录音开始时自动开始倒计时（仅当计时器尚未启动/处于满时长状态时）
watch(() => props.isRecording, (recording) => {
  if (recording && !timer.timerRunning && timer.timerRemainingMs === evalState.value.timerDurationSec * 1000) {
    timer.toggle()
  }
})

// 立即分析：把最新上下文（含当前倒计时）一并发给服务端并触发一次分析
function analyzeNow() {
  if (isAnalyzing.value) return
  request('/api/meeting-asr/assist/analyze', {
    method: 'POST',
    body: JSON.stringify({ sessionId: props.sessionId, speechContext: buildSpeechContext() }),
  }).catch(() => {})
}

// ---------- AI 实时点评聚合 ----------

// 赘语（拆分至 useSpeechFillerCounter，行为保持不变）
const {
  aiFillerTotals,
  fillerWords,
  fillerTotal,
  incrementFiller,
  removeFiller,
  newFiller,
  addFiller,
} = useSpeechFillerCounter({ evalState, persist, rounds })

// ---------- AI 实时点评聚合（抽至 useSpeechAiAggregation：评分/增量评价/金句/发言人用时） ----------
const {
  aiFillerBySpeaker,
  aiGoldenQuotes,
  aiGrammarIssues,
  aiWotdUsedCount,
  newPointRounds,
  liveScore,
  scoreUpdatedAt,
  highlights,
  improvements,
  topics,
  speakerDurations,
} = useSpeechAiAggregation({ rounds, session })



// ---------- 语法官 (Grammarian) ----------

const wotdInput = ref('')
const goodInput = ref('')
const grammarInput = ref('')

const goodPhrases = computed(() => evalState.value.goodPhrases || [])
const grammarNotes = computed(() => evalState.value.grammarNotes || [])

function saveWotd() {
  persist({ wordOfTheDay: wotdInput.value.trim() })
}

function wotdUsed() {
  persist({ wotdUsedCount: (evalState.value.wotdUsedCount || 0) + 1 })
}

function addGood() {
  const text = goodInput.value.trim()
  if (!text) return
  persist({ goodPhrases: [...goodPhrases.value, text] })
  goodInput.value = ''
}

function addGrammar() {
  const text = grammarInput.value.trim()
  if (!text) return
  persist({ grammarNotes: [...grammarNotes.value, text] })
  grammarInput.value = ''
}

function removeGood(index: number) {
  const next = [...goodPhrases.value]
  next.splice(index, 1)
  persist({ goodPhrases: next })
}

function removeGrammar(index: number) {
  const next = [...grammarNotes.value]
  next.splice(index, 1)
  persist({ grammarNotes: next })
}

// ---------- 肢体语言与台风（手动观察记录） ----------
// AI 只能听到音频、看不到画面，表情/动作/肢体语言由人工观察记录，
// 报告生成时随「演讲评估数据」交给 AI 结合点评。

const bodyInput = ref('')
const bodyNotes = computed(() => evalState.value.bodyNotes || [])

function addBodyNote() {
  const text = bodyInput.value.trim()
  if (!text) return
  persist({ bodyNotes: [...bodyNotes.value, text] })
  bodyInput.value = ''
}

function removeBodyNote(index: number) {
  const next = [...bodyNotes.value]
  next.splice(index, 1)
  persist({ bodyNotes: next })
}


// ---------- 评估报告 ----------

const isGeneratingReport = ref(false)
const reportMarkdown = ref('')
const reportError = ref<string | null>(null)

function buildTranscriptWithEval(): string {
  const sentences = session.value?.sentences || []
  const lines = sentences.map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
  const st = evalState.value
  const timerLines = (st.timerRecords || []).length
    ? (st.timerRecords || []).map(r => `- ${r.label}：${timer.fmtSec(r.durationSec)}${r.overtimeSec > 0 ? `（超时 ${timer.fmtSec(r.overtimeSec)}）` : ''}`)
    : ['（无记录）']
  const fillerLines = Object.entries(fillerWords.value)
    .filter(([, c]) => c > 0)
    .map(([w, c]) => `- ${w}：${c} 次`)
  const fillerBySpeakerLines = aiFillerBySpeaker.value.map(entry => {
    const words = Object.entries(entry.totals).map(([w, c]) => `${w}×${c}`).join('、')
    return `- ${entry.speaker}：${words || '（无）'}（共 ${entry.total} 次）`
  })
  const goldenLines = [
    ...aiGoldenQuotes.value.map(q => `- ${q.quote}${q.speaker ? `（${q.speaker}）` : ''}${q.reason ? `：${q.reason}` : ''}`),
    ...(st.goodPhrases || []).map(p => `- ${p}`),
  ]
  const grammarLines = [
    ...aiGrammarIssues.value.map(g => `- ${g.quote}${g.speaker ? `（${g.speaker}）` : ''}：${g.issue}`),
    ...(st.grammarNotes || []).map(n => `- ${n}`),
  ]
  const speakerLines = speakerDurations.value.map(d => `- ${d.speaker}：${timer.fmtSec(d.durationSec)}`)
  const transitionLines = timer.transitionRecords.length
    ? [
        `- 串场 ${timer.transitionRecords.length} 次，共 ${timer.fmtSec(timer.transitionTotalSec)}`,
        ...timer.transitionRecords.map(r => `- ${r.label}：${timer.fmtSec(r.durationSec)}`),
      ]
    : ['（无）']
  const bodyLines = (st.bodyNotes || []).map(n => `- ${n}`)
  const evalBlock = [
    '【演讲评估数据】',
    '## 计时员记录',
    ...timerLines,
    '## 发言人用时',
    ...(speakerLines.length ? speakerLines : ['（无）']),
    '## 串场用时',
    ...transitionLines,
    '## 赘语统计',
    ...(fillerLines.length ? fillerLines : ['（无赘语）']),
    '## 赘语统计（按发言人）',
    ...(fillerBySpeakerLines.length ? fillerBySpeakerLines : ['（无）']),
    `## 每日一词：${st.wordOfTheDay || '（未设置）'}（AI 检测使用 ${aiWotdUsedCount.value} 次${st.wotdUsedCount ? `，手动标记 ${st.wotdUsedCount} 次` : ''}）`,
    '## 金句',
    ...(goldenLines.length ? goldenLines : ['（无）']),
    '## 语法错误',
    ...(grammarLines.length ? grammarLines : ['（无）']),
    '## 肢体语言观察',
    ...(bodyLines.length ? bodyLines : ['（无）']),
    '## 亮点',
    ...(highlights.value.length ? highlights.value.map(h => `- ${h}`) : ['（无）']),
    '## 可提升的点',
    ...(improvements.value.length ? improvements.value.map(i => `- ${i}`) : ['（无）']),
    '## 主题',
    ...(topics.value.length ? topics.value.map(tp => `- ${tp}`) : ['（无）']),
    ...(liveScore.value ? [`## 实时评分（最终）：${JSON.stringify(liveScore.value)}`] : []),
  ]
  return [...lines, '', ...evalBlock].join('\n')
}

/** 下载演讲评分逐字稿：逐字稿 + 评估数据（计时/赘语/金句/语法/肢体/评分）落盘为 .txt。 */
function downloadVerbatim() {
  const transcript = buildTranscriptWithEval()
  if (!transcript.trim()) return
  const header = [
    `演讲评分逐字稿：${session.value?.title || ''}`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ].join('\n')
  const blob = new Blob([header + transcript], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${session.value?.title || '演讲评分'}_逐字稿.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function generateReport() {
  if (isGeneratingReport.value) return
  const transcript = buildTranscriptWithEval()
  if (!transcript.trim()) return

  isGeneratingReport.value = true
  reportError.value = null
  reportMarkdown.value = ''

  try {
    const response = await fetch('/api/meeting-asr/report/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
      body: JSON.stringify({
        sessionId: props.sessionId,
        sceneTemplate: 'speech',
        transcript,
        profile: session.value?.hermesProfile || undefined,
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

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

// 导出报告：拆分按钮 + 下拉菜单，默认 Word（极致样式），可切 HTML / Markdown。
const exportTitle = computed(() => session.value?.title || t('meeting.reportPanel.title'))

// 切换会话时重置
watch(() => props.sessionId, () => {
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  disconnect()
  clear()
  timer.resetVoiceFlags()
  timer.cancelAnnouncement()
  timer.reset()
  wotdInput.value = evalState.value.wordOfTheDay || ''
  reportMarkdown.value = ''
  reportError.value = null
})

onMounted(() => {
  // 计时器由共享模块持有且已在阈值 watch 中同步，这里不重置，避免打断左侧覆盖层正在走的表。
  wotdInput.value = evalState.value.wordOfTheDay || ''
})

onUnmounted(() => {
  // 计时器由共享模块持有：面板卸载时不停表（左侧波形/转写区覆盖层继续走表），
  // 由 MeetingView 在页面卸载/切换会话时统一 reset/stop。
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  timer.resetVoiceFlags()
  timer.cancelAnnouncement()
  disconnect()
})
</script>

<template>
  <div class="speech-eval-panel">
    <!-- 顶部：连接状态 + 开始分析 -->
    <div class="eval-topbar">
      <div class="eval-status">
        <span class="status-dot" :class="{ connected: isConnected, analyzing: isAnalyzing }" />
        <span v-if="isAnalyzing">{{ t('meeting.speechEval.analyzing') }}</span>
        <span v-else-if="isConnected">{{ t('meeting.speechEval.connected') }}</span>
        <span v-else>{{ t('meeting.speechEval.notConnected') }}</span>
      </div>
      <NButton size="small" type="primary" :loading="isAnalyzing" :disabled="!props.isRecording" @click="analyzeNow">
        {{ t('meeting.speechEval.analyzeNow') }}
      </NButton>
    </div>

    <!-- AI 实时点评与评分 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="role-icon">🤖</span>
        <span class="section-name">{{ t('meeting.speechEval.aiRounds') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.aiRoundsDesc') }}</p>

      <LiveScoreCard :live-score="liveScore" :score-updated-at="scoreUpdatedAt" />

      <SpeechEvalBlocks
        :highlights="highlights"
        :improvements="improvements"
        :topics="topics"
        :new-point-rounds="newPointRounds"
      />

      <div v-if="rounds.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyRounds') }}</div>

      <div v-if="isAnalyzing" class="analyzing-indicator">
        <NSpin size="small" />
        <span>{{ t('meeting.speechEval.thinking') }}</span>
      </div>
      <div v-if="assistError" class="assist-error">{{ assistError }}</div>
    </section>

    <!-- 计时员 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="role-icon">⏱️</span>
        <span class="section-name">{{ t('meeting.speechEval.timer') }}</span>
        <NButton size="tiny" quaternary class="settings-btn" @click="timer.openSettings">
          ⚙️ {{ t('meeting.speechEval.settings') }}
        </NButton>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.timerDesc') }}</p>

      <SpeechTimerCard :speaker-durations="speakerDurations" />
    </section>

    <!-- 赘语记录员（AI 检测） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="role-icon">🔤</span>
        <span class="section-name">{{ t('meeting.speechEval.ahCounter') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.ahCounterDesc') }}</p>
      <p class="section-desc">{{ t('meeting.speechEval.fillerThresholdNote') }}</p>

      <div v-if="Object.keys(fillerWords).length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyFillers') }}</div>

      <div class="filler-grid">
        <div v-for="(count, word) in fillerWords" :key="word" class="filler-item">
          <span class="filler-word">{{ word }}</span>
          <span class="filler-count">{{ count }}</span>
          <NButton size="tiny" quaternary class="filler-plus" @click="incrementFiller(word)">+</NButton>
          <button v-if="!(word in aiFillerTotals)" class="filler-remove" @click="removeFiller(word)">×</button>
        </div>
      </div>
      <div class="filler-total">{{ t('meeting.speechEval.fillerTotal') }}：{{ fillerTotal }} <span class="filler-unit">{{ t('meeting.speechEval.times') }}</span></div>

      <!-- 赘语按发言人区分 -->
      <div v-if="aiFillerBySpeaker.length" class="filler-speakers">
        <div class="records-title">{{ t('meeting.speechEval.fillerBySpeaker') }}</div>
        <div v-for="entry in aiFillerBySpeaker" :key="entry.speaker" class="speaker-filler-item">
          <span class="speaker-filler-name">{{ entry.speaker }}</span>
          <span class="speaker-filler-tags">
            <NTag v-for="(c, w) in entry.totals" :key="w" size="tiny" type="warning" :bordered="false">{{ w }} ×{{ c }}</NTag>
          </span>
          <span class="speaker-filler-total">{{ t('meeting.speechEval.fillerTotal') }} {{ entry.total }}</span>
        </div>
      </div>

      <div class="add-row">
        <NInput v-model:value="newFiller" size="small" :placeholder="t('meeting.speechEval.addFiller')" @keyup.enter="addFiller" />
        <NButton size="small" @click="addFiller">{{ t('meeting.speechEval.add') }}</NButton>
      </div>
    </section>

    <!-- 语法官（AI 检测 + 手动补充） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="role-icon">📖</span>
        <span class="section-name">{{ t('meeting.speechEval.grammarian') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.grammarianDesc') }}</p>

      <div class="wotd-row">
        <NInput v-model:value="wotdInput" size="small" :placeholder="t('meeting.speechEval.wordOfTheDay')" @blur="saveWotd" @keyup.enter="saveWotd" />
        <NButton size="small" @click="wotdUsed">
          {{ t('meeting.speechEval.used') }} +1 ({{ (evalState.wotdUsedCount || 0) + aiWotdUsedCount }})
        </NButton>
      </div>

      <!-- AI 检测的金句（按发言人） -->
      <div v-if="aiGoldenQuotes.length" class="note-group">
        <div class="note-title">✨ {{ t('meeting.speechEval.aiGoldenQuotes') }}</div>
        <div class="quote-def">{{ t('meeting.speechEval.goldenQuotesDesc') }}</div>
        <div v-for="(q, i) in aiGoldenQuotes" :key="`ai-${i}`" class="note-item note-item--quote">
          <span>「{{ q.quote }}」<template v-if="q.speaker"><span class="quote-speaker">—— {{ q.speaker }}</span></template></span>
          <div v-if="q.reason" class="quote-reason">{{ q.reason }}</div>
        </div>
      </div>

      <!-- AI 检测的语法问题 -->
      <div v-if="aiGrammarIssues.length" class="note-group">
        <div class="note-title">⚠️ {{ t('meeting.speechEval.aiGrammarIssues') }}</div>
        <div v-for="(g, i) in aiGrammarIssues" :key="`ai-${i}`" class="note-item">
          <span>「{{ g.quote }}」— {{ g.issue }}<template v-if="g.speaker"><span class="quote-speaker">（{{ g.speaker }}）</span></template></span>
        </div>
      </div>

      <div class="note-group">
        <div class="note-title">{{ t('meeting.speechEval.goodPhrases') }}</div>
        <div class="add-row">
          <NInput v-model:value="goodInput" size="small" :placeholder="t('meeting.speechEval.addNotePlaceholder')" @keyup.enter="addGood" />
          <NButton size="small" @click="addGood">{{ t('meeting.speechEval.add') }}</NButton>
        </div>
        <div v-for="(p, i) in goodPhrases" :key="i" class="note-item">
          <span>{{ p }}</span>
          <button class="note-remove" @click="removeGood(i)">×</button>
        </div>
      </div>

      <div class="note-group">
        <div class="note-title">{{ t('meeting.speechEval.grammarNotes') }}</div>
        <div class="add-row">
          <NInput v-model:value="grammarInput" size="small" :placeholder="t('meeting.speechEval.addNotePlaceholder')" @keyup.enter="addGrammar" />
          <NButton size="small" @click="addGrammar">{{ t('meeting.speechEval.add') }}</NButton>
        </div>
        <div v-for="(n, i) in grammarNotes" :key="i" class="note-item">
          <span>{{ n }}</span>
          <button class="note-remove" @click="removeGrammar(i)">×</button>
        </div>
      </div>
    </section>

    <!-- 肢体语言与台风（手动观察，AI 结合点评） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="role-icon">🧍</span>
        <span class="section-name">{{ t('meeting.speechEval.bodyLanguage') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.bodyLanguageDesc') }}</p>

      <div class="add-row">
        <NInput v-model:value="bodyInput" size="small" :placeholder="t('meeting.speechEval.bodyNotesPlaceholder')" @keyup.enter="addBodyNote" />
        <NButton size="small" @click="addBodyNote">{{ t('meeting.speechEval.addBodyNote') }}</NButton>
      </div>

      <div v-if="bodyNotes.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyBodyNotes') }}</div>
      <div v-for="(n, i) in bodyNotes" :key="i" class="note-item">
        <span>{{ n }}</span>
        <button class="note-remove" @click="removeBodyNote(i)">×</button>
      </div>
    </section>

    <!-- 评估报告 -->
    <section class="eval-section report-section">
      <div class="section-title">
        <span class="role-icon">📊</span>
        <span class="section-name">{{ t('meeting.speechEval.reportTitle') }}</span>
      </div>
      <SpeechEvalReportSection
        :report-markdown="reportMarkdown"
        :report-error="reportError"
        :is-generating-report="isGeneratingReport"
        :can-generate="!!session?.sentences?.length"
        :export-title="exportTitle"
        @generate="generateReport"
        @download-verbatim="downloadVerbatim"
      />
    </section>

    <SpeechTimerSettingsDialog />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.speech-eval-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 12px 14px;
  gap: 12px;
}

.eval-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}

.eval-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--n-text-color3, #888);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #555;

  &.connected { background: #18a058; }
  &.analyzing { background: #f0a020; animation: pulse 1s infinite; }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.eval-section {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.role-icon { font-size: 15px; }
.section-name { flex: 1; }
.settings-btn { flex-shrink: 0; }

.section-desc {
  font-size: 11px;
  color: var(--n-text-color3, #888);
  line-height: 1.5;
  margin: 0;
}

.empty-hint {
  font-size: 11px;
  color: var(--n-text-color3, #666);
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

// --- 实时评分（更新式面板） ---
.live-score {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(112, 192, 232, 0.06);
  border: 1px solid rgba(112, 192, 232, 0.2);
  animation: score-flash 0.6s ease;
}

@keyframes score-flash {
  0% { background: rgba(112, 192, 232, 0.2); }
  100% { background: rgba(112, 192, 232, 0.06); }
}

.live-score-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.live-score-title { font-size: 13px; font-weight: 700; color: #70c0e8; }
.live-score-time { font-size: 11px; color: var(--n-text-color3, #888); font-variant-numeric: tabular-nums; }

.live-score-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}

.live-score-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);

  &.overall {
    background: rgba(99, 226, 183, 0.08);
    border-color: rgba(99, 226, 183, 0.3);
  }
}

.live-score-label { font-size: 10px; color: var(--n-text-color3, #999); text-align: center; }
.live-score-value { font-size: 18px; font-weight: 700; color: #70c0e8; font-variant-numeric: tabular-nums; }
.live-score-item.overall .live-score-value { color: #63e2b7; }

// --- 累积评价块（亮点/改进点/主题） ---
.eval-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.eval-block-title { font-size: 12px; font-weight: 600; color: var(--n-text-color3, #bbb); }

.eval-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.round-chips { display: flex; flex-wrap: wrap; gap: 4px; }

.round-lists { display: flex; flex-direction: column; gap: 3px; }
.round-list-title { font-size: 11px; color: var(--n-text-color3, #888); }
.round-list-item { font-size: 12px; color: #c8c8c8; line-height: 1.5; }

.round-wotd { font-size: 12px; color: #63e2b7; }

.analyzing-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--n-text-color3, #888);
}

.assist-error {
  font-size: 12px;
  color: #d03050;
  padding: 6px 8px;
  background: rgba(208, 48, 80, 0.08);
  border-radius: 6px;
}

// --- 计时器 ---
.timer-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.2);
  transition: all 0.3s ease;

  &.phase-green { border-color: rgba(24, 160, 88, 0.6); }
  &.phase-yellow { border-color: rgba(240, 160, 32, 0.7); background: rgba(240, 160, 32, 0.06); }
  &.phase-red { border-color: rgba(208, 48, 80, 0.8); background: rgba(208, 48, 80, 0.08); }
}

.timer-time {
  font-size: 40px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  color: var(--n-text-color, #fff);
}

.phase-green .timer-time { color: #63e2b7; }
.phase-yellow .timer-time { color: #f0a020; }
.phase-red .timer-time { color: #ff4d4f; }

.timer-phase-label { font-size: 12px; font-weight: 600; letter-spacing: 0.5px; }

.timer-cards { display: flex; gap: 6px; }

.card {
  flex: 1;
  text-align: center;
  font-size: 11px;
  padding: 4px 0;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  opacity: 0.45;
  transition: all 0.2s ease;

  &.green.active { opacity: 1; border-color: #18a058; background: rgba(24, 160, 88, 0.15); }
  &.yellow.active { opacity: 1; border-color: #f0a020; background: rgba(240, 160, 32, 0.15); }
  &.red.active { opacity: 1; border-color: #d03050; background: rgba(208, 48, 80, 0.18); }
}

.timer-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.segment-row { display: flex; gap: 8px; align-items: center; }

.transition-hint {
  font-size: 11px;
  color: #70c0e8;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(112, 192, 232, 0.08);
  border: 1px solid rgba(112, 192, 232, 0.15);
}

.time-records { display: flex; flex-direction: column; gap: 4px; }
.records-title { font-size: 11px; color: var(--n-text-color3, #888); }

.record-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.record-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-duration { font-variant-numeric: tabular-nums; }
.record-overtime { color: #ff4d4f; }

.record-remove,
.note-remove,
.filler-remove {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;

  &:hover { color: #ff4d4f; }
}

// --- 赘语 ---
.filler-grid { display: flex; flex-wrap: wrap; gap: 6px; }

.filler-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.filler-word { font-size: 12px; }
.filler-count { font-size: 12px; font-weight: 700; color: #f0a020; min-width: 14px; text-align: center; }
.filler-plus { font-size: 13px; }

.filler-total { font-size: 12px; color: var(--n-text-color3, #999); }
.filler-unit { color: var(--n-text-color3, #777); }

// --- 赘语按发言人 ---
.filler-speakers { display: flex; flex-direction: column; gap: 4px; }

.speaker-filler-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  flex-wrap: wrap;
}

.speaker-filler-name { font-weight: 600; color: #9fd4f0; min-width: 48px; }
.speaker-filler-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.speaker-filler-total { margin-left: auto; color: var(--n-text-color3, #999); font-variant-numeric: tabular-nums; }

.add-row { display: flex; gap: 8px; align-items: center; }

// --- 语法官 ---
.wotd-row { display: flex; gap: 8px; align-items: center; }

.note-group { display: flex; flex-direction: column; gap: 6px; }
.note-title { font-size: 11px; color: var(--n-text-color3, #888); }

.note-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);

  > span { flex: 1; }
}

// 金句条目：引文 + 出处 + 点评（竖排）
.note-item--quote {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;

  > span { flex: none; }
}

// --- 金句 ---
.quote-def { font-size: 11px; color: var(--n-text-color3, #999); }
.quote-speaker { color: #9fd4f0; font-size: 11px; }
.quote-reason { font-size: 11px; color: var(--n-text-color3, #999); padding-left: 4px; }

// --- 报告 ---
.report-section { gap: 8px; }
.report-generate-row { display: flex; gap: 8px; }
.report-generate-row .n-button { flex: 1; }
.report-error { font-size: 12px; color: #d03050; padding: 6px 8px; background: rgba(208, 48, 80, 0.08); border-radius: 6px; }
.report-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--n-text-color3, #888); }
.report-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.report-content { font-size: 13px; line-height: 1.6; }

// --- 设置 ---
.settings-form { display: flex; flex-direction: column; gap: 12px; }

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  label { font-size: 12px; color: var(--n-text-color3, #999); }
}

.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

// --- Transition ---
.round-fade-enter-active { transition: all 0.4s ease; }
.round-fade-enter-from { opacity: 0; transform: translateY(12px); }
</style>
