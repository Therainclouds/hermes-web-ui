import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter, dirname, join } from 'path'

const UPDATE_PACKAGE = '@quanthermes/hermes-web-ui'
const UPDATE_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
const UPDATE_SCRIPT = '/opt/hermes-web-ui/scripts/update-source-deploy.sh'
const PUBLISHED_VERSION = '0.6.13'

type UpdateControllerMocks = {
  execFile: ReturnType<typeof vi.fn>
  execFileSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  existsSync: ReturnType<typeof vi.fn>
  readFileSync: ReturnType<typeof vi.fn>
  appendFileSync: ReturnType<typeof vi.fn>
}

async function loadUpdateController(overrides: Partial<UpdateControllerMocks> = {}) {
  const execFile = overrides.execFile ?? vi.fn((_command: string, _args: string[], _options: any, callback: any) => callback(null, '', ''))
  const execFileSync = overrides.execFileSync ?? vi.fn().mockReturnValue('updated')
  const unref = overrides.unref ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn(() => ({ unref, on: vi.fn() }))
  const existsSync = overrides.existsSync ?? vi.fn(() => true)
  const readFileSync = overrides.readFileSync ?? vi.fn(() => JSON.stringify({
    name: 'hermes-web-ui',
    version: '0.0.0',
    repository: { url: 'https://github.com/EKKOLearnAI/hermes-web-ui.git' },
  }))
  const appendFileSync = overrides.appendFileSync ?? vi.fn()

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFile, execFileSync, spawn }))
  vi.doMock('fs', () => ({
    appendFileSync,
    closeSync: vi.fn(),
    existsSync,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    readFileSync,
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  }))

  const mod = await import('../../packages/server/src/controllers/update')
  return {
    ...mod,
    mocks: { execFile, execFileSync, spawn, unref, existsSync, readFileSync, appendFileSync },
  }
}

