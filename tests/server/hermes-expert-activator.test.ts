import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchDetailMock = vi.fn()
const fetchLatestMock = vi.fn()
const installExpertPackageMock = vi.fn()
const upsertBindingMock = vi.fn()
const upsertInstalledExpertMock = vi.fn()
const createExpertProfileMock = vi.fn()
const removeExpertProfileMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/experts/marketplace-client', () => ({
  fetchDetail: fetchDetailMock,
  fetchLatest: fetchLatestMock,
}))

vi.mock('../../packages/server/src/services/hermes/experts/installer', () => ({
  InstallError: class InstallError extends Error {
    stage: string
    code: number

    constructor(stage: string, message: string, code = 500) {
      super(message)
      this.stage = stage
      this.code = code
    }
  },
  installExpertPackage: installExpertPackageMock,
}))

vi.mock('../../packages/server/src/db/hermes/experts-store', () => ({
  upsertBinding: upsertBindingMock,
  upsertInstalledExpert: upsertInstalledExpertMock,
}))

vi.mock('../../packages/server/src/services/hermes/profiles/create-from-expert-package', () => ({
  buildExpertProfileName: (kind: string, slug: string) => `${kind}:${slug}`,
  createExpertProfile: createExpertProfileMock,
  removeExpertProfile: removeExpertProfileMock,
}))

describe('hermes expert activator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createExpertProfileMock.mockResolvedValue({
      profileName: 'team:trend-following-team',
      created: true,
      updated: false,
      profileDir: '/profiles/team',
    })
  })

  it('downloads member packages when team members have no latest_version', async () => {
    fetchDetailMock.mockResolvedValue({
      slug: 'trend-following-team',
      name: '趋势跟踪专家团',
      kind: 'team',
      summary: 'summary',
      description: 'desc',
      category: '量化策略',
      default_launch_target: 'chat',
      is_featured: false,
      latest_version: {
        version: '2.0.0',
        artifact_sha256: 'team-sha',
        artifact_size: 123,
        published_at: '2026-07-03T10:00:00+08:00',
      },
      team_members: [
        {
          slug: 'trend-spotter',
          name: 'TrendSpotter',
          role_name: '信号识别',
          sort_order: 1,
          is_captain: false,
          latest_version: null,
        },
      ],
    })
    fetchLatestMock.mockResolvedValue({
      version: '1.5.0',
      artifact_sha256: 'member-sha',
      artifact_size: 456,
      published_at: '2026-07-03T10:00:00+08:00',
    })
    installExpertPackageMock.mockResolvedValue({
      slug: 'trend-spotter',
      version: '1.5.0',
      status: 'installed',
      installDir: '/packages/trend-spotter/1.5.0',
      manifest: {
        expert: {
          slug: 'trend-spotter',
          name: 'TrendSpotter',
          kind: 'expert',
          category: '量化策略',
          summary: 'summary',
          defaultLaunchTarget: 'chat',
        },
        version: {
          name: '1.5.0',
          artifactSha256: 'member-sha',
          artifactSize: 456,
        },
        profileTemplate: {
          displayName: 'TrendSpotter',
          systemPromptPath: 'prompts/system.md',
          avatarPath: 'assets/avatar.png',
          starterPrompts: [],
          defaultSkills: [],
        },
      },
    })

    const mod = await import('../../packages/server/src/services/hermes/experts/activator')
    const result = await mod.activateFromInstallDir(
      'trend-following-team',
      '2.0.0',
      '/packages/trend-following-team/2.0.0',
      {
        expert: {
          slug: 'trend-following-team',
          name: '趋势跟踪专家团',
          kind: 'team',
          category: '量化策略',
          summary: 'summary',
          defaultLaunchTarget: 'chat',
        },
        version: {
          name: '2.0.0',
          artifactSha256: 'team-sha',
          artifactSize: 123,
        },
        profileTemplate: {
          displayName: '趋势跟踪专家团',
          systemPromptPath: 'prompts/system.md',
          avatarPath: 'assets/avatar.png',
          starterPrompts: [],
          defaultSkills: [],
        },
      },
      'client-1',
    )

    expect(fetchLatestMock).toHaveBeenCalledWith('trend-spotter')
    expect(installExpertPackageMock).toHaveBeenCalledWith('trend-spotter', '1.5.0', 'client-1')
    expect(result.failed).toEqual([])
    expect(result.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'trend-following-team', role: 'captain' }),
        expect.objectContaining({ slug: 'trend-spotter', role: 'member', parent_team_slug: 'trend-following-team' }),
      ]),
    )
  })
})
