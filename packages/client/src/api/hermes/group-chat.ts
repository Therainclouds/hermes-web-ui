import { io } from 'socket.io-client'
import { request, getApiKey, getBaseUrlValue } from '../client'
import { fetchAuthenticatedBlob, saveBlob } from './binary-content'

// ─── Types ──────────────────────────────────────────────────

export interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    canManage?: boolean
    summaryProfile: string
    summaryProvider: string
    summaryModel: string
    summaryApiMode: string
    summaryEveryTurns: number
    totalTokens?: number
    workspace: string
}

export interface RoomSummaryConfig {
    summaryProfile: string
    summaryProvider: string
    summaryModel: string
    summaryApiMode: string
    summaryEveryTurns: number
}

export interface RoomConfigInput extends Partial<RoomSummaryConfig> {
    name?: string
}

export interface RoomSummaryState {
    roomId: string
    summary: string
    summaryThroughMessageId: string
    summaryThroughMessageTimestamp: number
    summarizedTurnCount: number
    status: 'idle' | 'summarizing' | 'success' | 'failed'
    version: number
    updatedAt: number
    lastError: string | null
}

export interface RoomSummaryAnchor {
    id: string
    timestamp: number
    senderName: string
    role?: string
    content: string
}

export interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    agent: 'hermes' | 'ekko' | 'codex' | 'claude'
    profile: string
    provider: string
    model: string
    apiMode: string
    reasoningEffort: string
    name: string
    description: string
    avatar: string
    invited: number
}

export interface RoomAgentInput {
    agent: 'hermes' | 'ekko' | 'codex' | 'claude'
    profile: string
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    name?: string
    description?: string
    avatar?: string
    invited?: boolean
}

export interface AgentAddResult {
    profile: string
    ok: boolean
    agent?: RoomAgent
    code?: string
    error?: string
    reason?: string
}

export interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    run_id?: string | null
    role?: string
    tool_call_id?: string | null
    tool_calls?: any[] | null
    tool_name?: string | null
    finish_reason?: 'streaming' | 'tool_calls' | 'error' | string | null
    reasoning?: string | null
    reasoning_details?: string | null
    reasoning_content?: string | null
    isStreaming?: boolean
    toolName?: string
    toolCallId?: string
    toolArgs?: unknown
    toolPreview?: string
    toolResult?: unknown
    toolStatus?: 'running' | 'done' | 'error'
    workspaceChanges?: GroupWorkspaceDiffPayload[]
    firstSeenAt?: number
    attachments?: Array<{ id: string; name: string; type: string; size: number; url: string }>
    runItems?: ChatMessage[]
}

export interface GroupWorkspaceDiffFile {
    id: string | number
    path: string
    change_type?: 'added' | 'modified' | 'deleted' | 'renamed'
    additions: number
    deletions: number
    patch?: string | null
    binary?: boolean
    truncated?: boolean
}

export interface GroupWorkspaceDiffPayload {
    kind: 'workspace_diff'
    version: number
    room_id: string
    session_id: string
    run_id: string
    status: 'completed' | 'failed' | 'aborted'
    change_id: string
    workspace_basename: string
    workspace?: string
    workspace_root?: string
    files_changed: number
    additions: number
    deletions: number
    truncated: boolean
    files: GroupWorkspaceDiffFile[]
    parent_message_id?: string
}

export interface MemberInfo {
    id: string
    userId: string
    name: string
    description: string
    joinedAt: number
    avatar?: string
}

export interface JoinResult {
    roomId: string
    roomName: string
    members: MemberInfo[]
    messages: ChatMessage[]
    rooms: string[]
}

// ─── Socket.IO Client ──────────────────────────────────────

let socket: ReturnType<typeof io> | null = null

export function connectGroupChat(opts?: { userId?: string; userName?: string; description?: string; authUserId?: number }): ReturnType<typeof io> {
    if (socket?.connected) return socket

    const token = getApiKey()
    const userId = opts?.userId || localStorage.getItem('gc_user_id') || generateUUID()
    if (!opts?.userId) localStorage.setItem('gc_user_id', userId)

    socket = io('/group-chat', {
        auth: {
            token: token || undefined,
            userId,
            name: opts?.userName || localStorage.getItem('gc_user_name') || undefined,
            description: opts?.description || localStorage.getItem('gc_user_description') || undefined,
            authUserId: opts?.authUserId,
        },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.5,
        timeout: 30000,
    })

    return socket
}

export function getStoredUserId(): string {
    let id = localStorage.getItem('gc_user_id')
    if (!id) {
        id = generateUUID()
        localStorage.setItem('gc_user_id', id)
    }
    return id
}

