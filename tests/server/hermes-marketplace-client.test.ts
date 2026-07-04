import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('hermes marketplace client', () => {
  const originalCwd = process.cwd
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'experts-marketplace-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(
      join(dir, 'config', 'experts-marketplace.yaml'),
      'baseUrl: "https://market.example"\ncacheTtlSeconds: 30\n',
      'utf8',
    )
    process.cwd = () => dir

    const configMod = await import('../../packages/server/src/services/hermes/experts/config')
    const clientMod = await import('../../packages/server/src/services/hermes/experts/marketplace-client')
    configMod.resetExpertsMarketplaceConfigCache()
    clientMod.clearCatalogCache()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    process.cwd = originalCwd
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('normalizes skillhub catalog payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 0,
        data: {
          experts: [
            {
              slug: 'quant-research-assistant',
              name: '量化研究助手',
              kind: 'expert',
              category: { slug: 'quant-strategy', name: '量化策略' },
              summary: '面向研究员的多因子分析与回测助手',
              icon_url: '',
              cover_url: '',
              default_launch_target: 'chat',
              is_featured: true,
              latest_version: {
                version: '1.2.0',
                artifact_sha256: 'abc123',
                artifact_size: 7654,
                published_at: '2026-06-30T10:00:00+08:00',
              },
              updated_at: '2026-07-03T03:20:19.529369+08:00',
            },
          ],
        },
      })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const mod = await import('../../packages/server/src/services/hermes/experts/marketplace-client')
    const items = await mod.fetchCatalog(true)

    expect(fetchMock).toHaveBeenCalledWith('https://market.example/api/skillhub/expert-catalog/', undefined)
    expect(items).toEqual([
      expect.objectContaining({
        slug: 'quant-research-assistant',
        category: '量化策略',
        latest_version: expect.objectContaining({
          version: '1.2.0',
          artifact_sha256: 'abc123',
        }),
      }),
    ])
  })

  it('builds manifest from skillhub latest payload', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/skillhub/expert-catalog/quant-research-assistant/')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          data: {
            slug: 'quant-research-assistant',
            name: '量化研究助手',
            kind: 'expert',
            category: { slug: 'quant-strategy', name: '量化策略' },
            summary: '面向研究员的多因子分析与回测助手',
            description: 'desc',
            default_launch_target: 'chat',
            is_featured: false,
            latest_version: {
              version: '1.2.0',
              artifact_sha256: 'abc123',
              artifact_size: 7654,
              published_at: '2026-06-30T10:00:00+08:00',
            },
          },
        })))
      }
      if (url.endsWith('/api/skillhub/expert-catalog/quant-research-assistant/latest/')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          data: {
            version: '1.2.0',
            artifact_sha256: 'abc123',
            artifact_size: 7654,
            published_at: '2026-06-30T10:00:00+08:00',
            manifest_json: {
              expert: {
                slug: 'quant-research-assistant',
                name: '量化研究助手',
                kind: 'expert',
                category: { slug: 'quant-strategy', name: '量化策略' },
                summary: '面向研究员的多因子分析与回测助手',
                default_launch_target: 'chat',
              },
              version: {
                name: '1.2.0',
                artifact_sha256: 'abc123',
                artifact_size: 7654,
                release_notes: '新增因子库',
              },
              profile_template: {
                display_name: '量化研究助手',
                system_prompt_path: 'prompts/system.md',
                avatar_path: 'assets/avatar.png',
                starter_prompts: ['做一个 alpha 因子分析'],
                default_skills: ['python'],
              },
            },
          },
        })))
      }
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const mod = await import('../../packages/server/src/services/hermes/experts/marketplace-client')
    const manifest = await mod.fetchManifest('quant-research-assistant', '1.2.0')

    expect(manifest).toEqual({
      expert: {
        slug: 'quant-research-assistant',
        name: '量化研究助手',
        kind: 'expert',
        category: '量化策略',
        summary: '面向研究员的多因子分析与回测助手',
        defaultLaunchTarget: 'chat',
      },
      version: {
        name: '1.2.0',
        artifactSha256: 'abc123',
        artifactSize: 7654,
        releaseNotes: '新增因子库',
      },
      profileTemplate: {
        displayName: '量化研究助手',
        systemPromptPath: 'prompts/system.md',
        avatarPath: 'assets/avatar.png',
        starterPrompts: ['做一个 alpha 因子分析'],
        defaultSkills: ['python'],
      },
    })
  })

  it('synthesizes direct download grant from skillhub latest payload', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/skillhub/expert-catalog/quant-research-assistant/latest/')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          data: {
            version: '1.2.0',
            artifact_url: '',
            artifact_sha256: 'abc123',
            artifact_size: 7654,
            published_at: '2026-06-30T10:00:00+08:00',
          },
        })))
      }
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const mod = await import('../../packages/server/src/services/hermes/experts/marketplace-client')
    const grant = await mod.requestDownload('quant-research-assistant', '1.2.0', 'client-1')

    expect(grant).toEqual(expect.objectContaining({
      download_url: 'https://market.example/api/skillhub/expert-catalog/quant-research-assistant/download/',
      sha256: 'abc123',
      size: 7654,
      signature_algorithm: 'direct',
    }))
    expect(grant.expires_at).toBeGreaterThan(Date.now())
  })

  it('falls back to legacy catalog when skillhub route is missing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/skillhub/expert-catalog/')) {
        return Promise.resolve(new Response('not found', { status: 404, statusText: 'Not Found' }))
      }
      if (url.endsWith('/api/experts/catalog/')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 0,
          data: {
            experts: [
              {
                slug: 'legacy-expert',
                name: '旧版专家',
                kind: 'expert',
                category: '旧版分类',
                summary: 'legacy',
                default_launch_target: 'chat',
                is_featured: false,
                latest_version: '0.9.0',
              },
            ],
          },
        })))
      }
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const mod = await import('../../packages/server/src/services/hermes/experts/marketplace-client')
    const items = await mod.fetchCatalog(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(items[0]).toEqual(expect.objectContaining({
      slug: 'legacy-expert',
      category: '旧版分类',
      latest_version: expect.objectContaining({ version: '0.9.0' }),
    }))
  })
})
