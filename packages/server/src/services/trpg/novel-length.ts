/** Count manuscript characters consistently; layout whitespace is not prose. */
export function countNovelChars(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length
}

export interface ChapterLengthWeight {
  weights: number[]
  targetChars?: number
}

/** Largest-remainder allocation preserves the total without per-scene floor inflation. */
function apportion(total: number, weights: number[]): number[] {
  if (!weights.length) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(sum) || sum <= 0) throw new Error('novel_length_budget_invalid')
  const exact = weights.map(weight => total * weight / sum)
  const result = exact.map(Math.floor)
  const order = exact.map((value, index) => ({ index, remainder: value - result[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  const remaining = total - result.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remaining; i++) result[order[i]!.index]!++
  return result
}

/** Chapter requests affect proportions, but can never override the whole-book budget. */
export function allocateNovelTargets(totalTarget: number, chapters: ChapterLengthWeight[]): number[][] {
  if (!Number.isSafeInteger(totalTarget) || totalTarget <= 0) throw new Error('novel_length_budget_invalid')
  if (!chapters.length || chapters.some(chapter => !chapter.weights.length
    || chapter.weights.some(weight => !Number.isFinite(weight) || weight <= 0)
    || (chapter.targetChars !== undefined && (!Number.isFinite(chapter.targetChars) || chapter.targetChars <= 0)))) {
    throw new Error('novel_length_budget_invalid')
  }
  const chapterSourceWeights = chapters.map(chapter => chapter.weights.reduce((a, b) => a + b, 0))
  const sourceTotal = chapterSourceWeights.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(sourceTotal)) throw new Error('novel_length_budget_invalid')
  const chapterWeights = chapters.map((chapter, index) => chapter.targetChars ?? totalTarget * chapterSourceWeights[index]! / sourceTotal)
  const chapterTargets = apportion(totalTarget, chapterWeights)
  const targets = chapters.map((chapter, index) => apportion(chapterTargets[index]!, chapter.weights))
  // The draft contract accepts at most 7,000 characters. Surface infeasible scene
  // budgets so the caller can split a scene; silently clipping would lose the total.
  if (targets.some(chapter => chapter.some(target => target < 1 || target > 7000))) {
    throw new Error('novel_length_budget_impossible')
  }
  return targets
}

export function assessLength(actual: number, target: number) {
  if (!Number.isSafeInteger(actual) || actual < 0 || !Number.isSafeInteger(target) || target <= 0) {
    throw new Error('novel_length_budget_invalid')
  }
  // Integer arithmetic avoids floating-point boundary errors (e.g. 100 * 1.1).
  const min = Math.ceil(target * 9 / 10), max = Math.floor(target * 11 / 10)
  const status = actual < min ? 'under' : actual > max ? 'over' : 'within'
  const detail = status === 'within' ? ''
    : `正文共 ${actual} 字，目标 ${target} 字，允许范围 ${min}–${max} 字（±10%）；${status === 'under' ? '请扩写已有事实的叙述与描写，不得增加无证据剧情' : '请压缩重复叙述与描写，保留全部必需事实'}。`
  return { status, min, max, actual, target, detail }
}
