/**
 * Agent-to-agent handoff guard: agent replies that @-mention other agents can
 * fan out into an unbounded reply loop (self-introductions, status chatter).
 * processMentions must stop routing agent-initiated mentions once the per-room
 * budget is exhausted, while human mentions always pass through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

function agentStub(name: string, agentId: string) {
    return {
        name,
        agentId,
        replyToMention: vi.fn(async () => {}),
        interrupt: vi.fn(async () => true),
        disconnect: vi.fn(),
        getActiveSessionId: () => null,
        isActiveSession: () => true,
    } as any
}

describe('agent handoff guard', () => {
    let clients: AgentClients
    let queueMentionSpy: ReturnType<typeof vi.spyOn>

    function seedRoom(roomId: string, names: Array<[string, string]>) {
        const room = new Map<string, any>()
        for (const [name, agentId] of names) room.set(agentId, agentStub(name, agentId))
        ;(clients as any).rooms.set(roomId, room)
    }

    afterEach(() => {
        queueMentionSpy?.mockRestore()
    })

    it('drops agent reply mentions after the per-room budget is exhausted', async () => {
        clients = new AgentClients()
        seedRoom('room-1', [['Alice', 'alice'], ['Bob', 'bob']])
        queueMentionSpy = vi.spyOn(clients as any, 'queueMention').mockImplementation(() => {})

        // 8 handoffs fit within budget (MAX = 8)...
        for (let i = 0; i < AgentClients.MAX_AGENT_HANDOFFS_PER_ROOM; i++) {
            await clients.processMentions('room-1', {
                content: '@Bob handoff',
                senderName: 'Alice',
                senderId: 'alice',
                role: 'assistant',
            })
        }
        expect(queueMentionSpy).toHaveBeenCalledTimes(8)

        // ...the 9th agent reply mentioning someone is dropped.
        await clients.processMentions('room-1', {
            content: '@Bob one more handoff',
            senderName: 'Alice',
            senderId: 'alice',
            role: 'assistant',
        })
        expect(queueMentionSpy).toHaveBeenCalledTimes(8)
    })

    it('never throttles human mentions even after budget is exhausted', async () => {
        clients = new AgentClients()
        seedRoom('room-1', [['Alice', 'alice'], ['Bob', 'bob']])
        queueMentionSpy = vi.spyOn(clients as any, 'queueMention').mockImplementation(() => {})

        for (let i = 0; i < AgentClients.MAX_AGENT_HANDOFFS_PER_ROOM + 3; i++) {
            await clients.processMentions('room-1', {
                content: '@Bob handoff',
                senderName: 'Alice',
                senderId: 'alice',
                role: 'assistant',
            })
        }
        // Human @-mention must still route regardless of the agent budget.
        await clients.processMentions('room-1', {
            content: '@Bob hello human',
            senderName: 'Human',
            senderId: 'human-1',
            role: 'user',
        })
        expect(queueMentionSpy).toHaveBeenCalledTimes(AgentClients.MAX_AGENT_HANDOFFS_PER_ROOM + 1)
    })

    it('resets the handoff budget when the room is cleared', async () => {
        clients = new AgentClients()
        seedRoom('room-1', [['Alice', 'alice'], ['Bob', 'bob']])
        queueMentionSpy = vi.spyOn(clients as any, 'queueMention').mockImplementation(() => {})

        for (let i = 0; i < AgentClients.MAX_AGENT_HANDOFFS_PER_ROOM; i++) {
            await clients.processMentions('room-1', {
                content: '@Bob handoff',
                senderName: 'Alice',
                senderId: 'alice',
                role: 'assistant',
            })
        }
        await clients.processMentions('room-1', {
            content: '@Bob dropped',
            senderName: 'Alice',
            senderId: 'alice',
            role: 'assistant',
        })
        expect(queueMentionSpy).toHaveBeenCalledTimes(8)

        ;(clients as any).clearMentionQueuesForRoom('room-1')
        await clients.processMentions('room-1', {
            content: '@Bob after clear',
            senderName: 'Alice',
            senderId: 'alice',
            role: 'assistant',
        })
        expect(queueMentionSpy).toHaveBeenCalledTimes(9)
    })
})
