import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestGroupChatServer } from './group-chat-test-helpers'
import { GC_ARCHIVE_PROMPT_THRESHOLD } from '../../packages/server/src/services/hermes/group-chat'
import {
  GroupRoomSummaryService,
  type GroupRoomSummary,
} from '../../packages/server/src/services/hermes/group-chat/room-summary'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

function message(id: string, role: string, content: string, timestamp: number) {
  return {
    id,
    roomId: 'room-1',
    senderId: `user-${id}`,
    senderName: role === 'user' ? 'Alice' : 'Worker',
    content,
    timestamp,
    role,
  }
}

describe('group chat archive storage', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let storage: ReturnType<GroupChatServer['getStorage']>

  beforeEach(async () => {
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    storage.updateRoomConfig('room-1', {
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'gpt-test',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 1000, // never auto-trigger during these tests
    })
  })

  afterEach(() => {
    harness?.cleanup()
  })

  let insertedCount = 0
  function bulkInsert(count: number) {
    for (let index = 1; index <= count; index += 1) {
      insertedCount += 1
      storage.addMessage(message(`msg-${insertedCount}`, 'user', `hello ${insertedCount}`, insertedCount) as any)
    }
  }

  it('deleteMessagesThrough removes rows up to the anchor and keeps the tail', () => {
    for (let index = 1; index <= 6; index += 1) {
      storage.saveMessageAndRefreshRoom(message(`msg-${index}`, 'user', `hello ${index}`, index) as any)
    }

    const deleted = storage.deleteMessagesThrough('room-1', 'msg-3')

    expect(deleted).toBe(3)
    expect(storage.getMessagesForContext('room-1').map(m => m.id)).toEqual(['msg-4', 'msg-5', 'msg-6'])
    expect(storage.getMessage('msg-2')).toBeNull()
  })

  it('returns 0 and changes nothing when the anchor is missing', () => {
    for (let index = 1; index <= 3; index += 1) {
      storage.saveMessageAndRefreshRoom(message(`msg-${index}`, 'user', `hello ${index}`, index) as any)
    }

    expect(storage.deleteMessagesThrough('room-1', 'no-such-message')).toBe(0)
    expect(storage.getMessageCount('room-1')).toBe(3)
  })

  it('archiveRoom summarizes everything and removes the raw transcript through the new anchor', async () => {
    const runner = vi.fn(async () => 'final archived summary')
    for (let index = 1; index <= 4; index += 1) {
      storage.saveMessageAndRefreshRoom(message(`msg-${index}`, 'user', `hello ${index}`, index) as any)
    }
    const service = new GroupRoomSummaryService(storage, undefined, runner)

    const result = await service.archiveRoom('room-1')

    expect(result.archived).toBe(true)
    expect(result.deletedMessages).toBe(4)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(storage.getMessageCount('room-1')).toBe(0)
    expect(storage.getRoomSummary('room-1')).toMatchObject({
      summary: 'final archived summary',
      summaryThroughMessageId: 'msg-4',
      status: 'success',
    })
  })

  it('archiveRoom with nothing unsummarized still cleans rows up to the existing anchor', async () => {
    const runner = vi.fn(async () => 'unused')
    for (let index = 1; index <= 6; index += 1) {
      storage.saveMessageAndRefreshRoom(message(`msg-${index}`, 'user', `hello ${index}`, index) as any)
    }
    storage.saveRoomSummary({
      roomId: 'room-1',
      summary: 'previous',
      summaryThroughMessageId: 'msg-6',
      summaryThroughMessageTimestamp: 6,
      summarizedTurnCount: 6,
      status: 'success',
      version: 1,
      updatedAt: 1,
      lastError: null,
    } as GroupRoomSummary)
    const service = new GroupRoomSummaryService(storage, undefined, runner)

    const result = await service.archiveRoom('room-1')

    expect(runner).not.toHaveBeenCalled()
    expect(result.archived).toBe(true)
    expect(result.deletedMessages).toBe(6)
    expect(storage.getMessageCount('room-1')).toBe(0)
  })

  it('fires the archive prompt once per threshold window, then re-arms after a window', () => {
    const notifier = vi.fn()
    storage.setArchivePromptNotifier(notifier)
    bulkInsert(499)
    storage.maybeNotifyArchivePrompt('room-1')
    expect(notifier).not.toHaveBeenCalled()

    bulkInsert(1)
    storage.maybeNotifyArchivePrompt('room-1')
    expect(notifier).toHaveBeenCalledTimes(1)
    expect(notifier).toHaveBeenLastCalledWith('room-1', 500)

    bulkInsert(499)
    storage.maybeNotifyArchivePrompt('room-1')
    expect(notifier).toHaveBeenCalledTimes(1)

    bulkInsert(1)
    storage.maybeNotifyArchivePrompt('room-1')
    expect(notifier).toHaveBeenCalledTimes(2)
    expect(notifier).toHaveBeenLastCalledWith('room-1', 1000)
  })

  it('silently hard-prunes a room that keeps dismissing archive prompts', () => {
    const notifier = vi.fn()
    storage.setArchivePromptNotifier(notifier)
    bulkInsert(1500)
    storage.maybeNotifyArchivePrompt('room-1')

    // At the hard limit the room is pruned back to the threshold window.
    expect(storage.getMessageCount('room-1')).toBeLessThanOrEqual(GC_ARCHIVE_PROMPT_THRESHOLD)
  })
})
