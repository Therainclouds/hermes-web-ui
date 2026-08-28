// 从 stores/hermes/chat.ts 拆出的纯函数区：类型 / 常量 / 工具函数。
// chat.ts 通过 `export * from './chat-core'` 对外保持兼容；
// 本模块不依赖 store 内部状态，可独立测试。
import { type RunEvent, type ContentBlock as ContentBlockImport } from '@/api/hermes/chat'
import { type HermesMessage, type SessionSummary, type WorkspaceRunChangeSummary } from '@/api/hermes/sessions'
import { getActiveProfileName } from '@/api/client'
import { type ChatCodingAgentId } from '@/api/coding-agents'
import type { ProviderApiMode } from '@/api/hermes/system'
import { useProfilesStore } from './profiles'
import { responseErrorMessage } from '@/utils/http-error'
import { classifyModelProviderError } from '@/utils/model-provider-error'

export type ContentBlock = ContentBlockImport

export const LIVE_CHAT_MESSAGE_PAGE_SIZE = 150
export const LIVE_CHAT_MAX_LOADED_MESSAGES = 300
export const LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX = 'workspace-run-change:'
export type ChatAgentId = 'hermes' | 'claude' | 'codex' | 'dsh' | 'pi' | 'ekko-agent'

export function agentToCodingAgentId(agent?: string): ChatCodingAgentId | undefined {
  if (agent === 'codex') return 'codex'
  if (agent === 'pi') return 'pi'
  if (agent === 'claude') return 'claude-code'
  if (agent === 'dsh') return 'dsh'
  if (agent === 'ekko-agent') return 'ekko-agent'
  return undefined
}

export function codingAgentIdToAgent(id?: ChatCodingAgentId): ChatAgentId | undefined {
  if (id === 'codex') return 'codex'
  if (id === 'pi') return 'pi'
  if (id === 'claude-code') return 'claude'
  if (id === 'dsh') return 'dsh'
  if (id === 'ekko-agent') return 'ekko-agent'
  return undefined
}

export function moaReferenceLabel(evt: RunEvent): string {
  const label = typeof evt.label === 'string' && evt.label.trim()
    ? evt.label.trim()
    : 'reference'
  const index = Number.isFinite(Number(evt.index)) ? Number(evt.index) : undefined
  const count = Number.isFinite(Number(evt.count)) ? Number(evt.count) : undefined
  return index != null && count != null
    ? `${index}/${count} ${label}`
    : label
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: File
  /** Structured context sent to the model but rendered collapsed in the UI. */
  context?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command'
  content: string
  timestamp: number
  toolName?: string
  toolCallId?: string
  toolPreview?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolStatus?: 'running' | 'done' | 'error'
  toolDuration?: number  // 工具执行时长（秒）
  workspaceChanges?: WorkspaceRunChangeSummary[]
  isStreaming?: boolean
  attachments?: Attachment[]
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
  queued?: boolean
  systemType?: 'command' | 'error' | 'fork-divider' | 'tool-run'
  commandAction?: string
  commandData?: Record<string, unknown>
  finishReason?: string | null
  runMarker?: string | null
  toolRunId?: string
  toolMessages?: Message[]
}

export type SubagentStreamStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface SubagentStreamEntry {
  id: string
  kind: 'text' | 'thinking' | 'tool' | 'status'
  timestamp: number
  text?: string
  reasoning?: string
  reasoningEntryId?: string
  toolName?: string
  toolArgs?: unknown
  status?: SubagentStreamStatus | 'started'
}

export interface SubagentStream {
  sessionId: string
  subagentId: string
  taskIndex: number
  taskCount: number
  goal?: string
  model?: string
  status: SubagentStreamStatus
  startedAt: number
  updatedAt: number
  completedAt?: number
  durationSeconds?: number
  toolCount?: number
  apiCalls?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  summary?: string
  lastBackgroundSeq?: number
  entries: SubagentStreamEntry[]
}

const SUBAGENT_STREAM_ENTRY_LIMIT = 200
const SUBAGENT_STREAM_TEXT_LIMIT = 80_000
let subagentStreamEntrySequence = 0

function subagentEventTimestamp(value: unknown): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now()
  return timestamp < 1_000_000_000_000 ? Math.round(timestamp * 1000) : Math.round(timestamp)
}

export function subagentStatus(value: unknown, fallback: SubagentStreamStatus = 'running'): SubagentStreamStatus {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled' || status === 'interrupted') {
    return status
  }
  return fallback
}

function subagentEntryId(eventName: string, evt: RunEvent): string {
  const backgroundSequence = Number((evt as any).background_seq)
  if (Number.isFinite(backgroundSequence)) return `${eventName}:${backgroundSequence}`
  if ((evt as any).background_snapshot) return `snapshot:${eventName}`
  subagentStreamEntrySequence += 1
  return `${eventName}:${subagentStreamEntrySequence}`
}

