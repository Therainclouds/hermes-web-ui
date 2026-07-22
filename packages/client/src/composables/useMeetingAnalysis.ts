import type { AnalysisResult } from '@/stores/hermes/meeting'

const ANALYSIS_HINT_KEYS = [
  'summary', 'key_points', 'action_items', 'topics',
  'people_mentioned', 'relationships', 'meeting_type',
  'feedback', 'decisions', 'risks', 'learnings',
  'html_content',
]

export function isAnalysisShaped(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const keys = Object.keys(obj)
  if (keys.length === 0) return false
  return keys.some(k => ANALYSIS_HINT_KEYS.includes(k))
}

// 从助手文本中提取 JSON，依次尝试：代码块 → 平衡大括号 → 宽松贪婪匹配
export function tryParseJson(content: string): AnalysisResult | null {
  if (!content) return null

  // 1) ```json ... ``` 代码块
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    const obj = tryParseBalancedJson(fenced[1].trim())
    if (obj) return obj
  }

  // 2) 平衡大括号（优先，避免贪婪吞并多个 JSON）
  const balanced = tryParseBalancedJson(content)
  if (balanced) return balanced

  // 3) 兼容老的贪婪匹配（最后兜底），仍要求看起来像分析结果
  try {
    const greedy = content.match(/\{[\s\S]*\}/)
    if (greedy) {
      const parsed = JSON.parse(greedy[0])
      if (isAnalysisShaped(parsed)) return parsed as AnalysisResult
    }
  } catch (e) {
    console.error('Failed to parse JSON from agent response:', e)
  }

  return null
}

// 在文本中找到第一个平衡的 { ... } 子串并尝试解析
export function tryParseBalancedJson(content: string): AnalysisResult | null {
  const start = content.search(/[\{[]/)
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false
  let openIdx = -1

  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) openIdx = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && openIdx !== -1) {
        const candidate = content.slice(openIdx, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (isAnalysisShaped(parsed)) {
            return parsed as AnalysisResult
          }
        } catch {
          // 继续往后找
        }
        openIdx = -1
      }
    }
  }

  return null
}

// HTML 转义
export function escHtml(s: any): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 检查字符串是否像完整的 HTML 文档
export function looksLikeHtmlDocument(s: any): boolean {
  return typeof s === 'string' && /<html[\s>]/i.test(s) && s.length > 200
}

// 从文本中提取 corrections JSON（用于 ASR 纠错）
export function extractCorrections(content: string): Array<{index: number, original: string, corrected: string, reason?: string}> | null {
  if (!content) return null

  // 1) 尝试 ```json ... ``` 代码块
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim())
      if (parsed.corrections && Array.isArray(parsed.corrections)) {
        return parsed.corrections
      }
    } catch {}
  }

  // 2) 尝试平衡大括号
  const start = content.search(/\{/)
  if (start !== -1) {
    let depth = 0
    let inString = false
    let escape = false
    let openIdx = -1

    for (let i = start; i < content.length; i++) {
      const ch = content[i]
      if (escape) { escape = false; continue }
      if (inString) {
        if (ch === '\\') { escape = true; continue }
        if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') {
        if (depth === 0) openIdx = i
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0 && openIdx !== -1) {
          try {
            const parsed = JSON.parse(content.slice(openIdx, i + 1))
            if (parsed.corrections && Array.isArray(parsed.corrections)) {
              return parsed.corrections
            }
          } catch {}
          openIdx = -1
        }
      }
    }
  }

  return null
}