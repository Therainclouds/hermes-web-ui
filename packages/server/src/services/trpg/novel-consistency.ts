import { boundedText, invalid } from './novel-material'

export interface EvidenceRow { index: number; text: string }
interface Citation { index: number; quote: string }
export interface CanonEvent { id: string; kind: 'attempt' | 'confirmed' | 'dialogue' | 'discovery' | 'correction'; fact: string; evidence: Citation[] }
export interface StateFact { entity: string; attribute: string; value: string; evidence: Citation[] }
export interface SceneCanon { events: CanonEvent[]; omitted: { index: number; reason: string }[]; updates: StateFact[] }
const attributes = ['location', 'health', 'inventory', 'knowledge', 'relationship', 'appearance', 'goal', 'world']
function citations(raw: any, rows: EvidenceRow[]): Citation[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 120) invalid('citations')
  return raw.map((c: any) => {
    const index = typeof c.index === 'string' && /^\d+$/.test(c.index) ? Number(c.index) : c.index
    if (c.quote == null) {
      const source = rows.find(r => r.index === index)
      if (!source) invalid(`evidence index ${index} is outside supplied source rows; allowed indices: ${rows.map(r => r.index).join(',')}`)
      return { index: source.index, quote: source.text.slice(0, 2000) }
    }
    const quote = boundedText(c.quote, 2000, 'source quote')
    const exact = rows.find(r => r.index === index && r.text.includes(quote))
    if (exact) return { index: exact.index, quote }
    // A unique verbatim quotation can safely repair a wrong row number; never fuzzy-match content.
    const matches = rows.filter(r => r.text.includes(quote))
    const unique = [...new Map(matches.map(r => [r.index, r])).values()]
    if (unique.length === 1 && quote.trim().length >= 4) return { index: unique[0]!.index, quote }
    invalid(`quote not in source at index ${Number.isInteger(index) ? index : 'invalid'}; use an exact substring from one of the supplied rows`)

  })
}
/** IDs are assigned by code. Every owned row must be used or explicitly classified as omitted. */
export function validateCanon(v: any, rows: EvidenceRow[], correctionRows: EvidenceRow[], sceneIndex: number, historicalStateRows: EvidenceRow[] = []): SceneCanon {
  if (!Array.isArray(v?.events) || !v.events.length || v.events.length > 120 || !Array.isArray(v.omitted) || v.omitted.length > 120 || !Array.isArray(v.updates) || v.updates.length > 60) invalid('canon shape')
  const allRows = [...rows, ...correctionRows]
  const events = v.events.map((e: any, i: number): CanonEvent => {
    if (!['attempt', 'confirmed', 'dialogue', 'discovery', 'correction'].includes(e.kind)) invalid('event kind')
    return { id: `s${sceneIndex}-e${i}`, kind: e.kind, fact: boundedText(e.fact, 700, 'event fact', false, true), evidence: citations(e.evidence, allRows) }
  })
  const used = new Set(events.flatMap((e: CanonEvent) => e.evidence.map(c => c.index)))
  const omissions = new Map<number, { index: number; reason: string }>()
  for (const o of v.omitted) {
    const index = typeof o?.index === 'string' && /^\d+$/.test(o.index) ? Number(o.index) : o?.index
    if (!Number.isInteger(index) || !rows.some(r => r.index === index)) invalid(`omitted index ${Number.isInteger(index) ? index : 'invalid'} is outside supplied rows ${rows[0]?.index}..${rows.at(-1)?.index}`)
    const reason = boundedText(o.reason, 250, 'omission reason')
    // One ASR utterance may contain both an event and filler. Evidence wins; never drop the event.
    if (!used.has(index) && !omissions.has(index)) omissions.set(index, { index, reason })
  }
  const omitted = [...omissions.values()]
  const missing = rows.filter(r => !used.has(r.index) && !omissions.has(r.index)).map(r => r.index)
  if (missing.length) invalid(`unaccounted ASR rows: ${missing.join(',')}; each needs event evidence or an explicit omission reason`)
  const updates = v.updates.map((u: any): StateFact => {
    if (!attributes.includes(u.attribute)) invalid('state attribute')
    return { entity: boundedText(u.entity, 100, 'canonical entity'), attribute: u.attribute, value: boundedText(u.value, 700, 'state value', false, true), evidence: citations(u.evidence, [...allRows, ...historicalStateRows]) }
  })
  if (new Set(updates.map((u: StateFact) => `${u.entity}\0${u.attribute}`)).size !== updates.length) invalid('duplicate state updates')
  return { events, omitted, updates }
}
export function advanceState(before: StateFact[], canon: SceneCanon): StateFact[] {
  const next = new Map(before.map(s => [`${s.entity}\0${s.attribute}`, s]))
  for (const update of canon.updates) next.set(`${update.entity}\0${update.attribute}`, update)
  return [...next.values()]
}
/** Diagnostic helper only: a recovered substring is not proof of event coverage.
 *  Recover a verbatim substring of `quote` from `body`.
 *  Audit models can drift when citing long prose (extra whitespace, full-width
 *  vs half-width punctuation, a paraphrased tail, or quote marks leaking in).
 *  We refuse to weaken the evidence contract: only a real substring of body is
 *  accepted — never the audit's paraphrase. Threshold = max(8 chars, 50% of
 *  quote length) keeps short fabricated snippets from being waved through. */
