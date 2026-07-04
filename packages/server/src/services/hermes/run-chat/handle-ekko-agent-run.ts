import type { Server, Socket } from 'socket.io'
import { inspect } from 'util'
import {
  AgentRuntime,
  createModelClient,
  type AgentMessage,
  type AgentToolCall,
  type ModelClient,
  type ModelEvent,
  type AgentRuntimeEvent,
  type ModelProviderConfig,
  type ModelProviderType,
  type ModelRequest,
  type ModelResponse,
  type ModelRequestStyle,
} from '../../../../../ekko-agent/src'
import { createSession, addMessage, getSession, updateSessionStats } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import { getProfileDir } from '../hermes-profile'
import { observeRunChatPetEvent } from '../pet-state-socket'
import { contentBlocksToString, extractTextForPreview } from './content-blocks'
import { getOrCreateSession } from './compression'
import { resolveBridgeRunModelConfig, type RunModelGroup } from './model-config'
import { estimateUsageTokensFromMessages } from './usage'
import type { ChatCodingAgentId, ContentBlock, SessionState } from './types'

export interface EkkoAgentRunSocketData {
  input: string | ContentBlock[]
  display_input?: string | ContentBlock[] | null
  display_role?: 'user' | 'command'
  storage_message?: string
  session_id?: string
  profile?: string
  provider?: string
  model?: string
  model_groups?: RunModelGroup[]
  coding_agent_id?: ChatCodingAgentId
  agent_id?: ChatCodingAgentId
  mode?: 'scoped' | 'global'
  workspace?: string | null
  source?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: string
  api_mode?: string
  peerExcludeSocketId?: string
  queue_id?: string
  onEvent?: (event: string, payload: any) => void
}

function isEkkoAgentId(data: EkkoAgentRunSocketData): boolean {
  return data.coding_agent_id === 'ekko-agent' || data.agent_id === 'ekko-agent'
}

function requestStyleForConfig(provider: string, baseUrl: string, apiMode?: string): ModelRequestStyle {
  const key = provider.toLowerCase()
  const url = baseUrl.toLowerCase()
  if (apiMode === 'codex_responses') return 'openai-responses'
  if (apiMode === 'anthropic_messages') return 'anthropic-messages'
  if (key.includes('gemini') || key.includes('google') || url.includes('generativelanguage.googleapis.com')) return 'gemini-contents'
  return 'openai-chat'
}

function providerTypeForStyle(provider: string, style: ModelRequestStyle): ModelProviderType {
  const key = provider.toLowerCase()
  if (style === 'anthropic-messages') return 'anthropic'
  if (style === 'gemini-contents') return 'gemini'
  if (key.includes('ollama')) return 'ollama'
  if (key === 'openai') return 'openai'
  return 'openai-compatible'
}

function toAgentMessages(messages: SessionState['messages']): AgentMessage[] {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'command')
    .map((message): AgentMessage => {
      const role: AgentMessage['role'] = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
      return {
        role,
        content: contentBlocksToString(message.content as any),
      }
    })
    .filter(message => message.content.trim().length > 0)
}

function appendStateEvent(state: SessionState, event: string, payload: any): void {
  if (!state.isWorking) return
  state.events.push({ event, data: payload })
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200)
}

function redactProviderConfig(config: ModelProviderConfig): ModelProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey ? '[redacted]' : undefined,
    headers: config.headers
      ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [
          key,
          /authorization|api[-_]?key|token/i.test(key) ? '[redacted]' : value,
        ]))
      : undefined,
  }
}

function consolePayload(value: unknown): string {
  return inspect(value, {
    depth: null,
    colors: false,
    maxArrayLength: null,
    maxStringLength: null,
    breakLength: 120,
    compact: false,
  })
}

function errorPayload(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  const withDetails = err as Error & {
    provider?: string
    statusCode?: number
    retryable?: boolean
    details?: unknown
  }
  return {
    name: err.name,
    message: err.message,
    provider: withDetails.provider,
    statusCode: withDetails.statusCode,
    retryable: withDetails.retryable,
    details: withDetails.details,
    stack: err.stack,
  }
}

