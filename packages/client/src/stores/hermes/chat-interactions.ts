// 审批 / 澄清交互域（从 stores/hermes/chat.ts 拆出）。
//
// 这是 chat store 拆分的第二批：把「工具审批（PendingApproval）与澄清
// （PendingClarify）」相关的状态更新、事件处理和用户响应逻辑收进一个
// 独立模块。store 通过 `createChatInteractions()` 工厂注入它依赖的
// 共享 refs 与 api 回调，函数签名与原来完全一致。
//
// 设计原则：模块内部不直接 import 其他 store 或 api 的副作用，
// 所有外部依赖都从 options 注入，便于单元测试。

import { computed, type ComputedRef, type Ref } from 'vue'
import { respondClarify, respondToolApproval, type ChatRunTransport, type RunEvent } from '@/api/hermes/chat'
import type { PendingApproval, PendingClarify } from './chat-core'

export interface ChatInteractionsOptions {
  activeSessionId: Ref<string | null>
  pendingApprovals: Ref<Map<string, PendingApproval>>
  pendingClarifies: Ref<Map<string, PendingClarify>>
  runtimeTransport: () => ChatRunTransport
}

export function createChatInteractions(options: ChatInteractionsOptions) {
  const { activeSessionId, pendingApprovals, pendingClarifies, runtimeTransport } = options

  const activePendingApproval: ComputedRef<PendingApproval | null> = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingApprovals.value.get(sid) || null : null
  })

  const activePendingClarify: ComputedRef<PendingClarify | null> = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingClarifies.value.get(sid) || null : null
  })

  function setPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    const approvalId = (evt as any).approval_id as string | undefined
    if (!sid || !approvalId) return
    const description = String((evt as any).description || '')
    const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, ' ')
    const isMemoryWrite = !Boolean((evt as any).allow_permanent) && (
      normalizedDescription === 'save to memory' ||
      normalizedDescription.startsWith('save to memory:') ||
      normalizedDescription.startsWith('save to memory?')
    )
    const rawChoices = Array.isArray((evt as any).choices) ? (evt as any).choices : ['once', 'session', 'deny']
    const choices = rawChoices
      .filter((choice: unknown): choice is PendingApproval['choices'][number] =>
        choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
    pendingApprovals.value.set(sid, {
      sessionId: sid,
      approvalId,
      command: String((evt as any).command || ''),
      description,
      choices: isMemoryWrite ? ['once', 'deny'] : choices.length ? choices : ['once', 'session', 'deny'],
      allowPermanent: Boolean((evt as any).allow_permanent),
      isMemoryWrite,
      requestedAt: Date.now(),
    })
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function clearPendingApproval(evt: RunEvent) {
    if ((evt as any).resolved === false) return
    const sid = evt.session_id
    if (!sid) return
    const current = pendingApprovals.value.get(sid)
    if (!current) return
    const approvalId = (evt as any).approval_id
    if (approvalId && current.approvalId !== approvalId) return
    pendingApprovals.value.delete(sid)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function setPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    const clarifyId = (evt as any).clarify_id as string | undefined
    if (!sid || !clarifyId) return
    pendingClarifies.value.set(sid, {
      sessionId: sid,
      clarifyId,
      question: String((evt as any).question || ''),
      choices: Array.isArray((evt as any).choices) ? (evt as any).choices : null,
      initialResponse: String((evt as any).initial_response || ''),
      responseMode: String((evt as any).response_mode || ''),
      timeoutMs: Number((evt as any).timeout_ms) || 300000,
      requestedAt: Date.now(),
    })
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingClarify(evt: RunEvent) {
    if ((evt as any).resolved === false) return
    const sid = evt.session_id
    if (!sid) return
    const current = pendingClarifies.value.get(sid)
    if (!current) return
    const clarifyId = (evt as any).clarify_id
    if (clarifyId && current.clarifyId !== clarifyId) return
    pendingClarifies.value.delete(sid)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingInteractions(sessionId: string) {
    let changed = false
    if (pendingApprovals.value.has(sessionId)) {
      pendingApprovals.value.delete(sessionId)
      changed = true
    }
    if (pendingClarifies.value.has(sessionId)) {
      pendingClarifies.value.delete(sessionId)
      changed = true
    }
    if (changed) {
      pendingApprovals.value = new Map(pendingApprovals.value)
      pendingClarifies.value = new Map(pendingClarifies.value)
    }
  }

  function respondToClarifyFor(sessionId: string, clarifyId: string, response: string) {
    const pending = pendingClarifies.value.get(sessionId)
    if (!pending || pending.clarifyId !== clarifyId) return
    respondClarify(sessionId, clarifyId, response, runtimeTransport())
  }

  function respondToClarify(response: string) {
    const pending = activePendingClarify.value
    if (!pending) return
    respondToClarifyFor(pending.sessionId, pending.clarifyId, response)
    pendingClarifies.value.delete(pending.sessionId)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function respondApprovalFor(sessionId: string, approvalId: string, choice: PendingApproval['choices'][number]) {
    const pending = pendingApprovals.value.get(sessionId)
    if (!pending || pending.approvalId !== approvalId) return
    respondToolApproval(sessionId, approvalId, choice, runtimeTransport())
  }

  function respondApproval(choice: PendingApproval['choices'][number]) {
    const pending = activePendingApproval.value
    if (!pending) return
    respondApprovalFor(pending.sessionId, pending.approvalId, choice)
    pendingApprovals.value.delete(pending.sessionId)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  return {
    activePendingApproval,
    activePendingClarify,
    setPendingApproval,
    clearPendingApproval,
    setPendingClarify,
    clearPendingClarify,
    clearPendingInteractions,
    respondToClarifyFor,
    respondToClarify,
    respondApprovalFor,
    respondApproval,
  }
}