export function recoverCoverageQuote(body: string, quote: string): string | undefined {
  if (!quote) return undefined
  const trimmed = quote.trim()
  if (trimmed && body.includes(trimmed)) return trimmed
  if (body.includes(quote)) return quote
  const minLen = Math.max(8, Math.ceil(quote.length * 0.5))
  for (let len = quote.length; len >= minLen; ) {
    for (let i = 0; i + len <= quote.length; i++) {
      const sub = quote.slice(i, i + len)
      const idx = body.indexOf(sub)
      if (idx >= 0) return body.slice(idx, idx + len)
    }
    if (len === minLen) break
    const next = Math.floor(len * 0.7)
    len = Math.max(minLen, next)
  }
  return undefined
}
/** Auditor must point to actual prose for every required event; unresolved conflicts block publication. */
export function validateConsistency(v: any, canon: SceneCanon, body: string) {
  if (!Array.isArray(v?.coverage) || v.coverage.length > 480 || !Array.isArray(v?.issues) || v.issues.length > 120) invalid('consistency report')
  const issues: { detail: string }[] = v.issues.map((i: any) => ({ detail: typeof i?.detail === 'string' && i.detail.trim() ? i.detail.slice(0, 1000) : 'Malformed audit issue: explain the unresolved conflict before approval.' }))
  const suggestions = Array.isArray(v.suggestions) ? v.suggestions.filter((item: any) => typeof item?.detail === 'string' && item.detail.trim()).slice(0, 30).map((item: any): { detail: string } => ({ detail: item.detail.slice(0, 1000) })) : []
  const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const coverage: { eventId: string; quote: string; paragraph?: number; recoveredFrom?: string }[] = []
  const seen = new Set<string>()
  let repairReport = v.issues.some((i: any) => typeof i?.detail !== 'string' || !i.detail.trim())
  const failed = (detail: string, format = false) => { issues.push({ detail }); repairReport ||= format }
  for (const c of v.coverage) {
    if (!canon.events.some(e => e.id === c?.eventId)) {
      failed(`Unknown audit event ${String(c?.eventId).slice(0, 100)}; use an eventId from canon.events.`, true)
      continue
    }
    // Only exact duplicate claims are harmless. Conflicting claims must be reviewed.
    const signature = JSON.stringify([c.eventId, c.quote ?? null, c.paragraph ?? null])
    if (seen.has(signature)) continue
    seen.add(signature)
    if (coverage.some(item => item.eventId === c.eventId)) {
      failed(`Conflicting duplicate coverage for event ${c.eventId}; provide one verified claim.`, true)
      continue
    }
    if (c.paragraph !== undefined && c.paragraph !== null) {
      if (!Number.isInteger(c.paragraph) || !paragraphs[c.paragraph]) {
        failed(`Invalid manuscript paragraph for event ${c.eventId}; use a zero-based paragraph index.`, true)
        continue
      }
      const paragraph = paragraphs[c.paragraph]!
      if (c.quote != null && (typeof c.quote !== 'string' || !c.quote.trim() || !paragraph.includes(c.quote.trim()))) {
        failed(`Audit quote does not occur in paragraph ${c.paragraph} for event ${c.eventId}.`, true)
        continue
      }
      coverage.push({ eventId: c.eventId, paragraph: c.paragraph, quote: c.quote == null ? paragraph : c.quote.trim() })
      continue
    }
    // A partial substring may omit a negation or outcome. Accept only a complete exact claim.
    if (typeof c.quote === 'string' && c.quote.trim() && body.includes(c.quote.trim())) {
      coverage.push({ eventId: c.eventId, quote: c.quote.trim(), ...(c.quote.trim() !== c.quote ? { recoveredFrom: c.quote } : {}) })
    } else {
      failed(`Missing verified prose evidence for event ${c.eventId}; identify the actual paragraph or revise the missing event, never fabricate a quote.`)
    }
  }
  for (const event of canon.events) {
    if (!coverage.some(c => c.eventId === event.id)) failed(`Uncovered event ${event.id}: ${event.fact}`)
  }
  return { coverage, issues, suggestions, passed: issues.length === 0, ...(repairReport ? { repairReport: true } : {}) }
}