export function getStoredUserName(): string | null {
    return localStorage.getItem('gc_user_name')
}

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0
        const v = c === 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
    })
}

export function getSocket(options: { requireConnected?: boolean } = {}): ReturnType<typeof io> | null {
    if (!socket) return null
    if (options.requireConnected === false) return socket
    return socket.connected ? socket : null
}

export function disconnectGroupChat(): void {
    if (socket) {
        socket.disconnect()
        socket = null
    }
}

// ─── REST API ───────────────────────────────────────────────

export async function createRoom(data: {
    name: string
    inviteCode: string
    memberName?: string
    memberDescription?: string
    agents?: RoomAgentInput[]
    summary: {
        profile: string
        provider: string
        model: string
        apiMode: string
        everyTurns: number
    }
    workspace?: string
}): Promise<{ room: RoomInfo; agents: RoomAgent[]; agentResults?: AgentAddResult[] }> {
    return request('/api/hermes/group-chat/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function cloneRoom(roomId: string, data?: { name?: string; inviteCode?: string }): Promise<{ room: RoomInfo; agents: RoomAgent[]; agentResults?: AgentAddResult[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {}),
    })
}

export async function listRooms(): Promise<{ rooms: RoomInfo[] }> {
    return request('/api/hermes/group-chat/rooms')
}

export async function getRoomDetail(
    roomId: string,
    options: { offset?: number; limit?: number } = {},
): Promise<{ room: RoomInfo; messages: ChatMessage[]; agents: RoomAgent[]; members: MemberInfo[]; total?: number; offset?: number; limit?: number; hasMore?: boolean }> {
    const params = new URLSearchParams()
    if (options.offset != null) params.set('offset', String(options.offset))
    if (options.limit != null) params.set('limit', String(options.limit))
    const query = params.toString()
    return request(`/api/hermes/group-chat/rooms/${roomId}${query ? `?${query}` : ''}`)
}

export async function joinRoomByCode(code: string): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/join/${code}`)
}

export async function updateInviteCode(roomId: string, inviteCode: string): Promise<{ success: boolean }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/invite-code`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode }),
    })
}

export async function addAgent(roomId: string, data: RoomAgentInput): Promise<{ agent: RoomAgent }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function updateAgent(roomId: string, agentId: string, data: RoomAgentInput): Promise<{ agent: RoomAgent; agents: RoomAgent[]; members: MemberInfo[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function listAgents(roomId: string): Promise<{ agents: RoomAgent[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents`)
}

export async function removeAgent(roomId: string, agentId: string): Promise<{ success: boolean; agents: RoomAgent[]; members: MemberInfo[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents/${agentId}`, {
        method: 'DELETE',
    })
}

export async function deleteRoom(roomId: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}`, {
        method: 'DELETE',
    })
}

export async function clearRoomContext(roomId: string): Promise<{ success: boolean; room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/clear-context`, {
        method: 'POST',
    })
}

export async function updateRoomConfig(roomId: string, config: RoomConfigInput): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
    })
}

export async function updateRoomWorkspace(roomId: string, workspace: string): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
    })
}

export async function getRoomSummary(roomId: string): Promise<{ summary: RoomSummaryState; anchor: RoomSummaryAnchor | null }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/summary`)
}

export async function updateRoomSummary(roomId: string, summary: string): Promise<{ summary: RoomSummaryState }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/summary`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary }),
    })
}

export type DiscussionStatus = 'pending' | 'running' | 'paused' | 'converged' | 'max_rounds' | 'stopped' | 'failed'

export interface DiscussionJudgeNote {
    round: number
    converged: boolean
    stalled: boolean
    progress?: boolean
    assessment: string
    suggestion: string
}

export interface DiscussionState {
    id: string
    roomId: string
    goal: string
    agentOrder: string[]
    reporterId: string
    maxRounds: number
    maxMessages: number
    judgeProfile: string
    judgeProvider: string
    judgeModel: string
    judgeApiMode: string
    status: DiscussionStatus
    currentRound: number
    judgeNotes: DiscussionJudgeNote[]
    reportMessageId: string
    lastError: string | null
    createdAt: number
    updatedAt: number
}

export interface DiscussionStartInput {
    goal: string
    agentOrder?: string[]
    maxRounds?: number
    maxMessages?: number
    reporterId?: string
    judge?: { profile?: string; provider?: string; model?: string; apiMode?: string }
}

export async function startDiscussion(roomId: string, input: DiscussionStartInput): Promise<{ discussion: DiscussionState }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/discussion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    })
}

