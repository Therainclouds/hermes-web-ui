import type { MeetingSession, SpeechEvalState } from '@/stores/hermes/meeting'
import { useReportStream } from '@/composables/useReportStream'
import type { GoldenQuote, GrammarIssue } from '@/composables/useMeetingAssist'

/**
 * 报告构建所需的转写数据快照。全部以取值函数注入（兼容 ComputedRef、
 * reactive 解包属性与即时计算），由 SpeechEvaluationPanel 装配。
 */
export interface SpeechEvalTranscriptData {
  fillerWords: () => Record<string, number>
  aiFillerBySpeaker: () => Array<{ speaker: string; totals: Record<string, number>; total: number }>
  aiGoldenQuotes: () => GoldenQuote[]
  aiGrammarIssues: () => GrammarIssue[]
  aiWotdUsedCount: () => number
  highlights: () => string[]
  improvements: () => string[]
  topics: () => string[]
  liveScore: () => Record<string, number> | undefined
  speakerDurations: () => Array<{ speaker: string; durationSec: number }>
  transitionRecords: () => Array<{ label: string; durationSec: number; overtimeSec: number; timestamp: number }>
  transitionTotalSec: () => number
  fmtSec: (sec: number) => string
}

export interface UseSpeechEvalReportDeps {
  getSessionId: () => string
  getSession: () => MeetingSession | undefined
  evalState: () => SpeechEvalState
  transcriptData: SpeechEvalTranscriptData
  onReportGenerated?: (markdown: string) => void
}

/**
 * 演讲评估报告生成（自 SpeechEvaluationPanel 抽出；S4 行为改进）。
 *
 * 与旧实现相比的对齐项（均为设计稿标记的行为改进，非冻结项）：
 *  - SSE 解析改走 useReportStream：{ fallback: true } 帧会清空累积内容
 *    （agent→direct LLM 切换时不再拼接半截输出）
 *  - { error } 帧经 classifyReportError 归一化为可读的本地化文案
 *  - retryReport 支持按最近一次 transcript 重试
 */
export function useSpeechEvalReport(deps: UseSpeechEvalReportDeps) {
  const stream = useReportStream({
    getSessionId: deps.getSessionId,
    getSceneTemplate: () => 'speech',
    resolveProfile: () => deps.getSession()?.hermesProfile || undefined,
    onReportGenerated: deps.onReportGenerated,
  })

  const { reportMarkdown, isGeneratingReport, reportError, generateReport: streamReport } = stream

  function buildTranscriptWithEval(): string {
    const session = deps.getSession()
    const sentences = session?.sentences || []
    const lines = sentences.map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
    const st = deps.evalState()
    const td = deps.transcriptData
    const timerLines = (st.timerRecords || []).length
      ? (st.timerRecords || []).map(r => `- ${r.label}：${td.fmtSec(r.durationSec)}${r.overtimeSec > 0 ? `（超时 ${td.fmtSec(r.overtimeSec)}）` : ''}`)
      : ['（无记录）']
    const fillerLines = Object.entries(td.fillerWords())
      .filter(([, c]) => c > 0)
      .map(([w, c]) => `- ${w}：${c} 次`)
    const fillerBySpeakerLines = td.aiFillerBySpeaker().map(entry => {
      const words = Object.entries(entry.totals).map(([w, c]) => `${w}×${c}`).join('、')
      return `- ${entry.speaker}：${words || '（无）'}（共 ${entry.total} 次）`
    })
    const goldenLines = [
      ...td.aiGoldenQuotes().map(q => `- ${q.quote}${q.speaker ? `（${q.speaker}）` : ''}${q.reason ? `：${q.reason}` : ''}`),
      ...(st.goodPhrases || []).map(p => `- ${p}`),
    ]
    const grammarLines = [
      ...td.aiGrammarIssues().map(g => `- ${g.quote}${g.speaker ? `（${g.speaker}）` : ''}：${g.issue}`),
      ...(st.grammarNotes || []).map(n => `- ${n}`),
    ]
    const speakerLines = td.speakerDurations().map(d => `- ${d.speaker}：${td.fmtSec(d.durationSec)}`)
    const transitionLines = td.transitionRecords().length
      ? [
          `- 串场 ${td.transitionRecords().length} 次，共 ${td.fmtSec(td.transitionTotalSec())}`,
          ...td.transitionRecords().map(r => `- ${r.label}：${td.fmtSec(r.durationSec)}`),
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
      `## 每日一词：${st.wordOfTheDay || '（未设置）'}（AI 检测使用 ${td.aiWotdUsedCount()} 次${st.wotdUsedCount ? `，手动标记 ${st.wotdUsedCount} 次` : ''}）`,
      '## 金句',
      ...(goldenLines.length ? goldenLines : ['（无）']),
      '## 语法错误',
      ...(grammarLines.length ? grammarLines : ['（无）']),
      '## 肢体语言观察',
      ...(bodyLines.length ? bodyLines : ['（无）']),
      '## 亮点',
      ...(td.highlights().length ? td.highlights().map(h => `- ${h}`) : ['（无）']),
      '## 可提升的点',
      ...(td.improvements().length ? td.improvements().map(i => `- ${i}`) : ['（无）']),
      '## 主题',
      ...(td.topics().length ? td.topics().map(tp => `- ${tp}`) : ['（无）']),
      ...(td.liveScore() ? [`## 实时评分（最终）：${JSON.stringify(td.liveScore())}`] : []),
    ]
    return [...lines, '', ...evalBlock].join('\n')
  }

  /** 下载演讲评分逐字稿：逐字稿 + 评估数据（计时/赘语/金句/语法/肢体/评分）落盘为 .txt。 */
  function downloadVerbatim() {
    const transcript = buildTranscriptWithEval()
    if (!transcript.trim()) return
    const session = deps.getSession()
    const header = [
      `演讲评分逐字稿：${session?.title || ''}`,
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
    ].join('\n')
    const blob = new Blob([header + transcript], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${session?.title || '演讲评分'}_逐字稿.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function generateReport() {
    const transcript = buildTranscriptWithEval()
    if (!transcript.trim()) return
    await streamReport(transcript)
  }

  return {
    reportMarkdown,
    isGeneratingReport,
    reportError,
    buildTranscriptWithEval,
    downloadVerbatim,
    generateReport,
  }
}
