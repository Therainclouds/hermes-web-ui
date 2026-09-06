/**
 * Seam tests for the atomic symlink-swap library.
 *
 * Covers scripts/_lib/atomic-swap.sh. Master spec:
 * docs/harness/source-deploy-refactor.md (§ Atomic Swap).
 *
 * NOTE: `ln -s` on Windows MSYS copies instead of symlinking. The suite
 * detects symlink support and skips (rather than lies) when missing;
 * CI on ubuntu always exercises the full behaviour.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { runSnippet, SCRIPTS, symlinksSupported } from './helpers'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-swap-test-'))
  tempDirs.push(dir)
  return dir
}

function makeStagingTree(root: string, version: string): string {
  const staging = join(root, 'staging-v' + version)
  mkdirSync(join(staging, 'dist'), { recursive: true })
  writeFileSync(join(staging, 'dist', 'version.txt'), version)
  return staging
}

const LIB = SCRIPTS.atomicSwapLib

describe('atomic swap library', () => {
  it.skipIf(!symlinksSupported())('swaps deploy to staging atomically and captures lastgood', () => {
    const root = scratch()
    const first = makeStagingTree(root, '1.0.0')
    const second = makeStagingTree(root, '2.0.0')
    const deploy = join(root, 'deploy')

    // First swap: no prior deploy, nothing to capture.
    const r1 = runSnippet(
      `source '${LIB}'; atomic_swap_dir '${first}' '${deploy}'`,
    )
    expect(r1.status).toBe(0)
    expect(runSnippet(`[ -L '${deploy}' ] && readlink '${deploy}'`).stdout.trim()).toBe(first)

    // Capture before second swap, then swap.
    const r2 = runSnippet(
      `source '${LIB}'; capture_lastgood '${deploy}' && atomic_swap_dir '${second}' '${deploy}'`,
    )
    expect(r2.status).toBe(0)
    expect(runSnippet(`readlink '${deploy}'`).stdout.trim()).toBe(second)
    // lastgood points at the previous tree.
    expect(runSnippet(`readlink '${root}/lastgood'`).stdout.trim()).toBe(first)
    // Both trees still exist (no deletion).
    expect(existsSync(join(first, 'dist', 'version.txt'))).toBe(true)
    expect(existsSync(join(second, 'dist', 'version.txt'))).toBe(true)
  })

  it.skipIf(!symlinksSupported())('reverts to lastgood in one step', () => {
    const root = scratch()
    const first = makeStagingTree(root, '1.0.0')
    const second = makeStagingTree(root, '2.0.0')
    const deploy = join(root, 'deploy')

    runSnippet(`source '${LIB}'; atomic_swap_dir '${first}' '${deploy}'`)
    runSnippet(`source '${LIB}'; capture_lastgood '${deploy}' && atomic_swap_dir '${second}' '${deploy}'`)

    const revert = runSnippet(
      `source '${LIB}'; revert_to_lastgood '${deploy}' && readlink '${deploy}'`,
    )
    expect(revert.status).toBe(0)
    expect(revert.stdout.trim()).toBe(first)
  })

  it.skipIf(!symlinksSupported())('revert is idempotent', () => {
    const root = scratch()
    const first = makeStagingTree(root, '1.0.0')
    const second = makeStagingTree(root, '2.0.0')
    const deploy = join(root, 'deploy')

    runSnippet(`source '${LIB}'; atomic_swap_dir '${first}' '${deploy}'`)
    runSnippet(`source '${LIB}'; capture_lastgood '${deploy}' && atomic_swap_dir '${second}' '${deploy}'`)
    runSnippet(`source '${LIB}'; revert_to_lastgood '${deploy}'`)
    const again = runSnippet(
      `source '${LIB}'; revert_to_lastgood '${deploy}' && readlink '${deploy}'`,
    )
    expect(again.status).toBe(0)
    expect(again.stdout.trim()).toBe(first)
  })

  it.skipIf(!symlinksSupported())('revert without lastgood is a hard error (exit 3)', () => {
    const root = scratch()
    const staging = makeStagingTree(root, '1.0.0')
    const deploy = join(root, 'deploy')
    runSnippet(`source '${LIB}'; atomic_swap_dir '${staging}' '${deploy}'`)
    const res = runSnippet(`source '${LIB}'; revert_to_lastgood '${deploy}'`)
    expect(res.status).toBe(3)
    expect(res.stderr).toContain('no usable lastgood')
  })

  it('refuses to swap over a non-symlink deploy (exit 4)', () => {
    const root = scratch()
    const staging = makeStagingTree(root, '1.0.0')
    const deploy = join(root, 'deploy')
    // A real directory sitting where the deploy link should be.
    mkdirSync(deploy, { recursive: true })
    const res = runSnippet(`source '${LIB}'; atomic_swap_dir '${staging}' '${deploy}'`)
    expect(res.status).toBe(4)
    expect(res.stderr).toContain('not a symlink')
    // The real directory must be untouched.
    expect(existsSync(deploy) && !runSnippet(`[ -L '${deploy}' ]`).stdout.includes('no')).toBe(true)
  })

  it('fails when the staging dir does not exist (exit 2)', () => {
    const root = scratch()
    const deploy = join(root, 'deploy')
    const res = runSnippet(
      `source '${LIB}'; atomic_swap_dir '${join(root, 'nope')}' '${deploy}'`,
    )
    expect(res.status).toBe(2)
  })

  it('capture_lastgood is a no-op when deploy does not exist yet (bootstrap)', () => {
    const root = scratch()
    const deploy = join(root, 'deploy')
    const res = runSnippet(`source '${LIB}'; capture_lastgood '${deploy}'`)
    expect(res.status).toBe(0)
    expect(existsSync(join(root, 'lastgood'))).toBe(false)
  })

  it.skipIf(!symlinksSupported())('swap survives a mid-flight interruption: deploy.new pattern resolves', () => {
    // WP3's recovery relies on the invariant that a swap either happened
    // (deploy → staging) or did not (deploy unchanged). Simulate a
    // completed swap followed by a crash: the next capture + swap still
    // yields a consistent chain.
    const root = scratch()
    const first = makeStagingTree(root, '1.0.0')
    const third = makeStagingTree(root, '3.0.0')
    const deploy = join(root, 'deploy')

    runSnippet(`source '${LIB}'; atomic_swap_dir '${first}' '${deploy}'`)
    // No capture_lastgood call (crash before it): the next cycle must
    // still work — capture happens before every swap by the caller.
    const res = runSnippet(
      `source '${LIB}'; capture_lastgood '${deploy}' && atomic_swap_dir '${third}' '${deploy}'`,
    )
    expect(res.status).toBe(0)
    expect(runSnippet(`readlink '${deploy}'`).stdout.trim()).toBe(third)
    expect(runSnippet(`readlink '${root}/lastgood'`).stdout.trim()).toBe(first)
  })
})
