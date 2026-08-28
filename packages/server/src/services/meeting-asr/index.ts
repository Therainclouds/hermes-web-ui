import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { logger } from '../logger'

export interface MeetingASRConfig {
  dashscopeApiKey?: string
  asrModel?: string  // 'paraformer-v2' | 'fun-asr' | 'fun-asr-mtl'
  paraformerWsUrl?: string
  paraformerModel?: string
  paraformerSampleRate?: number
  paraformerFormat?: string
  paraformerLanguageHints?: string
  paraformerSemanticPunctuation?: boolean
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  dataDir?: string
  host?: string
  asrPort?: number
  diarizePort?: number
  ossBucket?: string
  ossAccessKeyId?: string
  ossAccessKeySecret?: string
  ossEndpoint?: string
  ossPathPrefix?: string
}

export interface MeetingASRStatus {
  isRunning: boolean
  asrPort: number | null
  diarizePort: number | null
  pid: number | null
  uptime: number | null
  error: string | null
  /**
   * Where the service is in its startup lifecycle. Used by the UI to render
   * phase-specific copy (e.g. "installing dependencies, ~3 min on ARM64")
   * instead of a generic "connecting". Also surfaced while waiting for
   * `isRunning=true` after the user clicks record.
   */
  startupPhase: StartupPhase
  /** True iff the Python venv probe passed at least once this run. */
  isVenvReady: boolean
  /**
   * Whether the spawned uvicorn processes serve HTTPS. The Node WS proxy in
   * bootstrap reads this so the upgrade handler picks `tls.connect` vs
   * `net.connect` automatically — no deploy-time env coordination needed.
   */
  useTls: boolean
}

/**
 * Startup lifecycle phase. Exposed via MeetingASRStatus so the front-end can
 * show actionable progress without inventing its own state machine.
 */
export type StartupPhase =
  | 'idle'
  | 'venv'           // probing / creating the Python virtual environment
  | 'pip_install'    // installing requirements inside the venv (slow on ARM64)
  | 'starting'       // spawning uvicorn for asr / diarize
  | 'ready'          // both healthz endpoints respond OK
  | 'error'

