import type {
  AnalysisResult,
  MeetingSession,
  SpeechEvalState,
  TranscriptSentence,
} from '@/stores/hermes/meeting'

/** 待办事项兼容两种历史结构：纯字符串，或 { task, assignee, deadline }。 */
type ActionItem = string | { task?: string; assignee?: string; deadline?: string }

/**
 * 会议文字（ASR 逐字稿）Markdown 导出。
 *
 * 目标：把一场会议能拿到的**全部文字细节**打包成一份排版美观、可离线阅读的
 * `.md` 文件，而不是只导出裸句子：
 *   - 会议信息表（场景 / 时间 / 时长 / 句数 / 说话人数 / ASR 模型 / 分析配置）
 *   - 说话人名单
 *   - 带「相对时间 + 墙钟时间 + 说话人」的逐字稿
 *   - 无时间戳的连续全文（方便复制粘贴）
 *   - AI 分析结果（摘要 / 要点 / 待办 / 决策 / 风险 / 主题 / 反馈 / 关系…）
 *   - 实时分析记录（轮次时间线）
 *   - 演讲评分场景专属数据（计时 / 赘语 / 金句 / 语法 / 肢体观察）
 *
 * 导出文本是离线产物，标题与表头沿用项目既有约定使用中文硬编码
 * （与 utils/speech-export.ts 一致），不参与 UI i18n；场景名可由调用方注入。
 */

export interface MeetingTranscriptMarkdownOptions {
  /** 场景显示名（如「法律沟通」）。缺省时按内置场景表回退，未知场景用其原始 id。 */
  sceneLabel?: string
}

const SCENE_LABELS: Record<string, string> = {
  general: '通用会议',
  business: '商务谈判',
  medical: '医疗问诊',
  legal: '法律沟通',
  interview: '客户访谈',
  speech: '演讲评分',
}

const STATUS_LABELS: Record<MeetingSession['status'], string> = {
  idle: '未开始',
  recording: '录音中',
  paused: '已暂停',
  completed: '已完成',
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  attention: '注意',
  normal: '常规',
}

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

