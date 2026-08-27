// 子代理 / MoA 流事件域（从 stores/hermes/chat.ts 拆出）。
//
// 处理 Hermes 后台子代理（subagent.*）与多智能体聚合（moa.*）的实时流：
// 把 RunEvent 归约进 subagentStreams map，并同步为 transcript 里的
// delegate_task / moa_reference / moa_aggregating 工具消息。
//
// 依赖注入：subagentStreams ref + chat-messages 域的纯状态操作函数，
// 不直接 import 其他 store，便于单元测试。

import { type Ref } from 'vue'
import type { RunEvent } from '@/api/hermes/chat'
import {
  moaReferenceLabel,
  readRunMarker,
  reduceSubagentStream,
  runtimeObjectPayload,
  runtimeToolPayloadOrUndefined,
  subagentStatus,
  uid,
  type Message,
  type SubagentStream,
} from './chat-core'

export interface ChatMessagesActions {
  getSessionMsgs: (sessionId: string) => Message[]
  findHermesBackgroundDelegateAnchor: (messages: Message[], evt: RunEvent) => Message | undefined
  updateMessage: (sessionId: string, id: string, update: Partial<Message>) => void
  addMessageInTimelineOrder: (sessionId: string, msg: Message) => void
  addMessage: (sessionId: string, msg: Message) => void
}

export interface ChatSubagentsOptions {
  subagentStreams: Ref<Map<string, SubagentStream>>
  messages: ChatMessagesActions
}

