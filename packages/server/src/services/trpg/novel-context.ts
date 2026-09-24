import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tokens } from './novel-material'
import { compactNovelEvidence } from './novel-economy'

/** Hard ceiling enforced by `novelModel`: a request above this is refused before it is sent. */
export const CONTEXT_LIMIT = 28000
/** Above this the context manager starts reducing before the call is made. */
export const CONTEXT_SOFT_LIMIT = 24000
/** The size compaction aims for; leaves room for the instruction block and JSON overhead. */
export const CONTEXT_TARGET = 20000
/** Rolling-memory text below this is not worth a summarisation call. */
export const MEMORY_MIN_SUMMARY_CHARS = 1500

const MARK = '…（上下文压缩：其余内容已省略）'

export interface CompactionNote {
  field: string
  mode: 'evidence' | 'split-paragraphs' | 'summarize' | 'truncate' | 'drop'
  before: number
  after: number
}

export interface CompactedContext { value: unknown; notes: CompactionNote[]; tokens: number }

/** Whole-field drop order: cheapest information first. `memory` and `previousOutput` are never
 *  dropped outright — losing carried facts silently is worse than refusing a request, so they
 *  are only truncated and, if that is not enough, the call still fails visibly. */
const DROP_ORDER = ['history', 'observations', 'reportRepair', 'suggestions', 'repairFeedback', 'precedingProse', 'priorContinuity']

/** String truncation order and floors: [field, first cap, floor]. Low-value tails shrink first,
 *  the rolling factual memory shrinks last. */
const STRING_POLICIES: [string, number, number][] = [
  ['previousOutput', 1600, 200],
  ['history', 900, 0],
  ['precedingProse', 600, 0],
  ['priorContinuity', 600, 0],
  ['memory', 2400, 400],
]

interface FieldMatch { count: number; chars: number }

function walk(value: unknown, visit: (key: string, child: unknown, replace: (next: unknown) => void) => void): unknown {
  if (Array.isArray(value)) {
    return value.map(item => walk(item, visit))
  }
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const mapped = walk(child, visit)
    let result = mapped
    visit(key, mapped, next => { result = next })
    out[key] = result
  }
  return out
}

function measure(value: unknown, field: string): FieldMatch {
  let count = 0, chars = 0
  walk(value, (key, child) => {
    if (key !== field) return
    if (typeof child === 'string') { count++; chars += child.length }
    else if (Array.isArray(child)) { count++; chars += JSON.stringify(child).length }
    else if (child && typeof child === 'object') { count++; chars += JSON.stringify(child).length }
  })
  return { count, chars }
}

function capField(value: unknown, field: string, cap: number): unknown {
  return walk(value, (key, child, replace) => {
    if (key !== field) return
    if (typeof child === 'string') {
      if (child.length > cap) replace(cap <= 0 ? '' : `${child.slice(0, cap)}${MARK}`)
      return
    }
    if (Array.isArray(child)) {
      const take = cap <= 0 ? 0 : Math.min(child.length, Math.max(1, cap))
      if (take < child.length) replace(child.slice(child.length - take))
    }
  })
}

function dropField(value: unknown, field: string): unknown {
  return walk(value, (key, child, replace) => {
    if (key !== field) return
    if (Array.isArray(child)) replace([])
    else if (child && typeof child === 'object') replace({ omitted: 'context budget' })
    else replace('')
  })
}

/** The audit request carried both the manuscript and a paragraph array that repeats it. Code
 *  resolves quotes from the real manuscript, so only the numbering is needed: dropping `text`
 *  keeps the paragraph indices the prompt asks the model to use and removes a full duplicate. */
function splitParagraphArrays(value: unknown): unknown {
  return walk(value, (key, child, replace) => {
    if (key !== 'manuscriptParagraphs' || !Array.isArray(child)) return
    replace(child.map(item => {
      if (item && typeof item === 'object' && Number.isInteger((item as { paragraph?: unknown }).paragraph)) {
        return { paragraph: (item as { paragraph: number }).paragraph }
      }
      return item
    }))
  })
}

function findField(value: unknown, field: string): unknown {
  let found: unknown
  walk(value, (key, child) => { if (key === field && found === undefined) found = child })
  return found
}

function replaceField(value: unknown, field: string, next: unknown): unknown {
  let done = false
  return walk(value, (key, child, replace) => {
    if (key !== field || done || child === undefined) return
    replace(next); done = true
  })
}

/** Deterministic compaction. Never removes source rows, the manuscript, canon evidence or the
 *  scene itself; it removes copies, numbering text and low-value context until the request
 *  fits. A request whose protected evidence alone exceeds the target is left for
 *  `assembleNovelContext` to refuse visibly. */
