import type { Annotation, Box, GradeResult, Question, Word } from './types'

export function wordBox(words: Word[]): Box {
  if (!words.length) throw new Error('Empty annotation word range')
  const left = Math.min(...words.map(w => w.cx - w.w / 2)); const top = Math.min(...words.map(w => w.cy - w.h / 2))
  return [left, top, Math.max(...words.map(w => w.cx + w.w / 2)) - left, Math.max(...words.map(w => w.cy + w.h / 2)) - top]
}
/** Ranges use OCR line indices, inclusive start and exclusive end. No model calls. */
export function applyEdits(words: Word[], questions: Question[], results: GradeResult[]): Annotation[] {
  const annotations: Annotation[] = []
  for (const result of results) {
    const question = questions.find(q => q.qid === result.qid)
    if (!question) throw new Error('Unknown question')
    const [x, y, w] = question.bbox
    const add = (kind: string, bbox: Box, content = '') => annotations.push({ id: `${result.qid}-${annotations.length}`, kind, bbox, content })
    add('badge', [x + w - 90, y, 90, 30], `${result.score}/${result.fullMark}`)
    add('comment', [x, y + question.bbox[3], Math.max(w, 200), 40], result.feedback)
    for (const op of result.diffOps) {
      if (op.type === 'delete' || op.type === 'mark') {
        const [start, end] = op.range
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < question.wordRange[0] || end > question.wordRange[1] || end <= start) throw new Error('Invalid edit range')
        add(op.type === 'delete' ? 'cross' : op.mark || 'circle', wordBox(words.slice(start, end)))
      } else if (op.type === 'insert') {
        if (!Number.isInteger(op.after) || op.after < question.wordRange[0] || op.after >= question.wordRange[1]) throw new Error('Invalid insertion anchor')
        const word = words[op.after]!
        add('comment', [word.cx + word.w / 2, word.cy, 200, 30], op.text)
      } else if (op.type === 'comment' || op.type === 'badge') add(op.type, [x, y, 200, 30], op.text || op.content || '')
    }
  }
  return annotations
}
export function summarize(submissions: { results: GradeResult[] }[]) {
  const rows = submissions.filter(s => s.results.length)
  const totals = rows.map(s => s.results.reduce((n, r) => n + r.score, 0))
  const qids = [...new Set(rows.flatMap(s => s.results.map(r => r.qid)))]
  const questionStats = qids.map(qid => {
    const results = rows.flatMap(s => s.results.filter(r => r.qid === qid)); const scores = results.map(r => r.score)
    const wrongCount = results.filter(r => r.score < r.fullMark).length
    return { qid, count: results.length, average: scores.reduce((a, b) => a + b, 0) / scores.length, max: Math.max(...scores), min: Math.min(...scores), wrongCount, rate: wrongCount / results.length }
  })
  return { total: rows.length, average: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0, max: totals.length ? Math.max(...totals) : 0, min: totals.length ? Math.min(...totals) : 0, passRate: rows.length ? rows.filter((s, i) => totals[i]! >= s.results.reduce((n, r) => n + r.fullMark, 0) * 0.6).length / rows.length : 0, questionStats, wrongRank: [...questionStats].sort((a, b) => b.rate - a.rate) }
}
