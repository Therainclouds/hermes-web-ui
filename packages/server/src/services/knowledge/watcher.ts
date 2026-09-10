/**
 * Knowledge plugin — file watcher.
 *
 * Watches each vault's root_path for file events (add / change /
 * unlink) and forwards them to a shared EventEmitter. The watcher
 * never reads file contents — that is the extractor's job (Task 3).
 *
 * Debounce: chokidar's `awaitWriteFinish` option ensures we only emit
 * once a file has been fully written (so a USB drop that writes a
 * large file over 2s triggers one event, not many).
 *
 * Events emitted on the EventEmitter:
 *   - knowledge:ingest:add    { vaultId, path }
 *   - knowledge:ingest:change { vaultId, path }
 *   - knowledge:ingest:remove { vaultId, path }
 *   - knowledge:vault:offline { vaultId, reason }
 *
 * Source of truth: docs/knowledge-architecture.md §4.1, §10.3.
 * Implementation spec: docs/knowledge/specs/task-02-watcher.md.
 */

import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import chokidar, { type FSWatcher } from 'chokidar'

export interface VaultWatcherOptions {
  /**
   * Debounce: wait for this many ms of idle time before emitting an
   * event for a file write. Matches the architecture doc's
   * `KNOWLEDGE_WATCHER_DEBOUNCE_MS` (default 2000).
   */
  awaitWriteFinishStabilityMs?: number

  /**
   * Number of chokidar `error` events tolerated before marking the
   * vault offline. Default 3 per §10.2.
   */
  maxErrorsBeforeOffline?: number

  /**
   * Internal test hook — use polling instead of native `fs.watch`.
   * Required on Windows where native watchers can race with file
   * creation in temp dirs, and used by tests against real temp dirs.
   */
  usePolling?: boolean
}

export interface IngestEventPayload {
  vaultId: number
  path: string
}

export interface VaultOfflineEventPayload {
  vaultId: number
  reason: string
}

/**
 * Per-vault file watcher. Emits ingest events on the shared
 * EventEmitter. Does not read file contents — that is the
 * extractor's job.
 */
export class KnowledgeWatcher {
  private watcher: FSWatcher | null = null
  private errorCount = 0
  private readonly awaitWriteFinishStabilityMs: number
  private readonly maxErrorsBeforeOffline: number
  private readonly usePolling: boolean

  constructor(
    private readonly vaultId: number,
    private readonly rootPath: string,
    private readonly emitter: EventEmitter,
    options: VaultWatcherOptions = {},
  ) {
    this.awaitWriteFinishStabilityMs =
      options.awaitWriteFinishStabilityMs ?? 2000
    this.maxErrorsBeforeOffline = options.maxErrorsBeforeOffline ?? 3
    this.usePolling = options.usePolling ?? false
  }

  /**
   * Start watching. Idempotent — calling start() twice does not
   * create a second watcher.
   */
  start(): void {
    if (this.watcher) return
    if (!existsSync(this.rootPath)) {
      // Vault root_path doesn't exist on boot — emit offline immediately
      // and don't create a watcher. The orchestrator can re-attempt via
      // `tryRevive()` when the vault comes back online.
      this.emitOffline('root_path_missing')
      return
    }

    this.watcher = chokidar.watch(this.rootPath, {
      persistent: true,
      ignoreInitial: true, // only watch new events, not existing files
      awaitWriteFinish: {
        stabilityThreshold: this.awaitWriteFinishStabilityMs,
        pollInterval: 100,
      },
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      usePolling: this.usePolling,
      interval: this.usePolling ? 100 : undefined,
    })

    this.watcher
      .on('add', (path) => this.emitIngest('add', path))
      .on('change', (path) => this.emitIngest('change', path))
      .on('unlink', (path) => this.emitIngest('remove', path))
      .on('error', (err) => this.handleError(err))
  }

  /**
   * Stop the watcher. Idempotent — safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.watcher) return
    await this.watcher.close()
    this.watcher = null
    this.errorCount = 0
  }

  /**
   * Check whether the watcher is currently active.
   */
  get isWatching(): boolean {
    return this.watcher !== null
  }

  /**
   * Try to revive a watcher whose root_path was missing at start
   * time (USB re-plugged). Returns true if a watcher was started.
   */
  tryRevive(): boolean {
    if (this.watcher) return false
    if (!existsSync(this.rootPath)) return false
    this.errorCount = 0
    this.start()
    return this.watcher !== null
  }

  private emitIngest(
    event: 'add' | 'change' | 'remove',
    path: string,
  ): void {
    const eventName =
      event === 'add'
        ? 'knowledge:ingest:add'
        : event === 'change'
          ? 'knowledge:ingest:change'
          : 'knowledge:ingest:remove'
    const payload: IngestEventPayload = {
      vaultId: this.vaultId,
      path,
    }
    this.emitter.emit(eventName, payload)
  }

  private emitOffline(reason: string): void {
    const payload: VaultOfflineEventPayload = {
      vaultId: this.vaultId,
      reason,
    }
    this.emitter.emit('knowledge:vault:offline', payload)
  }

  private handleError(err: Error): void {
    this.errorCount += 1
    // Log every error for debugging, but only mark offline after the
    // tolerance is exhausted (arch doc §10.2: "chokidar throws → retry
    // 3x; if all fail, vault watch=0").
    // eslint-disable-next-line no-console
    console.error(
      `knowledge: watcher error on vault ${this.vaultId} ` +
        `(${this.rootPath}): ${err.message} ` +
        `(${this.errorCount}/${this.maxErrorsBeforeOffline})`,
    )
    if (this.errorCount >= this.maxErrorsBeforeOffline) {
      this.emitOffline('watcher_error_threshold')
      void this.stop()
    }
  }
}

/**
 * Manages one KnowledgeWatcher per vault. Provides a uniform surface
 * for the orchestrator (Task 6) to add / remove / stop all watchers.
 */
export class KnowledgeWatcherManager {
  private readonly watchers = new Map<number, KnowledgeWatcher>()

  constructor(
    private readonly emitter: EventEmitter,
    private readonly defaultOptions: VaultWatcherOptions = {},
  ) {}

  /**
   * Register and start a watcher for a vault. If a watcher for this
   * vault already exists, this is a no-op.
   */
  addVault(vaultId: number, rootPath: string): KnowledgeWatcher {
    const existing = this.watchers.get(vaultId)
    if (existing) return existing
    const watcher = new KnowledgeWatcher(
      vaultId,
      rootPath,
      this.emitter,
      this.defaultOptions,
    )
    this.watchers.set(vaultId, watcher)
    watcher.start()
    return watcher
  }

  /**
   * Stop and remove the watcher for a vault. Returns true if a
   * watcher was removed.
   */
  async removeVault(vaultId: number): Promise<boolean> {
    const watcher = this.watchers.get(vaultId)
    if (!watcher) return false
    await watcher.stop()
    this.watchers.delete(vaultId)
    return true
  }

  /**
   * Stop all watchers. Called on server shutdown.
   */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.watchers.values()).map((w) => w.stop())
    await Promise.all(stops)
    this.watchers.clear()
  }

  /**
   * Get the watcher for a vault (or undefined if none).
   */
  get(vaultId: number): KnowledgeWatcher | undefined {
    return this.watchers.get(vaultId)
  }

  /**
   * Number of active watchers.
   */
  get size(): number {
    return this.watchers.size
  }
}
