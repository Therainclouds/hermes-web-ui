/** Remove only quotation copies that can be recovered exactly from supplied source rows. */
export function compactNovelEvidence(input: unknown): unknown {
  const rows = new Map<number, Set<string>>()
  function collect(v: any) {
    if (!v || typeof v !== 'object') return
    if (Number.isInteger(v.index) && typeof v.text === 'string') {
      const texts = rows.get(v.index) ?? new Set<string>(); texts.add(v.text); rows.set(v.index, texts)
    }
    for (const item of Object.values(v)) collect(item)
  }
  collect(input)
  function compact(v: any): any {
    if (Array.isArray(v)) return v.map(compact)
    if (!v || typeof v !== 'object') return v
    const redundant = Number.isInteger(v.index) && typeof v.quote === 'string' && [...(rows.get(v.index) ?? [])].some(text => text.includes(v.quote))
    return Object.fromEntries(Object.entries(v).filter(([key]) => !(redundant && key === 'quote')).map(([key, value]) => [key, compact(value)]))
  }
  return compact(input)
}
