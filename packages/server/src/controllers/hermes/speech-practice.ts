import {
  speechPracticeReportStore,
  PRACTICE_REPORT_MAX_CHARS,
} from '../../services/speech-practice-report'

function readString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, max)
}

/**
 * POST /api/hermes/speech-practice/report
 * body: { markdown: string, suggestedName?: string }
 * response: { ok: true, fileName: string, path: string }
 *          | { ok: false, error: string }
 *
 * 口语对练结束后的分析报告（Markdown）落盘到 Web UI state 目录（upload
 * 子树下的 speech-practice/），返回文件名与绝对路径；下载由客户端用
 * `/api/hermes/download?path=…&name=…` 完成。
 */
export async function savePracticeReport(ctx: any): Promise<void> {
  const body = (ctx.request?.body || {}) as Record<string, unknown>
  const rawMarkdown = typeof body.markdown === 'string' ? body.markdown : ''
  if (!rawMarkdown.trim()) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'markdown is required' }
    return
  }
  if (rawMarkdown.length > PRACTICE_REPORT_MAX_CHARS) {
    ctx.status = 413
    ctx.body = { ok: false, error: `markdown too large (max ${PRACTICE_REPORT_MAX_CHARS} chars)` }
    return
  }
  const markdown = rawMarkdown.trim()
  const suggestedName = readString(body.suggestedName, 200)

  try {
    const saved = await speechPracticeReportStore.saveReport(markdown, suggestedName)
    ctx.status = 200
    ctx.body = { ok: true, fileName: saved.fileName, path: saved.absPath }
  } catch (err: any) {
    const code = String(err?.code || '')
    if (code === 'report_too_large') {
      ctx.status = 413
      ctx.body = { ok: false, error: err?.message || 'report too large' }
      return
    }
    ctx.status = 500
    ctx.body = { ok: false, error: err?.message || 'failed to save report' }
  }
}
