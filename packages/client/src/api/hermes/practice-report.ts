import { getApiKey } from '@/api/client'

/**
 * 口语对练分析报告（Markdown）服务端落盘 API。
 *
 * 报告文本在客户端确定性生成（见 utils/practice-mode.ts 的
 * buildPracticeReportMarkdown），保存成功后服务端返回文件名与绝对路径；
 * 下载用 api/hermes/download.ts 的 getDownloadUrl(path, fileName) 拼链接
 * （upload 目录内文件由 /api/hermes/download 本地读取，.md 的
 * text/markdown MIME 已支持）。
 */

export interface SavePracticeReportResult {
  ok: boolean
  fileName?: string
  path?: string
  error?: string
}

const MAX_REPORT_CHARS = 512 * 1024

/** POST /api/hermes/speech-practice/report */
export async function savePracticeReport(
  markdown: string,
  suggestedName?: string,
): Promise<SavePracticeReportResult> {
  const text = (markdown || '').trim()
  if (!text) return { ok: false, error: 'empty report' }
  if (text.length > MAX_REPORT_CHARS) return { ok: false, error: 'report too large' }

  try {
    const response = await fetch('/api/hermes/speech-practice/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
      body: JSON.stringify({ markdown: text, suggestedName }),
    })
    const payload = await response.json().catch(() => ({} as Record<string, unknown>))
    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: String(payload?.error || `save failed (${response.status})`) }
    }
    return {
      ok: true,
      fileName: String(payload?.fileName || 'report.md'),
      path: String(payload?.path || ''),
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, error: message }
  }
}
