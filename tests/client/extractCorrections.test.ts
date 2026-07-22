import { describe, expect, it } from 'vitest'
import { extractCorrections } from '@/composables/useMeetingAnalysis'

describe('extractCorrections', () => {
  it('returns null on empty input', () => {
    expect(extractCorrections('')).toBeNull()
    expect(extractCorrections(null as any)).toBeNull()
    expect(extractCorrections(undefined as any)).toBeNull()
  })

  it('returns null when no JSON found', () => {
    expect(extractCorrections('just some text')).toBeNull()
  })

  it('parses JSON from markdown code fence', () => {
    const content = '```json\n{"corrections": [{"index": 0, "original": "在", "corrected": "再", "reason": "错别字"}]}\n```'
    const result = extractCorrections(content)
    expect(result).toEqual([{ index: 0, original: '在', corrected: '再', reason: '错别字' }])
  })

  it('parses JSON from plain text with balanced braces', () => {
    const content = 'Here is the result: {"corrections": [{"index": 1, "original": "权利", "corrected": "权力"}]} done.'
    const result = extractCorrections(content)
    expect(result).toEqual([{ index: 1, original: '权利', corrected: '权力' }])
  })

  it('returns empty array when corrections is empty', () => {
    const content = '```json\n{"corrections": []}\n```'
    const result = extractCorrections(content)
    expect(result).toEqual([])
  })

  it('handles multiple corrections', () => {
    const content = `{
      "corrections": [
        {"index": 0, "original": "在", "corrected": "再", "reason": "错别字"},
        {"index": 3, "original": "权利", "corrected": "权力", "reason": "同音字"},
        {"index": 5, "original": "以经", "corrected": "已经", "reason": "错别字"}
      ]
    }`
    const result = extractCorrections(content)
    expect(result).toHaveLength(3)
    expect(result![0].index).toBe(0)
    expect(result![1].index).toBe(3)
    expect(result![2].index).toBe(5)
  })

  it('handles nested braces in content', () => {
    const content = '{"corrections": [{"index": 0, "original": "test {a}", "corrected": "fixed"}]}'
    const result = extractCorrections(content)
    expect(result).toEqual([{ index: 0, original: 'test {a}', corrected: 'fixed' }])
  })

  it('handles escaped quotes in strings', () => {
    const content = '{"corrections": [{"index": 0, "original": "He said \\"hi\\"", "corrected": "He said \\"hello\\""}]}'
    const result = extractCorrections(content)
    expect(result).toEqual([{ index: 0, original: 'He said "hi"', corrected: 'He said "hello"' }])
  })

  it('ignores non-corrections JSON', () => {
    const content = '{"foo": "bar"} and then {"corrections": [{"index": 0, "original": "a", "corrected": "b"}]}'
    const result = extractCorrections(content)
    expect(result).toEqual([{ index: 0, original: 'a', corrected: 'b' }])
  })

  it('parses real-world LLM output with markdown', () => {
    const content = `以下是纠正结果：

\`\`\`json
{
  "corrections": [
    {"index": 0, "original": "在来", "corrected": "再来", "reason": "错别字：在→再"},
    {"index": 2, "original": "已经", "corrected": "已经", "reason": "无错误"}
  ]
}
\`\`\`

共发现 1 处错别字。`
    const result = extractCorrections(content)
    expect(result).toHaveLength(2)
    expect(result![0]).toEqual({ index: 0, original: '在来', corrected: '再来', reason: '错别字：在→再' })
  })
})
