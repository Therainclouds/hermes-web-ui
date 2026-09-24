import { tokens, invalid, type ChapterPlan } from './novel-material'
/** Planning is an index over canon, never the writer's replacement for canon evidence. */
export async function boundedPlan(items: unknown[], context: Record<string, unknown>, call: (input: Record<string, unknown>, part?: string) => Promise<ChapterPlan>, budget = 16000): Promise<ChapterPlan> {
  let current = items
  for (let depth = 0; depth < 12; depth++) {
    if (tokens({ ...context, scenes: current }) <= budget) return call({ ...context, scenes: current })
    const batches: unknown[][] = []; let batch: unknown[] = []
    const overhead = tokens({ ...context, scenes: [] }) + 64
    let size = overhead
    const flush = (items: unknown[]) => {
      if (tokens({ ...context, scenes: items }) <= budget) { batches.push(items); return }
      if (items.length === 1) invalid('planning item exceeds context budget')
      const middle = Math.floor(items.length / 2)
      flush(items.slice(0, middle)); flush(items.slice(middle))
    }
    for (const item of current) {
      const cost = tokens(item) + 8
      if (batch.length && size + cost > budget) { flush(batch); batch = []; size = overhead }
      batch.push(item); size += cost
    }
    if (batch.length) flush(batch)
    const next: ChapterPlan[] = []
    for (const [part, scenes] of batches.entries()) next.push(await call({ ...context, scenes }, `${depth}-${part}`))
    if (tokens(next) >= tokens(current)) invalid('planning summaries did not reduce context')
    current = next
  }
  invalid('planning reduction depth exceeded')
}