function trimSubagentEntries(entries: SubagentStreamEntry[]): SubagentStreamEntry[] {
  return entries.length > SUBAGENT_STREAM_ENTRY_LIMIT
    ? entries.slice(entries.length - SUBAGENT_STREAM_ENTRY_LIMIT)
    : entries
}

function appendSubagentText(
  entries: SubagentStreamEntry[],
  entry: SubagentStreamEntry,
): SubagentStreamEntry[] {
  const previous = entries[entries.length - 1]
  if (previous?.kind === entry.kind && entry.text) {
    const previousText = previous.text || ''
    const nextText = entry.text.startsWith(previousText)
      ? entry.text
      : `${previousText}${entry.text}`
    entries[entries.length - 1] = {
      ...previous,
      text: nextText.slice(-SUBAGENT_STREAM_TEXT_LIMIT),
      timestamp: entry.timestamp,
    }
    return entries
  }
  entries.push({
    ...entry,
    text: entry.text?.slice(-SUBAGENT_STREAM_TEXT_LIMIT),
  })
  return trimSubagentEntries(entries)
}

function subagentReasoningSinceLastTool(
  entries: SubagentStreamEntry[],
): { id: string; text: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'tool') return null
    if (entry.kind === 'thinking' && entry.text?.trim()) {
      return { id: entry.id, text: entry.text }
    }
  }
  return null
}

export function reduceSubagentStream(
  current: SubagentStream | undefined,
  sessionId: string,
  evt: RunEvent,
): SubagentStream {
  const eventName = String(evt.event || '')
  const subagentId = String((evt as any).subagent_id || evt.delegation_id || `${(evt as any).task_index ?? 0}`)
  const timestamp = subagentEventTimestamp(evt.timestamp || (evt as any).updated_at)
  const backgroundSequence = Number((evt as any).background_seq)
  if (
    current
    && Number.isFinite(backgroundSequence)
    && current.lastBackgroundSeq != null
    && backgroundSequence <= current.lastBackgroundSeq
  ) {
    return current
  }

  const incomingTaskIndex = Number((evt as any).task_index)
  const incomingTaskCount = Number((evt as any).task_count)
  const goal = String((evt as any).goal || '').trim()
  const model = String((evt as any).model || '').trim()
  const summary = String((evt as any).summary || '').trim()
  const rawText = String(evt.text || evt.preview || '')
  const text = rawText.trim()
  const toolName = String((evt as any).tool || (evt as any).name || '').trim()
  const durationSeconds = Number((evt as any).duration_seconds ?? (evt as any).duration)
  const toolCount = Number((evt as any).tool_count)
  const apiCalls = Number((evt as any).api_calls)
  const inputTokens = Number((evt as any).input_tokens)
  const outputTokens = Number((evt as any).output_tokens)
  const costUsd = Number((evt as any).cost_usd)
  const isTerminal = eventName === 'subagent.complete'
    || (eventName === 'delegation.updated' && ['completed', 'failed', 'error', 'cancelled', 'interrupted'].includes(String((evt as any).status || '').toLowerCase()))
  if (current && current.status !== 'running' && !isTerminal) return current
  const nextStatus = isTerminal
    ? subagentStatus((evt as any).status, 'completed')
    : 'running'
  const entries = current ? [...current.entries] : []
  const entryId = subagentEntryId(eventName, evt)

  if (eventName === 'subagent.start') {
    if (!entries.some(entry => entry.kind === 'status' && entry.status === 'started')) {
      entries.push({ id: entryId, kind: 'status', status: 'started', timestamp, text: goal || undefined })
    }
  } else if (eventName === 'subagent.text' && rawText) {
    const reasoning = subagentReasoningSinceLastTool(entries)
    appendSubagentText(entries, {
      id: entryId,
      kind: 'text',
      timestamp,
      text: rawText,
      reasoning: reasoning?.text,
      reasoningEntryId: reasoning?.id,
    })
  } else if (eventName === 'subagent.thinking' && rawText) {
    appendSubagentText(entries, { id: entryId, kind: 'thinking', timestamp, text: rawText })
  } else if (eventName === 'subagent.tool') {
    const reasoning = subagentReasoningSinceLastTool(entries)
    if (reasoning) {
      // A tool boundary is the final owner for this reasoning segment. Text
      // deltas can arrive before the tool call is announced, so revoke their
      // provisional ownership to avoid rendering the same reasoning twice.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry.kind !== 'text' || entry.reasoningEntryId !== reasoning.id) continue
        const {
          reasoning: _reasoning,
          reasoningEntryId: _reasoningEntryId,
          ...textEntry
        } = entry
        entries[i] = textEntry
      }
    }
    entries.push({
      id: entryId,
      kind: 'tool',
      timestamp,
      text: text || undefined,
      reasoning: reasoning?.text,
      reasoningEntryId: reasoning?.id,
      toolName: toolName || undefined,
      toolArgs: (evt as any).arguments,
    })
  } else if (eventName === 'subagent.progress' && text) {
    const previous = entries[entries.length - 1]
    const progressEntry: SubagentStreamEntry = {
      id: entryId,
      kind: 'status',
      status: 'running',
      timestamp,
      text,
    }
    if (previous?.kind === 'status' && previous.status === 'running') entries[entries.length - 1] = progressEntry
    else entries.push(progressEntry)
  }

  if (isTerminal) {
    const finalText = summary || text
    const previousTextEntry = [...entries].reverse().find(entry => entry.kind === 'text')
    const previousText = previousTextEntry?.text?.trim()
    if (finalText && previousText !== finalText) {
      const activeReasoning = subagentReasoningSinceLastTool(entries)
      const reasoning = activeReasoning?.id === previousTextEntry?.reasoningEntryId
        ? null
        : activeReasoning
      entries.push({
        id: `${entryId}:summary`,
        kind: 'text',
        timestamp,
        text: finalText,
        reasoning: reasoning?.text,
        reasoningEntryId: reasoning?.id,
      })
    }
    const previous = entries[entries.length - 1]
    const terminalEntry: SubagentStreamEntry = {
      id: entryId,
      kind: 'status',
      status: nextStatus,
      timestamp,
    }
    if (previous?.kind === 'status' && previous.status !== 'started') entries[entries.length - 1] = terminalEntry
    else entries.push(terminalEntry)
  }

  return {
    sessionId,
    subagentId,
    taskIndex: Number.isFinite(incomingTaskIndex) ? incomingTaskIndex : current?.taskIndex || 0,
    taskCount: Number.isFinite(incomingTaskCount) && incomingTaskCount > 0 ? incomingTaskCount : current?.taskCount || 1,
    goal: goal || current?.goal,
    model: model || current?.model,
    status: nextStatus,
    startedAt: current?.startedAt || subagentEventTimestamp((evt as any).started_at || timestamp),
    updatedAt: timestamp,
    completedAt: isTerminal ? subagentEventTimestamp((evt as any).completed_at || timestamp) : current?.completedAt,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : current?.durationSeconds,
    toolCount: Number.isFinite(toolCount) ? toolCount : current?.toolCount,
    apiCalls: Number.isFinite(apiCalls) ? apiCalls : current?.apiCalls,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : current?.inputTokens,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : current?.outputTokens,
    costUsd: Number.isFinite(costUsd) ? costUsd : current?.costUsd,
    summary: summary || current?.summary,
    lastBackgroundSeq: Number.isFinite(backgroundSequence) ? backgroundSequence : current?.lastBackgroundSeq,
    entries: trimSubagentEntries(entries),
  }
}

