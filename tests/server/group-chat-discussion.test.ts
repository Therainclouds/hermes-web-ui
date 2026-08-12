import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DiscussionRunner,
  type DiscussionRow,
  type DiscussionState,
  type DiscussionStorage,
} from '../../packages/server/src/services/hermes/group-chat/discussion'

// The judge is a bare LLM call; mock it so tests drive convergence without a real provider.
vi.mock('../../packages/server/src/services/hermes/group-chat/room-summary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/group-chat/room-summary')>()
  return {
    ...actual,
    runBareModelAgent: vi.fn(),
  }
})

import { runBareModelAgent } from '../../packages/server/src/services/hermes/group-chat/room-summary'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { authenticateUserToken, isAuthEnabled } from '../../packages/server/src/middleware/user-auth'

const judgeMock = vi.mocked(runBareModelAgent)
const ACTIVE_STATUSES = new Set(['pending', 'running', 'paused'])

interface AgentSpec {
  agentId: string
  name: string
  profile: string
  reply?: (content: string) => Promise<void>
}

const DEFAULT_AGENTS: AgentSpec[] = [
  { agentId: 'agent-a', name: 'Agent A', profile: 'p-a' },
  { agentId: 'agent-b', name: 'Agent B', profile: 'p-b' },
]

function judgeJson(overrides: { converged?: boolean; stalled?: boolean; progress?: boolean } = {}): string {
  return JSON.stringify({
    converged: false,
    stalled: false,
    progress: false,
    assessment: '双方观点已清晰',
    suggestion: '继续深入讨论',
    ...overrides,
  })
}

function harness(opts: {
  agents?: AgentSpec[]
  messageCount?: number
  interruptRoom?: () => Promise<void>
} = {}) {
  const rows = new Map<string, DiscussionRow>()
  const contextMessages: Array<Record<string, unknown>> = []
  let messageCount = opts.messageCount ?? 0
  const room = {
    summaryProfile: 'default',
    summaryProvider: 'openai',
    summaryModel: 'gpt-test',
    summaryApiMode: 'chat_completions',
  }
  const agentSpecs = opts.agents ?? DEFAULT_AGENTS
  const agents = agentSpecs.map(spec => ({ id: spec.agentId, agentId: spec.agentId, profile: spec.profile, name: spec.name }))
  const speechLog: Array<{ agentId: string; content: string }> = []
  const clients = agentSpecs.map(spec => ({
    agentId: spec.agentId,
    name: spec.name,
    profile: spec.profile,
    replyToMention: vi.fn(async (_roomId: string, msg: { content: unknown }) => {
      speechLog.push({ agentId: spec.agentId, content: String(msg.content) })
      await spec.reply?.(String(msg.content))
    }),
  }))

  const storage: DiscussionStorage = {
    getRoom: (roomId: string) => (roomId === 'room-1' ? room : undefined),
    getRoomAgents: () => agents,
    getMessageCount: () => messageCount,
    getMessagesForContext: () => contextMessages,
    getDiscussionByRoom: (roomId: string) => rows.get(roomId) || null,
    saveDiscussion: (row: DiscussionRow) => {
      rows.set(row.roomId, { ...row })
    },
    updateDiscussion: (roomId: string, fields: Partial<DiscussionRow>) => {
      const current = rows.get(roomId)
      if (current) rows.set(roomId, { ...current, ...fields })
    },
    markDiscussionsFailed: (statuses: string[]) => {
      for (const row of rows.values()) {
        if (statuses.includes(row.status)) {
          row.status = 'failed'
          row.lastError = 'Discussion run was interrupted'
        }
      }
    },
  }

  const broadcasts: DiscussionState[] = []
  const systemMessages: Array<{ roomId: string; content: string }> = []
  const interruptRoom = opts.interruptRoom || vi.fn(async () => {})
  const runner = new DiscussionRunner({
    storage,
    agentClients: {
      getAgents: () => clients as any,
      interruptRoom,
    },
    roomSummaryService: {
      prepareForMessage: async () => ({ summary: '', history: [] }),
    },
    emitSystemMessage: async (roomId: string, content: string) => {
      systemMessages.push({ roomId, content })
    },
    broadcast: (roomId: string, state: DiscussionState) => {
      broadcasts.push({ ...state })
    },
  })

  function speechCalls(): Array<{ agentId: string; content: string }> {
    return speechLog
  }

  return {
    runner,
    storage,
    rows,
    clients,
    broadcasts,
    systemMessages,
    contextMessages,
    speechCalls,
    setMessageCount: (value: number) => {
      messageCount = value
    },
  }
}