/** 毫秒时间戳 → 本地墙钟 `HH:MM:SS`。 */
function formatClock(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 毫秒时间戳 → 本地日期时间 `YYYY-MM-DD HH:MM:SS`。 */
function formatDateTime(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(ts)}`
}

/** 毫秒时长 → `mm:ss` 或 `H:MM:SS`；非法/缺失返回空串。 */
function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** Markdown 表格单元格转义：竖线会截断列，换行会截断行。 */
function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** 正文转义：避免句子里的 `*`/`_`/`#` 破坏 Markdown 结构。 */
function escapeInline(value: string): string {
  return String(value ?? '').replace(/([\\`*_{}[\]()#+!|>-])/g, '\\$1')
}

function bulletList(items: string[] | undefined, empty = '（无）'): string[] {
  if (!items || items.length === 0) return [`- ${empty}`]
  return items.map(i => `- ${i}`)
}

function table(header: string[], rows: string[][]): string[] {
  const out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`)
  return out
}

/** 说话的展示名：优先句子自带 speaker，其次 speakerMap[speakerId]，兜底「未标注」。 */
function resolveSpeaker(sentence: TranscriptSentence, speakerMap: Record<string, string>): string {
  const named = (sentence.speaker || '').trim()
  if (named) return named
  if (sentence.speakerId && speakerMap[sentence.speakerId]) return speakerMap[sentence.speakerId]
  return '未标注'
}

/** 单句时间标签：`mm:ss–mm:ss`（有起止时间）或墙钟时间，两者都有则用 ` · ` 连接。 */
function sentenceTimeLabel(sentence: TranscriptSentence): string {
  const start = typeof sentence.startTime === 'number' ? sentence.startTime : undefined
  const end = typeof sentence.endTime === 'number' ? sentence.endTime : undefined
  const parts: string[] = []
  if (start != null) {
    const range = end != null && end > start
      ? `${formatDuration(start)}–${formatDuration(end)}`
      : formatDuration(start)
    if (range) parts.push(range)
  }
  const clock = formatClock(sentence.timestamp)
  if (clock) parts.push(clock)
  return parts.join(' · ')
}

function buildInfoSection(session: MeetingSession, opts: MeetingTranscriptMarkdownOptions): string[] {
  const sceneId = session.sceneTemplate || 'general'
  const sceneLabel = opts.sceneLabel || SCENE_LABELS[sceneId] || sceneId
  const speakerCount = collectSpeakers(session).size
  const rows: string[][] = [
    ['会议标题', session.title || '未命名会议'],
    ['会议场景', sceneLabel],
    ['会议状态', STATUS_LABELS[session.status] || session.status],
    ['创建时间', formatDateTime(session.createdAt)],
    ['最后更新', formatDateTime(session.updatedAt)],
    ['录音时长', formatDuration(session.audioDuration ? session.audioDuration * 1000 : undefined) || '—'],
    ['句子数量', String(session.sentences.length)],
    ['说话人数量', String(speakerCount)],
    ['说话人分离', session.useDiarize ? '已开启' : '未开启'],
    ['ASR 模型', session.asrModel || '—'],
    ['分析模式', session.analysisMode === 'hermes' ? 'Hermes Agent' : '自定义模型'],
  ]
  if (session.analysisMode === 'hermes') {
    if (session.hermesProfile) rows.push(['Agent Profile', session.hermesProfile])
  } else {
    if (session.customProvider) rows.push(['模型提供方', session.customProvider])
    if (session.customModel) rows.push(['分析模型', session.customModel])
  }
  return ['## 一、会议信息', '', ...table(['项目', '内容'], rows), '']
}

function collectSpeakers(session: MeetingSession): Map<string, string> {
  const names = new Map<string, string>()
  const seenLabels = new Set<string>()
  const remember = (id: string, rawName: string) => {
    const label = (rawName || '').trim()
    if (!label || names.has(id)) return
    names.set(id, label)
    seenLabels.add(label)
  }
  for (const sp of session.speakers || []) remember(String(sp.id), sp.displayName)
  for (const [id, name] of Object.entries(session.speakerMap || {})) remember(String(id), name)
  for (const sentence of session.sentences || []) {
    const label = resolveSpeaker(sentence, session.speakerMap || {})
    if (label && label !== '未标注' && !seenLabels.has(label)) {
      names.set(label, label)
      seenLabels.add(label)
    }
  }
  return names
}

function buildSpeakerSection(session: MeetingSession): string[] {
  const speakers = collectSpeakers(session)
  const rows = [...speakers.entries()].map(([id, name], i) => [String(i + 1), id, name])
  const body = rows.length
    ? table(['编号', '标识', '显示名称'], rows)
    : ['（未识别到说话人）']
  return ['## 二、说话人', '', ...body, '']
}

function buildTranscriptSection(session: MeetingSession): string[] {
  const speakerMap = session.speakerMap || {}
  const sentences = session.sentences || []
  const out = ['## 三、逐字稿（含时间戳）', '']
  if (sentences.length === 0) {
    out.push('（无转写内容）', '')
    return out
  }
  sentences.forEach((sentence, index) => {
    const time = sentenceTimeLabel(sentence)
    const speaker = resolveSpeaker(sentence, speakerMap)
    const prefix = time ? `**[${time}]** ` : ''
    out.push(`- ${prefix}**${escapeInline(speaker)}：** ${escapeInline(sentence.text || '')}`)
    // 每 20 句插入一条分隔线，长逐字稿更易读（也方便分页打印）。
    if ((index + 1) % 20 === 0 && index + 1 < sentences.length) out.push('', '---', '')
  })
  out.push('')
  return out
}

function buildPlainTranscriptSection(session: MeetingSession): string[] {
  const speakerMap = session.speakerMap || {}
  const sentences = session.sentences || []
  const out = ['## 四、全文（无时间戳，便于复制）', '']
  if (sentences.length === 0) {
    out.push('（无转写内容）', '')
    return out
  }
  let lastSpeaker = ''
  for (const sentence of sentences) {
    const speaker = resolveSpeaker(sentence, speakerMap)
    if (speaker !== lastSpeaker) {
      out.push('', `**${escapeInline(speaker)}：**`)
      lastSpeaker = speaker
    }
    out.push(escapeInline(sentence.text || ''))
  }
  out.push('')
  return out
}

function formatActionItem(item: ActionItem): string {
  if (typeof item === 'string') return item
  const parts: string[] = []
  if (item && typeof item === 'object') {
    if (item.task) parts.push(item.task)
    if (item.assignee) parts.push(`负责人：${item.assignee}`)
    if (item.deadline) parts.push(`截止：${item.deadline}`)
  }
  return parts.join(' · ')
}

function buildAnalysisSection(result: AnalysisResult | null): string[] {
  if (!result) return []
  const out = ['## 五、AI 分析结果', '']
  const pushList = (title: string, items: string[] | undefined) => {
    if (!items || items.length === 0) return
    out.push(`### ${title}`, '', ...bulletList(items), '')
  }

  if (result.meeting_type) out.push(`**会议类型：** ${result.meeting_type}`, '')
  if (result.summary) out.push('### 摘要', '', result.summary, '')
  pushList('关键要点', result.key_points)
  if (result.action_items && result.action_items.length) {
    out.push('### 待办事项', '')
    for (const item of result.action_items) out.push(`- [ ] ${formatActionItem(item as ActionItem)}`)
    out.push('')
  }
  pushList('决策', result.decisions)
  pushList('风险', result.risks)
  pushList('收获与学习', result.learnings)
  pushList('会议主题', result.topics)
  pushList('提及的人', result.people_mentioned)

  const feedback = result.feedback
  if (feedback && ((feedback.positive?.length ?? 0) > 0 || (feedback.negative?.length ?? 0) > 0)) {
    out.push('### 反馈', '')
    out.push('**做得好的：**', ...bulletList(feedback.positive), '')
    out.push('**可提升的：**', ...bulletList(feedback.negative), '')
  }

  if (result.relationships && result.relationships.length) {
    out.push('### 人物关系', '')
    out.push(...table(
      ['来源', '关系', '目标'],
      result.relationships.map(r => [r.source, r.relation, r.target]),
    ), '')
  }
  return out
}

function buildRealtimeRoundsSection(session: MeetingSession): string[] {
  const rounds = session.analysisRounds || []
  if (rounds.length === 0) return []
  const out = ['## 六、实时分析记录', '']
  for (const round of rounds) {
    const time = formatClock(round.timestamp)
    const priority = PRIORITY_LABELS[round.priority] || round.priority
    out.push(`### ${time ? `${time} · ` : ''}${priority}`)
    if (round.keyPoint) out.push('', `**${round.keyPoint}**`)
    if (round.context) out.push('', `> 「${round.context}」`)
    if (round.analysis) out.push('', round.analysis)
    out.push('')
  }
  return out
}

function buildSpeechEvalSection(evalState: SpeechEvalState | undefined): string[] {
  if (!evalState) return []
  const out = ['## 七、演讲评分数据', '']

  if (evalState.timerRecords && evalState.timerRecords.length) {
    out.push('### 计时记录', '')
    out.push(...table(
      ['环节 / 演讲者', '用时（秒）', '超时（秒）', '时刻'],
      evalState.timerRecords.map(r => [
        r.label || '未命名环节',
        String(Math.round(r.durationSec || 0)),
        String(Math.round(r.overtimeSec || 0)),
        formatClock(r.timestamp) || '—',
      ]),
    ), '')
  }

  const fillerEntries = Object.entries(evalState.fillerWords || {})
  if (fillerEntries.length) {
    out.push('### 赘语统计', '')
    out.push(...table(
      ['赘语', '次数'],
      fillerEntries.map(([word, count]) => [word, String(count)]),
    ), '')
  }

  if (evalState.wordOfTheDay) out.push('### 每日一词', '', evalState.wordOfTheDay, '')
  if (evalState.goodPhrases?.length) {
    out.push('### 金句', '', ...bulletList(evalState.goodPhrases), '')
  }
  if (evalState.grammarNotes?.length) {
    out.push('### 语法记录', '', ...bulletList(evalState.grammarNotes), '')
  }
  if (evalState.bodyNotes?.length) {
    out.push('### 肢体语言观察', '', ...bulletList(evalState.bodyNotes), '')
  }
  return out
}

/** 组装一场会议的完整 Markdown 导出文本。 */
export function buildMeetingTranscriptMarkdown(
  session: MeetingSession,
  opts: MeetingTranscriptMarkdownOptions = {},
): string {
  const title = session.title || '未命名会议'
  const out: string[] = [
    `# ${title}`,
    '',
    `> 会议文字记录（ASR 逐字稿） · 导出时间：${formatDateTime(Date.now())}`,
    '',
    ...buildInfoSection(session, opts),
    ...buildSpeakerSection(session),
    ...buildTranscriptSection(session),
    ...buildPlainTranscriptSection(session),
    ...buildAnalysisSection(session.analysisResult),
    ...buildRealtimeRoundsSection(session),
    ...buildSpeechEvalSection(session.speechEval),
  ]
  // 压缩超过两行的连续空行，避免长文档出现大片留白。
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** 文件名安全化（与报告导出一致），maxLength 截断避免超长文件名。 */
export function sanitizeTranscriptFileName(name: string, maxLength = 32): string {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || '会议文字').slice(0, maxLength)
}

/** 导出文件名：`<标题>_会议文字_YYYYMMDD-HHMM.md`。 */
export function buildTranscriptFileName(session: MeetingSession, date = new Date()): string {
  const stem = sanitizeTranscriptFileName(session.title || '会议文字')
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`
  return `${stem}_会议文字_${stamp}.md`
}

/** 浏览器端触发 `.md` 下载。 */
export function downloadMeetingTranscriptMarkdown(
  session: MeetingSession,
  opts: MeetingTranscriptMarkdownOptions = {},
): void {
  const markdown = buildMeetingTranscriptMarkdown(session, opts)
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = buildTranscriptFileName(session)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
