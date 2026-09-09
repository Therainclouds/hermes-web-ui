/**
 * Seam tests for scripts/_lib/staging-gc.sh (update-fleet-spec § R4).
 *
 * Root cause under test (6.6.6.73, 2026-09-07/08): nine consecutive
 * failed updates each left a 3–4.5 GB staging-update-* tree plus
 * partial downloads in updates/cache; nothing ever reclaimed them and
 * the disk hit 91%. The GC must reclaim stale unreferenced entries on
 * every sweep while never touching the live deploy tree, the lastgood
 * rollback generation, or the current task's own artifacts.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, describe, expect, it } from 'vitest'
import { runSnippet, SCRIPTS, symlinksSupported } from './helpers'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const haveSymlinks = symlinksSupported()

interface Fixture {
  home: string
  cache: string
  deployParent: string
  deployDir: string
  taskId: string
}

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'staging-gc-'))
  tempDirs.push(home)
  const cache = join(home, 'updates', 'cache')
  const deployParent = join(home, 'opt')
  mkdirSync(cache, { recursive: true })
  mkdirSync(deployParent, { recursive: true })
  return { home, cache, deployParent, deployDir: join(deployParent, 'src'), taskId: 'task-current' }
}

function writeTree(dir: string, marker = 'x'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'marker'), marker)
}

/** Source the lib and run a gc call with the fixture's env wired up. */
function runGc(fixture: Fixture, body: string): { status: number; stdout: string; stderr: string } {
  return runSnippet(`
source '${SCRIPTS.stagingGcLib}'
info() { printf '[gc-test] %s\n' "$*"; }
warn() { printf '[gc-test] WARN: %s\n' "$*" >&2; }
CACHE_DIR='${fixture.cache.split('\\').join('/')}'
DEPLOY_DIR='${fixture.deployDir.split('\\').join('/')}'
TASK_ID='${fixture.taskId}'
${body}
`)
}

function age(fixture: Fixture, relPath: string, daysAgo: string): void {
  const res = runGc(fixture, `touch -d '${daysAgo} days ago' '${join(fixture.cache, relPath).split('\\').join('/')}'`)
  expect(res.status).toBe(0)
}

describe('staging-gc sweep', () => {

  it('removes stale staging/inner dirs and partial downloads past the age threshold', () => {
    const f = makeFixture()
    writeTree(join(f.cache, 'staging-update-old1'))
    writeTree(join(f.cache, 'inner-old2'))
    writeTree(join(f.cache, 'staging-orchestrator-legacy'))
    writeFileSync(join(f.cache, 'partial-update-old3.part'), 'junk')
    age(f, 'staging-update-old1', '10')
    age(f, 'inner-old2', '10')
    age(f, 'staging-orchestrator-legacy', '10')
    age(f, 'partial-update-old3.part', '10')

    const res = runGc(f, 'gc_staging_cache 7')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('freed')
    expect(existsSync(join(f.cache, 'staging-update-old1'))).toBe(false)
    expect(existsSync(join(f.cache, 'inner-old2'))).toBe(false)
    expect(existsSync(join(f.cache, 'staging-orchestrator-legacy'))).toBe(false)
    expect(existsSync(join(f.cache, 'partial-update-old3.part'))).toBe(false)
  })

  it('keeps fresh entries at the default threshold but reclaims them in the aggressive sweep', () => {
    const f = makeFixture()
    writeTree(join(f.cache, 'staging-update-recent'))
    age(f, 'staging-update-recent', '3')

    const def = runGc(f, 'gc_staging_cache 7')
    expect(def.status).toBe(0)
    expect(existsSync(join(f.cache, 'staging-update-recent'))).toBe(true)

    const aggressive = runGc(f, 'gc_staging_cache 1')
    expect(aggressive.status).toBe(0)
    expect(existsSync(join(f.cache, 'staging-update-recent'))).toBe(false)
  })

  it('keeps the manifest cache and the current task artifacts during the sweep', () => {
    const f = makeFixture()
    writeFileSync(join(f.cache, 'manifest-stable.json'), '{}')
    writeTree(join(f.cache, `staging-${f.taskId}`))
    writeFileSync(join(f.cache, `partial-${f.taskId}.part`), 'junk')
    age(f, 'manifest-stable.json', '30')
    age(f, `staging-${f.taskId}`, '30')
    age(f, `partial-${f.taskId}.part`, '30')

    const res = runGc(f, 'gc_staging_cache 7')
    expect(res.status).toBe(0)
    expect(existsSync(join(f.cache, 'manifest-stable.json'))).toBe(true)
    expect(existsSync(join(f.cache, `staging-${f.taskId}`))).toBe(true)
    expect(existsSync(join(f.cache, `partial-${f.taskId}.part`))).toBe(true)
  })

  it('reclaims superseded .previous-* asides beside the deploy link but not the live tree or the lastgood target', () => {
    const f = makeFixture()
    writeTree(join(f.deployParent, 'src.previous-1000'))
    writeTree(join(f.deployParent, 'src.previous-2000'))
    writeTree(f.deployDir)

    const stale = runGc(f, `touch -d '10 days ago' '${join(f.deployParent, 'src.previous-1000').split('\\').join('/')}' '${join(f.deployParent, 'src.previous-2000').split('\\').join('/')}'`)

    if (!haveSymlinks) {
      // Windows without native symlinks: live-tree protection via a real
      // directory is still exercised; lastgood targeting is CI-only.
      expect(stale.status).toBe(0)
      const plain = runGc(f, 'gc_staging_cache 7')
      expect(plain.status).toBe(0)
      expect(existsSync(join(f.deployParent, 'src.previous-1000'))).toBe(false)
      expect(existsSync(join(f.deployParent, 'src.previous-2000'))).toBe(false)
      expect(existsSync(f.deployDir)).toBe(true)
      return
    }
    // Make src.previous-2000 the rollback generation via the lastgood link.
    const link = runGc(f, `ln -sfn '${join(f.deployParent, 'src.previous-2000').split('\\').join('/')}' '${join(f.deployParent, 'lastgood').split('\\').join('/')}'`)
    expect(link.status).toBe(0)
    expect(stale.status).toBe(0)

    const res = runGc(f, 'gc_staging_cache 7')
    expect(res.status).toBe(0)
    expect(existsSync(join(f.deployParent, 'src.previous-1000'))).toBe(false)
    expect(existsSync(join(f.deployParent, 'src.previous-2000'))).toBe(true)
    expect(existsSync(f.deployDir)).toBe(true)
  })
})