function shouldUsePlainChatRequest(config: ModelProviderConfig): boolean {
  const provider = String(config.id || '').toLowerCase()
  const baseUrl = String(config.baseUrl || '').toLowerCase()
  return provider.includes('glm') || baseUrl.includes('bigmodel.cn')
}

function requestForProvider(request: ModelRequest, config: ModelProviderConfig): ModelRequest {
  if (!shouldUsePlainChatRequest(config)) return request
  return {
    ...request,
    metadata: undefined,
  }
}

function toStoredToolCall(toolCall: AgentToolCall) {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.rawArguments || JSON.stringify(toolCall.arguments || {}),
    },
  }
}

function createConsoleModelClient(client: ModelClient, context: { sessionId: string; providerConfig: ModelProviderConfig }): ModelClient {
  return {
    ...client,
    provider: client.provider,
    requestStyle: client.requestStyle,
    capabilities: client.capabilities,
    async create(request: ModelRequest): Promise<ModelResponse> {
      const providerRequest = requestForProvider(request, context.providerConfig)
      console.log('[ekko-agent] model request', consolePayload({
        session_id: context.sessionId,
        provider_config: redactProviderConfig(context.providerConfig),
        request: providerRequest,
      }))
      try {
        const response = await client.create(providerRequest)
        console.log('[ekko-agent] model request success', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
          response,
        }))
        return response
      } catch (err) {
        console.error('[ekko-agent] model request failed', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
          error: errorPayload(err),
        }))
        throw err
      }
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const providerRequest = requestForProvider(request, context.providerConfig)
      console.log('[ekko-agent] model stream request', consolePayload({
        session_id: context.sessionId,
        provider_config: redactProviderConfig(context.providerConfig),
        request: providerRequest,
      }))
      try {
        for await (const event of client.stream(providerRequest)) {
          yield event
        }
        console.log('[ekko-agent] model stream success', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
        }))
      } catch (err) {
        console.error('[ekko-agent] model stream failed', consolePayload({
          session_id: context.sessionId,
          provider: client.provider,
          request_style: client.requestStyle,
          error: errorPayload(err),
        }))
        throw err
      }
    },
  }
}