export function createChatSubagents(options: ChatSubagentsOptions) {
  const { subagentStreams, messages } = options
  const {
    getSessionMsgs,
    findHermesBackgroundDelegateAnchor,
    updateMessage,
    addMessageInTimelineOrder,
    addMessage,
  } = messages

  function handleSubagentEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (!eventName.startsWith('subagent.') && eventName !== 'delegation.updated') return

    if (eventName === 'delegation.updated') {
      const delegationId = String(evt.delegation_id || '').trim()
      const status = subagentStatus((evt as any).status)
      if (status === 'running') return
      const sessionStreams = [...subagentStreams.value.values()].filter(stream =>
        stream.sessionId === sessionId && stream.status === 'running',
      )
      const exactMatch = sessionStreams.find(stream => stream.subagentId === delegationId)
      const targets = exactMatch
        ? [exactMatch]
        : ['failed', 'error', 'cancelled', 'interrupted'].includes(status)
          ? sessionStreams
          : []
      for (const stream of targets) {
        handleSubagentEvent(sessionId, {
          ...evt,
          event: 'subagent.complete',
          subagent_id: stream.subagentId,
          task_index: stream.taskIndex,
          task_count: stream.taskCount,
          goal: stream.goal,
          model: stream.model,
          status,
        })
      }
      return
    }

    const subagentId = String((evt as any).subagent_id || `${(evt as any).task_index ?? 0}`)
    const streamKey = `${sessionId}:${subagentId}`
    const currentStream = subagentStreams.value.get(streamKey)
    const nextStream = reduceSubagentStream(currentStream, sessionId, evt)
    if (nextStream === currentStream) return
    subagentStreams.value.set(streamKey, nextStream)
    const toolCallId = `subagent:${subagentId}`
    const taskIndex = Number((evt as any).task_index ?? 0)
    const taskCount = Number((evt as any).task_count ?? 1)
    const label = `${taskIndex + 1}/${Math.max(1, taskCount || 1)}`
    const toolName = String((evt as any).tool || (evt as any).name || '')
    const toolCount = Number((evt as any).tool_count || 0)
    const goal = String((evt as any).goal || '').trim()
    const rawText = String(evt.text || evt.preview || '')
    const text = rawText.trim()
    const summary = String((evt as any).summary || '').trim()
    const duration = Number((evt as any).duration_seconds ?? (evt as any).duration)

    let preview = `${label}${goal ? ` · ${goal}` : ''}`
    if (eventName === 'subagent.start') {
      preview = `${label}${goal ? ` · ${goal}` : ''}`
    } else if (eventName === 'subagent.tool') {
      preview = `${label}${toolCount ? ` · #${toolCount}` : ''}${toolName ? ` · ${toolName}` : ''}${text ? ` · ${text}` : ''}`
    } else if (eventName === 'subagent.progress' || eventName === 'subagent.text' || eventName === 'subagent.thinking') {
      preview = `${label}${text ? ` · ${text}` : goal ? ` · ${goal}` : ''}`
    } else if (eventName === 'subagent.complete') {
      preview = `${label}${summary ? ` · ${summary}` : text ? ` · ${text}` : ''}`
    }

    const msgs = getSessionMsgs(sessionId)
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
      || findHermesBackgroundDelegateAnchor(msgs, evt)
    const toolStatus = nextStream.status === 'running'
      ? 'running'
      : nextStream.status === 'completed' ? 'done' : 'error'
    const update: Partial<Message> = {
      toolName: 'delegate_task',
      toolCallId,
      toolPreview: preview.slice(0, 220),
      toolArgs: eventName === 'subagent.tool'
        ? runtimeToolPayloadOrUndefined((evt as any).arguments)
        : existing?.toolArgs,
      toolStatus,
      toolDuration: Number.isFinite(duration) ? duration : undefined,
      toolResult: eventName === 'subagent.complete'
        ? JSON.stringify({
            status: (evt as any).status || 'completed',
            summary: summary || text,
            api_calls: (evt as any).api_calls,
            input_tokens: (evt as any).input_tokens,
            output_tokens: (evt as any).output_tokens,
            output_tail: (evt as any).output_tail,
          }, null, 2)
        : existing?.toolResult,
    }

    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }

    addMessageInTimelineOrder(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: nextStream.startedAt,
      ...update,
    })
  }

  function restorePersistedSubagentStreams(sessionId: string) {
    for (const message of getSessionMsgs(sessionId)) {
      if (message.role !== 'tool' || !message.toolCallId?.startsWith('subagent:')) continue
      const subagentId = message.toolCallId.slice('subagent:'.length).trim()
      if (!subagentId || subagentStreams.value.has(`${sessionId}:${subagentId}`)) continue
      const payload = runtimeObjectPayload(message.toolResult)
      if (!payload) continue
      const status = subagentStatus(payload.status)
      const restoredOutput = String(payload.output || payload.output_tail || payload.summary || '').trim()
      handleSubagentEvent(sessionId, {
        ...payload,
        event: status === 'running' ? 'subagent.start' : 'subagent.complete',
        session_id: sessionId,
        subagent_id: subagentId,
        background: payload.mode === 'background',
        background_snapshot: true,
        summary: restoredOutput || payload.summary,
        timestamp: message.timestamp,
      } as RunEvent)
    }
  }

  function settleInterruptedSubagents(sessionId: string) {
    const runningStreams = [...subagentStreams.value.values()].filter(stream =>
      stream.sessionId === sessionId && stream.status === 'running',
    )
    for (const stream of runningStreams) {
      handleSubagentEvent(sessionId, {
        event: 'subagent.complete',
        session_id: sessionId,
        subagent_id: stream.subagentId,
        task_index: stream.taskIndex,
        task_count: stream.taskCount,
        goal: stream.goal,
        model: stream.model,
        status: 'interrupted',
        timestamp: Date.now(),
      })
    }
  }

  function getSubagentStream(sessionId: string, subagentId: string): SubagentStream | null {
    return subagentStreams.value.get(`${sessionId}:${subagentId}`) || null
  }

  function handleMoaEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (eventName !== 'moa.reference' && eventName !== 'moa.aggregating') return

    const msgs = getSessionMsgs(sessionId)
    if (eventName === 'moa.reference') {
      const label = moaReferenceLabel(evt)
      const index = Number.isFinite(Number(evt.index)) ? Number(evt.index) : label
      const toolCallId = `moa:reference:${evt.run_id || 'run'}:${index}`
      const output = typeof evt.text === 'string'
        ? evt.text
        : typeof evt.delta === 'string'
          ? evt.delta
          : ''
      const update: Partial<Message> = {
        toolName: 'moa_reference',
        toolCallId,
        runMarker: readRunMarker(evt),
        toolPreview: label.slice(0, 220),
        toolStatus: 'done',
        toolResult: output,
      }
      const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
      if (existing) {
        updateMessage(sessionId, existing.id, update)
        return
      }
      addMessage(sessionId, {
        id: uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        ...update,
      })
      return
    }

    const aggregator = typeof evt.aggregator === 'string' && evt.aggregator.trim()
      ? evt.aggregator.trim()
      : 'aggregator'
    const toolCallId = `moa:aggregating:${evt.run_id || 'run'}`
    const update: Partial<Message> = {
      toolName: 'moa_aggregating',
      toolCallId,
      runMarker: readRunMarker(evt),
      toolPreview: aggregator.slice(0, 220),
      toolStatus: 'running',
      toolArgs: { aggregator },
    }
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }
    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      ...update,
    })
  }

  return {
    handleSubagentEvent,
    restorePersistedSubagentStreams,
    settleInterruptedSubagents,
    getSubagentStream,
    handleMoaEvent,
  }
}
