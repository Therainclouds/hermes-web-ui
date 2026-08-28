import type { Ref } from 'vue'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { buildReportHtml } from '@/utils/report-html'

export interface UseMeetingDownloadsDeps {
  /** 录音结束生成的本地 Blob（下载音频时回退用） */
  audioBlob: Ref<Blob | null>
  /** 报告 HTML 内容（服务器没有报告时回退用） */
  htmlContent: Ref<string>
}

/**
 * 会议产物下载（音频 / 逐字稿 / JSON / 报告 HTML）。
 * 拆分自 MeetingView.vue，行为保持一致：每种产物都优先取服务器数据，
 * 失败或缺失时回退到本地（store / ref / IndexedDB 镜像）。
 */
export function useMeetingDownloads(deps: UseMeetingDownloadsDeps) {
  const meetingStore = useMeetingStore()

  async function downloadAudio() {
    if (!meetingStore.activeSessionId) return

    try {
      // 尝试从服务器下载
      const blob = await meetingStorageApi.downloadAudio(meetingStore.activeSessionId)
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${meetingStore.activeSession?.title || 'meeting'}.webm`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        return
      }
    } catch (err) {
      console.error('Failed to download audio from server:', err)
    }

    // 回退到本地 blob
    if (!deps.audioBlob.value) return
    const url = URL.createObjectURL(deps.audioBlob.value)
    const a = document.createElement('a')
    a.href = url
    a.download = `${meetingStore.activeSession?.title || 'meeting'}.webm`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function downloadTranscript() {
    if (!meetingStore.activeSessionId || !meetingStore.activeSession) return

    try {
      // 尝试从服务器下载
      const sentences = await meetingStorageApi.getTranscript(meetingStore.activeSessionId)
      if (sentences && sentences.length > 0) {
        const content = sentences.map((s: any, i: number) => {
          const time = s.startTime ? formatDuration(s.startTime / 1000) : new Date(s.timestamp).toLocaleTimeString('zh-CN')
          const speaker = s.speaker ? `[${s.speaker}] ` : ''
          return `${i + 1}. ${time} ${speaker}${s.text}`
        }).join('\n')

        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${meetingStore.activeSession.title || 'meeting'}.txt`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        return
      }
    } catch (err) {
      console.error('Failed to download transcript from server:', err)
    }

    // 回退到本地数据
    const session = meetingStore.activeSession
    const content = session.sentences.map((s, i) => {
      const time = s.startTime ? formatDuration(s.startTime / 1000) : new Date(s.timestamp).toLocaleTimeString('zh-CN')
      const speaker = s.speaker ? `[${s.speaker}] ` : ''
      return `${i + 1}. ${time} ${speaker}${s.text}`
    }).join('\n')

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${session.title || 'meeting'}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function downloadJson() {
    if (!meetingStore.activeSessionId || !meetingStore.activeSession) return

    try {
      // 尝试从服务器下载
      const data = await meetingStorageApi.downloadJsonReport(meetingStore.activeSessionId)
      if (data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${meetingStore.activeSession.title || 'meeting'}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        return
      }
    } catch (err) {
      console.error('Failed to download JSON from server:', err)
    }

    // 回退到本地数据
    const session = meetingStore.activeSession

    const jsonData = {
      title: session.title,
      createdAt: new Date(session.createdAt).toISOString(),
      duration: session.audioDuration,
      speakers: session.speakers,
      sentences: session.sentences.map((s, i) => ({
        index: i + 1,
        text: s.text,
        startTimeMs: s.startTime,
        endTimeMs: s.endTime,
        speakerId: s.speakerId,
        speakerName: s.speaker || null,
        timestamp: new Date(s.timestamp).toISOString(),
      })),
      analysis: session.analysisResult,
    }

    const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${session.title || 'meeting'}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function downloadReport() {
    if (!meetingStore.activeSessionId) return

    let content = ''
    let source = 'server'
    try {
      // 尝试从服务器下载
      content = (await meetingStorageApi.downloadHtmlReport(meetingStore.activeSessionId)) || ''
    } catch (err) {
      console.error('Failed to download report from server:', err)
    }

    // 回退到本地数据（store 是报告生成后的权威来源，局部 ref 可能未同步）
    if (!content) {
      source = 'local'
      content = meetingStore.activeSession?.htmlContent || deps.htmlContent.value
    }
    console.log('[downloadReport] 内容来源:', source, '长度:', content.length)
    if (!content) return

    const title = meetingStore.activeSession?.title || '会议报告'
    const html = toPrettyReportHtml(content, title)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title}_report.html`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 报告内容若为 Markdown（实时辅助生成）则转换为精美 HTML 页面；若已是 HTML（Agent 生成）则直接包装
  function toPrettyReportHtml(content: string, title: string): string {
    const trimmed = content.trim()
    const looksLikeHtml = /^<(!doctype|html|div|h[1-6]|p\b)/i.test(trimmed)
    console.log('[downloadReport] looksLikeHtml:', looksLikeHtml, '内容开头:', JSON.stringify(trimmed.slice(0, 40)))
    if (looksLikeHtml) return content
    return buildReportHtml(trimmed, title)
  }

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  return {
    downloadAudio,
    downloadTranscript,
    downloadJson,
    downloadReport,
    formatDuration,
  }
}
