import type { CanonicalResponsesEvent } from './responses-stream'

/**
 * A structural view of one DeepSeek Harness `session.event` envelope. The wire
 * type lives in `@deepseek-ai/dsh-session`; Hermes keeps a loose structural
 * contract here so it does not depend on the harness package directly.
 */
export interface DshSessionEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: Record<string, unknown>
}

/**
 * Per-turn accumulation state shared between the run manager and this mapper.
 * It reuses the canonical OpenAI Responses output vocabulary so the emitted
 * events flow through the same persistence and socket pipeline as Claude Code.
 */
export interface DshTurnAccumulator {
  /** Whether the assistant text message item has been opened. */
  textStarted: boolean
  /** Assembled visible text for the completed response output. */
  text: string
  /** Stable message id for the assistant text item. */
  messageId: string
  /** Stable response id for this turn. */
  responseId: string
  /** Tool-call blocks keyed by their assigned output index. */
  toolBlocks: Map<number, { id: string; name: string; arguments: string; done: boolean }>
  /** Monotonic output-index counter for tool calls. */
  nextToolIndex: number
  /** callId -> output index, for correlating tool results to their call. */
  toolOutputIndex: Map<string, number>
  /** Token usage reported by the model, mapped to the Responses usage shape. */
  pendingUsage?: Record<string, unknown>
  /** Error message recorded from a terminal `turn/end` with an error reason. */
  pendingError?: string
}

/** Create a fresh accumulator for one submitted prompt. */
export function createDshTurnAccumulator(responseId: string): DshTurnAccumulator {
  return {
    textStarted: false,
    text: '',
    messageId: `msg_${responseId}`,
    responseId,
    toolBlocks: new Map(),
    nextToolIndex: 0,
    toolOutputIndex: new Map(),
  }
}

/** Map a DeepSeek Harness `TokenUsage` into the OpenAI Responses usage shape. */
function dshUsageToResponsesUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const input = Number(record.inputTokens ?? 0) || 0
  const output = Number(record.outputTokens ?? 0) || 0
  const cacheRead = Number(record.cacheReadTokens ?? 0) || 0
  const cacheWrite = Number(record.cacheWriteTokens ?? 0) || 0
  const reasoning = Number(record.reasoningTokens ?? 0) || 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    ...(cacheRead || cacheWrite ? { input_tokens_details: { cached_tokens: cacheRead + cacheWrite } } : {}),
    ...(reasoning ? { output_tokens_details: { reasoning_tokens: reasoning } } : {}),
  }
}

/** Flatten a tool-result message's text blocks into one display string. */
function toolResultText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as Record<string, unknown>
  const content = Array.isArray(record.content) ? record.content as unknown[] : []
  const first = content[0]
  if (!first || typeof first !== 'object') return ''
  const block = first as Record<string, unknown>
  const parts = Array.isArray(block.content) ? block.content as unknown[] : []
  return parts
    .map((part) => (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
      ? (part as Record<string, unknown>).text as string
      : ''))
    .filter(Boolean)
    .join('\n')
}

/** Emit the assistant text item's opening events once per turn. */
function ensureText(state: DshTurnAccumulator, events: CanonicalResponsesEvent[]): void {
  if (state.textStarted) return
  state.textStarted = true
  const item = { type: 'message', id: state.messageId, status: 'in_progress', role: 'assistant', content: [] }
  events.push({
    type: 'response.output_item.added',
    data: { type: 'response.output_item.added', output_index: 0, item },
  })
  events.push({
    type: 'response.content_part.added',
    data: {
      type: 'response.content_part.added',
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  })
}

function handleChunk(state: DshTurnAccumulator, chunk: unknown, events: CanonicalResponsesEvent[]): void {
  if (!chunk || typeof chunk !== 'object') return
  const record = chunk as Record<string, unknown>
  const type = record.type
  if (type === 'text-delta' && typeof record.text === 'string' && record.text) {
    ensureText(state, events)
    state.text += record.text
    events.push({
      type: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        item_id: state.messageId,
        output_index: 0,
        content_index: 0,
        delta: record.text,
      },
    })
    return
  }
  if (type === 'reasoning-delta' && typeof record.text === 'string' && record.text) {
    events.push({
      type: 'response.reasoning.delta',
      data: {
        type: 'response.reasoning.delta',
        item_id: state.messageId,
        output_index: 0,
        delta: record.text,
      },
    })
    return
  }
  if (type === 'usage') {
    state.pendingUsage = dshUsageToResponsesUsage(record.usage)
  }
}