export interface MessageReference {
  id: string
  role: 'user' | 'assistant'
  content: string
  sender?: string
  senderId?: string
}

export interface ParsedMessageReference {
  content: string
  reply: string
}

export function parseMessageReference(content: string): ParsedMessageReference | null {
  if (!content.startsWith('<quoted_message')) return null
  const openEnd = content.indexOf('>\n')
  if (openEnd === -1) return null
  const closeMarker = '\n</quoted_message>'
  const closeStart = content.indexOf(closeMarker, openEnd + 2)
  if (closeStart === -1) return null

  return {
    content: content.slice(openEnd + 2, closeStart).trim(),
    reply: content.slice(closeStart + closeMarker.length).trim(),
  }
}

export function formatReferencedContentForDisplay(content: string): string {
  return content
    .trim()
    .split(/\r?\n/)
    .map(line => line ? `> ${line}` : '>')
    .join('\n')
}

export function formatMessageWithReference(reference: MessageReference, content: string): string {
  const sender = reference.sender?.trim()
  const openTag = sender
    ? `<quoted_message sender=${JSON.stringify(sender)}>`
    : '<quoted_message>'
  const quotedContent = reference.content.trim()
  const reply = content.trim()
  const referenceBlock = `${openTag}\n${quotedContent}\n</quoted_message>`
  return reply ? `${referenceBlock}\n\n${reply}` : referenceBlock
}

export interface PendingApproval {
  sessionId: string
  approvalId: string
  command: string
  description: string
  choices: Array<'once' | 'session' | 'always' | 'deny'>
  allowPermanent: boolean
  isMemoryWrite: boolean
  requestedAt: number
}

export interface PendingClarify {
  sessionId: string
  clarifyId: string
  question: string
  choices: string[] | null
  initialResponse: string
  responseMode: string
  timeoutMs: number
  requestedAt: number
}

export interface QueueInsertionState {
  generation: string
  runId?: string
  queueId: string
  runtime: 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi'
  phase: 'requesting' | 'waiting_for_tool_batch' | 'stopping_current_turn'
  guarantee: 'strict' | 'immediate'
  requestedAt: number
}

