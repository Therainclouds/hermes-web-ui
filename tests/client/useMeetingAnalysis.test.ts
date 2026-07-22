import { describe, expect, it } from 'vitest'
import {
  isAnalysisShaped,
  tryParseJson,
  tryParseBalancedJson,
  looksLikeHtmlDocument,
  escHtml,
} from '@/composables/useMeetingAnalysis'

describe('isAnalysisShaped', () => {
  it('returns false for null / undefined / primitives', () => {
    expect(isAnalysisShaped(null)).toBe(false)
    expect(isAnalysisShaped(undefined)).toBe(false)
    expect(isAnalysisShaped('foo')).toBe(false)
    expect(isAnalysisShaped(42)).toBe(false)
    expect(isAnalysisShaped([])).toBe(false)
  })

  it('returns false for objects with no known keys', () => {
    expect(isAnalysisShaped({ foo: 'bar' })).toBe(false)
    expect(isAnalysisShaped({})).toBe(false)
  })

  it('returns true when at least one hint key is present', () => {
    for (const k of [
      'summary', 'key_points', 'action_items', 'topics',
      'people_mentioned', 'relationships', 'meeting_type',
      'feedback', 'decisions', 'risks', 'learnings',
      'html_content',
    ]) {
      expect(isAnalysisShaped({ [k]: [] })).toBe(true)
    }
  })
})

describe('tryParseJson', () => {
  it('returns null on empty input', () => {
    expect(tryParseJson('')).toBeNull()
  })

  it('parses plain JSON', () => {
    const result = tryParseJson('{"summary": "abc", "key_points": ["a"]}')
    expect(result).toEqual({ summary: 'abc', key_points: ['a'] })
  })

  it('parses JSON inside markdown code fence', () => {
    const text = 'Here you go:\n```json\n{"summary": "abc", "topics": ["t"]}\n```\nDone.'
    expect(tryParseJson(text)).toEqual({ summary: 'abc', topics: ['t'] })
  })

  it('parses prose-wrapped JSON', () => {
    const text = 'The result is {"summary": "test", "topics": []} thanks!'
    expect(tryParseJson(text)).toEqual({ summary: 'test', topics: [] })
  })

  it('ignores objects that do not look like analysis results', () => {
    const text = '{"foo": "bar"} and then {"summary": "good", "topics": []}'
    expect(tryParseJson(text)).toEqual({ summary: 'good', topics: [] })
  })

  it('handles nested objects and arrays correctly', () => {
    const text = '{"summary": "outer", "feedback": {"positive": ["p"], "negative": ["n"]}, "action_items": [{"task": "t1", "assignee": "x"}]}'
    expect(tryParseJson(text)).toEqual({
      summary: 'outer',
      feedback: { positive: ['p'], negative: ['n'] },
      action_items: [{ task: 't1', assignee: 'x' }],
    })
  })

  it('handles escaped quotes inside strings', () => {
    const text = '{"summary": "He said \\"hi\\"", "topics": []}'
    expect(tryParseJson(text)).toEqual({ summary: 'He said "hi"', topics: [] })
  })

  it('skips a JSON with closing brace inside a string', () => {
    const text = 'preamble {"summary": "closing } in string", "topics": []}'
    expect(tryParseJson(text)).toEqual({ summary: 'closing } in string', topics: [] })
  })

  it('parses real-world LLM output wrapped in markdown', () => {
    const text = `以下是分析结果：

\`\`\`json
{
  "meeting_type": "项目分享",
  "summary": "本次会议分享了项目落地的经验。",
  "key_points": ["要点1", "要点2"],
  "topics": ["主题1"]
}
\`\`\`

希望对您有帮助。`
    expect(tryParseJson(text)).toEqual({
      meeting_type: '项目分享',
      summary: '本次会议分享了项目落地的经验。',
      key_points: ['要点1', '要点2'],
      topics: ['主题1'],
    })
  })
})

describe('tryParseBalancedJson', () => {
  it('returns null when no JSON object exists', () => {
    expect(tryParseBalancedJson('just text')).toBeNull()
  })

  it('returns null when only non-shaped objects are present', () => {
    expect(tryParseBalancedJson('{"foo": 1}')).toBeNull()
  })

  it('finds the first shaped object', () => {
    const text = '{"foo": 1, "bar": 2} {"summary": "x", "topics": []}'
    expect(tryParseBalancedJson(text)).toEqual({ summary: 'x', topics: [] })
  })
})

describe('looksLikeHtmlDocument', () => {
  it('rejects non-strings', () => {
    expect(looksLikeHtmlDocument(null)).toBe(false)
    expect(looksLikeHtmlDocument(undefined)).toBe(false)
    expect(looksLikeHtmlDocument(42)).toBe(false)
  })

  it('rejects short strings', () => {
    expect(looksLikeHtmlDocument('<html></html>')).toBe(false)
  })

  it('accepts a long <html> document', () => {
    const long = '<html><body>' + 'x'.repeat(300) + '</body></html>'
    expect(looksLikeHtmlDocument(long)).toBe(true)
  })

  it('accepts <html lang="zh-CN">', () => {
    const long = '<html lang="zh-CN"><body>' + 'x'.repeat(300) + '</body></html>'
    expect(looksLikeHtmlDocument(long)).toBe(true)
  })
})

describe('escHtml', () => {
  it('escapes HTML-sensitive characters', () => {
    expect(escHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('returns empty string for null / undefined', () => {
    expect(escHtml(null)).toBe('')
    expect(escHtml(undefined)).toBe('')
  })

  it('coerces non-strings', () => {
    expect(escHtml(42)).toBe('42')
  })

  it('escapes single quotes and ampersands', () => {
    expect(escHtml('A & B\'s "C"')).toBe('A &amp; B&#39;s &quot;C&quot;')
  })
})