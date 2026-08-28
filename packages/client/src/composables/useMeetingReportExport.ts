import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from '@/composables/useAppMessage'
import { buildReportHtml } from '@/utils/report-html'
import { downloadMeetingReportDocx, sanitizeFileName } from '@/utils/hermes/meeting-report-docx'

export type ExportFormat = 'docx' | 'html' | 'markdown'

function dateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/** 把内容触发为浏览器下载，HTML / Markdown 复用此实现。 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 会议报告导出 composable：docx / html / markdown 三种格式。
 *
 * 与 useDiscussionReportDownload 同源思路（独立实现、互不耦合），
 * 仅为会议/演讲评估场景复用一套导出入口。
 */
export function useMeetingReportExport(getMarkdown: () => string, getTitle: () => string) {
  const { t } = useI18n()
  const message = useMessage()
  const isExporting = ref(false)

  function resolveFileBase(): string {
    const base = sanitizeFileName(getTitle() || '')
    return `${base}_报告-${dateStamp()}`
  }

  async function exportAsDocx(): Promise<void> {
    const md = getMarkdown()
    if (!md) {
      message.warning(t('meeting.reportPanel.exportEmpty'))
      return
    }
    isExporting.value = true
    try {
      await downloadMeetingReportDocx(md, getTitle() || '')
    } catch (err) {
      message.error((err as Error)?.message || t('meeting.reportExport.failed'))
      throw err
    } finally {
      isExporting.value = false
    }
  }

  function exportAsHtml(): void {
    const md = getMarkdown()
    if (!md) {
      message.warning(t('meeting.reportPanel.exportEmpty'))
      return
    }
    isExporting.value = true
    try {
      const title = getTitle() || t('meeting.reportPanel.title')
      const html = buildReportHtml(md, title)
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      downloadBlob(blob, `${resolveFileBase()}.html`)
    } catch (err) {
      message.error((err as Error)?.message || t('meeting.reportExport.failed'))
    } finally {
      isExporting.value = false
    }
  }

  function exportAsMarkdown(): void {
    const md = getMarkdown()
    if (!md) {
      message.warning(t('meeting.reportPanel.exportEmpty'))
      return
    }
    isExporting.value = true
    try {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      downloadBlob(blob, `${resolveFileBase()}.md`)
    } catch (err) {
      message.error((err as Error)?.message || t('meeting.reportExport.failed'))
    } finally {
      isExporting.value = false
    }
  }

  async function exportAs(format: ExportFormat): Promise<void> {
    if (format === 'docx') return exportAsDocx()
    if (format === 'html') return exportAsHtml()
    return exportAsMarkdown()
  }

  return {
    isExporting,
    exportAsDocx,
    exportAsHtml,
    exportAsMarkdown,
    exportAs,
  }
}