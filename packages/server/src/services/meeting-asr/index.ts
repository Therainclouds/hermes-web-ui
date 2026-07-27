import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { logger } from '../logger'

export interface MeetingASRConfig {
  dashscopeApiKey?: string
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
}

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
    }
  }

  private getPythonBackendPath(): string {
    return path.join(__dirname, 'python-backend')
  }

  private getDataDir(): string {
    return this._config.dataDir || path.join(process.cwd(), 'data', 'meeting-asr')
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
    const venvPath = path.join(backendPath, '.venv')
    const pythonPath = this.getVenvPythonPath(venvPath)

    try {
      await fs.access(pythonPath)
      // Verify the python binary actually executes — covers the case where
      // .venv exists but is corrupted (partial install, wrong arch, etc.).
      await new Promise<void>((resolve, reject) => {
        const probe = spawn(pythonPath, ['-c', 'import sys; sys.exit(0)'], { stdio: 'pipe' })
        probe.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`venv python exited ${code}`))
        })
        probe.on('error', reject)
      })
      return pythonPath
    } catch {
      // Virtual env doesn't exist or is broken — recreate from scratch.
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

      // Install requirements. May take 5-10 minutes on ARM64 — log progress.
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

      return pythonPath
    }
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
      // If OSS config changed, restart with new config so the Python child
      // process picks up the updated env vars (OSS_BUCKET / keys / etc.)
      if (config.ossBucket || config.ossAccessKeyId || config.ossAccessKeySecret) {
        logger.info('[meeting-asr] OSS config provided while running; restarting to pick up new credentials')
        await this.stop()
      } else {
        logger.warn('[meeting-asr] Service is already running')
        return
      }
    }

    this._config = config
    this._error = null

    try {
      // Reset restart counter for a deliberate start.
      this._restartAttempts = 0
      this._autoRestart = true
      if (this._restartTimer) {
        clearTimeout(this._restartTimer)
        this._restartTimer = null
      }

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
        // Auto-restart fallback: try stored config
        try {
          const fs = require('fs') as typeof import('fs')
          const p = require('path') as typeof import('path')
          const storedPath = p.join(dataDir, 'config.json')
          if (fs.existsSync(storedPath)) {
            const stored = JSON.parse(fs.readFileSync(storedPath, 'utf-8'))
            const key = stored.asr?.dashscope_api_key || stored.llm?.api_key
            if (key) env.DASHSCOPE_API_KEY = key
          }
        } catch { /* best effort */ }
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
      logger.info('[meeting-asr] Starting main ASR service on port %d...', this._asrPort)
      const mainUvicornArgs = ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', String(this._asrPort)]
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
        this.emit('stopped', code ?? 0)
        // Auto-restart on unexpected crash, unless explicitly stopped.
        if (this._autoRestart && (code ?? 0) !== 0) {
          this._scheduleRestart('main process exited unexpectedly')
        }
      })

      // Start diarize process
      logger.info('[meeting-asr] Starting diarize service on port %d...', this._diarizePort)
      const diarizeUvicornArgs = ['-m', 'uvicorn', 'app.diarize_server:app', '--host', '0.0.0.0', '--port', String(this._diarizePort)]
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

      // Write LLM config if provided
      if (config.llmApiKey || config.llmBaseUrl || config.llmModel) {
        await this.updateLLMConfig(config)
      }

      logger.info('[meeting-asr] Services started successfully')
      this.emit('started')

    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err)
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
   * Single-port healthz probe via HTTP. The ASR backend runs in loopback so
   * there is no need for TLS on this path — Node handles TLS externally.
   */
  private async probeHealthz(
    port: number,
    timeoutMs = 2000,
  ): Promise<{ ok: boolean; status?: number; err?: string }> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: controller.signal,
      })
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

    logger.info('[meeting-asr] Services stopped (main=%s diarize=%s)', stops[1], stops[0])
    this.emit('stopped', 0)
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
    try {
      const dataDir = this.getDataDir()
      const configFile = path.join(dataDir, 'config.json')

      let currentConfig: any = {}
      try {
        const content = await fs.readFile(configFile, 'utf-8')
        currentConfig = JSON.parse(content)
      } catch {
        // Config file doesn't exist or is invalid
      }

      // Update LLM config
      if (!currentConfig.llm) {
        currentConfig.llm = {}
      }
      if (config.llmApiKey) {
        currentConfig.llm.api_key = config.llmApiKey
      }
      if (config.llmBaseUrl) {
        currentConfig.llm.base_url = config.llmBaseUrl
      }
      if (config.llmModel) {
        currentConfig.llm.model = config.llmModel
      }

      await fs.writeFile(configFile, JSON.stringify(currentConfig, null, 2), 'utf-8')
    } catch (err) {
      logger.error('[meeting-asr] Failed to update LLM config: %s', err)
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
      const response = await fetch(`http://127.0.0.1:${this._asrPort}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
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
