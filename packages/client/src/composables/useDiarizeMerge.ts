import { nextTick, type Ref } from 'vue'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { TranscriptSentence } from '@/stores/hermes/meeting'

export interface UseDiarizeMergeDeps {
  /** ASR 实时句子流（回填/追加目标） */
  finalSentences: Ref<TranscriptSentence[]>
  /** speakerId → 显示名映射（新说话人自动编号） */
  speakerMap: Ref<Record<string, string>>
  /** 推送到实时辅助服务（fire-and-forget，view 提供） */
  pushSentenceToAssist: (sessionId: string, sentence: TranscriptSentence) => void
}

/**
 * 说话人分离结果合并（拆分自 MeetingView.vue，行为保持一致）。
 *
 * 两种合并策略由 handleWsMessage 按"节省模式"开关选择：
 *  - addDiarizeResultDirectly：节省模式下直接添加带说话人标签的句子；
 *  - matchAndMergeDiarizeResult：正常模式下按时间戳回填到已有 ASR 句子。
 */
export function useDiarizeMerge(deps: UseDiarizeMergeDeps) {
  const meetingStore = useMeetingStore()

  function addDiarizeResultDirectly(diarizeSentences: any[], offsetSec: number = 0) {
    // 节省模式：直接添加 Diarize 结果（带说话人标签）
    console.log('[diarize-save] Adding', diarizeSentences.length, 'sentences directly')

    for (const diarizeSent of diarizeSentences) {
      const diarizeStartMs = offsetSec * 1000 + (diarizeSent.begin_ms || 0)
      const diarizeEndMs = offsetSec * 1000 + (diarizeSent.end_ms || 0)
      const speakerId = String(diarizeSent.speaker_id || 'unknown')

      // 获取或创建说话人显示名称
      if (!deps.speakerMap.value[speakerId]) {
        deps.speakerMap.value[speakerId] = `说话人 ${Object.keys(deps.speakerMap.value).length + 1}`
      }
      const session = meetingStore.activeSession
      const registeredName = session?.speakers.find(s => s.id === speakerId)?.displayName
      const speakerName = registeredName || deps.speakerMap.value[speakerId]

      // 检查是否是重复的文本（避免overlap导致的重复）
      const isDuplicate = deps.finalSentences.value.some(s =>
        s.text === diarizeSent.text &&
        Math.abs((s.startTime || 0) - diarizeStartMs) < 2000
      )

      if (!isDuplicate && diarizeSent.text) {
        const sentenceObj: TranscriptSentence = {
          text: diarizeSent.text,
          timestamp: Date.now(),
          startTime: diarizeStartMs,
          endTime: diarizeEndMs,
          speaker: speakerName,
          speakerId: speakerId,
        }
        deps.finalSentences.value.push(sentenceObj)

        if (meetingStore.activeSessionId) {
          meetingStore.addSentence(meetingStore.activeSessionId, sentenceObj)
          // 推送到实时辅助服务
          deps.pushSentenceToAssist(meetingStore.activeSessionId, sentenceObj)
        }
      }
    }

    // 按时间戳排序
    deps.finalSentences.value.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))

    // 自动滚动到底部
    nextTick(() => {
      const container = document.getElementById('transcript-container')
      if (container) container.scrollTop = container.scrollHeight
    })
  }

  function matchAndMergeDiarizeResult(diarizeSentences: any[], offsetSec: number = 0) {
    // 将说话人分离结果与已有的ASR句子按时间戳匹配
    // offsetSec: chunk在整个音频中的偏移量（秒）
    const timeThreshold = 2000 // 2秒容差（考虑ASR和Diarize的时间戳差异）

    console.log('[diarize] Processing', diarizeSentences.length, 'sentences with offset', offsetSec, 'sec')

    for (const diarizeSent of diarizeSentences) {
      // 计算绝对时间（毫秒）
      const diarizeStartMs = offsetSec * 1000 + (diarizeSent.begin_ms || 0)
      const diarizeEndMs = offsetSec * 1000 + (diarizeSent.end_ms || 0)
      const speakerId = String(diarizeSent.speaker_id || 'unknown')

      // 获取或创建说话人显示名称
      if (!deps.speakerMap.value[speakerId]) {
        deps.speakerMap.value[speakerId] = `说话人 ${Object.keys(deps.speakerMap.value).length + 1}`
      }
      const session = meetingStore.activeSession
      const registeredName = session?.speakers.find(s => s.id === speakerId)?.displayName
      const speakerName = registeredName || deps.speakerMap.value[speakerId]

      console.log('[diarize] Sentence:', diarizeSent.text?.substring(0, 20), 'speaker:', speakerName, 'time:', diarizeStartMs, '-', diarizeEndMs)

      // 查找匹配的ASR句子
      let matched = false
      for (const asrSent of deps.finalSentences.value) {
        // 如果ASR句子已经有说话人标签，跳过
        if (asrSent.speakerId) continue

        // 按时间戳匹配
        const asrStartMs = asrSent.startTime || 0
        const asrEndMs = asrSent.endTime || 0

        // 计算时间差
        const startDiff = Math.abs(asrStartMs - diarizeStartMs)
        const endDiff = Math.abs(asrEndMs - diarizeEndMs)

        if (startDiff < timeThreshold && endDiff < timeThreshold) {
          // 匹配成功，回填说话人信息
          asrSent.speaker = speakerName
          asrSent.speakerId = speakerId
          matched = true
          console.log('[diarize] Matched ASR sentence:', asrSent.text?.substring(0, 20))

          // 同步更新到 store
          if (meetingStore.activeSessionId) {
            meetingStore.updateSentence(meetingStore.activeSessionId, asrSent)
          }
          break
        }
      }

      // 如果没有匹配到已有句子，可能是新的句子（边界情况）
      if (!matched && diarizeSent.text) {
        // 检查是否是重复的文本（避免overlap导致的重复）
        const isDuplicate = deps.finalSentences.value.some(s =>
          s.text === diarizeSent.text &&
          Math.abs((s.startTime || 0) - diarizeStartMs) < timeThreshold
        )

        if (!isDuplicate) {
          const sentenceObj: TranscriptSentence = {
            text: diarizeSent.text,
            timestamp: Date.now(),
            startTime: diarizeStartMs,
            endTime: diarizeEndMs,
            speaker: speakerName,
            speakerId: speakerId,
          }
          deps.finalSentences.value.push(sentenceObj)
          console.log('[diarize] Added new sentence from diarize:', diarizeSent.text?.substring(0, 20))

          if (meetingStore.activeSessionId) {
            meetingStore.addSentence(meetingStore.activeSessionId, sentenceObj)
          }
        }
      }
    }

    // 按时间戳排序
    deps.finalSentences.value.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))

    // 自动滚动到底部
    nextTick(() => {
      const container = document.getElementById('transcript-container')
      if (container) container.scrollTop = container.scrollHeight
    })
  }

  return { addDiarizeResultDirectly, matchAndMergeDiarizeResult }
}
