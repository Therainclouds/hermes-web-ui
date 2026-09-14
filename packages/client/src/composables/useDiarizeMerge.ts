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

/** 整段音频转录（batch）返回的句子形状（见 meeting-asr-api.ts）。 */
export interface FileTranscriptionSentenceInput {
  text: string
  begin_ms?: number
  end_ms?: number
  /** 全局说话人序号；未开启说话人分离时为 -1 */
  speaker_id?: number | null
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

  /**
   * 整段音频转录 / 事后「拆分人声」结果写入。
   * 与上面两个实时 chunk 合并函数的区别：
   *  - `diarize === false` 时完全不写 speaker 字段（避免把 `speaker_id: -1`
   *    渲染成"说话人 1"）；
   *  - 依据当前是否已有转写自动选择策略：已有实时转写 → 按时间戳回填说话人
   *    （不覆盖用户已编辑的文本）；空转写（直接音频转录）→ 整体写入。
   *
   * @returns 新增（或回填）的句子数量
   */
  function applyFileTranscriptionResult(
    sentences: FileTranscriptionSentenceInput[],
    options: { diarize: boolean } = { diarize: true },
  ): number {
    const diarize = options.diarize
    const merge = deps.finalSentences.value.length > 0
    const timeThreshold = 2000
    let changed = 0
    // 整段转录首次出现的说话人要登记进 session.speakers（重命名/Agent 提示词
    // 都读这份列表），每个说话人只写一次，避免逐句触发 localStorage 写入。
    const registeredSpeakers = new Set<string>()

    for (const item of sentences) {
      const text = (item.text || '').trim()
      if (!text) continue
      const startMs = item.begin_ms || 0
      const endMs = item.end_ms || startMs

      let speaker: string | undefined
      let speakerId: string | undefined
      if (diarize && typeof item.speaker_id === 'number' && item.speaker_id >= 0) {
        speakerId = String(item.speaker_id)
        if (!deps.speakerMap.value[speakerId]) {
          deps.speakerMap.value[speakerId] = `说话人 ${Object.keys(deps.speakerMap.value).length + 1}`
        }
        const session = meetingStore.activeSession
        const registeredName = session?.speakers.find(s => String(s.id) === speakerId)?.displayName
        speaker = registeredName || deps.speakerMap.value[speakerId]
        if (session && speaker && !registeredSpeakers.has(speakerId)) {
          registeredSpeakers.add(speakerId)
          if (!session.speakers.some(s => String(s.id) === speakerId)) {
            // 复用现有 action：speakerId 尚无句子时它只登记说话人本身
            meetingStore.renameSpeaker(session.id, speakerId, speaker)
          }
        }
      }

      // 已有实时转写：只回填说话人，避免整段结果覆盖用户编辑过的文本。
      if (merge && diarize && speaker) {
        const target = deps.finalSentences.value.find(asrSent =>
          !asrSent.speakerId
          && Math.abs((asrSent.startTime || 0) - startMs) < timeThreshold
          && Math.abs((asrSent.endTime || 0) - endMs) < timeThreshold,
        )
        if (target) {
          target.speaker = speaker
          target.speakerId = speakerId
          if (meetingStore.activeSessionId) {
            meetingStore.updateSentence(meetingStore.activeSessionId, target)
          }
          changed++
          continue
        }
      }

      // 不覆盖已有文本：同文本 + 时间接近视为重复（overlap / 重复触发）。
      const isDuplicate = deps.finalSentences.value.some(s =>
        s.text === text && Math.abs((s.startTime || 0) - startMs) < timeThreshold,
      )
      if (isDuplicate) continue

      const sentenceObj: TranscriptSentence = {
        text,
        timestamp: Date.now(),
        startTime: startMs,
        endTime: endMs,
        ...(speaker ? { speaker, speakerId } : {}),
      }
      deps.finalSentences.value.push(sentenceObj)
      changed++

      if (meetingStore.activeSessionId) {
        meetingStore.addSentence(meetingStore.activeSessionId, sentenceObj)
        deps.pushSentenceToAssist(meetingStore.activeSessionId, sentenceObj)
      }
    }

    deps.finalSentences.value.sort((a, b) => (a.startTime || 0) - (b.startTime || 0))

    nextTick(() => {
      const container = document.getElementById('transcript-container')
      if (container) container.scrollTop = container.scrollHeight
    })

    return changed
  }

  return { addDiarizeResultDirectly, matchAndMergeDiarizeResult, applyFileTranscriptionResult }
}
