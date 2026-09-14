import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseWritingSettings, type WritingSettings, type HarnessControls, type ChapterDirection } from '../../../../shared/trpg-writing'
import type { NovelArtifact, NovelLayoutChapter, NovelWorkbench } from '../../../../shared/trpg-novel'

export async function readHarnessJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function writeHarnessJson(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}
export async function readControls(dir: string, defaults: WritingSettings = {}): Promise<HarnessControls> {
  return await readHarnessJson<HarnessControls>(join(dir, 'controls.json')) ?? {
    revision: 0, settings: parseWritingSettings(defaults), chapters: {}, epochs: {}, approvedOutline: false, approvedChapters: [],
  }
}
export function parseDirection(raw: any): ChapterDirection {
  const text = (key: string, max: number, required = false) => {
    const v = raw?.[key] ?? ''
    if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw Object.assign(new Error('invalid_direction'), { status: 400 })
    return v
  }
  const pacing = raw?.pacing ?? 'balanced'
  if (!['balanced', 'slow', 'fast'].includes(pacing) || (raw?.targetChars != null && (!Number.isInteger(raw.targetChars) || raw.targetChars < 500 || raw.targetChars > 60000))) throw Object.assign(new Error('invalid_direction'), { status: 400 })
  const visualReferences = raw?.visualReferences
  if (visualReferences != null && (!Array.isArray(visualReferences) || visualReferences.length > 6)) throw Object.assign(new Error('invalid_direction'), { status: 400 })
  const references = visualReferences?.map((r: any) => {
    if (typeof r?.id !== 'string' || r.id.length > 160 || typeof r.description !== 'string' || !r.description.trim() || r.description.length > 1500 || !Array.isArray(r.evidence) || !r.evidence.length || r.evidence.length > 8) throw Object.assign(new Error('invalid_direction'), { status: 400 })
    return { id: r.id, description: r.description, evidence: r.evidence.map((c: any) => {
      if (!Number.isInteger(c?.index) || typeof c.quote !== 'string' || !c.quote.trim() || c.quote.length > 2000) throw Object.assign(new Error('invalid_direction'), { status: 400 })
      return { index: c.index, quote: c.quote }
    }) }
  })
  return { ...(references ? { visualReferences: references } : {}), title: text('title', 160, true), guide: text('guide', 2500, true), pov: text('pov', 200), focus: text('focus', 1500), avoid: text('avoid', 1500), pacing, ...(raw.targetChars != null ? { targetChars: raw.targetChars } : {}) }
}
export const artifactName = (name: string) => /^(?:(?:read|memory|material|state|extract|canon|check|plan|write|review|chapter)-\d{1,6}|canon-\d{1,6}-gap-[a-f0-9]{12}|planpart-\d{1,6}-\d{1,2}-\d{1,6}|bookpart-\d{1,2}-\d{1,6}|revision-\d{1,6}-\d{1,6}|book)$/.test(name)
export async function readArtifact(dir: string, name: string, version?: string): Promise<NovelArtifact> {
  if (!artifactName(name) || (version && !/^[a-f0-9]{64}$/.test(version))) throw Object.assign(new Error('invalid_artifact'), { status: 400 })
  const current = await readHarnessJson<any>(join(dir, `${name}.json`))
  const value = !version || current?.inputHash === version ? current : await readHarnessJson<any>(join(dir, 'history', `${name}-${version}.json`))
  if (!value) throw Object.assign(new Error('artifact_not_found'), { status: 404 })
  // v1 assembled chapters predate the step envelope.
  return value.inputHash ? { ...value, name } : { name, createdAt: 0, version: 'legacy', inputHash: '', value }
}
export async function artifactVersions(dir: string, name: string) {
  if (!artifactName(name)) throw Object.assign(new Error('invalid_artifact'), { status: 400 })
  let files: string[] = []
  try { files = await readdir(join(dir, 'history')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const versions = await Promise.all(files.filter(f => f.startsWith(`${name}-`) && /^[a-f0-9]{64}\.json$/.test(f.slice(name.length + 1))).map(f => readHarnessJson<NovelArtifact>(join(dir, 'history', f))))
  return versions.filter((v): v is NovelArtifact => !!v).map(({ inputHash, createdAt, model }) => ({ inputHash, createdAt, model })).sort((a, b) => b.createdAt - a.createdAt)
}
export async function archiveArtifact(dir: string, name: string, value: unknown, inputHash: string) {
  await mkdir(join(dir, 'history'), { recursive: true })
  await writeHarnessJson(join(dir, 'history', `${name}-${inputHash}.json`), value)
}
const eventWrites = new Map<string, Promise<unknown>>()
export async function harnessEvent(dir: string, event: Omit<NovelWorkbench['events'][number], 'at'>) {
  const next = (eventWrites.get(dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const events = await readHarnessJson<NovelWorkbench['events']>(join(dir, 'events.json')) ?? []
    await writeHarnessJson(join(dir, 'events.json'), [...events, { at: Date.now(), ...event }].slice(-200))
  })
  eventWrites.set(dir, next)
  try { await next } finally { if (eventWrites.get(dir) === next) eventWrites.delete(dir) }

}
// Poll metadata without reparsing the entire novel every 2.5 seconds.
const metadataCache = new Map<string, { stamp: string; meta: NovelWorkbench['artifacts'][number] }>()
export async function inspectHarness(dir: string) {
  const files = (await readdir(dir)).filter(f => artifactName(f.replace(/\.json$/, '')) && f.endsWith('.json'))
  const artifacts = await Promise.all(files.map(async f => {
    const path = join(dir, f), info = await stat(path), stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
    const cached = metadataCache.get(path)
    if (cached?.stamp === stamp) return cached.meta
    const a = await readArtifact(dir, f.slice(0, -5))
    const meta = { name: a.name, createdAt: a.createdAt, model: a.model }
    if (metadataCache.size >= 4096) metadataCache.delete(metadataCache.keys().next().value!)
    metadataCache.set(path, { stamp, meta })
    return meta
  }))
  const layout = await readHarnessJson<NovelLayoutChapter[]>(join(dir, 'layout.json')) ?? []
  const events = await readHarnessJson<NovelWorkbench['events']>(join(dir, 'events.json')) ?? []
  return { layout, artifacts, events }
}