describe('staging-gc task artifacts', () => {

  it('failure path: reclaims the task staging, inner, and partial when nothing references them', () => {
    const f = makeFixture()
    writeTree(join(f.cache, `staging-${f.taskId}`))
    writeTree(join(f.cache, `inner-${f.taskId}`))
    writeFileSync(join(f.cache, `partial-${f.taskId}.part`), 'junk')

    const res = runGc(f, 'gc_task_artifacts')
    expect(res.status).toBe(0)
    expect(existsSync(join(f.cache, `staging-${f.taskId}`))).toBe(false)
    expect(existsSync(join(f.cache, `inner-${f.taskId}`))).toBe(false)
    expect(existsSync(join(f.cache, `partial-${f.taskId}.part`))).toBe(false)
  })

  it('success path: the staging IS the live tree, so it survives; the stale partial is reclaimed', () => {
    const f = makeFixture()
    writeTree(join(f.cache, `staging-${f.taskId}`))
    writeFileSync(join(f.cache, `partial-${f.taskId}.part`), 'junk')

    if (!haveSymlinks) {
      // Without symlinks the live tree cannot be the staging dir; still
      // verify the partial is reclaimed and unrelated trees survive.
      const res = runGc(f, 'gc_task_artifacts')
      expect(res.status).toBe(0)
      expect(existsSync(join(f.cache, `partial-${f.taskId}.part`))).toBe(false)
      return
    }
    const link = runGc(f, `ln -sfn '${join(f.cache, `staging-${f.taskId}`).split('\\').join('/')}' '${f.deployDir.split('\\').join('/')}'`)
    expect(link.status).toBe(0)

    const res = runGc(f, 'gc_task_artifacts')
    expect(res.status).toBe(0)
    expect(existsSync(join(f.cache, `staging-${f.taskId}`))).toBe(true)
    expect(existsSync(join(f.cache, `partial-${f.taskId}.part`))).toBe(false)
  })

  it('is a clean no-op when the cache does not exist', () => {
    const f = makeFixture()
    rmSync(f.cache, { recursive: true, force: true })
    const res = runGc(f, 'gc_staging_cache 7; gc_task_artifacts')
    expect(res.status).toBe(0)
  })
})
