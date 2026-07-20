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
      return pythonPath
    } catch {
      // Virtual env doesn't exist, create it
      const pythonCmd = await this.findPython()
      logger.info('[meeting-asr] Creating Python virtual environment with %s...', pythonCmd)
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(pythonCmd, ['-m', 'venv', venvPath], {
          cwd: backendPath,
          stdio: 'pipe',
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Failed to create venv, exit code: ${code}`))
        })
        proc.on('error', reject)
      })

      // Install requirements
      logger.info('[meeting-asr] Installing Python dependencies...')
      const requirementsPath = path.join(__dirname, 'requirements.txt')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(pythonPath, ['-m', 'pip', 'install', '-r', requirementsPath], {
          cwd: backendPath,
          stdio: 'pipe',
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Failed to install dependencies, exit code: ${code}`))
        })
        proc.on('error', reject)
      })

      return pythonPath
    }
  }

  async start(config: MeetingASRConfig = {}): Promise<void> {
    if (this._isRunning) {
      logger.warn('[meeting-asr] Service is already running')
      return
    }

    this._config = config
    this._error = null

    try {
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
        BACKEND_HOST: config.host || '127.0.0.1',
        BACKEND_PORT: String(this._asrPort),
        DIARIZE_PORT: String(this._diarizePort),
        CORS_ORIGIN: `http://localhost:${process.env.PORT || 6060}`,
      }

      if (config.dashscopeApiKey) {
        env.DASHSCOPE_API_KEY = config.dashscopeApiKey
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
      if (config.llmApiKey) {
        // LLM config is stored in the data dir config.json
        // We'll write it after starting
      }

      // Start main ASR process
      logger.info('[meeting-asr] Starting main ASR service on port %d...', this._asrPort)
      this.mainProcess = spawn(pythonPath, ['-m', 'uvicorn', 'app.main:app', '--host', env.BACKEND_HOST, '--port', String(this._asrPort)], {
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
      })

      // Start diarize process
      logger.info('[meeting-asr] Starting diarize service on port %d...', this._diarizePort)
      this.diarizeProcess = spawn(pythonPath, ['-m', 'uvicorn', 'app.diarize_server:app', '--host', env.BACKEND_HOST, '--port', String(this._diarizePort)], {
        cwd: backendPath,
        env,
        stdio: 'pipe',
        detached: false,
      })

      this.diarizeProcess.stdout?.on('data', (data) => {
        logger.debug('[meeting-asr:diarize] %s', data.toString().trim())
      })

      this.diarizeProcess.stderr?.on('data', (data) => {
        logger.debug('[meeting-asr:diarize] %s', data.toString().trim())
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
    const startTime = Date.now()
    let lastError: Error | null = null

    while (Date.now() - startTime < timeout) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 2000)
        
        const response = await fetch(`http://127.0.0.1:${this._asrPort}/healthz`, {
          signal: controller.signal
        })
        clearTimeout(timeoutId)
        
        if (response.ok) {
          logger.info('[meeting-asr] Main service is ready')
          return
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Service not ready yet, continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    logger.error('[meeting-asr] Timeout waiting for service. Last error: %s', lastError?.message || 'unknown')
    throw new Error(`Timeout waiting for ASR service to be ready after ${timeout}ms. Last error: ${lastError?.message || 'unknown'}`)
  }

  async stop(): Promise<void> {
    if (!this._isRunning && !this.mainProcess && !this.diarizeProcess) {
      return
    }

    logger.info('[meeting-asr] Stopping services...')

    // Stop diarize process
    if (this.diarizeProcess) {
      this.diarizeProcess.kill('SIGTERM')
      this.diarizeProcess = null
    }

    // Stop main process
    if (this.mainProcess) {
      this.mainProcess.kill('SIGTERM')
      this.mainProcess = null
    }

    this._isRunning = false
    this._startTime = null
    this._asrPort = null
    this._diarizePort = null

    logger.info('[meeting-asr] Services stopped')
    this.emit('stopped', 0)
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

    // Update via API
    try {
      const response = await fetch(`http://127.0.0.1:${this._asrPort}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        }),
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
