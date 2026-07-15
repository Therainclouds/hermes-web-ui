// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  clearStaleUpdateStatus: vi.fn(),
  fetchAvailableModels: vi.fn(),
  fetchUpdateCapabilities: vi.fn(),
  fetchUpdateStatus: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelAlias: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)
vi.mock('@/api/client', () => ({ hasApiKey: () => true }))

import { useAppStore } from '@/stores/hermes/app'

describe('App Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockSystemApi.addCustomModel.mockResolvedValue({ success: true, custom_models: {} })
    mockSystemApi.removeCustomModel.mockResolvedValue({ success: true, custom_models: {} })
    mockSystemApi.clearStaleUpdateStatus.mockResolvedValue({ success: true, currentTask: null, lastTask: null })
    mockSystemApi.fetchUpdateCapabilities.mockResolvedValue({
      enabled: true,
      strategy: 'device-package',
      packageType: 'device-package',
      channel: 'stable',
      sourceLabel: 'Device Manifest',
      currentVersion: '0.6.10',
      latestVersion: '0.6.17',
      updateAvailable: true,
      detectionSource: 'manifest',
      remoteError: '',
      supports: {
        versionCheck: true,
        fullPackage: true,
        deltaPackage: false,
        resumableDownload: false,
        checksumVerification: true,
        rollback: true,
        healthcheck: true,
        silentInstall: true,
        promptedInstall: true,
        crossPlatformShell: true,
      },
      runtime: {
        manifestConfigured: true,
        executionConfigured: true,
        runnerManaged: true,
        autoInstallDependencies: true,
        includeAgentUpgrade: false,
        stateFile: '/tmp/update-task-state.json',
        logDir: '/tmp/update-logs',
        stagingDir: '/tmp/update-staging',
        backupDir: '/tmp/update-backups',
        minFreeSpaceBytes: 1024,
      },
      preflight: {
        strategy: 'device-package',
        riskLevel: 'low',
        issues: [],
        shouldBlock: false,
        warningText: '',
        blockingText: '',
      },
    })
    mockSystemApi.fetchUpdateStatus.mockResolvedValue({ currentTask: null, lastTask: null })
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists desktop sidebar collapsed state to localStorage', () => {
    const store = useAppStore()

    expect(store.sidebarCollapsed).toBe(false)

    store.toggleSidebarCollapsed()
    expect(store.sidebarCollapsed).toBe(true)
    expect(window.localStorage.getItem('hermes_sidebar_collapsed')).toBe('1')

    store.toggleSidebarCollapsed()
    expect(store.sidebarCollapsed).toBe(false)
    expect(window.localStorage.getItem('hermes_sidebar_collapsed')).toBe('0')
  })

  it('loads model visibility and falls back when the configured default is hidden', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
        },
      ],
      allProviders: [],
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(store.customModels).toEqual({})
    expect(store.isModelVisible('deepseek', 'deepseek-reasoner')).toBe(true)
    expect(store.isModelVisible('deepseek', 'deepseek-chat')).toBe(false)
  })

  it('loads aliases while falling back from a hidden default without rehydrating it as custom', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
          available_models: ['deepseek-chat', 'deepseek-reasoner'],
        },
      ],
      allProviders: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-chat', 'deepseek-reasoner'],
        },
      ],
      model_aliases: {
        deepseek: { 'deepseek-reasoner': 'Reasoner Alias' },
      },
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.modelAliases).toEqual({
      deepseek: { 'deepseek-reasoner': 'Reasoner Alias' },
    })
    expect(store.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(store.displayModelName('deepseek-reasoner', 'deepseek')).toBe('Reasoner Alias')
    expect(store.customModels).toEqual({})
  })

  it('persists model visibility without changing the canonical selected model id', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
        },
      ],
      allProviders: [],
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    mockSystemApi.updateModelVisibility.mockResolvedValue({
      success: true,
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.setModelVisibility('deepseek', { mode: 'include', models: ['deepseek-reasoner'] })

    expect(mockSystemApi.updateModelVisibility).toHaveBeenCalledWith({
      provider: 'deepseek',
      mode: 'include',
      models: ['deepseek-reasoner'],
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(mockSystemApi.updateDefaultModel).not.toHaveBeenCalled()
  })

  it('marks the client stale when the served Web UI version changes', async () => {
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: '0.5.17',
      webui_latest: '0.5.17',
      webui_update_available: false,
      webui_update_source_label: 'Device Manifest',
      webui_update_channel: 'stable',
      webui_update_strategy: 'device-package',
      webui_update_package_type: 'device-package',
    })
    const store = useAppStore()

    await store.checkConnection()

    expect(store.connected).toBe(true)
    expect(store.serverVersion).toBe('0.5.17')
    expect(store.clientOutdated).toBe(true)
    expect(store.updateAvailable).toBe(false)
    expect(store.updateSourceLabel).toBe('Device Manifest')
    expect(store.updateChannel).toBe('stable')
    expect(store.updateStrategy).toBe('device-package')
    expect(store.updatePackageType).toBe('device-package')
  })

  it('stores update capability warnings from the dedicated capabilities endpoint', async () => {
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: '0.6.10',
      webui_latest: '0.6.17',
      webui_update_enabled: true,
      webui_update_available: true,
      webui_update_source_label: 'Device Manifest',
      webui_update_channel: 'stable',
      webui_update_strategy: 'device-package',
      webui_update_package_type: 'device-package',
    })
    mockSystemApi.fetchUpdateCapabilities.mockResolvedValue({
      enabled: true,
      strategy: 'device-package',
      packageType: 'device-package',
      channel: 'stable',
      sourceLabel: 'Device Manifest',
      currentVersion: '0.6.10',
      latestVersion: '0.6.17',
      updateAvailable: true,
      detectionSource: 'manifest',
      remoteError: '',
      supports: {
        versionCheck: true,
        fullPackage: true,
        deltaPackage: false,
        resumableDownload: false,
        checksumVerification: true,
        rollback: true,
        healthcheck: true,
        silentInstall: true,
        promptedInstall: true,
        crossPlatformShell: true,
      },
      runtime: {
        manifestConfigured: true,
        executionConfigured: true,
        runnerManaged: true,
        autoInstallDependencies: true,
        includeAgentUpgrade: false,
        stateFile: '/tmp/update-task-state.json',
        logDir: '/tmp/update-logs',
        stagingDir: '/tmp/update-staging',
        backupDir: '/tmp/update-backups',
        minFreeSpaceBytes: 1024,
      },
      preflight: {
        strategy: 'device-package',
        riskLevel: 'medium',
        issues: [
          {
            code: 'hermes-home-in-deploy-dir',
            level: 'medium',
            path: '/opt/hermes-web-ui/hermes_data',
            message: 'Hermes data directory is inside the deploy directory.',
          },
        ],
        shouldBlock: false,
        warningText: 'Hermes data directory is inside the deploy directory.',
        blockingText: '',
      },
    })
    const store = useAppStore()

    await store.checkConnection()

    expect(mockSystemApi.fetchUpdateCapabilities).toHaveBeenCalledTimes(1)
    expect(store.updateRiskLevel).toBe('medium')
    expect(store.updateCapabilitiesWarning).toContain('Hermes data directory')
    expect(store.updateRollbackSupported).toBe(true)
    expect(store.updateChecksumVerification).toBe(true)
  })

  it('waits for the restarted server after triggering self-update', async () => {
    vi.useFakeTimers()
    mockSystemApi.triggerUpdate.mockResolvedValue({
      success: true,
      message: 'ok',
      taskId: 'task-1',
      status: 'queued',
      stage: 'queued',
    })
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: 'test',
      webui_latest: 'test',
      webui_update_enabled: true,
      webui_update_available: false,
      webui_update_source_label: 'Company npm registry',
    })
    mockSystemApi.fetchUpdateStatus
      .mockResolvedValueOnce({
        currentTask: {
          id: 'task-1',
          strategy: 'source-deploy',
          status: 'running',
          stage: 'installing',
          message: 'installing',
          targetVersion: 'test',
          warning: '',
          error: '',
          startedAt: '2026-06-09T00:00:00.000Z',
          finishedAt: null,
        },
        lastTask: null,
      })
      .mockResolvedValueOnce({
        currentTask: null,
        lastTask: {
          id: 'task-1',
          strategy: 'source-deploy',
          status: 'succeeded',
          stage: 'succeeded',
          message: 'done',
          targetVersion: 'test',
          warning: '',
          error: '',
          startedAt: '2026-06-09T00:00:00.000Z',
          finishedAt: '2026-06-09T00:00:03.000Z',
        },
      })
    const store = useAppStore()
    store.updateEnabled = true

    const updatePromise = store.doUpdate()
    const ok = await updatePromise
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3000)

    expect(ok).toBe(true)
    expect(store.updating).toBe(false)
    expect(store.updateTaskStatus).toBe('succeeded')
    expect(store.updateTaskStage).toBe('succeeded')
    expect(mockSystemApi.triggerUpdate).toHaveBeenCalledTimes(1)
    expect(mockSystemApi.checkHealth).toHaveBeenCalled()
    expect(mockSystemApi.fetchUpdateStatus).toHaveBeenCalled()
  })

  it('keeps polling slow self-updates past the old 10 minute timeout before failing', async () => {
    vi.useFakeTimers()
    mockSystemApi.triggerUpdate.mockResolvedValue({
      success: true,
      message: 'ok',
      taskId: 'task-2',
      status: 'queued',
      stage: 'queued',
    })
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: 'test',
      webui_latest: '0.6.29',
      webui_update_enabled: true,
      webui_update_available: false,
      webui_update_source_label: 'Quanthermes Device Releases',
      webui_update_channel: 'stable',
      webui_update_strategy: 'source-deploy',
      webui_update_package_type: 'npm-package',
    })
    mockSystemApi.fetchUpdateStatus.mockResolvedValue({
      currentTask: {
        id: 'task-2',
        strategy: 'source-deploy',
        status: 'running',
        stage: 'installing',
        message: 'installing',
        targetVersion: '0.6.29',
        warning: '',
        error: '',
        startedAt: '2026-07-01T00:00:00.000Z',
        finishedAt: null,
      },
      lastTask: null,
    })
    const store = useAppStore()
    store.updateEnabled = true

    const ok = await store.doUpdate()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 3000)

    expect(ok).toBe(true)
    expect(store.updating).toBe(true)
    expect(store.updateTaskStatus).toBe('running')
    expect(store.updateTaskStage).toBe('installing')

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 3000)

    expect(store.updating).toBe(false)
    expect(store.updateTaskStatus).toBe('failed')
    expect(store.updateTaskError).toBe('Update status polling timed out')
  })

  it('does not mark the client stale when the served Web UI version matches this bundle', async () => {
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: 'test',
      webui_latest: 'test',
      webui_update_available: false,
    })
    const store = useAppStore()

    await store.checkConnection()

    expect(store.serverVersion).toBe('test')
    expect(store.clientOutdated).toBe(false)
  })

  it('clears a stale failed update status through the store action', async () => {
    mockSystemApi.fetchUpdateStatus.mockResolvedValueOnce({
      currentTask: null,
      lastTask: null,
    })
    const store = useAppStore()
    store.updateTaskId = 'task-stale'
    store.updateTaskStatus = 'failed'
    store.updateTaskStage = 'failed'
    store.updateTaskMessage = 'Failed to start source deployment update 0.6.29.'
    store.updateTaskError = 'managed source deployment update service exited before replacing server: code=null signal=SIGINT'

    const ok = await store.clearStaleUpdateStatus()

    expect(ok).toBe(true)
    expect(mockSystemApi.clearStaleUpdateStatus).toHaveBeenCalledTimes(1)
    expect(store.updateTaskId).toBe('')
    expect(store.updateTaskStatus).toBe('idle')
    expect(store.updateTaskStage).toBe('idle')
    expect(store.updateTaskError).toBe('')
  })

  it('records Docker runtime state from the health response', async () => {
    mockSystemApi.checkHealth.mockResolvedValue({
      status: 'ok',
      webui_version: 'test',
      webui_update_available: false,
      is_docker: true,
    })
    const store = useAppStore()

    await store.checkConnection()

    expect(store.isDocker).toBe(true)
    expect(store.updateAvailable).toBe(false)
  })

  it('clears the updating state and reports failure when self-update request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSystemApi.triggerUpdate.mockRejectedValue(new Error('install failed'))
    const store = useAppStore()
    store.updateEnabled = true

    const ok = await store.doUpdate()

    expect(ok).toBe(false)
    expect(store.updating).toBe(false)
    expect(store.updateTaskStatus).toBe('failed')
    expect(store.updateTaskStage).toBe('failed')
    expect(store.updateTaskError).toBe('install failed')
    expect(consoleError).toHaveBeenCalledWith('Failed to update Hermes Web UI:', expect.any(Error))
    consoleError.mockRestore()
  })

  it('loads model aliases and resolves display names without changing canonical IDs', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash'],
        api_key: '',
      }],
      allProviders: [],
      model_aliases: {
        deepseek: { 'deepseek-v4-flash': 'Flash Alias' },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('deepseek-v4-flash')
    expect(store.getModelAlias('deepseek-v4-flash', 'deepseek')).toBe('Flash Alias')
    expect(store.displayModelName('deepseek-v4-flash', 'deepseek')).toBe('Flash Alias')
    expect(store.displayModelName('unknown', 'deepseek')).toBe('unknown')
  })

  it('selects the browser active profile default instead of the aggregate response default', async () => {
    window.localStorage.setItem('hermes_active_profile_name', 'tester')
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'glm-5-turbo',
      default_provider: 'custom:glm-coding-plan',
      groups: [{
        provider: 'custom:glm-coding-plan',
        label: 'glm-coding-plan',
        base_url: 'https://api.z.ai/api/anthropic',
        models: ['glm-5-turbo', 'glm-5.1'],
        api_key: '',
      }],
      allProviders: [],
      profiles: [
        {
          profile: 'default',
          default: 'glm-5-turbo',
          default_provider: 'custom:glm-coding-plan',
          groups: [{
            provider: 'custom:glm-coding-plan',
            label: 'glm-coding-plan',
            base_url: 'https://api.z.ai/api/anthropic',
            models: ['glm-5-turbo', 'glm-5.1'],
            api_key: '',
          }],
        },
        {
          profile: 'tester',
          default: 'claude-opus-4-6',
          default_provider: 'custom:subrouter',
          groups: [{
            provider: 'custom:subrouter',
            label: 'subrouter',
            base_url: 'https://subrouter.ai/v1',
            models: ['claude-opus-4-6', 'gpt-5.5'],
            api_key: '',
          }],
        },
      ],
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('claude-opus-4-6')
    expect(store.selectedProvider).toBe('custom:subrouter')
  })

  it('does not refetch available models within the cache window after an empty response', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: '',
      default_provider: '',
      groups: [],
      allProviders: [],
    })
    const store = useAppStore()

    await store.loadModels()
    await store.loadModels()

    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('keeps the manually selected model on refresh with preserveSelection when it still exists', async () => {
    const deepseekGroup = {
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: '',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    }
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [deepseekGroup],
      allProviders: [],
    })
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)
    const store = useAppStore()

    await store.loadModels()
    expect(store.selectedModel).toBe('deepseek-chat')

    // User manually switches away from the config default
    await store.switchModel('deepseek-reasoner', 'deepseek')
    expect(store.selectedModel).toBe('deepseek-reasoner')

    // config.yaml now points at a different default and grows a new model
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [{ ...deepseekGroup, models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4'] }],
      allProviders: [],
    })

    await store.reloadModels({ preserveSelection: true })

    expect(store.modelGroups[0].models).toContain('deepseek-v4')
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
  })

  it('falls back to the config default on refresh when the selected model disappeared', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: '',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      }],
      allProviders: [],
    })
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)
    const store = useAppStore()

    await store.loadModels()
    await store.switchModel('deepseek-chat', 'deepseek')
    expect(store.selectedModel).toBe('deepseek-chat')

    // deepseek-chat got removed from config.yaml
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: '',
        models: ['deepseek-reasoner'],
      }],
      allProviders: [],
    })

    await store.reloadModels({ preserveSelection: true })

    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
  })

  it('waits only up to the run timeout for the first available models request', async () => {
    vi.useFakeTimers()
    mockSystemApi.fetchAvailableModels.mockReturnValue(new Promise(() => {}))
    const store = useAppStore()
    let resolved = false

    const waitPromise = store.waitForModelsForRun(15000).then(() => {
      resolved = true
    })

    expect(mockSystemApi.fetchAvailableModels).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(14999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waitPromise
    expect(resolved).toBe(true)
    expect(store.modelGroups).toEqual([])
  })

  it('keeps aliases scoped to their provider when model IDs overlap', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'shared-model',
      default_provider: 'provider-a',
      groups: [
        {
          provider: 'provider-a',
          label: 'Provider A',
          base_url: 'https://a.example/v1',
          models: ['shared-model'],
          api_key: '',
        },
        {
          provider: 'provider-b',
          label: 'Provider B',
          base_url: 'https://b.example/v1',
          models: ['shared-model'],
          api_key: '',
        },
      ],
      allProviders: [],
      model_aliases: {
        'provider-a': { 'shared-model': 'A Alias' },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.displayModelName('shared-model', 'provider-a')).toBe('A Alias')
    expect(store.displayModelName('shared-model', 'provider-b')).toBe('shared-model')
    expect(store.displayModelName('shared-model')).toBe('A Alias')
  })

  it('rehydrates an active unlisted default model as removable after loading models', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'manually-supported-id',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash'],
        api_key: '',
      }],
      allProviders: [],
      model_aliases: {},
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('manually-supported-id')
    expect(store.customModels).toEqual({ deepseek: ['manually-supported-id'] })
  })

  it('loads persisted custom models from the server response', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'gemma-4-26b-a4b-it',
      default_provider: 'google-ai-studio',
      groups: [{
        provider: 'google-ai-studio',
        label: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemma-4-26b-a4b-it'],
        api_key: '',
      }],
      allProviders: [],
      custom_models: {
        'google-ai-studio': ['gemma-4-26b-a4b-it'],
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('gemma-4-26b-a4b-it')
    expect(store.customModels).toEqual({
      'google-ai-studio': ['gemma-4-26b-a4b-it'],
    })
  })

  it('saves and clears model aliases via the Web UI-only alias API', async () => {
    mockSystemApi.updateModelAlias.mockResolvedValue(undefined)
    const store = useAppStore()

    await store.setModelAlias('deepseek-v4-flash', 'deepseek', '  Flash Alias  ')

    expect(mockSystemApi.updateModelAlias).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      alias: 'Flash Alias',
    })
    expect(store.modelAliases).toEqual({ deepseek: { 'deepseek-v4-flash': 'Flash Alias' } })

    await store.setModelAlias('deepseek-v4-flash', 'deepseek', '')
    expect(store.modelAliases).toEqual({})
  })

  it('removes an unlisted custom model and falls back to a listed model when active', async () => {
    mockSystemApi.updateDefaultModel.mockResolvedValue(undefined)
    const store = useAppStore()
    store.modelGroups = [{
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-v4-flash'],
      api_key: '',
    }]
    mockSystemApi.addCustomModel.mockResolvedValue({
      success: true,
      custom_models: { deepseek: ['test'] },
    })
    mockSystemApi.removeCustomModel.mockResolvedValue({
      success: true,
      custom_models: {},
    })

    await store.switchModel('test', 'deepseek')
    expect(store.selectedModel).toBe('test')
    expect(store.customModels).toEqual({ deepseek: ['test'] })
    expect(mockSystemApi.addCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'test',
    })

    await store.removeCustomModel('test', 'deepseek')
    expect(store.customModels).toEqual({})
    expect(mockSystemApi.removeCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'test',
    })
    expect(store.selectedModel).toBe('deepseek-v4-flash')
    expect(mockSystemApi.updateDefaultModel).toHaveBeenLastCalledWith({
      default: 'deepseek-v4-flash',
      provider: 'deepseek',
    })
  })

  it('removes deleted custom models from loaded model groups immediately', async () => {
    mockSystemApi.removeCustomModel.mockResolvedValue({
      success: true,
      custom_models: {},
    })
    const store = useAppStore()
    store.customModels = { deepseek: ['manual-model'] }
    store.modelGroups = [{
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-v4-flash', 'manual-model'],
      available_models: ['deepseek-v4-flash', 'manual-model'],
      api_key: '',
    }]
    store.profileModelGroups = [{
      profile: 'default',
      default: 'deepseek-v4-flash',
      default_provider: 'deepseek',
      groups: [{
        provider: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash', 'manual-model'],
        available_models: ['deepseek-v4-flash', 'manual-model'],
        api_key: '',
      }],
    }]

    await store.removeCustomModel('manual-model', 'deepseek')

    expect(store.modelGroups[0].models).toEqual(['deepseek-v4-flash'])
    expect(store.modelGroups[0].available_models).toEqual(['deepseek-v4-flash'])
    expect(store.profileModelGroups[0].groups[0].models).toEqual(['deepseek-v4-flash'])
    expect(store.profileModelGroups[0].groups[0].available_models).toEqual(['deepseek-v4-flash'])
  })
})