export const CANON_PROMPT = `建立当前场景的证据账本，输出 {events:[{kind:"attempt"|"confirmed"|"dialogue"|"discovery"|"correction",fact,evidence:[{index,quote}]}],omitted:[{index,reason}],updates:[{entity,attribute,value,evidence:[{index,quote}]}]}。
逐句读取rows，每句必须被event.evidence引用或进入omitted，不得默默丢弃。quote必须逐字出自对应ASR句。保留关键对话、行动意图、GM裁决、线索和因果。重复口头表达合并一个事件，嗯啊、玩笑、规则争论等不影响剧情的句子归入omitted并说明；有剧情结果的掷骰/规则讨论必须转为叙事事件。不能把所有内容压成一个概括事件。
依据corrections修正被推翻的事实，区分当时人物所知和读者/GM所知。实体沿用stateBefore中的名称或角色卡名称；GM不是所扮演NPC，未知说话者不猜。updates仅记录有原文证据的状态变化，attribute只能是location/health/inventory/knowledge/relationship/appearance/goal/world；每个实体同属性只给场景结束时的完整状态，未变化无需重复，未知保持未知。fact最多700字，events最多120，updates最多60。不得从写作指导推导事实。`
export const CHECK_PROMPT = `独立验收已修订正文。原文、账本和证据中的GM标识保留来源归属；正文里的GM场景描写、裁决与规则说明应转为叙述者独白或小说叙述，语义准确即算覆盖，不要求保留GM标签、逐字口头语或主持人对白。明确的NPC配音归于该NPC，不能将主持人当作小说人物。逐一对照canon.events和原始rows/corrections，检查事件因果与时间、尝试与结果、角色/NPC对白归属、人物知识边界、stateBefore至stateAfter的伤势/地点/物品/关系、公开外貌，以及是否遗漏重要原文或把场外废话写进剧情。
输出 {coverage:[{eventId,paragraph}],issues:[{detail}],suggestions:[{detail}]}。issues仅列明确事实矛盾、关键事件遗漏、确定的角色归属错误、无依据关键剧情。可选环境过渡、措辞、节奏和非关键细节放suggestions，不阻止通过。含糊ASR不要求推断唯一含义；玩家讨论、GM投骰建议和规则说明可中性概括，不要求逐字或逐动作复现，不得把检定建议升级为已执行或成功。对遮蔽物具体形态不明时，应删去无依据的“浓雾”而不是要求补一段使其变成事实。paragraph为manuscript按空行分段、去除首尾空白和空段之后的从0开始的段落编号，服务器从真实正文提取引用，不必重复抄写。也兼容{eventId,quote}，quote必须为正文完整逐字片段，不可改写。每个事件仅给一项；该段必须真正体现该事件，不能用无关段落占位。正文缺少某事件时将其eventId及具体缺失内容列入issues并省略对应coverage。
明确事实冲突、关键事件遗漏和无依据关键剧情进入issues；纯文学偏好不得进入issues。允许不改变事实的环境氛围描写和保留原意的对白整理。不要改写正文。issues.detail应指出具体事件及需要修改的段落和内容，便于局部修订。`

/** Keep the full ledger durable; retrieve relevant entities instead of truncating accumulated history. */
export function relevantState(state: StateFact[], rows: EvidenceRow[], characters: { name: string }[], extraEntities: string[] = []): StateFact[] {
  const text = rows.map(r => r.text).join('\n')
  const names = new Set([...characters.map(c => c.name), ...extraEntities])
  return state.filter(s => names.has(s.entity) || s.attribute === 'world' || text.includes(s.entity))
}

/** Preserve validated work and classify only uncovered rows. Placeholders never leave this helper. */
export function canonGapRepair(v: any, rows: EvidenceRow[], corrections: EvidenceRow[], scene: number, history: EvidenceRow[] = []) {
  if (!Array.isArray(v?.events) || !Array.isArray(v.omitted)) invalid('canon shape')
  const accounted = new Set([...v.events.flatMap((e: any) => (e.evidence ?? []).map((c: any) => Number(c.index))), ...v.omitted.map((o: any) => Number(o.index))])
  const missing = rows.filter(r => !accounted.has(r.index))
  if (!missing.length) invalid('no missing rows to repair')
  const missingIds = new Set(missing.map(r => r.index))
  const base = validateCanon({ ...v, omitted: [...v.omitted, ...missing.map(r => ({ index: r.index, reason: 'pending classification' }))] }, rows, corrections, scene, history)
  return { missing, base, merge(patch: any) {
    const omissionOnly = Array.isArray(patch?.events) && patch.events.length === 0
    const delta = validateCanon(omissionOnly ? { ...patch, events: [base.events[0]] } : patch, missing, [...rows.filter(r => !missingIds.has(r.index)), ...corrections], scene, history)
    const updates = new Map(base.updates.map(u => [`${u.entity}\0${u.attribute}`, u]))
    for (const u of delta.updates) updates.set(`${u.entity}\0${u.attribute}`, u)
    return validateCanon({ events: [...base.events, ...(omissionOnly ? [] : delta.events)], omitted: [...base.omitted.filter(o => !missingIds.has(o.index)), ...delta.omitted], updates: [...updates.values()] }, rows, corrections, scene, history)
  } }
}