function createMockCtx() {
  return {
    status: 200,
    body: null as unknown,
  }
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getNpmCliPath() {
  const prefix = getNodePrefix()
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function getGlobalCliScript(prefix: string) {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', '@quanthermes', 'hermes-web-ui', 'bin', UPDATE_CLI_BIN)
    : join(prefix, 'lib', 'node_modules', '@quanthermes', 'hermes-web-ui', 'bin', UPDATE_CLI_BIN)
}

describe('update controller', () => {
  const originalPort = process.env.PORT
  const originalUpdateEnabled = process.env.WEBUI_UPDATE_ENABLED
  const originalUpdatePackage = process.env.WEBUI_UPDATE_PACKAGE
  const originalUpdateRegistry = process.env.WEBUI_UPDATE_REGISTRY
  const originalUpdateCliBin = process.env.WEBUI_UPDATE_CLI_BIN
  const originalUpdateStrategy = process.env.WEBUI_UPDATE_STRATEGY
  const originalUpdateScript = process.env.WEBUI_UPDATE_SCRIPT
  const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
  const originalWebUiStateDir = process.env.HERMES_WEBUI_STATE_DIR
  const originalUploadDir = process.env.UPLOAD_DIR
  const originalHermesHome = process.env.HERMES_HOME
  const originalHermesHomeDir = process.env.HERMES_HOME_DIR
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_CLI_BIN = UPDATE_CLI_BIN
    delete process.env.WEBUI_UPDATE_STRATEGY
    delete process.env.WEBUI_UPDATE_SCRIPT
    delete process.env.HERMES_WEB_UI_HOME
    delete process.env.HERMES_WEBUI_STATE_DIR
    delete process.env.UPLOAD_DIR
    delete process.env.HERMES_HOME
    delete process.env.HERMES_HOME_DIR
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: PUBLISHED_VERSION,
        'dist-tags': { latest: PUBLISHED_VERSION },
      }),
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('child_process')
    vi.doUnmock('fs')
    vi.unstubAllGlobals()
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
    if (originalUpdateEnabled === undefined) delete process.env.WEBUI_UPDATE_ENABLED
    else process.env.WEBUI_UPDATE_ENABLED = originalUpdateEnabled
    if (originalUpdatePackage === undefined) delete process.env.WEBUI_UPDATE_PACKAGE
    else process.env.WEBUI_UPDATE_PACKAGE = originalUpdatePackage
    if (originalUpdateRegistry === undefined) delete process.env.WEBUI_UPDATE_REGISTRY
    else process.env.WEBUI_UPDATE_REGISTRY = originalUpdateRegistry
    if (originalUpdateCliBin === undefined) delete process.env.WEBUI_UPDATE_CLI_BIN
    else process.env.WEBUI_UPDATE_CLI_BIN = originalUpdateCliBin
    if (originalUpdateStrategy === undefined) delete process.env.WEBUI_UPDATE_STRATEGY
    else process.env.WEBUI_UPDATE_STRATEGY = originalUpdateStrategy
    if (originalUpdateScript === undefined) delete process.env.WEBUI_UPDATE_SCRIPT
    else process.env.WEBUI_UPDATE_SCRIPT = originalUpdateScript
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (originalWebUiStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
    else process.env.HERMES_WEBUI_STATE_DIR = originalWebUiStateDir
    if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR
    else process.env.UPLOAD_DIR = originalUploadDir
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalHermesHomeDir === undefined) delete process.env.HERMES_HOME_DIR
    else process.env.HERMES_HOME_DIR = originalHermesHomeDir
    delete process.env.HERMES_WEB_UI_PREVIEW_REPO
  })

  it('updates and restarts through the running Node executable, not PATH shims', async () => {
    process.env.PORT = '9129'
    const nodeBinDir = getNodeBinDir()
    const npmCli = getNpmCliPath()
    const globalPrefix = getNodePrefix()
    const cliScript = getGlobalCliScript(globalPrefix)
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      if (args[1] === 'root') {
        return process.platform === 'win32'
          ? join(globalPrefix, 'node_modules')
          : join(globalPrefix, 'lib', 'node_modules')
      }
      return 'updated'
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '-g', `${UPDATE_PACKAGE}@${PUBLISHED_VERSION}`, '--registry', UPDATE_REGISTRY, '--ignore-scripts', '--no-audit', '--no-fund'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: expect.objectContaining({
          npm_node_execpath: process.execPath,
          PATH: expect.stringContaining(`${nodeBinDir}${delimiter}`),
        }),
      }),
    )
    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      message: 'updated',
      status: 'running',
      stage: 'restarting',
      taskId: expect.any(String),
    }))

    vi.runAllTimers()

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'root', '-g'],
      expect.objectContaining({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
    )
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [cliScript, 'restart', '--port', '9129'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({ npm_node_execpath: process.execPath }),
      }),
    )
    expect(mocks.unref).toHaveBeenCalledOnce()
  })

  it('starts the source deployment update script instead of installing a global npm package', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.body).toEqual(expect.objectContaining({
      success: true,
      message: `Starting source deployment update to ${PUBLISHED_VERSION}`,
      status: 'running',
      stage: 'starting',
      taskId: expect.any(String),
    }))
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['install']),
      expect.anything(),
    )

    vi.runAllTimers()

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'bash' : UPDATE_SCRIPT,
      process.platform === 'win32'
        ? [UPDATE_SCRIPT, '--version', PUBLISHED_VERSION]
        : ['--version', PUBLISHED_VERSION],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({
          HERMES_WEB_UI_UPDATE_VERSION: PUBLISHED_VERSION,
          HERMES_WEB_UI_UPDATE_PACKAGE: UPDATE_PACKAGE,
          HERMES_WEB_UI_UPDATE_REGISTRY: UPDATE_REGISTRY,
        }),
      }),
    )
    expect(mocks.unref).toHaveBeenCalledOnce()
  })

  it('falls back to the default port when PORT is not set', async () => {
    delete process.env.PORT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    vi.runAllTimers()

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.any(String), 'restart', '--port', '8648'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    )
  })

  it('rejects updates when the update source is not fully configured', async () => {
    delete process.env.WEBUI_UPDATE_REGISTRY
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      success: false,
      message: 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, and WEBUI_UPDATE_CLI_BIN.',
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('requires WEBUI_UPDATE_SCRIPT for source deployment updates', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    delete process.env.WEBUI_UPDATE_SCRIPT
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({
      success: false,
      message: 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, and WEBUI_UPDATE_SCRIPT.',
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('blocks updates when protected web-ui data would be inside the deploy directory', async () => {
    process.env.HERMES_WEB_UI_HOME = './state'
    const { handleUpdate, mocks } = await loadUpdateController()
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual(expect.objectContaining({
      success: false,
      code: 'update_dangerous_layout',
    }))
    expect(String((ctx.body as any).message)).toContain('Web UI data directory is inside the deploy directory')
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('returns update task status for the active task', async () => {
    process.env.WEBUI_UPDATE_STRATEGY = 'source-deploy'
    process.env.WEBUI_UPDATE_SCRIPT = UPDATE_SCRIPT
    const { handleUpdate, updateStatus } = await loadUpdateController()
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: expect.objectContaining({
        id: expect.any(String),
        strategy: 'source-deploy',
        status: 'running',
        stage: 'starting',
        targetVersion: PUBLISHED_VERSION,
      }),
      lastTask: null,
    })
  })

  it('does not log a restart error when the restart helper exits successfully', async () => {
    const handlers = new Map<string, (...args: any[]) => void>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unref = vi.fn()
    const restart = {
      unref,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return restart
      }),
    }
    const spawn = vi.fn(() => restart)
    const { handleUpdate } = await loadUpdateController({ spawn, unref })
    const ctx = createMockCtx()

    await handleUpdate(ctx)
    vi.runAllTimers()
    handlers.get('exit')?.(0, null)

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('returns a 500 with stderr when installation fails', async () => {
    const execFileSync = vi.fn(() => {
      const error = new Error('install failed') as Error & { stderr?: string }
      error.stderr = 'engine mismatch'
      throw error
    })
    const { handleUpdate, mocks } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ success: false, message: 'engine mismatch' })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('stores the failed task result when installation fails', async () => {
    const execFileSync = vi.fn(() => {
      const error = new Error('install failed') as Error & { stderr?: string }
      error.stderr = 'engine mismatch'
      throw error
    })
    const { handleUpdate, updateStatus } = await loadUpdateController({ execFileSync })
    const ctx = createMockCtx()
    const statusCtx = createMockCtx()

    await handleUpdate(ctx)
    await updateStatus(statusCtx)

    expect(statusCtx.body).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        error: 'engine mismatch',
      }),
    })
  })

  it('loads preview tags through async git with a short timeout', async () => {
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/EKKOLearnAI/hermes-web-ui'
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(null, [
        'abc123\trefs/tags/v0.6.6',
        'def456\trefs/tags/v0.6.7',
      ].join('\n'), '')
    })
    const execFileSync = vi.fn(() => 'git version 2.0.0')
    const { previewTags, mocks } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await previewTags(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      tags: [
        { name: 'main', sha: '' },
        { name: 'v0.6.7', sha: 'def456' },
        { name: 'v0.6.6', sha: 'abc123' },
      ],
    })
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--tags', '--refs', 'https://github.com/EKKOLearnAI/hermes-web-ui.git'],
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function),
    )
  })

  it('falls back to GitHub API when async git tag loading fails', async () => {
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/EKKOLearnAI/hermes-web-ui'
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(new Error('git timeout'), '', '')
    })
    const execFileSync = vi.fn(() => 'git version 2.0.0')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { name: 'v0.6.7', commit: { sha: 'def456' } },
        { name: 'v0.6.6', commit: { sha: 'abc123' } },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { previewTags } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await previewTags(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      tags: [
        { name: 'main', sha: '' },
        { name: 'v0.6.7', sha: 'def456' },
        { name: 'v0.6.6', sha: 'abc123' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/EKKOLearnAI/hermes-web-ui/tags?per_page=100',
      expect.objectContaining({
        headers: { 'User-Agent': 'hermes-web-ui-preview' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('runs preview npm install through async execFile', async () => {
    const npmCli = getNpmCliPath()
    const execFile = vi.fn((_command: string, _args: string[], _options: any, callback: any) => {
      callback(null, 'installed', '')
    })
    const execFileSync = vi.fn(() => '')
    const { installPreview, mocks } = await loadUpdateController({ execFile, execFileSync })
    const ctx = createMockCtx()

    await installPreview(ctx)

    expect(ctx.status).toBe(202)
    expect((ctx.body as any).success).toBe(true)
    expect((ctx.body as any).accepted).toBe(true)
    expect((ctx.body as any).active_action).toBe('install')
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--include=dev', '--ignore-scripts'],
      expect.objectContaining({
        timeout: 15 * 60 * 1000,
        cwd: expect.any(String),
      }),
      expect.any(Function),
    )
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--include=dev', '--ignore-scripts'],
      expect.any(Object),
    )
  })

})