export interface Session {
  id: string
  profile?: string
  title: string
  source?: string
  agent?: string
  agentSessionId?: string
  agentNativeSessionId?: string
  codingAgentId?: ChatCodingAgentId
  codingAgentMode?: 'global' | 'scoped'
  messages: Message[]
  createdAt: number
  updatedAt: number
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: ProviderApiMode
  messageCount?: number
  messageTotal?: number
  loadedMessageCount?: number
  hasMoreBefore?: boolean
  isLoadingOlderMessages?: boolean
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  endedAt?: number | null
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  parentTitle?: string | null
  parentLastMessage?: string | null
  parentLastMessageRole?: string | null
  lastActiveAt?: number
  isArchived?: boolean
  workspace?: string | null
  categoryId?: number | null
  isLocalOnly?: boolean
  /** Per-session reasoning effort override.
   * Empty string / undefined = use config.yaml default.
   * Values: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' */
  reasoningEffort?: string
}

export interface CompressionState {
  compressing: boolean
  messageCount: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean | null
  error?: string
}

export interface AbortState {
  aborting: boolean
  synced: boolean | null
  timedOut?: boolean
  message?: string
  error?: string
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function alignWorkspaceChangeAssistantMessage(
  messages: Message[],
  change: WorkspaceRunChangeSummary | null | undefined,
  assistantMessageId?: string | null,
): string | null {
  const currentAssistantMessageId = String(assistantMessageId || '').trim()
  const persistedAssistantMessageId = String(change?.assistant_message_id || '').trim()
  if (!persistedAssistantMessageId) return currentAssistantMessageId || null
  if (!currentAssistantMessageId || persistedAssistantMessageId === currentAssistantMessageId) {
    return messages.some(item => item.id === persistedAssistantMessageId)
      ? persistedAssistantMessageId
      : currentAssistantMessageId || null
  }
  const message = messages.find(item => item.id === currentAssistantMessageId)
  const idAlreadyLoaded = messages.some(item => item.id === persistedAssistantMessageId)
  if (message && !idAlreadyLoaded) {
    message.id = persistedAssistantMessageId
    return persistedAssistantMessageId
  }
  return idAlreadyLoaded ? persistedAssistantMessageId : currentAssistantMessageId
}

export function attachWorkspaceChangesToExactTurns(
  messages: Message[],
  changes: WorkspaceRunChangeSummary[],
): void {
  for (const message of messages) message.workspaceChanges = []
  const assistantById = new Map(
    messages
      .filter(message => message.role === 'assistant')
      .map(message => [message.id, message]),
  )
  for (const change of changes) {
    const assistantMessageId = String(change.assistant_message_id || '').trim()
    if (!assistantMessageId) continue
    const target = assistantMessageId ? assistantById.get(assistantMessageId) : undefined
    if (target) target.workspaceChanges!.push(change)
  }
}

function isToolOutputError(output: unknown): boolean {
  if (typeof output !== 'string' || !output.trim()) return false
  try {
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (record.success === false) return true
      if (record.error != null && String(record.error).trim() !== '') return true
    }
  } catch {
    return false
  }
  return false
}

function errorMessageText(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error == null) return ''
  if (typeof error !== 'object') return String(error).trim()

  if (Array.isArray(error)) {
    return error.map(errorMessageText).filter(Boolean).join('\n')
  }

  const record = error as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description', 'code']) {
    const text = errorMessageText(record[key])
    if (text) return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function friendlyAgentErrorMessage(error: unknown): string {
  const message = errorMessageText(error)
  const providerError = classifyModelProviderError(message)
  if (!providerError) return message
  if (providerError.kind === 'billing_required') {
    return '当前配置的大模型账号可能已欠费、余额不足或额度用尽，请前往模型设置页续费或更换可用的 API Key。'
  }
  if (providerError.kind === 'auth_invalid') {
    return '当前配置的大模型凭据校验失败，请检查模型设置中的 API Key、权限和账号状态。'
  }
  if (providerError.kind === 'quota_exceeded') {
    return '当前配置的大模型请求额度已触发限制，请稍后重试，或前往模型设置页检查额度与计费状态。'
  }
  return message
}

export async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const profileName = getActiveProfileName()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (profileName) headers['X-Hermes-Profile'] = profileName
  const res = await fetch('/upload', {
    method: 'POST',
    body: formData,
    headers,
  })
  if (!res.ok) throw new Error(await responseErrorMessage(res, 'Upload failed'))
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

export async function buildContentBlocks(
  content: string,
  attachments?: Attachment[],
  uploadedFiles?: { name: string; path: string }[],
  includeContextText = true,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  // Add text block if content is not empty
  if (content.trim()) {
    blocks.push({ type: 'text', text: content.trim() })
  }

  // Add attachment blocks using uploaded file paths
  if (attachments && attachments.length > 0 && uploadedFiles) {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const uploaded = uploadedFiles[i]
      const attachment = attachments[i]

      // Check if it's an image
      if (attachment?.type.startsWith('image/')) {
        blocks.push({
          type: 'image',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment.type,
          ...(attachment.context?.trim() ? { context: attachment.context.trim() } : {}),
        })
      } else {
        // Other files
        blocks.push({
          type: 'file',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment?.type,
          ...(attachment?.context?.trim() ? { context: attachment.context.trim() } : {}),
        })
      }
      if (includeContextText && attachment?.context?.trim()) {
        blocks.push({
          type: 'text',
          text: `<browser_selection_context format="json">\n${attachment.context.trim()}\n</browser_selection_context>`,
        })
      }
    }
  }

  return blocks
}

