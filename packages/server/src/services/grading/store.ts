import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getWebUiHome } from '../../config'
import type { Submission } from './types'

export function gradingDirectory(profile: string): string {
  return join(getWebUiHome(), 'grading', createHash('sha256').update(profile).digest('hex'))
}
export function withGradingDb<T>(profile: string, fn: (db: DatabaseSync) => T): T {
  const dir = gradingDirectory(profile)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'grading.sqlite'))
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS grading_class (id TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER);
      CREATE TABLE IF NOT EXISTS grading_exam (id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES grading_class(id), name TEXT NOT NULL, date TEXT, rubric TEXT);
      CREATE TABLE IF NOT EXISTS grading_submission (id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES grading_exam(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grading_layout_template (exam_id TEXT PRIMARY KEY REFERENCES grading_exam(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grading_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`)
    return fn(db)
  } finally { db.close() }
}
export function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }) }
export function requiredText(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Invalid or missing text')
  return value.trim()
}
export function catalog(profile: string) {
  return withGradingDb(profile, db => ({ classes: db.prepare('SELECT * FROM grading_class').all(), exams: db.prepare('SELECT * FROM grading_exam').all() }))
}
export function createClass(profile: string, name: unknown, year?: unknown) {
  const id = randomUUID(); const text = requiredText(name)
  const y = year === undefined ? null : Number(year)
  if (y !== null && (!Number.isInteger(y) || y < 1900 || y > 2200)) fail('Invalid year')
  withGradingDb(profile, db => db.prepare('INSERT INTO grading_class VALUES (?, ?, ?)').run(id, text, y))
  return { classId: id }
}
export function createExam(profile: string, args: any) {
  const id = randomUUID(); const name = requiredText(args.name); const classId = requiredText(args.classId)
  withGradingDb(profile, db => {
    if (!db.prepare('SELECT id FROM grading_class WHERE id=?').get(classId)) fail('Class not found', 404)
    db.prepare('INSERT INTO grading_exam VALUES (?, ?, ?, ?, ?)').run(id, classId, name, String(args.date || ''), String(args.rubricRef || ''))
  })
  return { examId: id }
}
export function readSubmission(profile: string, id: string): Submission {
  return withGradingDb(profile, db => {
    const row = db.prepare('SELECT data FROM grading_submission WHERE id=?').get(id)
    if (!row) fail('Submission not found', 404)
    return JSON.parse(String(row.data))
  })
}
export function saveSubmission(profile: string, submission: Submission) {
  withGradingDb(profile, db => {
    if (!db.prepare('SELECT id FROM grading_exam WHERE id=?').get(submission.examId)) fail('Exam not found', 404)
    db.prepare('INSERT INTO grading_submission VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(submission.id, submission.examId, JSON.stringify(submission))
  })
}
export function listSubmissions(profile: string, examId: string): Omit<Submission, 'image'>[] {
  return withGradingDb(profile, db => db.prepare('SELECT data FROM grading_submission WHERE exam_id=?').all(examId).map(row => {
    const { image: _image, ...rest } = JSON.parse(String(row.data)) as Submission
    return rest
  }))
}
export function readSettings(profile: string): Record<string, any> {
  return withGradingDb(profile, db => {
    const row = db.prepare('SELECT data FROM grading_settings WHERE id=1').get()
    return row ? JSON.parse(String(row.data)) : { enabled: false, ocrModel: 'qwen3.5-ocr', model: 'qwen3.8-plus', threshold: 0.7 }
  })
}
export function writeSettings(profile: string, input: any) {
  const settings = { ...readSettings(profile) }
  if (typeof input.enabled === 'boolean') settings.enabled = input.enabled
  for (const key of ['ocrModel', 'model']) if (input[key] !== undefined) settings[key] = requiredText(input[key])
  if (input.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || input.threshold < 0 || input.threshold > 1) fail('Invalid confidence threshold')
    settings.threshold = input.threshold
  }
  withGradingDb(profile, db => db.prepare('INSERT INTO grading_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(settings)))
  return settings
}