export async function fetchDiscussion(roomId: string): Promise<{ discussion: DiscussionState | null }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/discussion`)
}

export async function stopDiscussion(roomId: string): Promise<{ discussion: DiscussionState }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/discussion/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    })
}

export async function listGroupWorkspaceFiles(roomId: string, path = ''): Promise<{
    entries: Array<{ name: string; path: string; absolutePath?: string; isDir: boolean; size: number; modTime: string }>
    path: string
    absolutePath?: string
}> {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    const query = params.toString()
    return request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-files/list${query ? `?${query}` : ''}`)
}

export async function readGroupWorkspaceFile(roomId: string, path: string): Promise<{ content: string; path: string; size: number }> {
    const params = new URLSearchParams({ path })
    return request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/read?${params}`)
}

export async function fetchGroupWorkspaceFileBlob(roomId: string, path: string, signal?: AbortSignal): Promise<Blob> {
    const params = new URLSearchParams({ path })
    return fetchAuthenticatedBlob(
        `/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/content?${params}`,
        { signal },
    )
}

export async function fetchGroupWorkspaceAttachmentBlob(roomId: string, path: string, signal?: AbortSignal): Promise<Blob> {
    const params = new URLSearchParams({ path, download: '1' })
    return fetchAuthenticatedBlob(
        `/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/content?${params}`,
        { signal },
    )
}

export async function fetchGroupWorkspaceFileText(roomId: string, path: string): Promise<{ content: string; size: number }> {
    const params = new URLSearchParams({ path, text: '1' })
    const blob = await fetchAuthenticatedBlob(
        `/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/content?${params}`,
    )
    return { content: await blob.text(), size: blob.size }
}

export async function downloadGroupWorkspaceFile(roomId: string, path: string, fileName: string): Promise<void> {
    const params = new URLSearchParams({ path, download: '1' })
    const blob = await fetchAuthenticatedBlob(
        `/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/content?${params}`,
    )
    saveBlob(blob, fileName)
}

export async function writeGroupWorkspaceFile(roomId: string, path: string, content: string): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/write`, {
        method: 'PUT', body: JSON.stringify({ path, content }),
    })
}

export async function mkdirGroupWorkspaceFile(roomId: string, path: string): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/mkdir`, {
        method: 'POST', body: JSON.stringify({ path }),
    })
}

export async function deleteGroupWorkspaceFile(roomId: string, path: string, recursive = false): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/delete`, {
        method: 'DELETE', body: JSON.stringify({ path, recursive }),
    })
}

export async function renameGroupWorkspaceFile(roomId: string, oldPath: string, newPath: string): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/rename`, {
        method: 'POST', body: JSON.stringify({ oldPath, newPath }),
    })
}

export async function copyGroupWorkspaceFile(roomId: string, srcPath: string, destPath: string): Promise<void> {
    await request(`/api/hermes/group-chat/rooms/${encodeURIComponent(roomId)}/workspace-file/copy`, {
        method: 'POST', body: JSON.stringify({ srcPath, destPath }),
    })
}

// ─── Export ──────────────────────────────────────────────────

export async function exportRoom(roomId: string, ext: 'json' | 'txt' = 'json'): Promise<void> {
    const base = getBaseUrlValue()
    const url = `${base}/api/hermes/group-chat/rooms/${roomId}/export?ext=${ext}`
    const apiKey = getApiKey()
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)

    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
    const filename = filenameMatch?.[1] || `room_${roomId.slice(0, 8)}.${ext}`

    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(objectUrl)
}

export async function exportAllRooms(ext: 'json' | 'txt' = 'json'): Promise<void> {
    const base = getBaseUrlValue()
    const url = `${base}/api/hermes/group-chat/rooms/export?ext=${ext}`
    const apiKey = getApiKey()
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)

    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
    const filename = filenameMatch?.[1] || `all_group_chats.${ext}`

    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(objectUrl)
}

export interface ImportResult {
    success: boolean
    importedCount: number
    failedCount: number
    results: Array<{ name: string; roomId?: string; error?: string }>
}

export async function importRooms(file: File): Promise<ImportResult> {
    const base = getBaseUrlValue()
    const url = `${base}/api/hermes/group-chat/rooms/import`
    const apiKey = getApiKey()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const text = await file.text()
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: text,
    })
    if (!res.ok) {
        const raw = await res.text().catch(() => '')
        try {
            const parsed = JSON.parse(raw)
            throw new Error(parsed?.error || `Import failed: ${res.status}`)
        } catch {
            throw new Error(raw || `Import failed: ${res.status}`)
        }
    }
    return res.json()
}