export function hasRuntimeToolPayload(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

export function runtimeToolPayloadOrUndefined(value: unknown): unknown | undefined {
  return hasRuntimeToolPayload(value) ? value : undefined
}

export function runtimeToolOutputFromEvent(event: unknown): unknown | undefined {
  if (!event || typeof event !== 'object') return undefined
  const record = event as Record<string, unknown>
  return runtimeToolPayloadOrUndefined(
    record.output ?? record.result ?? record.content ?? record.preview,
  )
}

function runtimePayloadText(value: unknown): string {
  if (!hasRuntimeToolPayload(value)) return ''
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return serialized
  } catch {
    // Fall through to String(value) for non-serializable runtime payloads.
  }
  return String(value)
}

export function runtimeObjectPayload(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function isBackgroundDelegateToolPayload(toolName: unknown, payload: unknown): boolean {
  if (String(toolName || '') !== 'delegate_task') return false
  return runtimeObjectPayload(payload)?.mode === 'background'
}

export const HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX = 'background-delegate:'

export function backgroundDelegateTaskDescriptors(
  payload: Record<string, unknown>,
  toolArgs: unknown,
): Array<{ taskIndex: number; taskCount: number; goal: string }> {
  const args = runtimeObjectPayload(toolArgs)
  const payloadGoals = Array.isArray(payload.goals)
    ? payload.goals.map(value => String(value || '').trim())
    : []
  const argumentGoals = Array.isArray(args?.goals)
    ? args.goals.map(value => String(value || '').trim())
    : []
  const goals = payloadGoals.length > 0 ? payloadGoals : argumentGoals
  const fallbackGoal = String(payload.goal || args?.goal || '').trim()
  const requestedCount = Number(payload.count ?? payload.task_count)
  const taskCount = Math.max(
    1,
    Number.isFinite(requestedCount) ? requestedCount : 0,
    goals.length,
  )
  return Array.from({ length: taskCount }, (_, taskIndex) => ({
    taskIndex,
    taskCount,
    goal: goals[taskIndex] || (taskIndex === 0 ? fallbackGoal : ''),
  }))
}

export function backgroundDelegateAnchorCallId(baseId: string, taskIndex: number): string {
  return `${HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX}${baseId}:${taskIndex}`
}

function parsePersistedMoaToolPayload(toolName: string | undefined, value: unknown): { preview?: string; result?: unknown } | null {
  if (toolName !== 'moa_reference' && toolName !== 'moa_aggregating') return null
  const payload = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      })()
    : value
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  const preview = typeof data.preview === 'string'
    ? data.preview
    : typeof data.label === 'string'
      ? data.label
      : typeof data.aggregator === 'string'
        ? data.aggregator
        : undefined
  const result = data.text ?? data.result
  return { preview, result }
}

function isPersistedMoaToolDisplay(msg: HermesMessage): boolean {
  return (msg.role === 'moa' || msg.display_role === 'tool')
    && (msg.tool_name === 'moa_reference' || msg.tool_name === 'moa_aggregating')
}

export function runtimeToolOutputHasError(value: unknown): boolean {
  return typeof value === 'string' && isToolOutputError(value)
}

function readFinishReason(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'finishReason')) {
    return (record as { finishReason?: string | null }).finishReason
  }
  if (Object.prototype.hasOwnProperty.call(record, 'finish_reason')) {
    return (record as { finish_reason?: string | null }).finish_reason
  }
  return undefined
}

export function readRunMarker(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'runMarker')) {
    return typeof record.runMarker === 'string' || record.runMarker == null
      ? record.runMarker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_marker')) {
    return typeof record.run_marker === 'string' || record.run_marker == null
      ? record.run_marker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_id')) {
    return typeof record.run_id === 'string' || record.run_id == null
      ? record.run_id as string | null
      : undefined
  }
  return undefined
}

export function isQueueInsertionInterruption(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Pick<RunEvent, 'interrupted' | 'stop_reason'>
  return event.interrupted === true && event.stop_reason === 'queue_insertion'
}

function hasAssistantVisibleText(message: Message | null | undefined): boolean {
  if (!message) return false
  return message.content.trim() !== '' || (message.reasoning?.trim() ?? '') !== ''
}

function selectResumedInFlightAssistant(messages: Message[], activeRunMarker?: string | null): Message | null {
  if (messages.length === 0) return null
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== 'assistant') return null
  const finishReason = readFinishReason(lastMessage)
  const runMarker = readRunMarker(lastMessage)
  const hasMatchingRunMarker = !!activeRunMarker && !!runMarker && runMarker === activeRunMarker
  return finishReason === null || hasMatchingRunMarker ? lastMessage : null
}

