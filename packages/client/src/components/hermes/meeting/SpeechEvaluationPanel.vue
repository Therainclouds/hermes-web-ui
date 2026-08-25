<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NInputNumber, NModal, NSpin, NTag } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { SpeechEvalState, SpeechTimerRecord } from '@/stores/hermes/meeting'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { request, getApiKey } from '@/api/client'
import { buildReportHtml } from '@/utils/report-html'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

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
}

const evalState = computed<SpeechEvalState>(() => session.value?.speechEval || DEFAULT_EVAL)

function persist(patch: Partial<SpeechEvalState>) {
  meetingStore.updateSession(props.sessionId, { speechEval: { ...evalState.value, ...patch } })
}

// ---------- 计时员 (Timer) ----------

const timerRunning = ref(false)
const timerRemainingMs = ref(0)
const timerLabel = ref('')
let timerInterval: number | null = null
let timerStartAt = 0        // 本次开始计时的墙钟时间戳
let timerStartRemaining = 0 // 本次开始时的剩余毫秒

function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const timerDisplay = computed(() => {
  const rem = timerRemainingMs.value
  if (rem > 0) return fmtSec(rem / 1000)
  return `+${fmtSec(-rem / 1000)}`
})

const phase = computed(() => {
  const rem = timerRemainingMs.value
  if (rem <= evalState.value.redAtSec * 1000) return 'red'
  if (rem <= evalState.value.yellowAtSec * 1000) return 'yellow'
  return 'green'
})

const phaseLabel = computed(() => {
  const map = {
    green: t('meeting.speechEval.greenCard'),
    yellow: t('meeting.speechEval.yellowCard'),
    red: t('meeting.speechEval.redCard'),
  }
  return map[phase.value]
})

function resetTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  timerRunning.value = false
  timerRemainingMs.value = evalState.value.timerDurationSec * 1000
}

function toggleTimer() {
  if (timerRunning.value) {
    // 暂停：按墙钟结算剩余时间
    timerRemainingMs.value = timerStartRemaining - (Date.now() - timerStartAt)
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
    timerRunning.value = false
    return
  }
  timerStartAt = Date.now()
  timerStartRemaining = timerRemainingMs.value
  timerRunning.value = true
  timerInterval = window.setInterval(() => {
    timerRemainingMs.value = timerStartRemaining - (Date.now() - timerStartAt)
  }, 250)
}

function nextLabel(): string {
  const n = timerRecords.value.length + 1
  return `${t('meeting.speechEval.segmentLabelPrefix')} ${n}`
}

function recordSegment() {
  const durationSec = evalState.value.timerDurationSec - timerRemainingMs.value / 1000
  const overtimeSec = Math.max(0, -timerRemainingMs.value / 1000)
  const record: SpeechTimerRecord = {
    label: timerLabel.value.trim() || nextLabel(),
    durationSec,
    overtimeSec,
    timestamp: Date.now(),
  }
  persist({ timerRecords: [...evalState.value.timerRecords, record] })
  timerLabel.value = ''
  resetTimer()
}

function removeRecord(index: number) {
  const records = [...evalState.value.timerRecords]
  records.splice(index, 1)
  persist({ timerRecords: records })
}

const timerRecords = computed(() => evalState.value.timerRecords || [])

// ---------- 计时设置 ----------

const showSettings = ref(false)
const settingsDuration = ref(180)
const settingsYellow = ref(30)
const settingsRed = ref(10)

function openSettings() {
  settingsDuration.value = evalState.value.timerDurationSec
  settingsYellow.value = evalState.value.yellowAtSec
  settingsRed.value = evalState.value.redAtSec
  showSettings.value = true
}

function saveSettings() {
  persist({
    timerDurationSec: Math.max(10, Math.round(settingsDuration.value || 180)),
    yellowAtSec: Math.max(0, Math.round(settingsYellow.value || 30)),
    redAtSec: Math.max(0, Math.round(settingsRed.value || 10)),
  })
  showSettings.value = false
  resetTimer()
}

// ---------- 演讲上下文（注入 AI 提示词：计时/每日一词） ----------

