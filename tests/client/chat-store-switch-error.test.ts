// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onApprovalRequested: vi.fn(() => vi.fn()),
  onApprovalResolved: vi.fn(() => vi.fn()),
  onClarifyRequested: vi.fn(() => vi.fn()),
  onClarifyResolved: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * switchSession 在 resume 超时时曾经只 console.error，UI 完全不知道失败。
 * 现在 store 把失败原因写到 lastSwitchError，让 ChatPanel 之类的组件可以 watch
 * 并 surface 给用户。这里保证：
 *   - 超时：lastSwitchError 被写入并包含 'resume timeout'
 *   - callback 收到 session_id 不匹配：不会写入
 *   - clearLastSwitchError() 把 ref 重置为 null
 */
describe('chat store switchSession error surface', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.registerSessionHandlers.mockReturnValue(vi.fn())
  })

  it('writes lastSwitchError when resumeSession hits the 15s timeout', async () => {
    chatApi.resumeSession.mockImplementation(() => {
      // 故意不调用 onResumed → store 内部的 15s timeout 会触发。
      // 测试里我们通过 fake timers 直接推进时间避免真正等待。
      return {} as any
    })

    const store = useChatStore()
    const session = makeSession('s-timeout')
    store.sessions = [session]
    store.activeSessionId = 's-timeout'
    store.activeSession = session

    vi.useFakeTimers()
    try {
      const pending = store.switchSession('s-timeout')
      await vi.advanceTimersByTimeAsync(16_000)
      await pending
    } finally {
      vi.useRealTimers()
    }

    expect(store.lastSwitchError).not.toBeNull()
    expect(store.lastSwitchError).toContain('s-timeout')
    expect(store.lastSwitchError?.toLowerCase()).toContain('resume timeout')
  })

  it('does not write lastSwitchError when the resumed callback returns a different session_id', async () => {
    chatApi.resumeSession.mockImplementation((_id: string, onResumed: (data: any) => void) => {
      // session_id 不匹配 → store 视为过期响应 → resolve() 走人，不算错。
      onResumed({ session_id: 'wrong-id', isWorking: false })
      return {} as any
    })

    const store = useChatStore()
    const session = makeSession('s-ok')
    store.sessions = [session]
    store.activeSessionId = 's-ok'
    store.activeSession = session

    await store.switchSession('s-ok')

    expect(store.lastSwitchError).toBeNull()
  })

  it('clearLastSwitchError resets the ref to null', async () => {
    chatApi.resumeSession.mockImplementation(() => ({} as any))
    const store = useChatStore()
    const session = makeSession('s-clear')
    store.sessions = [session]
    store.activeSessionId = 's-clear'
    store.activeSession = session

    vi.useFakeTimers()
    try {
      const pending = store.switchSession('s-clear')
      await vi.advanceTimersByTimeAsync(16_000)
      await pending
    } finally {
      vi.useRealTimers()
    }
    expect(store.lastSwitchError).not.toBeNull()

    store.clearLastSwitchError()
    expect(store.lastSwitchError).toBeNull()
  })
})