export function getReplayRunMarker(events?: Array<{ event: string; data: RunEvent }>): string | null {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const runMarker = readRunMarker(events[i]?.data)
    if (typeof runMarker === 'string' && runMarker.trim() !== '') return runMarker
  }
  return null
}

export function resolveResumedAssistantState(
  messages: Message[],
  options: {
    previousActiveAssistantMessageId?: string | null
    previousReasoningAssistantMessageId?: string | null
    activeRunMarker?: string | null
  },
): {
  activeAssistant: Message | null
  reasoningAssistant: Message | null
  runMarker: string | null
  hadVisibleText: boolean
} {
  const activeAssistant = options.previousActiveAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousActiveAssistantMessageId) || null
    : null
  const selectedActiveAssistant = activeAssistant || selectResumedInFlightAssistant(messages, options.activeRunMarker)
  const reasoningAssistant = options.previousReasoningAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousReasoningAssistantMessageId) || null
    : null
  const selectedReasoningAssistant = reasoningAssistant || (selectedActiveAssistant?.reasoning ? selectedActiveAssistant : null)
  const selectedRunMarker = readRunMarker(selectedActiveAssistant) ?? options.activeRunMarker ?? null
  return {
    activeAssistant: selectedActiveAssistant,
    reasoningAssistant: selectedReasoningAssistant,
    runMarker: selectedRunMarker,
    hadVisibleText: hasAssistantVisibleText(selectedActiveAssistant),
  }
}