function buildSpeechContext() {
  return {
    wordOfTheDay: evalState.value.wordOfTheDay || undefined,
    timerDurationSec: evalState.value.timerDurationSec,
    yellowAtSec: evalState.value.yellowAtSec,
    redAtSec: evalState.value.redAtSec,
    timerRecords: evalState.value.timerRecords || [],
    // 倒计时状态始终上报（含暂停/超时），让 AI 的评分以实际时间情况为依据
    currentRemainingSec: Math.max(0, timerRemainingMs.value / 1000),
    currentPhase: phase.value,
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
  if (recording && !timerRunning.value && timerRemainingMs.value === evalState.value.timerDurationSec * 1000) {
    toggleTimer()
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

const aiFillerTotals = computed<Record<string, number>>(() => {
  const totals: Record<string, number> = {}
  for (const r of rounds.value) {
    for (const f of r.fillerWords || []) {
      totals[f.word] = (totals[f.word] || 0) + f.count
    }
  }
  return totals
})

// 赘语展示 = AI 检测汇总 + 手动修正
const fillerWords = computed<Record<string, number>>(() => {
  const merged: Record<string, number> = { ...evalState.value.fillerWords }
  for (const [w, c] of Object.entries(aiFillerTotals.value)) {
    merged[w] = (merged[w] || 0) + c
  }
  return merged
})

const fillerTotal = computed(() => Object.values(fillerWords.value).reduce((a, b) => a + b, 0))

// 手动修正只累加在 evalState.fillerWords（与 AI 检测分开计数，展示时合并）
function incrementFiller(word: string) {
  persist({ fillerWords: { ...evalState.value.fillerWords, [word]: (evalState.value.fillerWords[word] || 0) + 1 } })
}

// 仅允许删除纯手动添加的词（AI 检测的词由 AI 数据驱动，删除无意义）
function removeFiller(word: string) {
  const next = { ...evalState.value.fillerWords }
  delete next[word]
  persist({ fillerWords: next })
}

const aiGoodPhrases = computed<string[]>(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rounds.value) {
    for (const p of r.goodPhrases || []) {
      if (!seen.has(p)) { seen.add(p); out.push(p) }
    }
  }
  return out
})

const aiGrammarIssues = computed<Array<{ quote: string; issue: string }>>(() => {
  const seen = new Set<string>()
  const out: Array<{ quote: string; issue: string }> = []
  for (const r of rounds.value) {
    for (const g of r.grammarIssues || []) {
      const key = `${g.quote}|${g.issue}`
      if (!seen.has(key)) { seen.add(key); out.push(g) }
    }
  }
  return out
})

const aiWotdUsedCount = computed(() => rounds.value.filter(r => r.wotdUsed).length)

const scoreLabelMap: Record<string, string> = {
  content: 'meeting.speechEval.scoreContent',
  structure: 'meeting.speechEval.scoreStructure',
  language: 'meeting.speechEval.scoreLanguage',
  timeControl: 'meeting.speechEval.scoreTimeControl',
  overall: 'meeting.speechEval.scoreOverall',
}

// ---------- 赘语记录员 (Ah-Counter) ----------

const newFiller = ref('')

function addFiller() {
  const word = newFiller.value.trim()
  if (!word) return
  // 手动登记该词（保留当前合并计数，使其可被删除；AI 词只读）
  persist({ fillerWords: { ...evalState.value.fillerWords, [word]: evalState.value.fillerWords[word] || 0 } })
  newFiller.value = ''
}

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

// ---------- 评估报告 ----------

const isGeneratingReport = ref(false)
const reportMarkdown = ref('')
const reportError = ref<string | null>(null)

function buildTranscriptWithEval(): string {
  const sentences = session.value?.sentences || []
  const lines = sentences.map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
  const st = evalState.value
  const timerLines = (st.timerRecords || []).length
    ? (st.timerRecords || []).map(r => `- ${r.label}：${fmtSec(r.durationSec)}${r.overtimeSec > 0 ? `（超时 ${fmtSec(r.overtimeSec)}）` : ''}`)
    : ['（无记录）']
  const fillerLines = Object.entries(fillerWords.value)
    .filter(([, c]) => c > 0)
    .map(([w, c]) => `- ${w}：${c} 次`)
  const goodLines = [...aiGoodPhrases.value, ...(st.goodPhrases || [])]
  const grammarLines = [...aiGrammarIssues.value.map(g => `- ${g.quote}：${g.issue}`), ...(st.grammarNotes || []).map(n => `- ${n}`)]
  const evalBlock = [
    '【演讲评估数据】',
    '## 计时员记录',
    ...timerLines,
    '## 赘语统计',
    ...(fillerLines.length ? fillerLines : ['（无赘语）']),
    `## 每日一词：${st.wordOfTheDay || '（未设置）'}（AI 检测使用 ${aiWotdUsedCount.value} 次${st.wotdUsedCount ? `，手动标记 ${st.wotdUsedCount} 次` : ''}）`,
    '## 好词好句',
    ...(goodLines.length ? goodLines.map(p => `- ${p}`) : ['（无）']),
    '## 语法错误',
    ...(grammarLines.length ? grammarLines : ['（无）']),
  ]
  return [...lines, '', ...evalBlock].join('\n')
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

function exportReportHtml() {
  if (!reportMarkdown.value) return
  const title = session.value?.title || t('meeting.reportPanel.title')
  const html = buildReportHtml(reportMarkdown.value, title)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title}_演讲评估.html`
  a.click()
  URL.revokeObjectURL(url)
}

// 切换会话时重置
watch(() => props.sessionId, () => {
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  disconnect()
  clear()
  resetTimer()
  wotdInput.value = evalState.value.wordOfTheDay || ''
  reportMarkdown.value = ''
  reportError.value = null
})

onMounted(() => {
  resetTimer()
  wotdInput.value = evalState.value.wordOfTheDay || ''
})

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
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

      <div v-if="rounds.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyRounds') }}</div>

      <TransitionGroup name="round-fade">
        <div v-for="round in rounds" :key="round.id" class="round-card" :class="`priority-${round.priority}`">
          <div class="round-meta">
            <span class="round-time">{{ new Date(round.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
            <span v-if="round.priority === 'urgent'" class="priority-badge urgent">{{ t('meeting.assist.urgent') }}</span>
            <span v-else-if="round.priority === 'attention'" class="priority-badge attention">{{ t('meeting.assist.attention') }}</span>
          </div>

          <div v-if="round.keyPoint" class="round-keypoint" :class="`priority-${round.priority}`">{{ round.keyPoint }}</div>
          <div v-if="round.context" class="round-context">「{{ round.context }}」</div>
          <div v-if="round.analysis" class="round-analysis">{{ round.analysis }}</div>
          <div v-if="round.timeNote" class="round-timenote">⏱️ {{ round.timeNote }}</div>

          <!-- 评分表 -->
          <div v-if="round.score && Object.keys(round.score).length" class="score-table">
            <div class="score-row" v-for="(labelKey, key) in scoreLabelMap" :key="key">
              <span class="score-label">{{ t(labelKey) }}</span>
              <span class="score-value">{{ round.score[key] ?? '—' }}</span>
            </div>
          </div>

          <!-- 赘语 -->
          <div v-if="round.fillerWords?.length" class="round-chips">
            <NTag v-for="f in round.fillerWords" :key="f.word" size="small" type="warning" :bordered="false">
              {{ f.word }} ×{{ f.count }}
            </NTag>
          </div>

          <!-- 好词好句 -->
          <div v-if="round.goodPhrases?.length" class="round-lists">
            <div class="round-list-title">✨ {{ t('meeting.speechEval.goodPhrases') }}</div>
            <div v-for="(p, i) in round.goodPhrases" :key="i" class="round-list-item">「{{ p }}」</div>
          </div>

          <!-- 语法问题 -->
          <div v-if="round.grammarIssues?.length" class="round-lists">
            <div class="round-list-title">⚠️ {{ t('meeting.speechEval.grammarIssues') }}</div>
            <div v-for="(g, i) in round.grammarIssues" :key="i" class="round-list-item">
              「{{ g.quote }}」— {{ g.issue }}
            </div>
          </div>

          <!-- 每日一词使用 -->
          <div v-if="round.wotdUsed" class="round-wotd">📖 {{ t('meeting.speechEval.wotdUsedFlag') }}</div>
        </div>
      </TransitionGroup>

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
        <NButton size="tiny" quaternary class="settings-btn" @click="openSettings">
          ⚙️ {{ t('meeting.speechEval.settings') }}
        </NButton>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.timerDesc') }}</p>

      <div class="timer-display" :class="`phase-${phase}`">
        <span class="timer-time">{{ timerDisplay }}</span>
        <span class="timer-phase-label">{{ phaseLabel }}</span>
      </div>

      <div class="timer-cards">
        <span class="card green" :class="{ active: phase === 'green' }">🟢 {{ t('meeting.speechEval.greenCard') }}</span>
        <span class="card yellow" :class="{ active: phase === 'yellow' }">🟡 {{ t('meeting.speechEval.yellowCard') }}</span>
        <span class="card red" :class="{ active: phase === 'red' }">🔴 {{ t('meeting.speechEval.redCard') }}</span>
      </div>

      <div class="timer-controls">
        <NButton size="small" :type="timerRunning ? 'warning' : 'primary'" @click="toggleTimer">
          {{ timerRunning ? t('meeting.speechEval.pause') : t('meeting.speechEval.start') }}
        </NButton>
        <NButton size="small" @click="resetTimer">{{ t('meeting.speechEval.reset') }}</NButton>
      </div>

      <div class="segment-row">
        <NInput v-model:value="timerLabel" size="small" :placeholder="t('meeting.speechEval.segmentLabelPlaceholder')" />
        <NButton size="small" type="primary" @click="recordSegment">{{ t('meeting.speechEval.recordSegment') }}</NButton>
      </div>

      <div class="time-records">
        <div class="records-title">{{ t('meeting.speechEval.timeRecords') }}</div>
        <div v-if="timerRecords.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyRecords') }}</div>
        <div v-for="(r, i) in timerRecords" :key="i" class="record-item">
          <span class="record-label">{{ r.label }}</span>
          <span class="record-duration">{{ fmtSec(r.durationSec) }}<span v-if="r.overtimeSec > 0" class="record-overtime"> (+{{ fmtSec(r.overtimeSec) }})</span></span>
          <button class="record-remove" @click="removeRecord(i)">×</button>
        </div>
      </div>
    </section>

    <!-- 赘语记录员（AI 检测） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="role-icon">🔤</span>
        <span class="section-name">{{ t('meeting.speechEval.ahCounter') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.ahCounterDesc') }}</p>

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

      <!-- AI 检测的好词好句 -->
      <div v-if="aiGoodPhrases.length" class="note-group">
        <div class="note-title">✨ {{ t('meeting.speechEval.aiGoodPhrases') }}</div>
        <div v-for="(p, i) in aiGoodPhrases" :key="`ai-${i}`" class="note-item"><span>「{{ p }}」</span></div>
      </div>

      <!-- AI 检测的语法问题 -->
      <div v-if="aiGrammarIssues.length" class="note-group">
        <div class="note-title">⚠️ {{ t('meeting.speechEval.aiGrammarIssues') }}</div>
        <div v-for="(g, i) in aiGrammarIssues" :key="`ai-${i}`" class="note-item"><span>「{{ g.quote }}」— {{ g.issue }}</span></div>
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

    <!-- 评估报告 -->
    <section class="eval-section report-section">
      <div class="section-title">
        <span class="role-icon">📊</span>
        <span class="section-name">{{ t('meeting.speechEval.reportTitle') }}</span>
      </div>
      <NButton type="primary" size="small" block :loading="isGeneratingReport" :disabled="!session?.sentences?.length" @click="generateReport">
        {{ t('meeting.speechEval.generateReport') }}
      </NButton>

      <div v-if="reportError" class="report-error">{{ reportError }}</div>

      <div v-if="isGeneratingReport && !reportMarkdown" class="report-loading">
        <NSpin size="small" />
        <span>{{ t('meeting.speechEval.generating') }}</span>
      </div>

      <div v-if="reportMarkdown" class="report-content">
        <div class="report-actions">
          <NButton size="tiny" @click="exportReportHtml">{{ t('meeting.speechEval.exportReport') }}</NButton>
        </div>
        <MarkdownRenderer :content="reportMarkdown" />
      </div>
    </section>

    <!-- 计时设置弹窗 -->
    <NModal
      v-model:show="showSettings"
      preset="card"
      :title="t('meeting.speechEval.settingsTitle')"
      :style="{ width: '380px' }"
      :bordered="false"
    >
      <div class="settings-form">
        <div class="setting-field">
          <label>{{ t('meeting.speechEval.durationLabel') }}</label>
          <NInputNumber v-model:value="settingsDuration" :min="10" :max="3600" size="small" style="width: 100%" />
        </div>
        <div class="setting-field">
          <label>{{ t('meeting.speechEval.yellowLabel') }}</label>
          <NInputNumber v-model:value="settingsYellow" :min="0" :max="300" size="small" style="width: 100%" />
        </div>
        <div class="setting-field">
          <label>{{ t('meeting.speechEval.redLabel') }}</label>
          <NInputNumber v-model:value="settingsRed" :min="0" :max="300" size="small" style="width: 100%" />
        </div>
        <div class="settings-actions">
          <NButton size="small" @click="showSettings = false">{{ t('common.cancel') }}</NButton>
          <NButton size="small" type="primary" @click="saveSettings">{{ t('common.confirm') }}</NButton>
        </div>
      </div>
    </NModal>
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

.score-table {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(112, 192, 232, 0.06);
  border: 1px solid rgba(112, 192, 232, 0.15);
}

.score-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.score-label { color: var(--n-text-color3, #999); }
.score-value { font-weight: 700; color: #70c0e8; font-variant-numeric: tabular-nums; }

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

.timer-controls { display: flex; gap: 8px; }
.segment-row { display: flex; gap: 8px; align-items: center; }

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

// --- 报告 ---
.report-section { gap: 8px; }
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

.settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

// --- Transition ---
.round-fade-enter-active { transition: all 0.4s ease; }
.round-fade-enter-from { opacity: 0; transform: translateY(12px); }
</style>