export class MeetingASRService extends EventEmitter {
  private static instance: MeetingASRService | null = null
  private mainProcess: ChildProcess | null = null
  private diarizeProcess: ChildProcess | null = null
  private _isRunning = false
  private _startTime: number | null = null
  private _config: MeetingASRConfig = {}
  private _error: string | null = null
  private _asrPort: number | null = null
  private _diarizePort: number | null = null
  // Auto-restart: when true, an unexpected main-process exit triggers a
  // bounded backoff restart loop. Disabled by stop() to avoid fighting
  // deliberate shutdowns.
  private _autoRestart = false
  private _restartAttempts = 0
  private _restartTimer: NodeJS.Timeout | null = null
  private static readonly MAX_RESTART_ATTEMPTS = 5
  private static readonly RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]

  // Startup phase tracking + health monitor (added for v0.7.8 to surface
  // long-running start phases and recover from silent OOM kills).
  private _startupPhase: StartupPhase = 'idle'
  private _isVenvReady = false
  private _healthTimer: NodeJS.Timeout | null = null
  private _healthFailures = 0
  private static readonly HEALTH_PROBE_INTERVAL_MS = 30_000
  private static readonly HEALTH_PROBE_TIMEOUT_MS = 5_000
  private static readonly HEALTH_FAILURES_BEFORE_RESTART = 3

  // TLS mode is decided at construction from env so that:
  //   1. spawn() can pass --ssl-keyfile/--ssl-certfile to uvicorn, and
  //   2. the WS upgrade proxy in bootstrap/index.ts can pick the matching
  //      transport (tls.connect vs net.connect) without an extra env hop.
  // Default is plain HTTP (dev-friendly); device images set
  // HERMES_WEB_UI_MEETING_ASR_TLS=true to use the shared self-signed cert
  // under packages/server/certs/.
  private readonly _useTls: boolean =
    String(process.env.HERMES_WEB_UI_MEETING_ASR_TLS || '').toLowerCase() === 'true'

  private constructor() {
    super()
  }

  static getInstance(): MeetingASRService {
    if (!MeetingASRService.instance) {
      MeetingASRService.instance = new MeetingASRService()
    }
    return MeetingASRService.instance
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  get status(): MeetingASRStatus {
    return {
      isRunning: this._isRunning,
      asrPort: this._asrPort,
      diarizePort: this._diarizePort,
      pid: this.mainProcess?.pid || null,
      uptime: this._startTime ? Date.now() - this._startTime : null,
      error: this._error,
      startupPhase: this._startupPhase,
      isVenvReady: this._isVenvReady,
      useTls: this._useTls,
    }
  }

  /**
   * Public read-only view of the TLS decision so the WS upgrade proxy in
   * bootstrap/index.ts can pick tls.connect vs net.connect without reading
   * process.env on its own. Constant for the lifetime of the process — the
   * env is sampled once at construction.
   */
  get useTls(): boolean {
    return this._useTls
  }

  private getPythonBackendPath(): string {
    return path.join(__dirname, 'python-backend')
  }

  /**
   * Build the `--ssl-*` argv pair for uvicorn when running in TLS mode.
   *
   * Path resolution matches the Node HTTPS server in bootstrap/index.ts so
   * both sides use the same self-signed cert under packages/server/certs/.
   * Env overrides exist for non-standard deploy layouts.
   *
   * Returns [] when TLS is off — the caller spreads these into uvicorn argv.
   */
  private _uvicornTlsArgs(): string[] {
    if (!this._useTls) return []
    const certPath = process.env.HERMES_WEB_UI_SSL_CERTFILE
      || path.resolve(__dirname, '..', '..', 'certs', 'server.crt')
    const keyPath = process.env.HERMES_WEB_UI_SSL_KEYFILE
      || path.resolve(__dirname, '..', '..', 'certs', 'server.key')
    return ['--ssl-certfile', certPath, '--ssl-keyfile', keyPath]
  }

  private getDataDir(): string {
    // Resolution order (highest priority first):
    //   1. start({ dataDir }) constructor arg — used by tests and ad-hoc
    //      overrides from /api/meeting-asr/start.
    //   2. MEETING_ASR_DATA_DIR env var — set by deploy-source-armbian.sh
    //      so the pre-warmed venv and the runtime venv share the same path
    //      (was a regression risk before v0.7.16; see audit #1).
    //   3. <cwd>/data/meeting-asr — the historical default for non-systemd
    //      dev runs.
    return (
      this._config.dataDir
      || process.env.MEETING_ASR_DATA_DIR
      || path.join(process.cwd(), 'data', 'meeting-asr')
    )
  }

  /**
   * Resolve where the Python virtual environment should live.
   *
   * The venv must NOT sit under `python-backend/` because that directory is
   * part of the deployed bundle (`dist/server/services/meeting-asr/python-backend/`)
   * and is owned by the deploy user. If the runtime service runs as a
   * different (non-root) user it cannot write into the venv directory and
   * the first `start` call fails with EACCES — see incident at
   * `docs/planning/meeting-mode-rk3528-audit.md` #1 and #5.
   *
   * We co-locate the venv with the rest of the meeting-asr persistent state
   * under `dataDir/.venv/`. The data directory is owned by the runtime user
   * (`WorkingDirectory={{DEPLOY_DIR}}` in systemd + mkdir at bootstrap) and
   * survives device-package upgrades because it's outside the dist tree.
   *
   * `pythonBackendPath` is kept as an argument so the same helper is callable
   * from tests with arbitrary tmp paths and so future overrides (env var,
   * per-profile data dirs) can be added without churning call sites.
   */
  resolveVenvPath(dataDir: string, _pythonBackendPath: string): string {
    return path.join(dataDir, '.venv')
  }

  resolveVenvMarkerPath(venvPath: string): string {
    return path.join(venvPath, '.hermes-ready')
  }

  /**
   * Recover the DashScope API key from persistent storage when the caller
   * didn't pass one inline. The Python backend stores secrets in two files
   * under dataDir, and we must check both:
   *
   *   - config.json: written by the Node controller's /api/config proxy and
   *     by updateLLMConfig(). Key lives at `llm.api_key` or `asr.dashscope_api_key`.
   *   - config.env: written by Python `storage.update_config()` as shell-style
   *     `DASHSCOPE_API_KEY=sk-...` lines, consumed by `config.py` at import
   *     time via python-dotenv.
   *
   * Before this fix, the fallback only read config.json, so auto-restart or
   * first-start-after-deploy failed with "DASHSCOPE_API_KEY is not configured"
   * whenever the key had been persisted exclusively via the Python path
   * (config.env) — which is the common case after the user saves ASR config
   * from the UI.
   */
  async readStoredDashScopeKey(dataDir: string): Promise<string | null> {
    // 1. config.json (JSON)
    try {
      const configPath = path.join(dataDir, 'config.json')
      const raw = await fs.readFile(configPath, 'utf-8')
      const stored = JSON.parse(raw)
      const key = stored?.asr?.dashscope_api_key || stored?.llm?.api_key
      if (key) return key
    } catch { /* file missing or invalid JSON */ }

    // 2. config.env (shell-style KEY=VALUE lines)
    try {
      const envPath = path.join(dataDir, 'config.env')
      const raw = await fs.readFile(envPath, 'utf-8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        if (trimmed.slice(0, eq).trim() === 'DASHSCOPE_API_KEY') {
          let val = trimmed.slice(eq + 1).trim()
          // Strip surrounding quotes if present
          if ((val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          if (val) return val
        }
      }
    } catch { /* file missing */ }

    return null
  }

  private async findPython(): Promise<string> {
    const candidates = os.platform() === 'win32'
      ? ['python', 'python3', 'py -3', 'py']
      : ['python3', 'python']

    for (const cmd of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cmd, ['--version'], { stdio: 'pipe' })
          proc.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`exit code ${code}`))
          })
          proc.on('error', reject)
        })
        return cmd
      } catch {
        continue
      }
    }
    throw new Error('Python not found. Please install Python 3.')
  }

  private getVenvPythonPath(venvPath: string): string {
    return os.platform() === 'win32'
      ? path.join(venvPath, 'Scripts', 'python.exe')
      : path.join(venvPath, 'bin', 'python')
  }

  private async ensureVirtualEnv(): Promise<string> {
    const backendPath = this.getPythonBackendPath()
    const dataDir = this.getDataDir()
    const venvPath = this.resolveVenvPath(dataDir, backendPath)
    const pythonPath = this.getVenvPythonPath(venvPath)
    // Marker file written after a successful pip install — lets us skip the
    // ~3-10 minute install on ARM64 after the first successful run. Treated
    // as a hint, not a hard guarantee: the probe below still verifies that
    // the binary actually executes.
    const markerPath = this.resolveVenvMarkerPath(venvPath)

    const probePython = async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const probe = spawn(pythonPath, ['-c', 'import sys; sys.exit(0)'], { stdio: 'pipe' })
        probe.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`venv python exited ${code}`))
        })
        probe.on('error', reject)
      })
    }

    // Fast path: marker present + python executable + probe passes → reuse.
    try {
      await fs.access(pythonPath)
      await fs.access(markerPath)
      this._startupPhase = 'venv'
      this.emit('phase', this._startupPhase)
      await probePython()
      this._isVenvReady = true
      logger.info('[meeting-asr] Reusing existing Python virtual environment at %s', venvPath)
      return pythonPath
    } catch {
      // fall through to slow path
    }

    // Migration path (v0.7.16+): if the legacy venv at
    // `<pythonBackend>/.venv` exists and is probe-healthy, move it to the
    // new data-dir location atomically. This preserves the multi-minute
    // `pip install` work already done on the device and keeps the
    // "start → ready in seconds" UX contract. Without this, every upgrade
    // would trigger a fresh 5-10 min pip install on ARM64.
    const legacyVenvPath = path.join(backendPath, '.venv')
    const legacyPythonPath = this.getVenvPythonPath(legacyVenvPath)
    try {
      await fs.access(legacyPythonPath)
      // Legacy venv exists — verify it actually works before moving it,
      // so we don't relocate a broken venv and then trust it.
      await new Promise<void>((resolve, reject) => {
        const probe = spawn(legacyPythonPath, ['-c', 'import sys; sys.exit(0)'], { stdio: 'pipe' })
        probe.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`legacy venv python exited ${code}`))
        })
        probe.on('error', reject)
      })
      // Legacy venv is healthy. Move it. fs.rename is atomic on the same
      // filesystem; if cross-device (unlikely for /opt → /var/lib on the
      // same root partition) it falls back to copy + remove below.
      await fs.mkdir(path.dirname(venvPath), { recursive: true })
      try {
        await fs.rename(legacyVenvPath, venvPath)
      } catch (renameErr) {
        // Cross-device rename: fall back to recursive copy then remove.
        // Node fs.cp is available on Node 16.7+; we use it explicitly so
        // the failure mode is observable instead of silent.
        logger.warn(
          '[meeting-asr] fs.rename failed (%s); falling back to recursive copy',
          renameErr instanceof Error ? renameErr.message : String(renameErr),
        )
        await fs.cp(legacyVenvPath, venvPath, { recursive: true, force: true })
        await fs.rm(legacyVenvPath, { recursive: true, force: true })
      }
      // Re-link the venv's absolute python path if the venv was created
      // with absolute symlinks. Most venvs use relative symlinks so a move
      // is safe; if the probe below fails, the slow path recreates.
      try {
        await probePython()
        // Move succeeded and the relocated venv probes clean — write the
        // marker so the next start hits the fast path.
        try {
          await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8')
        } catch (err) {
          logger.warn('[meeting-asr] Could not write venv marker %s: %s', markerPath, err)
        }
        this._isVenvReady = true
        logger.info(
          '[meeting-asr] Migrated legacy venv %s -> %s (fast path preserved)',
          legacyVenvPath,
          venvPath,
        )
        return pythonPath
      } catch (probeErr) {
        logger.warn(
          '[meeting-asr] Migrated venv failed probe (%s); proceeding to recreate',
          probeErr instanceof Error ? probeErr.message : String(probeErr),
        )
        // Remove the broken relocated venv so createVenv starts clean.
        await fs.rm(venvPath, { recursive: true, force: true })
      }
    } catch {
      // Legacy venv absent or broken — proceed to fresh creation below.
    }

    // Slow path: venv missing, broken, or marker absent — recreate + install.
    const createVenv = async (): Promise<void> => {
      this._startupPhase = 'venv'
      this.emit('phase', this._startupPhase)
      logger.info('[meeting-asr] Creating Python virtual environment at %s', venvPath)
      const pythonCmd = await this.findPython()
      const createStderr = await this.runCaptured(pythonCmd, ['-m', 'venv', venvPath], backendPath)
      if (createStderr.code !== 0) {
        const hint = createStderr.stderr.includes('ensurepip')
          ? ' On Debian/Ubuntu/Armbian, ensure python3-venv is installed: apt-get install -y python3-venv python3-dev'
          : ''
        throw new Error(
          `Failed to create Python venv (exit ${createStderr.code}): ${createStderr.stderr.trim() || 'no stderr'}.${hint}`,
        )
      }
    }

    try {
      await fs.access(pythonPath)
    } catch {
      await createVenv()
    }

    // Guard against a partial venv left behind by an interrupted creation:
    // the venv python exists but pip is missing (e.g. the service was
    // restarted mid-`python -m venv`). Proceeding straight to `pip install`
    // would loop on "No module named pip" forever, so wipe and recreate.
    const pipProbe = await this.runCaptured(pythonPath, ['-m', 'pip', '--version'], backendPath, 60_000)
    if (pipProbe.code !== 0) {
      logger.warn(
        '[meeting-asr] venv python exists but pip is missing (%s); recreating venv',
        pipProbe.stderr.trim().slice(-200) || `exit ${pipProbe.code}`,
      )
      await fs.rm(venvPath, { recursive: true, force: true })
      await createVenv()
    }

    // Install requirements. May take 5-10 minutes on ARM64 — surface phase so
    // the UI can show "installing dependencies (~3 min)…" instead of "connecting".
    this._startupPhase = 'pip_install'
    this.emit('phase', this._startupPhase)
    logger.info('[meeting-asr] Installing Python dependencies (this may take several minutes on ARM64)...')
    const requirementsPath = path.join(__dirname, 'requirements.txt')
    const installStderr = await this.runCaptured(
      pythonPath,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath],
      backendPath,
    )
    if (installStderr.code !== 0) {
      throw new Error(
        `Failed to install Python dependencies (exit ${installStderr.code}): ` +
          `${installStderr.stderr.trim().slice(-500) || 'no stderr'}. ` +
          `Verify the device has network access to PyPI.`,
      )
    }

    // Write the marker so subsequent starts can take the fast path.
    try {
      await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8')
    } catch (err) {
      logger.warn('[meeting-asr] Could not write venv marker %s: %s', markerPath, err)
    }

    this._isVenvReady = true
    return pythonPath
  }

  /**
   * Run a child process to completion, capturing stderr so we can surface
   * actionable errors instead of opaque exit codes.
   */
  private runCaptured(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs = 15 * 60 * 1000,
  ): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      let proc: ChildProcess
      try {
        proc = spawn(cmd, args, { cwd, stdio: 'pipe' })
      } catch (err) {
        reject(err)
        return
      }
      proc.stderr?.on('data', (d) => {
        stderr += d.toString()
        // Cap memory: only keep the last 64KB of stderr
        if (stderr.length > 64 * 1024) {
          stderr = stderr.slice(-64 * 1024)
        }
      })
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error(`Process ${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stderr })
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async start(config: MeetingASRConfig = {}): Promise<void> {
    if (this._isRunning) {
      // Service is already up. Decide between restart and hot-config push:
      //   - OSS_* fields require a restart because Python config.py reads
      //     them from os.environ at import time (no runtime override).
      //   - All other fields (DashScope key, Paraformer, LLM) are pushed via
      //     updateConfig() → POST /api/config so we avoid interrupting the
      //     user's recording session.
      if (config.ossBucket || config.ossAccessKeyId || config.ossAccessKeySecret) {
        logger.info('[meeting-asr] OSS config provided while running; restarting to pick up new credentials')
        await this.stop()
        // Fall through to the normal start path below.
      } else {
        try {
          await this.updateConfig(config)
          logger.info('[meeting-asr] Hot-pushed non-OSS config to running service')
          return
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this._error = `config push failed: ${msg}`
          logger.error('[meeting-asr] %s', this._error)
          this.emit('error', err)
          // Surface the failure to the caller instead of silently dropping
          // the new config like v0.7.7 did — the user must know their
          // updated key did not take effect.
          throw err
        }
      }
    }

    this._config = config
    this._error = null
    this._startupPhase = 'venv'
    this.emit('phase', this._startupPhase)

    try {
      // Reset restart counter for a deliberate start.
      this._restartAttempts = 0
      this._autoRestart = true
      if (this._restartTimer) {
        clearTimeout(this._restartTimer)
        this._restartTimer = null
      }
      // Stop any leftover health monitor from a prior failed start.
      this._stopHealthMonitor()
      this._healthFailures = 0

      // Ensure data directory exists
      const dataDir = this.getDataDir()
      await fs.mkdir(dataDir, { recursive: true })

      // Get Python path
      const pythonPath = await this.ensureVirtualEnv()
      const backendPath = this.getPythonBackendPath()

      // Set ports
      this._asrPort = config.asrPort || 8000
      this._diarizePort = config.diarizePort || 8001

      // Build environment variables
      const env: Record<string, string> = {
        ...process.env,
        DATA_DIR: dataDir,
        BACKEND_HOST: config.host || '0.0.0.0',
        BACKEND_PORT: String(this._asrPort),
        DIARIZE_PORT: String(this._diarizePort),
        CORS_ORIGIN: `http://localhost:${process.env.PORT || 6060}`,
      }

      if (config.dashscopeApiKey) {
        env.DASHSCOPE_API_KEY = config.dashscopeApiKey
      } else {
        // Auto-restart fallback: the caller (UI or auto-restart) didn't
        // provide a key inline, so recover it from persistent storage.
        // The Python backend stores secrets in TWO files under dataDir:
        //   - config.json  (LLM section: llm.api_key)
        //   - config.env    (shell-style: DASHSCOPE_API_KEY=...)
        // We check both because the Python `storage.update_config` writes
        // config.env for env-based consumption (used by config.py at import
        // time) while the Node controller's updateASRConfig pushes via
        // /api/config which only touches config.json. Missing either source
        // meant "DASHSCOPE_API_KEY is not configured" on auto-restart or
        // first UI start after a deploy.
        try {
          const key = await this.readStoredDashScopeKey(dataDir)
          if (key) env.DASHSCOPE_API_KEY = key
        } catch { /* best effort */ }
      }
      if (config.asrModel) {
        env.ASR_MODEL = config.asrModel
      }
      if (config.paraformerWsUrl) {
        env.PARAFORMER_WS_URL = config.paraformerWsUrl
      }
      if (config.paraformerModel) {
        env.PARAFORMER_MODEL = config.paraformerModel
      }
      if (config.paraformerSampleRate) {
        env.PARAFORMER_SAMPLE_RATE = String(config.paraformerSampleRate)
      }
      if (config.paraformerFormat) {
        env.PARAFORMER_FORMAT = config.paraformerFormat
      }
      if (config.paraformerLanguageHints) {
        env.PARAFORMER_LANGUAGE_HINTS = config.paraformerLanguageHints
      }
      if (config.paraformerSemanticPunctuation !== undefined) {
        env.PARAFORMER_SEMANTIC_PUNCTUATION = String(config.paraformerSemanticPunctuation)
      }
      // OSS config for diarize OSS-based chunk flow (speaker diarization)
      if (config.ossBucket) {
        env.OSS_BUCKET = config.ossBucket
      }
      if (config.ossAccessKeyId) {
        env.OSS_ACCESS_KEY_ID = config.ossAccessKeyId
      }
      if (config.ossAccessKeySecret) {
        env.OSS_ACCESS_KEY_SECRET = config.ossAccessKeySecret
      }
      if (config.ossEndpoint) {
        env.OSS_ENDPOINT = config.ossEndpoint
      }
      if (config.ossPathPrefix) {
        env.OSS_PATH_PREFIX = config.ossPathPrefix
      }
      if (config.llmApiKey) {
        // LLM config is stored in the data dir config.json
        // We'll write it after starting
      }

      // Start main ASR process
      this._startupPhase = 'starting'
      this.emit('phase', this._startupPhase)
      logger.info('[meeting-asr] Starting main ASR service on port %d...', this._asrPort)
      const mainUvicornArgs = [
        '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', String(this._asrPort),
        ...this._uvicornTlsArgs(),
      ]
      this.mainProcess = spawn(pythonPath, mainUvicornArgs, {
        cwd: backendPath,
        env,
        stdio: 'pipe',
        detached: false,
      })

      this.mainProcess.stdout?.on('data', (data) => {
        logger.debug('[meeting-asr:main] %s', data.toString().trim())
      })

      this.mainProcess.stderr?.on('data', (data) => {
        logger.debug('[meeting-asr:main] %s', data.toString().trim())
      })

      this.mainProcess.on('error', (err) => {
        logger.error('[meeting-asr] Main process error: %s', err.message)
        this._error = err.message
        this.emit('error', err)
      })

      this.mainProcess.on('close', (code) => {
        logger.info('[meeting-asr] Main process exited with code %d', code ?? 0)
        this._isRunning = false
        this._stopHealthMonitor()
        this.emit('stopped', code ?? 0)
        // Auto-restart on unexpected crash, unless explicitly stopped.
        if (this._autoRestart && (code ?? 0) !== 0) {
          this._scheduleRestart('main process exited unexpectedly')
        }
      })

      // Start diarize process
      logger.info('[meeting-asr] Starting diarize service on port %d...', this._diarizePort)
      const diarizeUvicornArgs = [
        '-m', 'uvicorn', 'app.diarize_server:app', '--host', '0.0.0.0', '--port', String(this._diarizePort),
        ...this._uvicornTlsArgs(),
      ]
      this.diarizeProcess = spawn(pythonPath, diarizeUvicornArgs, {
        cwd: backendPath,
        env,
        stdio: 'pipe',
        detached: false,
      })

      this.diarizeProcess.stdout?.on('data', (data) => {
        logger.info('[meeting-asr:diarize:out] %s', data.toString().trim())
      })

      this.diarizeProcess.stderr?.on('data', (data) => {
        logger.info('[meeting-asr:diarize:err] %s', data.toString().trim())
      })

      this.diarizeProcess.on('error', (err) => {
        logger.error('[meeting-asr] Diarize process error: %s', err.message)
      })

      this.diarizeProcess.on('close', (code) => {
        logger.info('[meeting-asr] Diarize process exited with code %d', code ?? 0)
      })

      // Wait for services to be ready
      await this.waitForReady()

      this._isRunning = true
      this._startTime = Date.now()
      this._startupPhase = 'ready'
      this.emit('phase', this._startupPhase)

      // Write LLM config if provided
      if (config.llmApiKey || config.llmBaseUrl || config.llmModel) {
        await this.updateLLMConfig(config)
      }

      // Begin background health monitor — recovers from silent OOM kills
      // by recycling through the existing _scheduleRestart pipeline.
      this._startHealthMonitor()

      logger.info('[meeting-asr] Services started successfully')
      this.emit('started')

    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err)
      this._startupPhase = 'error'
      this.emit('phase', this._startupPhase)
      logger.error('[meeting-asr] Failed to start services: %s', this._error)
      await this.stop()
      throw err
    }
  }

  private async waitForReady(timeout = 60000): Promise<void> {
    // Poll main (:8000) and diarize (:8001) healthz in parallel. Both must be
    // healthy before we declare the service ready — silence on diarize means
    // user-side speaker-diarization will silently hang without diagnostics.
    //
    // When the backend is HTTPS, Node's native fetch rejects the self-signed
    // cert, so we route through `node:https` with rejectUnauthorized:false.
    const startTime = Date.now()
    let mainOk = false
    let diarizeOk = false
    let mainLastErr = ''
    let diarizeLastErr = ''

    while (Date.now() - startTime < timeout) {
      if (!mainOk && this._asrPort) {
        const r = await this.probeHealthz(this._asrPort)
        if (r.ok) {
          mainOk = true
          logger.info('[meeting-asr] Main service is ready on :%d', this._asrPort)
        } else {
          mainLastErr = r.err || `main healthz status ${r.status}`
        }
      }

      if (!diarizeOk && this._diarizePort) {
        const r = await this.probeHealthz(this._diarizePort)
        if (r.ok) {
          diarizeOk = true
          logger.info('[meeting-asr] Diarize service is ready on :%d', this._diarizePort)
        } else {
          diarizeLastErr = r.err || `diarize healthz status ${r.status}`
        }
      }

      if (mainOk && diarizeOk) return

      // Bail early if either process died unexpectedly
      if (this.mainProcess?.exitCode !== null && this.mainProcess?.exitCode !== undefined) {
        throw new Error(
          `Main ASR process exited with code ${this.mainProcess.exitCode} during startup. ` +
            `Check journald logs for traceback.`,
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    const missing = [
      mainOk ? null : `main(:${this._asrPort}): ${mainLastErr || 'no response'}`,
      diarizeOk ? null : `diarize(:${this._diarizePort}): ${diarizeLastErr || 'no response'}`,
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(
      `Timeout waiting for ASR services to be ready after ${timeout}ms. Not ready: ${missing}.`,
    )
  }

  /**
   * Single-port healthz probe. Matches the protocol chosen for uvicorn:
   *   - dev (useTls=false) → plain http://
   *   - device (useTls=true) → https:// with rejectUnauthorized:false because
   *     the cert is the shared self-signed one under packages/server/certs/
   *
   * Earlier this hard-coded `http://` and assumed Node terminates TLS
   * externally — true for the WS upgrade path, but not when uvicorn itself
   * was spawned with --ssl-certfile (which is what `_useTls=true` implies).
   */
  private async probeHealthz(
    port: number,
    timeoutMs = 2000,
  ): Promise<{ ok: boolean; status?: number; err?: string }> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const scheme = this._useTls ? 'https' : 'http'
      const url = `${scheme}://127.0.0.1:${port}/healthz`
      // Dynamic import avoids loading node:https on the cold path for dev runs.
      const init: RequestInit = { signal: controller.signal }
      if (this._useTls) {
        const { Agent } = await import('node:https')
        ;(init as any).dispatcher = new Agent({ rejectUnauthorized: false })
      }
      const response = await fetch(url, init)
      clearTimeout(timer)
      return { ok: response.ok, status: response.status }
    } catch (err) {
      return { ok: false, err: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Send SIGTERM to a process, wait up to `graceMs` for graceful exit,
   * then SIGKILL if still alive. Resolves to the eventual exit code.
   */
  private killGraceful(proc: ChildProcess | null, graceMs = 5000): Promise<number | null> {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        resolve(proc?.exitCode ?? null)
        return
      }
      const onExit = (code: number | null) => {
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          logger.warn('[meeting-asr] Process did not exit within %dms; sending SIGKILL', graceMs)
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }, graceMs)
      proc.once('exit', onExit)
      try {
        proc.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve(proc.exitCode ?? null)
      }
    })
  }

  async stop(): Promise<void> {
    if (!this._isRunning && !this.mainProcess && !this.diarizeProcess) {
      return
    }

    logger.info('[meeting-asr] Stopping services...')

    // Disable auto-restart while we shut down deliberately.
    this._autoRestart = false
    this._stopHealthMonitor()

    // Stop diarize and main in parallel, each with SIGTERM → SIGKILL fallback.
    const stops = await Promise.all([
      this.diarizeProcess ? this.killGraceful(this.diarizeProcess) : Promise.resolve(null),
      this.mainProcess ? this.killGraceful(this.mainProcess) : Promise.resolve(null),
    ])

    this.diarizeProcess = null
    this.mainProcess = null
    this._isRunning = false
    this._startTime = null
    this._asrPort = null
    this._diarizePort = null
    this._startupPhase = 'idle'
    this.emit('phase', this._startupPhase)

    logger.info('[meeting-asr] Services stopped (main=%s diarize=%s)', stops[1], stops[0])
    this.emit('stopped', 0)
  }

  /**
   * Begin polling both healthz endpoints at a fixed interval. After
   * HEALTH_FAILURES_BEFORE_RESTART consecutive failures we recycle through
   * the same _scheduleRestart path used for unexpected crashes, so recovery
   * is bounded and observable via status.error.
   */
  private _startHealthMonitor(): void {
    if (this._healthTimer) return
    this._healthTimer = setInterval(() => {
      this._probeHealthBoth()
        .then((ok) => {
          if (ok) {
            this._healthFailures = 0
            return
          }
          this._healthFailures += 1
          logger.warn(
            '[meeting-asr] health probe failed %d/%d',
            this._healthFailures,
            MeetingASRService.HEALTH_FAILURES_BEFORE_RESTART,
          )
          if (this._healthFailures >= MeetingASRService.HEALTH_FAILURES_BEFORE_RESTART) {
            this._healthFailures = 0
            this._scheduleRestart('health monitor: repeated healthz failures')
          }
        })
        .catch((err) => {
          logger.error('[meeting-asr] health probe threw: %s', err?.message || err)
        })
    }, MeetingASRService.HEALTH_PROBE_INTERVAL_MS)
  }

  private _stopHealthMonitor(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer)
      this._healthTimer = null
    }
    this._healthFailures = 0
  }

  /**
   * Probe main + diarize healthz concurrently. Returns true iff both report
   * a healthy response within the per-probe timeout. Either child dying or
   * a non-2xx response counts as failure.
   */
  private async _probeHealthBoth(): Promise<boolean> {
    if (!this._asrPort || !this._diarizePort) return false
    const results = await Promise.all([
      this.probeHealthz(this._asrPort, MeetingASRService.HEALTH_PROBE_TIMEOUT_MS),
      this.probeHealthz(this._diarizePort, MeetingASRService.HEALTH_PROBE_TIMEOUT_MS),
    ])
    return results.every((r) => r.ok)
  }

  /**
   * Schedule an auto-restart with exponential backoff. Bounded by
   * MAX_RESTART_ATTEMPTS — after that we give up and surface the failure
   * to the user via the status endpoint.
   */
  private _scheduleRestart(reason: string): void {
    if (this._restartAttempts >= MeetingASRService.MAX_RESTART_ATTEMPTS) {
      logger.error(
        '[meeting-asr] Auto-restart exhausted after %d attempts (reason: %s). User must restart manually.',
        this._restartAttempts,
        reason,
      )
      this._error = `auto-restart exhausted: ${reason}`
      this._autoRestart = false
      this.emit('crashed', this._error)
      return
    }
    const delay =
      MeetingASRService.RESTART_BACKOFF_MS[
        Math.min(this._restartAttempts, MeetingASRService.RESTART_BACKOFF_MS.length - 1)
      ]
    this._restartAttempts += 1
    logger.warn(
      '[meeting-asr] Auto-restart %d/%d scheduled in %dms (reason: %s)',
      this._restartAttempts,
      MeetingASRService.MAX_RESTART_ATTEMPTS,
      delay,
      reason,
    )
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      this.start(this._config).catch((err) => {
        logger.error('[meeting-asr] Auto-restart failed: %s', err?.message || err)
        this._scheduleRestart(`restart attempt ${this._restartAttempts} failed`)
      })
    }, delay)
  }

  private async updateLLMConfig(config: MeetingASRConfig): Promise<void> {
    // Route through the Python backend's /api/config/llm endpoint instead of
    // writing config.json directly. Direct file writes bypassed Storage's
    // in-memory config AND its runtime Settings sync, so llm_service (which
    // reads storage.get_config()) kept serving the old key after an update —
    // the same class of desync that caused the v0.7.17
    // "DASHSCOPE_API_KEY is not configured" incident for ASR.
    try {
      const scheme = this._useTls ? 'https' : 'http'
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: config.llmApiKey || '',
          base_url: config.llmBaseUrl || '',
          model: config.llmModel || '',
        }),
      }
      if (this._useTls) {
        const { Agent } = await import('node:https')
        ;(init as any).dispatcher = new Agent({ rejectUnauthorized: false })
      }
      const response = await fetch(
        `${scheme}://127.0.0.1:${this._asrPort}/api/config/llm`,
        init,
      )
      if (!response.ok) {
        throw new Error(`Python backend rejected LLM config: ${response.status} ${response.statusText}`)
      }
      logger.info('[meeting-asr] LLM config persisted via Python backend')
    } catch (err) {
      // Best-effort: a failed LLM push must not fail the whole ASR start.
      logger.error('[meeting-asr] Failed to update LLM config via backend: %s', err)
    }
  }

  async updateConfig(config: Partial<MeetingASRConfig>): Promise<void> {
    if (!this._isRunning) {
      throw new Error('ASR service is not running')
    }

    const body = JSON.stringify({
      asr: {
        dashscope_api_key: config.dashscopeApiKey,
        paraformer_ws_url: config.paraformerWsUrl,
        paraformer_model: config.paraformerModel,
        paraformer_sample_rate: config.paraformerSampleRate,
        paraformer_format: config.paraformerFormat,
        paraformer_language_hints: config.paraformerLanguageHints,
        paraformer_semantic_punctuation: config.paraformerSemanticPunctuation,
      },
      llm: {
        api_key: config.llmApiKey,
        base_url: config.llmBaseUrl,
        model: config.llmModel,
      },
    })

    try {
      const scheme = this._useTls ? 'https' : 'http'
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
      if (this._useTls) {
        const { Agent } = await import('node:https')
        ;(init as any).dispatcher = new Agent({ rejectUnauthorized: false })
      }
      const response = await fetch(`${scheme}://127.0.0.1:${this._asrPort}/api/config`, init)
      if (!response.ok) {
        throw new Error(`Failed to update config: ${response.statusText}`)
      }
    } catch (err) {
      logger.error('[meeting-asr] Failed to update config: %s', err)
      throw err
    }
  }

  getASRPort(): number | null {
    return this._asrPort
  }

  getDiarizePort(): number | null {
    return this._diarizePort
  }
}

export const meetingASRService = MeetingASRService.getInstance()