export function compactContext(input: unknown, target = CONTEXT_TARGET): CompactedContext {
  const notes: CompactionNote[] = []
  let value = compactNovelEvidence(input)
  const start = tokens(value)
  if (start <= target) return { value, notes, tokens: start }

  const quoteBefore = measure(input, 'quote')
  const evidenceSaved = quoteBefore.chars - measure(value, 'quote').chars
  if (evidenceSaved > 0) notes.push({ field: 'quote', mode: 'evidence', before: quoteBefore.chars, after: quoteBefore.chars - evidenceSaved })
  if (tokens(value) <= target) return { value, notes, tokens: tokens(value) }

  const paragraphBefore = JSON.stringify(findField(value, 'manuscriptParagraphs') ?? []).length
  value = splitParagraphArrays(value)
  const paragraphAfter = JSON.stringify(findField(value, 'manuscriptParagraphs') ?? []).length
  if (paragraphAfter < paragraphBefore) notes.push({ field: 'manuscriptParagraphs', mode: 'split-paragraphs', before: paragraphBefore, after: paragraphAfter })
  if (tokens(value) <= target) return { value, notes, tokens: tokens(value) }

  const caps = new Map(STRING_POLICIES.map(([field, cap]) => [field, cap]))
  for (let round = 0; round < 24 && tokens(value) > target; round++) {
    let changed = false
    for (const [field, , floor] of STRING_POLICIES) {
      const cap = caps.get(field)!
      if (cap <= floor) continue
      const before = measure(value, field)
      if (!before.count) continue
      value = capField(value, field, cap)
      caps.set(field, Math.max(floor, Math.floor(cap / 2)))
      changed = true
      const after = measure(value, field)
      if (after.chars < before.chars) notes.push({ field, mode: 'truncate', before: before.chars, after: after.chars })
      if (tokens(value) <= target) break
    }
    if (!changed) break
  }
  if (tokens(value) <= target) return { value, notes, tokens: tokens(value) }

  for (const field of DROP_ORDER) {
    const before = measure(value, field)
    if (!before.count) continue
    value = dropField(value, field)
    notes.push({ field, mode: 'drop', before: before.chars, after: 0 })
    if (tokens(value) <= target) break
  }
  return { value, notes, tokens: tokens(value) }
}

export const MEMORY_SUMMARY_INSTRUCTION = `压缩这份长篇小说流水线的滚动事实记忆。按块阅读并合并，输出纯文本，不输出 JSON，不解释过程。
必须保留：人物与 NPC 的姓名/别名、已确认结果与失败尝试、GM 更正、未解线索、未决动作、以及每一项后面的 [源句索引] 标记。
可以删除：重复表述、寒暄、规则复述、已经从同一索引合并过的重复条目。
不得新增输入中没有的任何人名、事件、结果或索引；不得把尝试写成成功。保持时间顺序，长度不超过 maxChars 个中文字符。`

/** Model-assisted memory compression, cached by exact source text and target so a resumed job
 *  and repeated calls reuse the same summary instead of paying for it again. */
async function summarizeMemory(dir: string, source: string, target: number, summarize: (memory: string, maxChars: number) => Promise<string>): Promise<string | undefined> {
  const key = createHash('sha256').update(`${target}\0${source}`).digest('hex')
  const path = join(dir, 'context', `memory-${key}.json`)
  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as { text?: string }
    if (typeof cached.text === 'string' && cached.text.trim()) return cached.text
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const text = (await summarize(source, target)).trim()
  if (!text) return undefined
  await mkdir(join(dir, 'context'), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify({ source: key, target, text, at: Date.now() }), { mode: 0o600 })
  await rename(tmp, path)
  return text
}

/** Budget-aware context assembly for one model call.
 *
 *  Order is deliberate: recoverable evidence first (free), then model summarization of the
 *  rolling memory (keeps facts that truncation would lose), then deterministic truncation of
 *  low-value context, then whole-field drops. Only when the protected evidence alone still
 *  exceeds the hard ceiling does this throw `novel_context_budget`, so an over-budget job stops
 *  visibly instead of silently dropping ASR. */
export async function assembleNovelContext(options: {
  dir: string
  input: unknown
  instruction: string
  summarize?: (memory: string, maxChars: number) => Promise<string>
}): Promise<{ input: unknown; notes: CompactionNote[]; reused: number; tokens: number; savedTokens: number }> {
  const instructionTokens = tokens(options.instruction)
  let value = compactNovelEvidence(options.input)
  const notes: CompactionNote[] = []
  let reused = 0
  const rawTotal = tokens(value) + instructionTokens
  if (rawTotal <= CONTEXT_SOFT_LIMIT) return { input: value, notes, reused, tokens: rawTotal, savedTokens: 0 }

  const memory = findField(value, 'memory')
  if (options.summarize && typeof memory === 'string' && memory.length >= MEMORY_MIN_SUMMARY_CHARS) {
    const target = Math.max(800, Math.floor(memory.length / 3))
    try {
      const summary = await summarizeMemory(options.dir, memory, target, options.summarize)
      if (summary && summary.length < memory.length) {
        value = replaceField(value, 'memory', summary)
        reused = 1
        notes.push({ field: 'memory', mode: 'summarize', before: memory.length, after: summary.length })
      }
    } catch { /* Summarisation is an optimisation: deterministic compaction below still applies. */ }
  }

  const compacted = compactContext(value)
  notes.push(...compacted.notes)
  const total = compacted.tokens + instructionTokens
  if (total > CONTEXT_LIMIT) {
    const detail = `保护性证据（原文、账本与正文）约 ${compacted.tokens} tokens，超过 ${CONTEXT_LIMIT} 上下文上限；未发送本次调用，也未丢弃任何原文。请减少目标篇幅或拆分该场景。`
    throw Object.assign(new Error('novel_context_budget'), { detail })
  }
  return { input: compacted.value, notes, reused, tokens: total, savedTokens: Math.max(0, rawTotal - total) }
}
