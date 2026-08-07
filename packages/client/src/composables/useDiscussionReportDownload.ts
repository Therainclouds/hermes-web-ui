import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useMessage } from '@/composables/useAppMessage'
import { downloadDiscussionReport, sanitizeFileName } from '@/utils/hermes/group-discussion-docx'

function dateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/**
 * 讨论报告下载（Word 单文件），供报告消息卡片与讨论结果卡片复用。
 * 未终态（pending/running/paused）时拒绝并提示。
 */
export function useDiscussionReportDownload() {
  const store = useGroupChatStore()
  const { t } = useI18n()
  const message = useMessage()
  const isDownloading = ref(false)

  function reportLabels(): Parameters<typeof downloadDiscussionReport>[2] {
    const status = (key: string) => t(`groupChat.discussion.status.${key}`)
    return {
      docTitle: t('groupChat.discussion.docTitle'),
      goalLabel: t('groupChat.discussion.goal'),
      metaLabel: t('groupChat.discussion.docMetaLabel'),
      statusLabel: t('groupChat.discussion.docStatusLabel'),
      roundsLabel: t('groupChat.discussion.docRoundsLabel'),
      maxRoundsLabel: t('groupChat.discussion.maxRounds'),
      agentsLabel: t('groupChat.discussion.docAgentsLabel'),
      judgeLabel: t('groupChat.discussion.docJudgeLabel'),
      judgeNotesMissingLabel: t('groupChat.discussion.docJudgeMissingLabel'),
      reportLabel: t('groupChat.discussion.docReportLabel'),
      roundLabel: round => t('groupChat.discussion.docRoundLabel', { round }),
      convergedLabel: t('groupChat.discussion.convergedLabel'),
      stalledLabel: t('groupChat.discussion.docStalledLabel'),
      progressLabel: t('groupChat.discussion.docProgressLabel'),
      assessmentLabel: t('groupChat.discussion.docAssessmentLabel'),
      suggestionLabel: t('groupChat.discussion.docSuggestionLabel'),
      generatedBy: t('groupChat.discussion.docGeneratedBy'),
      statusLabels: {
        pending: status('pending'),
        running: status('running'),
        paused: status('paused'),
        converged: status('converged'),
        max_rounds: status('max_rounds'),
        stopped: status('stopped'),
        failed: status('failed'),
      },
    }
  }

  async function downloadReport(): Promise<void> {
    const roomId = store.currentRoomId
    const state = roomId ? store.discussionStates.get(roomId) : null
    if (!state || !roomId) return
    const active = state.status === 'pending' || state.status === 'running' || state.status === 'paused'
    if (active) {
      message.warning(t('groupChat.discussion.downloadDuringActive'))
      return
    }
    isDownloading.value = true
    try {
      const reportMsg = state.reportMessageId
        ? store.messages.find(msg => msg.id === state.reportMessageId)
        : undefined
      const reportText = typeof reportMsg?.content === 'string' ? reportMsg.content : ''
      const fileName = `${sanitizeFileName(state.goal)}讨论报告-${dateStamp()}`
      await downloadDiscussionReport(
        {
          goal: state.goal,
          status: state.status,
          currentRound: state.currentRound,
          maxRounds: state.maxRounds,
          agentOrder: state.agentOrder,
          judgeNotes: state.judgeNotes,
          reportText,
          generatedAt: Date.now(),
          lastError: state.lastError || undefined,
        },
        fileName,
        reportLabels(),
      )
    } catch (err: any) {
      message.error(err?.message || t('groupChat.discussion.downloadFailed'))
    } finally {
      isDownloading.value = false
    }
  }

  return { isDownloading, downloadReport }
}