function handleToolCall(state: DshTurnAccumulator, data: Record<string, unknown>, events: CanonicalResponsesEvent[]): void {
  const callId = typeof data.callId === 'string' ? data.callId : `call_${state.nextToolIndex}`
  const name = typeof data.name === 'string' && data.name ? data.name : 'tool'
  const argumentsValue = typeof data.arguments === 'string' ? data.arguments : '{}'
  const index = state.nextToolIndex
  state.nextToolIndex += 1
  const block = { id: callId, name, arguments: argumentsValue, done: true }
  state.toolBlocks.set(index, block)
  state.toolOutputIndex.set(callId, index)
  events.push({
    type: 'response.output_item.added',
    data: {
      type: 'response.output_item.added',
      output_index: index,
      item: { type: 'function_call', id: callId, call_id: callId, name, arguments: argumentsValue },
    },
  })
  events.push({
    type: 'response.output_item.done',
    data: {
      type: 'response.output_item.done',
      output_index: index,
      item: { type: 'function_call', id: callId, call_id: callId, name, arguments: argumentsValue },
    },
  })
}

/** Extract the correlated call id from a tool-result message's first block. */
function toolResultCallId(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as Record<string, unknown>).content
  const first = Array.isArray(content) ? content[0] : undefined
  if (!first || typeof first !== 'object') return ''
  const callId = (first as Record<string, unknown>).toolCallId
  return typeof callId === 'string' ? callId : ''
}

function handleToolResult(state: DshTurnAccumulator, data: Record<string, unknown>, events: CanonicalResponsesEvent[]): void {
  const callId = toolResultCallId(data.message)
  const index = callId && state.toolOutputIndex.has(callId) ? state.toolOutputIndex.get(callId)! : state.nextToolIndex
  if (!callId) state.nextToolIndex += 1
  const output = toolResultText(data.message)
  events.push({
    type: 'response.output_item.done',
    data: {
      type: 'response.output_item.done',
      output_index: index,
      item: { type: 'function_call_output', id: callId, call_id: callId, output },
    },
  })
}

/**
 * Map one DeepSeek Harness session event into zero or more canonical Responses
 * events, mutating the accumulator. `turn/end` only records terminal error and
 * usage; the run manager closes the response on whole-agent idle.
 */
export function dshSessionEventToResponsesEvents(
  state: DshTurnAccumulator,
  event: DshSessionEvent,
): CanonicalResponsesEvent[] {
  const events: CanonicalResponsesEvent[] = []
  const type = typeof event.type === 'string' ? event.type : ''
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  if (type === 'assistant/chunk') {
    handleChunk(state, data.chunk, events)
  } else if (type === 'assistant/message') {
    if (!state.pendingUsage) state.pendingUsage = dshUsageToResponsesUsage(data.usage)
  } else if (type === 'tool/call') {
    handleToolCall(state, data, events)
  } else if (type === 'tool/result') {
    handleToolResult(state, data, events)
  } else if (type === 'turn/end') {
    const reason = data.reason
    if (reason && typeof reason === 'object' && (reason as Record<string, unknown>).kind === 'error') {
      const error = (reason as Record<string, unknown>).error
      const message = error && typeof error === 'object'
        ? ((error as Record<string, unknown>).message as string | undefined)
        : undefined
      state.pendingError = typeof message === 'string' && message ? message : 'DeepSeek Harness turn failed'
    }
  }
  return events
}
