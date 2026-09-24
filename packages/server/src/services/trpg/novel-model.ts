import type { WritingModel } from '../../../../shared/trpg-writing'
import { randomUUID } from 'node:crypto'
import { looksLikeStandaloneAgentFailure } from '../meeting-asr/agent-bridge'
import { tokens } from './novel-material'

export type NovelModel = (instructions: string, input: unknown, signal: AbortSignal, route?: WritingModel, image?: string, onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void, onOutput?: (text: string) => void) => Promise<string>
/** Fresh bounded context per stage, using the existing profile runtime and credentials. */
export function novelModel(profile: string): NovelModel {
  return async (instructions, input, signal, route, image, onUsage, onOutput) => {
    signal.throwIfAborted()
    const message = JSON.stringify(input)
    if (tokens(message) + tokens(instructions) > 28000) throw new Error('novel_context_budget')
    const { AgentBridgeClient } = await import('../hermes/agent-bridge/client')
    const bridge = new AgentBridgeClient({ connectRetryMs: 1500 })
    const sessionId = `trpg-novel-${randomUUID()}`
    const stop = () => { void bridge.destroy(sessionId, profile).catch(() => {}) }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; stop() }, 240000)
    signal.addEventListener('abort', stop, { once: true })
    try {
      const started = await bridge.chat(sessionId, image ? [{ type: 'text', text: message }, { type: 'image_url', image_url: { url: image } }] : message, [], instructions, profile, { ...route, source: 'trpg-novel', wait: false, timeout: 240, background_delegation_enabled: false })
      signal.throwIfAborted()
      let text = '', done = false
      for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 240000 })) {
        signal.throwIfAborted()
        if (timedOut || chunk.status === 'error' || chunk.status === 'interrupted') throw new Error('novel_model_failed')
        if (chunk.delta) { text += chunk.delta; if (/^(?:\s*\{|\s*```json)/.test(text)) onOutput?.(text) }
        if (chunk.done) {
          const usage = (chunk.result ?? chunk) as { input_tokens?: number; output_tokens?: number }
          if (Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens) && usage.input_tokens! >= 0 && usage.output_tokens! >= 0) onUsage?.({ inputTokens: usage.input_tokens!, outputTokens: usage.output_tokens! })
          text = (chunk.result as { final_response?: string } | undefined)?.final_response || chunk.output || text
          onOutput?.(text)
          done = true
          break
        }
      }
      if (timedOut || !done || !text.trim() || looksLikeStandaloneAgentFailure(text)) throw new Error('novel_model_failed')
      return text
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      await bridge.destroy(sessionId, profile).catch(() => {})
    }
  }
}
