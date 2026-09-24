/** Canonical bounded agent loop used by the long-novel harness.
 *
 *  Every long-horizon agent needs the same five properties, and this is the single place the
 *  harness encodes them for tool-directed steps:
 *
 *  1. **Bounded autonomy** — a hard turn cap, so a model that keeps asking for more evidence
 *     cannot run forever (and cannot run up an unbounded bill).
 *  2. **Act → observe → reflect** — the model chooses a domain action, code executes it, and
 *     the *result* (or the concrete rejection reason) is fed back as an observation. Tool
 *     results are data, never instructions.
 *  3. **No-progress detection** — repeating an identical read, or re-submitting a patch that
 *     was just refused, is answered with a correction instead of being executed again.
 *  4. **Bounded working memory** — observations are truncated to a window, with an explicit
 *     marker, so loop context does not grow linearly with turns.
 *  5. **Deterministic termination** — the loop can only end by applying a code-validated
 *     change, by an explicit conflict report, or by exhausting its budget. There is no path
 *     where a model's prose alone ends the loop.
 */
export interface AgentObservation { tool: string; result: unknown }

export type AgentDecision<A, R> =
  | { type: 'finish'; value: R }
  | { type: 'apply'; tool: string; run: () => R; describe: string }
  | { type: 'observe'; tool: string; key: string; run: () => Promise<unknown> }
  | { type: 'conflict'; reason: string }

export interface AgentLoopResult<R> {
  result?: R
  conflict?: string
  action?: string
  outcome: 'applied' | 'conflict' | 'exhausted'
  rejected: string[]
  turns: number
  observations: AgentObservation[]
}

export interface AgentLoopOptions<A, R> {
  maxTurns: number
  decide: (context: { turn: number; observations: AgentObservation[]; rejected: string[] }) => Promise<A>
  classify: (action: A) => AgentDecision<A, R>
  /** Keep only the most recent observations handed back to the model. */
  maxObservations?: number
  onObservation?: (observation: AgentObservation) => Promise<void> | void
  /** Reason recorded when the turn budget runs out without a decision. */
  exhausted?: string
}

function bound(observations: AgentObservation[], max: number): AgentObservation[] {
  if (observations.length <= max) return observations
  const dropped = observations.length - max
  return [{ tool: 'context', result: { note: `已省略较早的 ${dropped} 条工具观察；需要可重新读取。` } }, ...observations.slice(-max)]
}

export function rejectionDetail(error: unknown): string {
  if ((error as Error)?.message !== 'novel_invalid_output') throw error
  return (error as { detail?: string }).detail ?? 'invalid patch; inspect the named paragraphs and repair the patch'
}

export async function boundedAgentLoop<A, R>(options: AgentLoopOptions<A, R>): Promise<AgentLoopResult<R>> {
  const maxObservations = options.maxObservations ?? 12
  const observations: AgentObservation[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (let turn = 0; turn < options.maxTurns; turn++) {
    const action = await options.decide({ turn, observations: bound(observations, maxObservations), rejected })
    const decision = options.classify(action)
    if (decision.type === 'conflict') return { conflict: decision.reason, outcome: 'conflict', rejected, turns: turn + 1, observations }
    if (decision.type === 'finish') return { result: decision.value, outcome: 'applied', rejected, turns: turn + 1, observations }
    if (decision.type === 'apply') {
      try {
        const value = decision.run()
        return { result: value, action: decision.describe, outcome: 'applied', rejected, turns: turn + 1, observations }
      } catch (error) {
        const detail = rejectionDetail(error)
        rejected.push(detail)
        const observation = { tool: decision.tool, result: { error: detail } }
        observations.push(observation)
        await options.onObservation?.(observation)
        continue
      }
    }
    if (seen.has(decision.key)) {
      const observation = { tool: decision.tool, result: { error: 'same read already provided; choose a change or report a conflict' } }
      observations.push(observation)
      await options.onObservation?.(observation)
      continue
    }
    seen.add(decision.key)
    const observation = { tool: decision.tool, result: await decision.run() }
    observations.push(observation)
    await options.onObservation?.(observation)
  }
  return { conflict: options.exhausted ?? '编辑工具调用未收敛', outcome: 'exhausted', rejected, turns: options.maxTurns, observations }
}
