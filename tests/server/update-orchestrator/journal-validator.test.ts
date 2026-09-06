/**
 * Seam tests for the JSONL update journal (writer, validator, rotation).
 *
 * Covers scripts/_lib/journal-write.sh, scripts/journal-validator.sh and
 * scripts/journal-rotate.sh. Master spec:
 * docs/harness/source-deploy-refactor.md (§ Journal).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { makeTempHome, runBash, runSnippet, SCRIPTS } from './helpers'

function historyDir(home: string): string {
  return join(home, 'updates', 'history')
}

function quarantineDir(home: string): string {
  return join(home, 'updates', 'quarantine')
}

function journalPath(home: string, taskId: string): string {
  return join(historyDir(home), `${taskId}.jsonl`)
}

function initJournal(home: string, taskId = 'task-1', version = '0.8.1'): void {
  const res = runSnippet(
    `source '${SCRIPTS.journalWriteLib}'; journal_init '${taskId}' '${version}' 'sha-manifest'`,
    { HERMES_WEB_UI_HOME: home },
  )
  expect(res.status).toBe(0)
}

function appendStage(
  home: string,
  taskId: string,
  stage: string,
  message = '',
): { status: number; stderr: string } {
  const res = runSnippet(
    `source '${SCRIPTS.journalWriteLib}'; journal_append '${taskId}' '${stage}' '${message}'`,
    { HERMES_WEB_UI_HOME: home },
  )
  return { status: res.status, stderr: res.stderr }
}

describe('journal writer (_lib/journal-write.sh)', () => {
  it('creates the _meta first line on init', () => {
    const home = makeTempHome()
    initJournal(home, 'meta-task', '9.9.9')
    const lines = readFileSync(journalPath(home, 'meta-task'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const meta = JSON.parse(lines[0])._meta
    expect(meta.taskId).toBe('meta-task')
    expect(meta.version).toBe('9.9.9')
    expect(meta.manifestSha).toBe('sha-manifest')
    expect(meta.startedAt).toBeTruthy()
  })

  it('is idempotent: re-init keeps the existing journal', () => {
    const home = makeTempHome()
    initJournal(home)
    appendStage(home, 'task-1', 'downloading')
    initJournal(home)
    const lines = readFileSync(journalPath(home, 'task-1'), 'utf8').trim().split('\n')
    // _meta + downloading stage survive the second init.
    expect(lines).toHaveLength(2)
  })

  it('appends one JSON line per stage with valid vocabulary', () => {
    const home = makeTempHome()
    initJournal(home)
    expect(appendStage(home, 'task-1', 'downloading', 'range-resume from byte 4096').status).toBe(0)
    expect(appendStage(home, 'task-1', 'verifying').status).toBe(0)
    const lines = readFileSync(journalPath(home, 'task-1'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const entry = JSON.parse(lines[2])
    expect(entry.stage).toBe('verifying')
    expect(entry.message).toBe('')
    expect(entry.at).toBeTruthy()
  })

  it('escapes quotes and newlines in messages', () => {
    const home = makeTempHome()
    initJournal(home)
    appendStage(home, 'task-1', 'failed', 'boom "quoted" and\\slash')
    const lines = readFileSync(journalPath(home, 'task-1'), 'utf8').trim().split('\n')
    const entry = JSON.parse(lines[1])
    expect(entry.message).toBe('boom "quoted" and\\slash')
  })

  it('rejects unknown stage names with exit 2', () => {
    const home = makeTempHome()
    initJournal(home)
    const res = appendStage(home, 'task-1', 'not_a_stage')
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('unknown stage')
  })

  it('fails appending to an uninitialised journal', () => {
    const home = makeTempHome()
    const res = appendStage(home, 'ghost-task', 'downloading')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('not initialised')
  })
})

describe('journal validator', () => {
  it('passes a valid journal and exits 0', () => {
    const home = makeTempHome()
    initJournal(home)
    appendStage(home, 'task-1', 'downloading')
    appendStage(home, 'task-1', 'succeeded')
    const res = runBash(SCRIPTS.journalValidator, [], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('1/1 journals valid')
    expect(existsSync(journalPath(home, 'task-1'))).toBe(true)
  })

  it('quarantines a corrupt JSON line and exits 0', () => {
    const home = makeTempHome()
    initJournal(home)
    appendStage(home, 'task-1', 'downloading')
    // Simulate a torn write: append a truncated line.
    const path = journalPath(home, 'task-1')
    const existing = readFileSync(path, 'utf8')
    writeFileSync(path, `${existing}{"stage":"veri`)
    const res = runBash(SCRIPTS.journalValidator, [], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('update_journal_corrupt')
    expect(existsSync(path)).toBe(false)
    // The quarantined copy retains the content for forensics.
    const quarantinedDir = quarantineDir(home)
    expect(existsSync(quarantinedDir)).toBe(true)
    const quarantinedFiles = readdirSync(quarantinedDir).filter((f) => f.startsWith('task-1'))
    expect(quarantinedFiles.length).toBe(1)
    expect(readFileSync(join(quarantinedDir, quarantinedFiles[0]), 'utf8')).toContain('"stage":"downloading"')
  })

  it('quarantines a journal with an unknown stage name', () => {
    const home = makeTempHome()
    mkdirSync(historyDir(home), { recursive: true })
    writeFileSync(
      journalPath(home, 'bad-stage'),
      '{"_meta":{"taskId":"bad-stage","version":"0.8.1","manifestSha":"x","startedAt":"2026-09-06T00:00:00Z"}}\n' +
        '{"stage":"made_up_stage","at":"2026-09-06T00:00:01Z"}\n',
    )
    const res = runBash(SCRIPTS.journalValidator, [], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('unknown stage')
    expect(existsSync(journalPath(home, 'bad-stage'))).toBe(false)
  })

  it('quarantines a file whose _meta.taskId does not match its name', () => {
    const home = makeTempHome()
    mkdirSync(historyDir(home), { recursive: true })
    writeFileSync(
      journalPath(home, 'mismatch'),
      '{"_meta":{"taskId":"other-task","version":"0.8.1","manifestSha":"x","startedAt":"2026-09-06T00:00:00Z"}}\n',
    )
    const res = runBash(SCRIPTS.journalValidator, [], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('does not match file name')
  })

  it('is a clean no-op on a missing history dir (first boot)', () => {
    const home = makeTempHome()
    const res = runBash(SCRIPTS.journalValidator, [], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('nothing to validate')
  })
})

describe('journal rotation', () => {
  it('keeps the newest N and moves older files to quarantine with a marker', () => {
    const home = makeTempHome()
    mkdirSync(historyDir(home), { recursive: true })
    // Create 5 journals with distinct mtimes: 4 old, 1 recent.
    for (let i = 0; i < 5; i++) {
      writeFileSync(journalPath(home, `task-${i}`), `{"_meta":{"taskId":"task-${i}"}}\n`)
    }
    // Give task-0..3 old mtimes, task-4 the newest.
    const base = Date.now() - 10_000
    for (let i = 0; i < 5; i++) {
      const path = journalPath(home, `task-${i}`)
      const mtime = new Date(base + i * 1000)
      // touch via utimes: set atime/mtime explicitly.
      const { utimesSync } = require('fs') as typeof import('fs')
      utimesSync(path, mtime, mtime)
    }
    const res = runBash(SCRIPTS.journalRotate, ['--keep', '1'], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(existsSync(journalPath(home, 'task-4'))).toBe(true)
    for (let i = 0; i < 4; i++) {
      expect(existsSync(journalPath(home, `task-${i}`))).toBe(false)
      const marker = join(quarantineDir(home), `task-${i}.jsonl.retained_1_rotation`)
      expect(existsSync(marker)).toBe(true)
    }
  })

  it('is a no-op when under the keep window', () => {
    const home = makeTempHome()
    initJournal(home)
    const res = runBash(SCRIPTS.journalRotate, ['--keep', '30'], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('nothing to rotate')
  })

  it('is a clean no-op on a missing history dir', () => {
    const home = makeTempHome()
    const res = runBash(SCRIPTS.journalRotate, [], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
  })
})
