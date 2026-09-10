/**
 * Tests for the knowledge plugin file watcher.
 *
 * Real filesystem only — no memfs or fakes. Chokidar's native
 * backends don't work reliably on fakes, and the production code
 * uses real fs.watch anyway. The spec (task-02-watcher.md) requires
 * real temp dirs with `usePolling: true` so Windows doesn't race
 * with file creation.
 *
 * Why polling in tests: Windows `fs.watch` (ReadDirectoryChangesW)
 * can lose events during the rapid create/write/unlink patterns of
 * test fixtures. Polling is slower but deterministic. Production
 * uses native watchers.
 */

import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  KnowledgeWatcher,
  KnowledgeWatcherManager,
  type IngestEventPayload,
  type VaultOfflineEventPayload,
} from '../../packages/server/src/services/knowledge/watcher'

const STABILITY_MS = 300 // shorter than prod (2000) for test speed

function collectEvents<T>(
  emitter: EventEmitter,
  event: string,
): { payload: T[]; cleanup: () => void } {
  const payload: T[] = []
  const handler = (p: T) => payload.push(p)
  emitter.on(event, handler)
  return {
    payload,
    cleanup: () => emitter.off(event, handler),
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('KnowledgeWatcher', () => {
  let tempDir: string
  let emitter: EventEmitter

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-knowledge-watcher-'))
    emitter = new EventEmitter()
    emitter.setMaxListeners(50)
  })

  afterEach(async () => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  })

  it('emits knowledge:ingest:add once per file write (debounced)', async () => {
    const watcher = new KnowledgeWatcher(1, tempDir, emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })
    const adds = collectEvents<IngestEventPayload>(
      emitter,
      'knowledge:ingest:add',
    )
    try {
      watcher.start()
      // Wait for chokidar's initial scan to settle.
      await waitMs(STABILITY_MS + 50)

      const filePath = join(tempDir, 'doc.md')
      // Simulate a multi-step write: chokidar must collapse the
      // intermediate fs events into a single stable event.
      writeFileSync(filePath, 'part 1')
      await waitMs(50)
      writeFileSync(filePath, 'part 1\npart 2')
      await waitMs(50)
      writeFileSync(filePath, 'part 1\npart 2\npart 3')

      // Wait for awaitWriteFinish to fire.
      await waitMs(STABILITY_MS + 200)

      expect(adds.payload).toHaveLength(1)
      expect(adds.payload[0].vaultId).toBe(1)
      // chokidar may normalize the path (e.g. on Windows); only assert
      // the basename matches so the test doesn't flake on path casing.
      expect(adds.payload[0].path.replace(/\\/g, '/')).toContain('doc.md')
    } finally {
      await watcher.stop()
      adds.cleanup()
    }
  })

  it('emits knowledge:ingest:change on file modification', async () => {
    const filePath = join(tempDir, 'existing.md')
    writeFileSync(filePath, 'initial')

    const watcher = new KnowledgeWatcher(1, tempDir, emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })
    try {
      const changes = collectEvents<IngestEventPayload>(
        emitter,
        'knowledge:ingest:change',
      )
      watcher.start()
      await waitMs(STABILITY_MS + 50)

      writeFileSync(filePath, 'modified content')
      await waitMs(STABILITY_MS + 200)

      expect(changes.payload.length).toBeGreaterThanOrEqual(1)
      expect(changes.payload[0].vaultId).toBe(1)
    } finally {
      await watcher.stop()
    }
  })

  it('emits knowledge:ingest:remove on file deletion', async () => {
    const filePath = join(tempDir, 'to-delete.md')
    writeFileSync(filePath, 'bye')

    const watcher = new KnowledgeWatcher(1, tempDir, emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })
    try {
      const removes = collectEvents<IngestEventPayload>(
        emitter,
        'knowledge:ingest:remove',
      )
      watcher.start()
      await waitMs(STABILITY_MS + 50)

      unlinkSync(filePath)
      await waitMs(STABILITY_MS + 200)

      expect(removes.payload.length).toBeGreaterThanOrEqual(1)
      expect(removes.payload[0].vaultId).toBe(1)
    } finally {
      await watcher.stop()
    }
  })

  it('emits knowledge:vault:offline when root_path is missing at start', () => {
    const missing = join(tempDir, 'does-not-exist')
    const watcher = new KnowledgeWatcher(1, missing, emitter)

    const offlines = collectEvents<VaultOfflineEventPayload>(
      emitter,
      'knowledge:vault:offline',
    )

    watcher.start()

    expect(watcher.isWatching).toBe(false)
    expect(offlines.payload).toHaveLength(1)
    expect(offlines.payload[0].vaultId).toBe(1)
    expect(offlines.payload[0].reason).toBe('root_path_missing')
  })

  it('start() is idempotent', async () => {
    const watcher = new KnowledgeWatcher(1, tempDir, emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })
    try {
      watcher.start()
      watcher.start() // should not throw or create a second watcher
      expect(watcher.isWatching).toBe(true)
    } finally {
      await watcher.stop()
    }
  })

  it('stop() releases the watcher and is idempotent', async () => {
    const watcher = new KnowledgeWatcher(1, tempDir, emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })
    watcher.start()
    expect(watcher.isWatching).toBe(true)

    await watcher.stop()
    expect(watcher.isWatching).toBe(false)

    // Calling stop() again should not throw.
    await watcher.stop()
    expect(watcher.isWatching).toBe(false)
  })

  it('tryRevive() starts a watcher when the root_path reappears', async () => {
    const vaultPath = join(tempDir, 'replugged')
    // Path does not exist yet.
    const watcher = new KnowledgeWatcher(1, vaultPath, emitter)
    watcher.start()
    expect(watcher.isWatching).toBe(false)

    // Simulate USB replug.
    const { mkdirSync } = await import('fs')
    mkdirSync(vaultPath)
    expect(watcher.tryRevive()).toBe(true)
    expect(watcher.isWatching).toBe(true)

    await watcher.stop()
  })

  it('tryRevive() is a no-op if root_path is still missing', () => {
    const missing = join(tempDir, 'still-missing')
    const watcher = new KnowledgeWatcher(1, missing, emitter)
    watcher.start()
    expect(watcher.tryRevive()).toBe(false)
    expect(watcher.isWatching).toBe(false)
  })
})

describe('KnowledgeWatcherManager', () => {
  let tempDir: string
  let emitter: EventEmitter

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-knowledge-manager-'))
    emitter = new EventEmitter()
    emitter.setMaxListeners(50)
  })

  afterEach(async () => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('addVault creates a watcher; removeVault stops it', async () => {
    const manager = new KnowledgeWatcherManager(emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })

    manager.addVault(1, tempDir)
    expect(manager.size).toBe(1)
    expect(manager.get(1)?.isWatching).toBe(true)

    // Second add for the same vault is a no-op.
    manager.addVault(1, tempDir)
    expect(manager.size).toBe(1)

    await manager.removeVault(1)
    expect(manager.size).toBe(0)

    // Removing again returns false.
    expect(await manager.removeVault(1)).toBe(false)
  })

  it('stopAll clears every watcher', async () => {
    const { mkdirSync } = await import('fs')
    const dir2 = join(tempDir, 'v2')
    mkdirSync(dir2)

    const manager = new KnowledgeWatcherManager(emitter, {
      awaitWriteFinishStabilityMs: STABILITY_MS,
      usePolling: true,
    })
    manager.addVault(1, tempDir)
    manager.addVault(2, dir2)
    expect(manager.size).toBe(2)

    await manager.stopAll()
    expect(manager.size).toBe(0)
  })
})
