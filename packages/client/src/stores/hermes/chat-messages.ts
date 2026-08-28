// 消息 / 会话状态操作域（从 stores/hermes/chat.ts 拆出）。
//
// 只做「纯状态更新」：在 sessions ref 上增删改消息与会话对象，
// 不涉及 Socket 事件、队列、审批等跨域逻辑。store 通过
// `createChatMessages()` 工厂注入共享的 sessions ref 与 core 工具。
//
// 设计原则：模块内部只依赖注入的 refs 与 chat-core 纯函数，
// 不 import 其他 store 或 api 副作用，便于单元测试。

import { type Ref } from 'vue'
import {
  backgroundDelegateAnchorCallId,
  backgroundDelegateTaskDescriptors,
  runtimeObjectPayload,
  uid,
  type Message,
  type Session,
} from './chat-core'
import type { RunEvent } from '@/api/hermes/chat'

export interface ChatMessagesOptions {
  sessions: Ref<Session[]>
}

export function createChatMessages(options: ChatMessagesOptions) {
  const { sessions } = options

  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  function isEkkoAgentSession(sessionId: string): boolean {
    const session = sessions.value.find(item => item.id === sessionId)
    return session?.codingAgentId === 'ekko-agent' || session?.agent === 'ekko-agent'
  }

  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.messages.push(msg)
  }

  function addMessageInTimelineOrder(sessionId: string, msg: Message) {
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session) return
    const insertAt = session.messages.findIndex(existing => existing.timestamp > msg.timestamp)
    if (insertAt === -1) {
      session.messages.push(msg)
      return
    }
    session.messages.splice(insertAt, 0, msg)
  }

  function addHermesBackgroundDelegateAnchors(
    sessionId: string,
    toolCallId: string | undefined,
    output: unknown,
    toolArgs: unknown,
  ) {
    const payload = runtimeObjectPayload(output)
    if (!payload || payload.mode !== 'background' || payload.runtime === 'ekko') return
    const baseId = toolCallId || String(payload.delegation_id || uid())
    const messages = getSessionMsgs(sessionId)
    for (const task of backgroundDelegateTaskDescriptors(payload, toolArgs)) {
      const anchorCallId = backgroundDelegateAnchorCallId(baseId, task.taskIndex)
      if (messages.some(message => message.toolCallId === anchorCallId)) continue
      const label = `${task.taskIndex + 1}/${task.taskCount}`
      addMessage(sessionId, {
        id: uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        toolName: 'delegate_task',
        toolCallId: anchorCallId,
        toolArgs,
        toolPreview: `${label}${task.goal ? ` · ${task.goal}` : ''}`.slice(0, 220),
        toolResult: {
          ...payload,
          runtime: 'hermes',
          task_index: task.taskIndex,
          task_count: task.taskCount,
          goal: task.goal,
        },
        toolStatus: 'done',
      })
    }
  }

  function findHermesBackgroundDelegateAnchor(messages: Message[], evt: RunEvent): Message | undefined {
    const taskIndex = Number((evt as any).task_index ?? 0)
    const goal = String((evt as any).goal || '').trim()
    const candidates = messages.filter(message =>
      message.role === 'tool'
      && message.toolCallId?.startsWith('background-delegate:')
      && runtimeObjectPayload(message.toolResult)?.runtime === 'hermes',
    )
    return candidates.find(message => {
      const payload = runtimeObjectPayload(message.toolResult)
      return Number(payload?.task_index ?? 0) === taskIndex
        && (!goal || !String(payload?.goal || '').trim() || String(payload?.goal || '').trim() === goal)
    }) || candidates.find(message => Number(runtimeObjectPayload(message.toolResult)?.task_index ?? 0) === taskIndex)
  }

  function addOrUpdateSession(session: Session) {
    const existingIndex = sessions.value.findIndex(s => s.id === session.id)
    if (existingIndex !== -1) {
      // Update existing session
      sessions.value[existingIndex] = session
    } else {
      // Add new session
      sessions.value.push(session)
    }
  }

  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  function settleRunningTools(sessionId: string, status: 'done' | 'error') {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.role === 'tool' && m.toolStatus === 'running' && !m.toolCallId?.startsWith('subagent:')) {
        msgs[i] = { ...m, toolStatus: status }
      }
    })
  }

  function settleRuntimeDisplayForCommand(sessionId: string) {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.isStreaming) updateMessage(sessionId, m.id, { isStreaming: false })
      if (m.role === 'tool' && m.toolStatus === 'running') {
        msgs[i] = { ...m, toolStatus: 'done' }
      }
    })
  }

  return {
    getSessionMsgs,
    isEkkoAgentSession,
    addMessage,
    addMessageInTimelineOrder,
    addHermesBackgroundDelegateAnchors,
    findHermesBackgroundDelegateAnchor,
    addOrUpdateSession,
    updateMessage,
    settleRunningTools,
    settleRuntimeDisplayForCommand,
  }
}
