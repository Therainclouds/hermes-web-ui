import type { AnalysisRound } from '@/composables/useMeetingAssist'
import type { TranscriptSentence } from '@/stores/hermes/meeting'
import { resolveSegmentSpeaker, type SpeechSegmentRange } from '@/utils/speech-segments'

/**
 * 演讲场景导出工具：
 *  1) 按演讲者打包实时点评（评分 + 亮点/提升点/主题 + 点评轮次）为 Markdown
 *  2) 把逐字稿句子按演讲者分组（支持按已记录环节时间线兜底归属）
 *  3) 浏览器端文本文件下载
 * 与 useSpeechEvalReport 的逐字稿导出一致，导出文件内的标题用中文硬编码
 * （导出物是离线阅读的文件，不参与 UI i18n）。
 */

/** 评分维度 → 导出文件中的中文列名（与 SCORE_LABEL_MAP 的 key 对应） */
const SCORE_LABELS: Record<string, string> = {
  content: '内容',
  structure: '结构',
  language: '语言表达',
  timeControl: '时间把控',
  overall: '总分',
}

export interface SpeakerFeedbackInput {
  speaker: string
  score?: Record<string, number>
  scoreUpdatedAt?: number
  highlights: string[]
  improvements: string[]
  topics: string[]
  rounds: AnalysisRound[]
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function linesOrNone(items: string[], prefix = '- '): string[] {
  return items.length ? items.map(i => `${prefix}${i}`) : ['-（无）']
}

/** 单位演讲者的点评打包为 Markdown 段落（可独立下载，也可多人拼接导出） */
export function buildSpeakerFeedbackMarkdown(input: SpeakerFeedbackInput): string {
  const out: string[] = [`# 🎤 ${input.speaker || '未标注'} · 演讲点评`]

  if (input.score && Object.keys(input.score).length > 0) {
    const keys = Object.keys(SCORE_LABELS).filter(k => typeof input.score![k] === 'number')
    if (keys.length) {
      out.push('', '## 评分', '')
      out.push(`| ${keys.map(k => SCORE_LABELS[k]).join(' | ')} |`)
      out.push(`| ${keys.map(() => '---').join(' | ')} |`)
      out.push(`| ${keys.map(k => input.score![k]).join(' | ')} |`)
      if (input.scoreUpdatedAt) out.push('', `> 更新于 ${fmtClock(input.scoreUpdatedAt)}`)
    }
  }

  out.push('', '## ✨ 亮点', ...linesOrNone(input.highlights))
  out.push('', '## 💡 可提升的点', ...linesOrNone(input.improvements))
  out.push('', '## 🏷️ 主题', ...linesOrNone(input.topics))

  if (input.rounds.length) {
    out.push('', '## 🆕 点评轮次')
    for (const r of input.rounds) {
      out.push('', `### ${fmtClock(r.timestamp)}`)
      if (r.keyPoint) out.push(`**${r.keyPoint}**`)
      if (r.context) out.push(`> 「${r.context}」`)
      if (r.analysis) out.push(r.analysis)
      if (r.timeNote) out.push(`⏱️ ${r.timeNote}`)
      for (const f of r.fillerWords || []) {
        out.push(`- 赘语：${f.word} ×${f.count}${f.speaker ? `（${f.speaker}）` : ''}`)
      }
      for (const q of r.goldenQuotes || []) {
        out.push(`- 金句：「${q.quote}」${q.speaker ? `—— ${q.speaker}` : ''}${q.reason ? `：${q.reason}` : ''}`)
      }
      for (const g of r.grammarIssues || []) {
        out.push(`- 语法：「${g.quote}」— ${g.issue}${g.speaker ? `（${g.speaker}）` : ''}`)
      }
      if (r.wotdUsed) out.push('- 📖 使用了每日一词')
    }
  }
  return out.join('\n')
}

/** 多位演讲者的点评拼接为一份完整 Markdown（整体导出） */
export function buildAllSpeakersFeedbackMarkdown(inputs: SpeakerFeedbackInput[]): string {
  const header = `# 演讲点评汇总\n\n> 导出时间：${new Date().toLocaleString('zh-CN')}\n`
  return [header, ...inputs.map(buildSpeakerFeedbackMarkdown)].join('\n\n---\n\n')
}

/**
 * 把逐字稿句子按演讲者分组（保持出现顺序）。
 * 句子自带 speaker 优先；缺失时用已记录环节时间线按时间戳兜底归属。
 * 返回按首次出现顺序排列的分组；speaker 为空串表示「未标注」桶。
 */
export function groupSentencesBySpeaker(
  sentences: TranscriptSentence[],
  ranges?: SpeechSegmentRange[],
): Array<{ speaker: string; sentences: TranscriptSentence[] }> {
  const bySpeaker = new Map<string, TranscriptSentence[]>()
  for (const s of sentences || []) {
    let sp = (s.speaker || '').trim()
    if (!sp) sp = resolveSegmentSpeaker(ranges || [], s.timestamp, '')
    let bucket = bySpeaker.get(sp)
    if (!bucket) { bucket = []; bySpeaker.set(sp, bucket) }
    bucket.push(s)
  }
  return [...bySpeaker.entries()].map(([speaker, list]) => ({ speaker, sentences: list }))
}

/** 浏览器端文本文件下载（Blob + a[download]） */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
