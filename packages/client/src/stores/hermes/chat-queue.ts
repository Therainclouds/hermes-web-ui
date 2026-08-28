// 队列系统域（从 stores/hermes/chat.ts 拆出）。
//
// 处理用户消息排队（queued run）：排队消息的增删改、队列插入状态
// （replaceQueueInsertionState）、dequeue 追踪，以及 handleRunQueuedEvent
// 事件归约。依赖注入共享 refs 与少量 store 内函数（runtimeTransport /
// updateSessionTitle / 消息域操作），不直接 import 其他 store。

import { type Ref } from 'vue'
import { getChatRunSocket, type ChatRunTransport, type ResumeSessionPayload, type RunEvent } from '@/api/hermes/chat'
import type { Message, QueueInsertionState } from './chat-core'

export interface ChatQueueMessagesActions {
  getSessionMsgs: (sessionId: string) => Message[]
  addMessage: (sessionId: string, msg: Message) => void
}

export interface ChatQueueOptions {
  queuedUserMessages: Ref<Map<string, Message[]>>
  queueLengths: Ref<Map<string, number>>
  queueInsertionStates: Ref<Map<string, QueueInsertionState>>
  dequeuedQueueIds: Ref<Map<string, Set<string>>>
  runtimeTransport: () => ChatRunTransport
  updateSessionTitle: (sessionId: string) => void
  messages: ChatQueueMessagesActions
}

