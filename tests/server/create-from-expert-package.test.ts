import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const createProfileMock = vi.fn()
const deleteProfileMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const saveEnvValueForProfileMock = vi.fn()
const copyModelProviderAuthForCloneMock = vi.fn()

let tmpDir = ''

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  createProfile: createProfileMock,
  deleteProfile: deleteProfileMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-path', () => ({
  detectHermesRootHome: () => tmpDir,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  PROVIDER_ENV_MAP: {
    'minimax-cn': {
      api_key_env: 'MINIMAX_CN_API_KEY',
      base_url_env: 'MINIMAX_CN_BASE_URL',
    },
  },
  readConfigYamlForProfile: readConfigYamlForProfileMock,
  saveEnvValueForProfile: saveEnvValueForProfileMock,
}))

vi.mock('../../packages/server/src/services/hermes/profile-credentials', () => ({
  copyModelProviderAuthForClone: copyModelProviderAuthForCloneMock,
}))

describe('create-from-expert-package', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'expert-profile-test-'))
    vi.clearAllMocks()
    createProfileMock.mockResolvedValue('created')
    deleteProfileMock.mockResolvedValue(true)
    readConfigYamlForProfileMock.mockResolvedValue({
      model: {
        default: 'MiniMax-M2.7',
        provider: 'minimax-cn',
      },
    })
    copyModelProviderAuthForCloneMock.mockReturnValue([])
    saveEnvValueForProfileMock.mockResolvedValue(undefined)
    writeFileSync(join(tmpDir, '.env'), [
      'MINIMAX_CN_API_KEY=sk-default-minimax',
      'MINIMAX_CN_BASE_URL=https://api.minimaxi.com/anthropic',
      '',
    ].join('\n'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('hydrates expert profiles with default model env keys and provider auth context', async () => {
    const systemPromptAbs = join(tmpDir, 'system.md')
    writeFileSync(systemPromptAbs, '# system prompt\n')

    const mod = await import('../../packages/server/src/services/hermes/profiles/create-from-expert-package')
    const result = await mod.createExpertProfile({
      profileName: 'expert_fullstack-architect',
      displayName: '全栈架构专家',
      expertSlug: 'fullstack-architect',
      expertKind: 'expert',
      installedVersion: '1.0.0',
      sourceManifestPath: '/tmp/expert/manifest.json',
      systemPromptAbs,
    })

    expect(result.created).toBe(true)
    expect(createProfileMock).toHaveBeenCalledWith('expert_fullstack-architect')
    expect(saveEnvValueForProfileMock).toHaveBeenCalledWith(
      'expert_fullstack-architect',
      'MINIMAX_CN_API_KEY',
      'sk-default-minimax',
    )
    expect(saveEnvValueForProfileMock).toHaveBeenCalledWith(
      'expert_fullstack-architect',
      'MINIMAX_CN_BASE_URL',
      'https://api.minimaxi.com/anthropic',
    )
    expect(copyModelProviderAuthForCloneMock).toHaveBeenCalledWith('expert_fullstack-architect', 'default')

    const configYaml = readFileSync(join(tmpDir, 'profiles', 'expert_fullstack-architect', 'config.yaml'), 'utf-8')
    expect(configYaml).toContain('default: MiniMax-M2.7')
    expect(configYaml).toContain('provider: minimax-cn')
  })
})