export function mapHermesMessages(msgs: HermesMessage[]): Message[] {
  // Filter out assistant messages with no display content unless they carry tool call metadata
  // needed to name later tool result rows when resuming persisted history.
  const filteredMsgs = msgs.filter(m => {
    if (m.role === 'assistant') {
      return (m.tool_calls?.length || 0) > 0 || runtimePayloadText((m as any).content).trim() !== ''
    }
    return true
  })

  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, unknown>()
  const toolReasoningMap = new Map<string, string>()
  for (const msg of filteredMsgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
          if (hasRuntimeToolPayload(tc.function?.arguments)) toolArgsMap.set(tc.id, tc.function.arguments)
          if (msg.reasoning?.trim()) toolReasoningMap.set(tc.id, msg.reasoning)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of filteredMsgs) {
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !runtimePayloadText((msg as any).content).trim()) {
      // Emit a tool.started message for each tool call
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || undefined,
          toolCallId: tc.id,
          toolArgs: runtimeToolPayloadOrUndefined(tc.function?.arguments),
          reasoning: msg.reasoning?.trim() ? msg.reasoning : undefined,
          toolStatus: 'done',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
      }
      continue
    }

    // Tool result messages. MoA display rows are persisted with role "moa"
    // so they can render as tool lines without becoming model-context tool results.
    if (msg.role === 'tool' || isPersistedMoaToolDisplay(msg)) {
      const tcId = msg.tool_call_id || ''
      const toolName = msg.tool_name || toolNameMap.get(tcId) || undefined
      const toolArgs = toolArgsMap.has(tcId) ? toolArgsMap.get(tcId) : undefined
      const toolReasoning = toolReasoningMap.get(tcId)
      const moaPayload = parsePersistedMoaToolPayload(toolName, (msg as any).content)
      const backgroundDelegate = isBackgroundDelegateToolPayload(toolName, (msg as any).content)
      const delegatePayload = toolName === 'delegate_task'
        ? runtimeObjectPayload(msg.display_content) || runtimeObjectPayload((msg as any).content)
        : null
      // Extract a short preview from the content
      let preview = moaPayload?.preview || ''
      const contentText = runtimePayloadText((msg as any).content)
      if (!preview && contentText) {
        try {
          const parsed = typeof (msg as any).content === 'string'
            ? JSON.parse(contentText)
            : (msg as any).content
          preview = parsed?.url || parsed?.title || parsed?.preview || parsed?.summary || ''
        } catch {
          preview = contentText.slice(0, 80)
        }
      }
      // Find and remove the matching placeholder from tool_calls above
      const placeholderIdx = result.findIndex(
        m => m.role === 'tool' && m.toolName === toolName && !m.toolResult && m.id.includes('_' + tcId)
      )
      if (placeholderIdx !== -1) {
        result.splice(placeholderIdx, 1)
      }
      if (delegatePayload?.runtime === 'ekko') {
        const subagentId = String(delegatePayload.subagent_id || '').trim()
        if (!subagentId) continue
        const delegateArgs = runtimeObjectPayload(toolArgs)
        const status = subagentStatus(delegatePayload.status)
        const taskIndex = Number(delegatePayload.task_index ?? 0)
        const taskCount = Math.max(1, Number(delegatePayload.task_count ?? 1) || 1)
        const goal = String(delegatePayload.goal || delegateArgs?.goal || '').trim()
        const summary = String(delegatePayload.summary || delegatePayload.output || '').trim()
        const label = `${Number.isFinite(taskIndex) ? taskIndex + 1 : 1}/${taskCount}`
        const durationMs = Number(delegatePayload.duration_ms)
        const restoredPayload = {
          ...delegatePayload,
          goal,
          duration_seconds: delegatePayload.duration_seconds
            ?? (Number.isFinite(durationMs) ? durationMs / 1000 : undefined),
        }
        result.push({
          id: String(msg.id),
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: 'delegate_task',
          toolCallId: `subagent:${subagentId}`,
          toolArgs,
          toolPreview: `${label}${summary ? ` · ${summary}` : goal ? ` · ${goal}` : ''}`.slice(0, 220),
          toolResult: restoredPayload,
          reasoning: toolReasoning,
          toolStatus: status === 'running' ? 'running' : status === 'completed' ? 'done' : 'error',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
        continue
      }
      if (delegatePayload?.runtime === 'hermes') {
        const persistedTasks = Array.isArray(delegatePayload.tasks)
          ? delegatePayload.tasks.filter(task => task && typeof task === 'object') as Array<Record<string, unknown>>
          : [delegatePayload]
        const restorableTasks = persistedTasks.filter(task => String(task.subagent_id || '').trim())
        if (restorableTasks.length > 0) {
          for (const [index, task] of restorableTasks.entries()) {
            const subagentId = String(task.subagent_id || '').trim()
            const status = subagentStatus(task.status)
            const taskIndex = Number(task.task_index ?? index)
            const taskCount = Math.max(1, Number(task.task_count ?? restorableTasks.length) || 1)
            const goal = String(task.goal || '').trim()
            const summary = String(task.summary || task.output || '').trim()
            const label = `${Number.isFinite(taskIndex) ? taskIndex + 1 : index + 1}/${taskCount}`
            result.push({
              id: `${String(msg.id)}:background:${Number.isFinite(taskIndex) ? taskIndex : index}`,
              role: 'tool',
              content: '',
              timestamp: Math.round(msg.timestamp * 1000),
              toolName: 'delegate_task',
              toolCallId: `subagent:${subagentId}`,
              toolArgs,
              toolPreview: `${label}${summary ? ` · ${summary}` : goal ? ` · ${goal}` : ''}`.slice(0, 220),
              toolResult: task,
              reasoning: toolReasoning,
              toolStatus: status === 'running' ? 'running' : status === 'completed' ? 'done' : 'error',
              finishReason: readFinishReason(msg),
              runMarker: readRunMarker(msg),
            })
          }
          continue
        }
      }
      if (backgroundDelegate && delegatePayload) {
        const baseId = tcId || String(msg.id)
        for (const task of backgroundDelegateTaskDescriptors(delegatePayload, toolArgs)) {
          const label = `${task.taskIndex + 1}/${task.taskCount}`
          result.push({
            id: `${String(msg.id)}:background:${task.taskIndex}`,
            role: 'tool',
            content: '',
            timestamp: Math.round(msg.timestamp * 1000),
            toolName: 'delegate_task',
            toolCallId: backgroundDelegateAnchorCallId(baseId, task.taskIndex),
            toolArgs,
            toolPreview: `${label}${task.goal ? ` · ${task.goal}` : ''}`.slice(0, 220),
            toolResult: {
              ...delegatePayload,
              runtime: 'hermes',
              task_index: task.taskIndex,
              task_count: task.taskCount,
              goal: task.goal,
            },
            reasoning: toolReasoning,
            toolStatus: 'done',
            finishReason: readFinishReason(msg),
            runMarker: readRunMarker(msg),
          })
        }
        continue
      }
      result.push({
        id: String(msg.id),
        role: 'tool',
        content: '',
        timestamp: Math.round(msg.timestamp * 1000),
        toolName,
        toolCallId: tcId || undefined,
        toolArgs,
        toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
        toolResult: moaPayload ? runtimeToolPayloadOrUndefined(moaPayload.result) : runtimeToolPayloadOrUndefined((msg as any).content),
        reasoning: toolReasoning,
        toolStatus: readFinishReason(msg) === 'error' ? 'error' : 'done',
        finishReason: readFinishReason(msg),
        runMarker: readRunMarker(msg),
      })
      continue
    }

    // Normal user/assistant/command messages
    const displayRole = msg.display_role || msg.role
    const displayContent = msg.display_content ?? msg.content
    result.push({
      id: String(msg.id),
      role: displayRole === 'moa' ? 'system' : displayRole,
      content: displayContent || '',
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
      systemType: displayRole === 'command' ? 'command' : undefined,
      finishReason: readFinishReason(msg),
      runMarker: readRunMarker(msg),
    })
  }
  return result
}

export function sessionActivitySeconds(s: SessionSummary): number {
  return Math.max(
    s.started_at || 0,
    s.ended_at || 0,
    s.last_active || 0,
  )
}