export function createChatQueue(options: ChatQueueOptions) {
  const {
    queuedUserMessages,
    queueLengths,
    queueInsertionStates,
    dequeuedQueueIds,
    runtimeTransport,
    updateSessionTitle,
    messages,
  } = options
  const { getSessionMsgs, addMessage } = messages

  function enqueueUserMessage(sessionId: string, message: Message) {
    const queue = queuedUserMessages.value.get(sessionId) || []
    if (queue.some(item => item.id === message.id)) return
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, [...queue, { ...message, queued: true }])
    queuedUserMessages.value = nextMap
  }

  function updateQueuedUserMessage(sessionId: string, messageId: string, patch: Partial<Message>) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.map(message => message.id === messageId
      ? { ...message, ...patch, queued: true }
      : message)
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, next)
    queuedUserMessages.value = nextMap
  }

  function dropQueuedUserMessage(sessionId: string, messageId: string): boolean {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return false
    const next = queue.filter(message => message.id !== messageId)
    if (next.length === queue.length) return false
    const nextMap = new Map(queuedUserMessages.value)
    if (next.length > 0) {
      nextMap.set(sessionId, next)
      queueLengths.value.set(sessionId, next.length)
    } else {
      nextMap.delete(sessionId)
      queueLengths.value.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
    return true
  }

  function removeQueuedMessage(sessionId: string, messageId: string) {
    if (!dropQueuedUserMessage(sessionId, messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('cancel_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function insertQueuedMessage(sessionId: string, messageId: string) {
    if (!(queuedUserMessages.value.get(sessionId) || []).some(message => message.id === messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('insert_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function replaceQueueInsertionState(sessionId: string, raw: ResumeSessionPayload['queueInsertion'] | RunEvent | null | undefined) {
    const nextMap = new Map(queueInsertionStates.value)
    const phase = raw?.phase
    const generation = typeof raw?.generation === 'string' ? raw.generation : ''
    const queueId = typeof raw?.queue_id === 'string' ? raw.queue_id : ''
    if (!raw || phase === 'cancelled' || phase === 'starting_queued_message' || !generation || !queueId) {
      nextMap.delete(sessionId)
      queueInsertionStates.value = nextMap
      return
    }
    if (phase !== 'requesting' && phase !== 'waiting_for_tool_batch' && phase !== 'stopping_current_turn') return
    nextMap.set(sessionId, {
      generation,
      runId: typeof raw.run_id === 'string' ? raw.run_id : undefined,
      queueId,
      runtime: raw.runtime === 'ekko'
        || raw.runtime === 'claude-code'
        || raw.runtime === 'codex'
        || raw.runtime === 'pi'
        ? raw.runtime
        : 'hermes',
      phase,
      guarantee: raw.guarantee === 'immediate' ? 'immediate' : 'strict',
      requestedAt: typeof raw.requested_at === 'number' ? raw.requested_at : Date.now(),
    })
    queueInsertionStates.value = nextMap
  }

  function handleQueueInsertionUpdated(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    replaceQueueInsertionState(sid, evt)
  }

  function normalizeQueuedUserMessages(rawMessages: unknown): Message[] {
    if (!Array.isArray(rawMessages)) return []
    return rawMessages.flatMap((raw) => {
      const peer = raw as NonNullable<RunEvent['queued_messages']>[number]
      const content = typeof peer?.content === 'string' ? peer.content : ''
      const messageId = peer?.id != null ? String(peer.id) : ''
      if (!messageId || !content.trim()) return []
      const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
        ? Math.round(peer.timestamp * 1000)
        : Date.now()
      const role = peer?.role === 'command' ? 'command' : 'user'
      return [{
        id: messageId,
        role,
        content,
        timestamp,
        queued: true,
        systemType: role === 'command' ? 'command' as const : undefined,
      }]
    })
  }

  function replaceQueuedUserMessages(sessionId: string, messagesIn: Message[]) {
    const existingById = new Map((queuedUserMessages.value.get(sessionId) || []).map(message => [message.id, message]))
    const merged = messagesIn.map(message => ({
      ...(existingById.get(message.id) || {}),
      ...message,
      attachments: existingById.get(message.id)?.attachments || message.attachments,
      queued: true,
    }))
    const nextMap = new Map(queuedUserMessages.value)
    if (merged.length > 0) {
      nextMap.set(sessionId, merged)
    } else {
      nextMap.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
  }

  function markDequeuedQueueId(sessionId: string, messageId: string) {
    const nextMap = new Map(dequeuedQueueIds.value)
    const ids = new Set(nextMap.get(sessionId) || [])
    ids.add(messageId)
    nextMap.set(sessionId, ids)
    dequeuedQueueIds.value = nextMap
  }

  function consumeDequeuedQueueId(sessionId: string, messageId: string): boolean {
    const ids = dequeuedQueueIds.value.get(sessionId)
    if (!ids?.has(messageId)) return false
    const nextIds = new Set(ids)
    nextIds.delete(messageId)
    const nextMap = new Map(dequeuedQueueIds.value)
    if (nextIds.size > 0) nextMap.set(sessionId, nextIds)
    else nextMap.delete(sessionId)
    dequeuedQueueIds.value = nextMap
    return true
  }

  function handleRunQueuedEvent(sessionId: string, evt: RunEvent) {
    const queueLength = Number((evt as any).queue_length || 0)
    if (queueLength > 0) {
      queueLengths.value.set(sessionId, queueLength)
    } else {
      queueLengths.value.delete(sessionId)
    }

    const dequeuedId = (evt as any).dequeued_queue_id != null
      ? String((evt as any).dequeued_queue_id)
      : ''
    if (dequeuedId) {
      const existingQueue = queuedUserMessages.value.get(sessionId) || []
      const dequeued = existingQueue.find(message => message.id === dequeuedId)
      if (Array.isArray((evt as any).queued_messages)) {
        const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
        replaceQueuedUserMessages(sessionId, queued)
      } else {
        const nextQueue = existingQueue.filter(message => message.id !== dequeuedId)
        replaceQueuedUserMessages(sessionId, nextQueue)
      }
      if (dequeued && !getSessionMsgs(sessionId).some(message => message.id === dequeued.id)) {
        addMessage(sessionId, { ...dequeued, queued: false })
        updateSessionTitle(sessionId)
      } else if (!dequeued) {
        markDequeuedQueueId(sessionId, dequeuedId)
      }
      return
    }

    if (Array.isArray((evt as any).queued_messages)) {
      const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
      replaceQueuedUserMessages(sessionId, queued)
      return
    }

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    const messageId = peer?.id != null ? String(peer.id) : ''
    if (!messageId || !content.trim()) return

    if ((queuedUserMessages.value.get(sessionId) || []).some(msg => msg.id === messageId)) return

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()
    const msgs = getSessionMsgs(sessionId)
    const existingIndex = msgs.findIndex(msg => msg.id === messageId && msg.role === 'user')
    const existing = existingIndex >= 0 ? msgs[existingIndex] : null
    if (existingIndex >= 0) {
      msgs.splice(existingIndex, 1)
    }

    enqueueUserMessage(sessionId, {
      ...(existing || {}),
      id: messageId,
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp: existing?.timestamp || timestamp,
      attachments: existing?.attachments,
      queued: true,
      systemType: peer?.role === 'command' ? 'command' : existing?.systemType,
    })
  }

  return {
    enqueueUserMessage,
    updateQueuedUserMessage,
    dropQueuedUserMessage,
    removeQueuedMessage,
    insertQueuedMessage,
    replaceQueueInsertionState,
    handleQueueInsertionUpdated,
    normalizeQueuedUserMessages,
    replaceQueuedUserMessages,
    markDequeuedQueueId,
    consumeDequeuedQueueId,
    handleRunQueuedEvent,
  }
}