export async function handleEkkoAgentRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: EkkoAgentRunSocketData,
  profile: string,
  sessionMap: Map<string, SessionState>,
  dequeueNextQueuedRun: (socket: Socket, sessionId: string, fallbackProfile?: string) => boolean,
  skipUserMessage = false,
) {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for ekko-agent runs' })
    return
  }
  if (!isEkkoAgentId(data)) {
    socket.emit('run.failed', { event: 'run.failed', session_id: sessionId, error: 'ekko-agent run requires coding_agent_id=ekko-agent' })
    return
  }

  socket.join(`session:${sessionId}`)
  const state = getOrCreateSession(sessionMap, sessionId)
  state.isWorking = true
  state.isAborting = false
  state.profile = profile
  state.source = data.source === 'workflow' ? 'workflow' : 'coding_agent'
  state.events = []

  const storedSession = getSession(sessionId)
  const modelConfig = await resolveBridgeRunModelConfig({
    profile,
    sessionModel: storedSession?.model,
    sessionProvider: storedSession?.provider,
    requestedModel: data.model,
    requestedProvider: data.provider,
    modelGroups: data.model_groups,
    preferRequested: true,
  })
  const workspace = data.workspace || storedSession?.workspace || getProfileDir(profile)
  const displayInput = data.display_input === undefined ? data.input : data.display_input
  const inputText = contentBlocksToString(data.input)
  const displayText = displayInput == null ? '' : contentBlocksToString(displayInput)
  const storageText = data.storage_message !== undefined ? data.storage_message : displayText
  const shouldPersistUserMessage = !skipUserMessage && displayInput !== null
  const now = Math.floor(Date.now() / 1000)
  const emit = (event: string, payload: any) => {
    const tagged = { ...payload, session_id: sessionId }
    observeRunChatPetEvent(profile, event, tagged)
    data.onEvent?.(event, tagged)
    appendStateEvent(state, event, tagged)
    nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!data.onEvent && !nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  if (!storedSession) {
    const previewText = extractTextForPreview(displayInput === null ? data.input : displayInput || data.input)
    const title = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
    createSession({
      id: sessionId,
      profile,
      source: 'coding_agent',
      agent: 'ekko-agent',
      agent_mode: 'scoped',
      model: modelConfig.model,
      provider: modelConfig.provider,
      title,
      workspace,
    })
  }

  if (shouldPersistUserMessage) {
    const role = data.display_role === 'command' ? 'command' : 'user'
    const messageId = addMessage({
      session_id: sessionId,
      role,
      content: storageText,
      timestamp: now,
    })
    state.messages.push({
      id: data.queue_id || messageId || state.messages.length + 1,
      session_id: sessionId,
      role,
      content: storageText,
      timestamp: now,
    })
    const peerTarget = data.peerExcludeSocketId
      ? nsp.to(`session:${sessionId}`).except(data.peerExcludeSocketId)
      : socket.to(`session:${sessionId}`)
    peerTarget.emit('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id: sessionId,
      message: {
        id: data.queue_id || messageId,
        role,
        content: storageText,
        timestamp: now,
      },
    })
  }

  const baseUrl = data.baseUrl || data.base_url || ''
  const requestStyle = requestStyleForConfig(modelConfig.provider, baseUrl, data.apiMode || data.api_mode)
  const providerConfig: ModelProviderConfig = {
    id: modelConfig.provider || 'openai',
    type: providerTypeForStyle(modelConfig.provider, requestStyle),
    requestStyle,
    baseUrl: baseUrl || undefined,
    apiKey: data.apiKey || data.api_key || undefined,
    defaultModel: modelConfig.model,
    timeoutMs: 120_000,
  }
  const modelClient = createConsoleModelClient(createModelClient(providerConfig), {
    sessionId,
    providerConfig,
  })
  const runtime = new AgentRuntime({
    modelClient,
    toolContext: {
      cwd: workspace,
      workspaceRoot: workspace,
      timeoutMs: 120_000,
    },
    modelDefaults: {
      model: modelConfig.model,
    },
  })

  let assistantText = ''
  let runId = ''
  let usageInput = 0
  let usageOutput = 0
  const handleRuntimeEvent = (event: AgentRuntimeEvent) => {
    if ('runId' in event) runId = event.runId
    if (event.type === 'run.started') {
      state.runId = event.runId
      emit('run.started', {
        event: 'run.started',
        run_id: event.runId,
        model: modelConfig.model,
        provider: modelConfig.provider,
      })
    } else if (event.type === 'model.message') {
      const text = event.message.content || ''
      if (text && !event.message.toolCalls?.length) {
        assistantText = text
        emit('message.delta', {
          event: 'message.delta',
          run_id: event.runId,
          delta: text,
        })
      }
      if (event.message.usage) {
        usageInput += event.message.usage.inputTokens || 0
        usageOutput += event.message.usage.outputTokens || 0
      }
    } else if (event.type === 'tool.started') {
      emit('tool.started', {
        event: 'tool.started',
        run_id: event.runId,
        tool: event.toolName,
        name: event.toolName,
        preview: JSON.stringify(event.arguments || {}),
        tool_call_id: event.toolCallId,
      })
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      emit(event.type, {
        event: event.type,
        run_id: event.runId,
        tool: event.toolName,
        name: event.toolName,
        preview: event.result.content,
        tool_call_id: event.toolCallId,
        error: event.result.error,
      })
    }
  }

  try {
    logger.info('[chat-run-socket] starting ekko-agent run for session %s', sessionId)
    const result = await runtime.run({
      model: modelConfig.model,
      messages: toAgentMessages(state.messages),
      onEvent: handleRuntimeEvent,
      toolContext: {
        cwd: workspace,
        workspaceRoot: workspace,
        timeoutMs: 120_000,
      },
      metadata: {
        session_id: sessionId,
        profile,
      },
    })
    assistantText = result.output.content || assistantText
    const outputUsage = result.output.usage
    if (outputUsage && !usageInput && !usageOutput) {
      usageInput += outputUsage.inputTokens || 0
      usageOutput += outputUsage.outputTokens || 0
    }
    for (const step of result.steps) {
      if (step.type === 'model' && step.message.toolCalls?.length) {
        const toolCalls = step.message.toolCalls.map(toStoredToolCall)
        const timestamp = Math.floor(Date.now() / 1000)
        const assistantId = addMessage({
          session_id: sessionId,
          role: 'assistant',
          content: step.message.content || '',
          tool_calls: toolCalls,
          timestamp,
          finish_reason: 'tool_calls',
        })
        state.messages.push({
          id: assistantId || state.messages.length + 1,
          session_id: sessionId,
          role: 'assistant',
          content: step.message.content || '',
          tool_calls: toolCalls,
          timestamp,
          finish_reason: 'tool_calls',
        })
      } else if (step.type === 'tool') {
        const timestamp = Math.floor(Date.now() / 1000)
        const toolId = addMessage({
          session_id: sessionId,
          role: 'tool',
          content: step.result.content,
          tool_call_id: step.toolCallId,
          tool_name: step.toolName,
          timestamp,
        })
        state.messages.push({
          id: toolId || state.messages.length + 1,
          session_id: sessionId,
          role: 'tool',
          content: step.result.content,
          tool_call_id: step.toolCallId,
          tool_name: step.toolName,
          timestamp,
        })
      }
    }
    if (assistantText.trim()) {
      const assistantId = addMessage({
        session_id: sessionId,
        role: 'assistant',
        content: assistantText,
        timestamp: Math.floor(Date.now() / 1000),
        finish_reason: result.output.finishReason || null,
      })
      state.messages.push({
        id: assistantId || state.messages.length + 1,
        session_id: sessionId,
        role: 'assistant',
        content: assistantText,
        timestamp: Math.floor(Date.now() / 1000),
        finish_reason: result.output.finishReason || null,
      })
    }
    if (!usageInput && !usageOutput) {
      const usage = estimateUsageTokensFromMessages([
        { role: 'user', content: inputText },
        { role: 'assistant', content: assistantText },
      ])
      usageInput = usage.inputTokens
      usageOutput = usage.outputTokens
    }
    state.inputTokens = (state.inputTokens || 0) + usageInput
    state.outputTokens = (state.outputTokens || 0) + usageOutput
    updateSessionStats(sessionId)
    emit('usage.updated', {
      event: 'usage.updated',
      run_id: runId || result.runId,
      input_tokens: state.inputTokens || 0,
      output_tokens: state.outputTokens || 0,
      total_tokens: (state.inputTokens || 0) + (state.outputTokens || 0),
    })
    emit('run.completed', {
      event: 'run.completed',
      run_id: runId || result.runId,
      output: assistantText,
      usage: {
        input_tokens: usageInput,
        output_tokens: usageOutput,
        total_tokens: usageInput + usageOutput,
      },
      queue_remaining: state.queue.length,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn(err, '[chat-run-socket] ekko-agent run failed for session %s', sessionId)
    emit('run.failed', {
      event: 'run.failed',
      run_id: runId,
      error,
      queue_remaining: state.queue.length,
    })
  } finally {
    state.isWorking = false
    state.isAborting = false
    state.runId = undefined
    state.abortController = undefined
    state.activeRunMarker = undefined
    state.responseRun = undefined
    state.profile = undefined
    state.events = []
    if (state.queue.length > 0) {
      dequeueNextQueuedRun(socket, sessionId, profile)
    }
  }
}