function lastVisibleMessage(messages?: Message[] | null): Message | null {
  if (!messages?.length) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!String(message.content || '').trim()) continue
    return message
  }
  return null
}

export function lastVisibleMessageContent(messages?: Message[] | null): string | null {
  const message = lastVisibleMessage(messages)
  if (!message) return null
  const content = String(message.content || '').replace(/\s+/g, ' ').trim()
  return content.length > 280 ? `${content.slice(0, 277)}...` : content
}

export function lastVisibleMessageRole(messages?: Message[] | null): string | null {
  return lastVisibleMessage(messages)?.role || null
}

export function mapHermesSession(s: SessionSummary): Session {
  const codingAgentId = agentToCodingAgentId(s.agent)
  const isCodingAgentSession = s.source === 'coding_agent' || Boolean(codingAgentId)
  const codingAgentMode = isCodingAgentSession
    ? (s.agent_mode === 'global' || s.agent_mode === 'scoped'
        ? s.agent_mode
        : s.provider === 'global' ? 'global' : 'scoped')
    : undefined
  const activitySeconds = sessionActivitySeconds(s)
  return {
    id: s.id,
    profile: s.profile || 'default',
    title: s.title || '',
    source: s.source || undefined,
    agent: s.agent || undefined,
    agentSessionId: s.agent_session_id || undefined,
    agentNativeSessionId: s.agent_native_session_id || undefined,
    codingAgentId,
    codingAgentMode,
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round(activitySeconds * 1000),
    model: s.model,
    provider: s.provider || (s as any).billing_provider || '',
    apiMode: s.api_mode,
    reasoningEffort: s.reasoning_effort || undefined,
    messageCount: s.message_count,
    messageTotal: s.message_count,
    loadedMessageCount: 0,
    hasMoreBefore: false,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    parentSessionId: s.parent_session_id || null,
    forkPointMessageId: (s as any).fork_point_message_id != null ? String((s as any).fork_point_message_id) : null,
    parentTitle: s.parent_title || null,
    parentLastMessage: s.parent_last_message || null,
    parentLastMessageRole: s.parent_last_message_role || null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    isArchived: Boolean(s.is_archived),
    workspace: s.workspace || null,
    categoryId: s.category_id ?? null,
  }
}

const STORAGE_KEY_PREFIX = 'hermes_active_session_'
export type ChatRuntimeMode = 'default' | 'global_agent'
export let activeRuntimeMode: ChatRuntimeMode = 'default'
export function setActiveRuntimeMode(mode: ChatRuntimeMode): void {
  activeRuntimeMode = mode
}
export const LEGACY_STORAGE_KEY = 'hermes_active_session'
export const SESSION_PROFILE_FILTER_STORAGE_KEY = 'hermes_session_profile_filter_v1'

// 获取当前 profile 名称，用于隔离缓存。
// 从 profiles store 的 activeProfileName（同步 localStorage）读取，
// 避免异步加载导致 chat store 初始化时拿到 null。
function getProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    return 'default'
  }
}

function runtimeStoragePrefix(): string {
  return activeRuntimeMode === 'global_agent' ? `${STORAGE_KEY_PREFIX}global_agent_` : STORAGE_KEY_PREFIX
}

export function storageKey(): string { return runtimeStoragePrefix() + getProfileName() }
export function legacyStorageKey(): string | null { return activeRuntimeMode === 'default' && getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }

export function isCodingAgentLikeSession(session?: Pick<Session, 'source' | 'agent' | 'codingAgentId'> | null): boolean {
  return session?.source === 'coding_agent' ||
    Boolean(session?.codingAgentId) ||
    Boolean(agentToCodingAgentId(session?.agent))
}

export function clearCodingAgentRuntimeCredentials(session?: Session | null) {
  if (!session || !isCodingAgentLikeSession(session)) return
  session.baseUrl = undefined
  session.apiKey = undefined
}

export function shouldPreserveRuntimeApiMode(session?: Session | null): boolean {
  return isCodingAgentLikeSession(session) && session?.codingAgentMode !== 'global'
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

function recoverStorageQuota() {
  try {
    // 清理所有会话相关的旧缓存（已完全废弃）
    const prefixes = [
      'hermes_sessions_cache_v1_',
      'hermes_session_msgs_v1_',
      'hermes_session_pins_v1_',
      'hermes_human_only_v1_',
    ]
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === storageKey() || key === LEGACY_STORAGE_KEY) continue
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
    if (keysToRemove.length > 0) {
      console.log(`Recovered storage: cleared ${keysToRemove.length} old session cache entries`)
    }
  } catch {
    // ignore
  }
}

export function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }

  recoverStorageQuota()

  try {
    localStorage.setItem(key, value)
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

export function getItemBestEffort(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// Strip the circular `file: File` reference from attachments before caching —
// File objects don't serialize and we only need name/type/size/url for display.


