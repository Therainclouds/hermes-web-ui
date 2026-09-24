/** Drain active work before failing: a stopped job must never have background writers. */
export async function boundedMap<T, R>(items: T[], concurrency: number, fn: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0, failed = false, failure: unknown
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++
      try { results[index] = await fn(items[index]!, index) }
      catch (error) { if (!failed) { failed = true; failure = error } }
    }
  }))
  if (failed) throw failure
  return results
}

/** Bounded look-ahead with a strictly ordered commit lane. Commit + active prepares never exceed the limit. */
export async function orderedPipeline<T, R>(items: T[], concurrency: number, prepare: (item: T, index: number) => Promise<R>, commit: (result: R, item: T, index: number) => Promise<void>) {
  type Outcome = { ok: true; value: R } | { ok: false; error: unknown }
  const pending = new Map<number, Promise<Outcome>>()
  let next = 0, failed = false
  const fill = () => {
    while (!failed && next < items.length && pending.size < concurrency) {
      const index = next++
      pending.set(index, Promise.resolve().then(() => prepare(items[index]!, index)).then(value => ({ ok: true, value }) as Outcome, error => { failed = true; return { ok: false, error } as Outcome }))
    }
  }
  fill()
  try {
    for (let index = 0; index < items.length; index++) {
      const result = await pending.get(index)!
      if (!result?.ok) throw result && !result.ok ? result.error : new Error('novel_pipeline_stopped')
      // Keep the occupied slot until commit completes; this provides backpressure.
      await commit(result.value, items[index]!, index)
      pending.delete(index); fill()
    }
  } finally { failed = true; await Promise.all(pending.values()) }
}
