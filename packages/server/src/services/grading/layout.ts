import { withGradingDb } from './store'
import type { Submission, Question } from './types'
import { wordBox } from './annotation-engine'
interface Template { width: number; height: number; questions: { qid: string; bbox: [number,number,number,number]; fullMark: number; heading: string }[] }
/** Only reuse a layout when headings match and every OCR line falls in one region. */
export function reuseLayout(profile: string, s: Submission): Question[] | null {
  const row = withGradingDb(profile, db => db.prepare('SELECT data FROM grading_layout_template WHERE exam_id=?').get(s.examId))
  if (!row) return null
  const template: Template = JSON.parse(String(row.data))
  if (Math.abs(template.width / template.height - s.width / s.height) > .03) return null
  const assigned = new Set<number>()
  const questions: Question[] = []
  for (const q of template.questions) {
    const [x,y,w,h] = q.bbox
    const indices = s.words.map((word,index) => ({ word,index })).filter(({word}) => word.cx/s.width >= x && word.cx/s.width <= x+w && word.cy/s.height >= y && word.cy/s.height <= y+h).map(({index}) => index)
    if (!indices.length || indices.some(i => assigned.has(i)) || indices.at(-1)! - indices[0]! + 1 !== indices.length) return null
    const selected = s.words.slice(indices[0], indices.at(-1)! + 1)
    if (!selected[0]!.text.startsWith(q.heading)) return null
    indices.forEach(i => assigned.add(i))
    questions.push({ qid:q.qid, fullMark:q.fullMark, bbox:wordBox(selected), wordRange:[indices[0]!, indices.at(-1)!+1], text:selected.map(w => w.text).join('\n') })
  }
  return assigned.size === s.words.length ? questions : null
}
export function saveLayout(profile: string, s: Submission) {
  const template: Template = { width:s.width, height:s.height, questions:s.questions.map(q => ({ qid:q.qid, fullMark:q.fullMark, bbox:[q.bbox[0]/s.width,q.bbox[1]/s.height,q.bbox[2]/s.width,q.bbox[3]/s.height], heading:s.words[q.wordRange[0]]!.text.slice(0,12) })) }
  withGradingDb(profile, db => db.prepare('INSERT INTO grading_layout_template VALUES (?,?) ON CONFLICT(exam_id) DO NOTHING').run(s.examId,JSON.stringify(template)))
}
