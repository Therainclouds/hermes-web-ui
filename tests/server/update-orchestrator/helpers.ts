/**
 * Shared helper for tests that exercise the update shell scripts.
 *
 * The device-side scripts are bash; tests shell out to bash with an
 * isolated HERMES_WEB_UI_HOME so they never touch real state.
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')

const tempHomes: string[] = []

afterAll(() => {
  for (const dir of tempHomes) {
    rmSync(dir, { recursive: true, force: true })
  }
})

export function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-update-test-'))
  tempHomes.push(dir)
  return dir
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export function runBash(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
): RunResult {
  const home = env.HERMES_WEB_UI_HOME ?? makeTempHome()
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HERMES_WEB_UI_HOME: home,
      ...env,
    },
    cwd: REPO_ROOT,
  })
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

/** Execute a snippet that sources a lib and calls its functions. */
export function runSnippet(snippet: string, env: Record<string, string> = {}): RunResult {
  const home = env.HERMES_WEB_UI_HOME ?? makeTempHome()
  const full = `set -uo pipefail\n${snippet}\n`
  const res = spawnSync('bash', ['-c', full], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HERMES_WEB_UI_HOME: home,
      ...env,
    },
    cwd: REPO_ROOT,
  })
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

/**
 * `ln -s` on Windows MSYS copies instead of symlinking unless native
 * symlinks are enabled. CI (ubuntu) always has real symlinks; local
 * Windows runs skip the swap assertions rather than lie about them.
 */
export function symlinksSupported(): boolean {
  const probe = makeTempHome()
  const real = join(probe, 'real')
  const link = join(probe, 'link')
  const res = spawnSync('bash', ['-c', `mkdir -p '${real}' && ln -s '${real}' '${link}' && [ -L '${link}' ] && echo yes || echo no`], {
    encoding: 'utf8',
  })
  return res.stdout?.trim() === 'yes'
}export const SCRIPTS = {
  journalValidator: join(REPO_ROOT, 'scripts', 'journal-validator.sh'),
  journalRotate: join(REPO_ROOT, 'scripts', 'journal-rotate.sh'),
  policyParse: join(REPO_ROOT, 'scripts', 'policy-parse.sh'),
  journalWriteLib: join(REPO_ROOT, 'scripts', '_lib', 'journal-write.sh'),
  atomicSwapLib: join(REPO_ROOT, 'scripts', '_lib', 'atomic-swap.sh'),
}