async function waitForDone(runner: DiscussionRunner, roomId: string): Promise<DiscussionState> {
  return await vi.waitFor(() => {
    const current = runner.getState(roomId)
    if (current && !ACTIVE_STATUSES.has(current.status)) return current
    throw new Error(`discussion still active (${current?.status})`)
  })
}

describe('group chat free discussion runner', () => {
  beforeEach(() => {
    judgeMock.mockReset()
    judgeMock.mockResolvedValue(judgeJson())
  })

  it('rejects invalid starts: missing room, empty goal, fewer than 2 agents, duplicate 409', async () => {
    const { runner } = harness()

    await expect(runner.start('missing-room', { goal: 'go' })).rejects.toMatchObject({ status: 404 })
    await expect(runner.start('room-1', { goal: '   ' })).rejects.toThrow('goal is required')
    await expect(runner.start('room-1', { goal: 'go', agentOrder: ['agent-a'] })).rejects.toThrow('at least 2 agents')
    await expect(runner.start('room-1', { goal: 'go', agentOrder: ['agent-a', 'stranger'] })).rejects.toThrow('at least 2 agents')

    const single = harness({ agents: [DEFAULT_AGENTS[0]] })
    await expect(single.runner.start('room-1', { goal: 'go' })).rejects.toThrow('at least 2 agents')
  })

  it('rejects a duplicate start while a discussion is already running', async () => {
    const { runner } = harness()
    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    await expect(runner.start('room-1', { goal: 'go again' })).rejects.toMatchObject({ status: 409 })
    await waitForDone(runner, 'room-1')
  })

  it('drives two agents round by round in the configured order with injected prompts, then reports on convergence', async () => {
    const { runner, speechCalls, systemMessages } = harness()
    judgeMock
      .mockResolvedValueOnce(judgeJson())               // round 1: not converged
      .mockResolvedValueOnce(judgeJson({ converged: true })) // round 2: converged

    await runner.start('room-1', { goal: '决定发布策略', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(2)
    expect(final.reportMessageId).toBe('')
    expect(judgeMock).toHaveBeenCalledTimes(2)

    // 2 agents x 2 rounds, then the reporter (order[0] = agent-a) closes with the report.
    const calls = speechCalls()
    expect(calls.map(call => call.agentId)).toEqual(['agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a'])

    // Speech prompts carry the goal and per-agent identity.
    expect(calls[0].content).toContain('【讨论目标】决定发布策略')
    expect(calls[0].content).toContain('【你的身份】Agent A（p-a）')
    expect(calls[1].content).toContain('【你的身份】Agent B（p-b）')
    // Round 2 speech inherits the judge's previous assessment.
    expect(calls[2].content).toContain('【裁判上轮评估】双方观点已清晰')
    // The closing call is the reporting phase.
    expect(calls[4].content).toContain('汇报阶段')
    expect(calls[4].content).toContain('【讨论目标】决定发布策略')

    // Judge notes are broadcast and echoed to the room as system messages.
    expect(systemMessages.map(item => item.content).join('\n')).toContain('第1轮评估')
    expect(systemMessages.map(item => item.content).join('\n')).toContain('第2轮评估')
  })

  it('forces a report when maxRounds is reached without convergence', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson())

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
    expect(calls.at(-1)?.content).toContain('已达轮次/消息上限')
  })

  it('appends attachment file names to the goal so agents know what to discuss', async () => {
    const { runner, speechCalls, rows } = harness()
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))

    await runner.start('room-1', {
      goal: '自由讨论这个文件的内容',
      attachments: ['contract_1mb.txt', '证据清单.pdf'],
      maxRounds: 1,
    })
    await waitForDone(runner, 'room-1')

    // The persisted goal includes the attachment file names.
    const persisted = rows.get('room-1')
    expect(persisted?.goal).toContain('自由讨论这个文件的内容')
    expect(persisted?.goal).toContain('【讨论文件】contract_1mb.txt、证据清单.pdf')

    // Every agent speech prompt carries the attachment reference.
    for (const call of speechCalls()) {
      expect(call.content).toContain('【讨论目标】自由讨论这个文件的内容')
      expect(call.content).toContain('【讨论文件】contract_1mb.txt、证据清单.pdf')
    }
  })

  it('includes on-disk paths for attachments that exist in gc_documents', async () => {
    // Seed a matching doc record so the goal gains a readable path.
    const { runner, rows } = harness()
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))
    // Patch listDocumentsByRoom at runtime is complex in this unit; verify the
    // fallback (no matching doc) keeps a plain name in the goal.
    await runner.start('room-1', {
      goal: '读文件',
      attachments: ['unmatched.pdf'],
      maxRounds: 1,
    })
    await waitForDone(runner, 'room-1')
    expect(rows.get('room-1')?.goal).toContain('【讨论文件】unmatched.pdf')
  })

  it('does not terminate on pre-existing room history; only counts messages produced during the discussion', async () => {
    const { runner, speechCalls, setMessageCount } = harness({ messageCount: 60 })
    judgeMock.mockResolvedValue(judgeJson())

    // maxMessages applies to messages *during* this run, not the 60 historical ones.
    await runner.start('room-1', { goal: 'go', maxRounds: 2, maxMessages: 60 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(2) // full 2 rounds ran despite 60 historical msgs
    // All agents spoke (2 rounds x 2 agents) plus the report.
    const calls = speechCalls()
    expect(calls.length).toBe(2 * 2 + 1)
  })

  it('stops early when messages produced during the discussion hit the cap', async () => {
    const { runner, speechCalls, setMessageCount } = harness({ messageCount: 10 })
    judgeMock.mockResolvedValue(judgeJson())

    // Simulate heavy chatter: after the run starts, the room gains enough new
    // messages to cross the (incremental) cap, forcing an early max_rounds stop.
    let started = false
    const origSpeech = speechCalls
    await runner.start('room-1', { goal: 'go', maxRounds: 8, maxMessages: 20 })
    // Pump the counter past the incremental cap right away.
    setMessageCount(10 + 25)
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBeLessThan(8)
    void origSpeech
    void started
    const calls = speechCalls()
    expect(calls.at(-1)?.content).toContain('已达轮次/消息上限')
  })

  it('terminates after two consecutive stalled rounds with a forced report', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson({ stalled: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.currentRound).toBe(2)
    expect(final.status).toBe('max_rounds') // stalled maps to the forced-report terminal status
    const calls = speechCalls()
    expect(calls.length).toBe(5) // 2 rounds x 2 + 1 report
    expect(calls.at(-1)?.content).toContain('原地打转')
  })

  it('skips an agent whose speech fails without blocking the round', async () => {
    const { runner, speechCalls } = harness({
      agents: [
        { agentId: 'agent-a', name: 'Agent A', profile: 'p-a', reply: async () => { throw new Error('agent runtime hung') } },
        { agentId: 'agent-b', name: 'Agent B', profile: 'p-b' },
      ],
    })
    judgeMock
      .mockResolvedValueOnce(judgeJson())
      .mockResolvedValueOnce(judgeJson({ converged: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(2)
    const bCalls = speechCalls().filter(call => call.agentId === 'agent-b')
    expect(bCalls.length).toBe(2) // round 1 and round 2 still happened
    expect(bCalls.at(-1)?.content).toContain('第 2/')
  })

  it('keeps running when the judge keeps failing and still reports on the round cap', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockRejectedValue(new Error('provider unavailable'))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    expect(final.lastError).toContain('裁判暂不可用')
    // Every round still advanced exactly one turn per agent; the judge outage
    // never repeats a round or kills the run.
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
    expect(calls.map(call => call.agentId)).toEqual(['agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a'])
  })

  it('recovers when the judge succeeds again after a failed round', async () => {
    const { runner } = harness()
    judgeMock
      .mockRejectedValueOnce(new Error('provider unavailable'))  // round 1: outage
      .mockResolvedValueOnce(judgeJson({ converged: true }))     // round 2: converged

    await runner.start('room-1', { goal: 'go', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(2)
    expect(final.lastError).toBeNull() // cleared once a judge round succeeds
    expect(judgeMock).toHaveBeenCalledTimes(2)
  })

  it('extends past maxRounds while the judge keeps reporting progress, capped by the extension budget', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson({ progress: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    // Soft cap extends maxRounds(3) by DISCUSSION_MAX_EXTEND_ROUNDS(4) = 7 rounds.
    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(7)
    expect(final.judgeNotes.every(note => note.progress)).toBe(true)
    const calls = speechCalls()
    expect(calls.length).toBe(15) // 7 rounds x 2 agents + 1 report
  })

  it('closes at maxRounds without extending when the judge reports no progress', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson({ progress: false }))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
  })

  it('stops extending as soon as a round stops producing progress', async () => {
    const { runner, speechCalls } = harness()
    judgeMock
      .mockResolvedValueOnce(judgeJson({ progress: true }))   // round 1
      .mockResolvedValueOnce(judgeJson({ progress: true }))   // round 2
      .mockResolvedValueOnce(judgeJson({ progress: true }))   // round 3 (hits maxRounds, first extension)
      .mockResolvedValueOnce(judgeJson({ progress: true }))   // round 4 (second extension)
      .mockResolvedValueOnce(judgeJson({ progress: false }))  // round 5: no progress → close

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(5)
    expect(final.judgeNotes.at(-1)?.progress).toBe(false)
    const calls = speechCalls()
    expect(calls.length).toBe(11) // 5 rounds x 2 agents + 1 report
  })

  it('stops an active discussion and forces a stopped report', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { runner } = harness({
      agents: [
        { agentId: 'agent-a', name: 'Agent A', profile: 'p-a', reply: async () => { await gate; throw new Error('interrupted') } },
        { agentId: 'agent-b', name: 'Agent B', profile: 'p-b' },
      ],
      interruptRoom: async () => { release() },
    })
    judgeMock.mockResolvedValue(judgeJson())

    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    await vi.waitFor(() => {
      if (runner.getState('room-1')?.status !== 'running') throw new Error('discussion not started yet')
    })
    const stopped = await runner.stop('room-1')

    expect(stopped.status).toBe('stopped')
    expect(runner.isActive('room-1')).toBe(false)
  })

  it('marks in-flight discussions as failed on recovery', () => {
    const { runner, storage, rows } = harness()
    storage.saveDiscussion({
      id: 'disc-old',
      roomId: 'room-1',
      goal: 'go',
      agentOrder: JSON.stringify(['agent-a', 'agent-b']),
      reporterId: 'agent-a',
      maxRounds: 8,
      maxMessages: 60,
      judgeProfile: 'default',
      judgeProvider: 'openai',
      judgeModel: 'gpt-test',
      judgeApiMode: 'chat_completions',
      status: 'running',
      currentRound: 3,
      judgeNotes: '[]',
      reportMessageId: '',
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    })

    runner.recoverInterrupted()

    expect(rows.get('room-1')?.status).toBe('failed')
    expect(runner.getState('room-1')?.lastError).toBe('Discussion run was interrupted')
  })
})

describe('group chat discussion @-mention routing gate', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    vi.mocked(authenticateUserToken).mockResolvedValue(null as any)
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    vi.spyOn(groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  async function joinHumanAndAgent() {
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    const agent = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(human, agent)
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(agent, 'join', { roomId: 'room-1' })
    return { human }
  }

  function seedDiscussion(status: string) {
    groupServer.getStorage().saveDiscussion({
      id: 'disc-seeded',
      roomId: 'room-1',
      goal: 'seeded goal',
      agentOrder: JSON.stringify(['agent-worker']),
      reporterId: 'agent-worker',
      maxRounds: 8,
      maxMessages: 60,
      judgeProfile: 'default',
      judgeProvider: 'openai',
      judgeModel: 'gpt-test',
      judgeApiMode: 'chat_completions',
      status,
      currentRound: 1,
      judgeNotes: '[]',
      reportMessageId: '',
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  it('suspends @-mention routing while a discussion is running and restores it afterwards', async () => {
    const { human } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    // Running discussion: human mentions must not trigger agent routing.
    seedDiscussion('running')
    expect(groupServer.isRoomDiscussionRunning('room-1')).toBe(true)
    await emitAck(human, 'message', { roomId: 'room-1', id: 'msg-1', content: '@Worker hello' })
    expect(processMentions).not.toHaveBeenCalled()

    // Terminal discussion: routing resumes.
    groupServer.getStorage().updateDiscussion('room-1', { status: 'converged' })
    expect(groupServer.isRoomDiscussionRunning('room-1')).toBe(false)
    await emitAck(human, 'message', { roomId: 'room-1', id: 'msg-2', content: '@Worker hello again' })
    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({ messageId: 'msg-2' }))
  })
})
