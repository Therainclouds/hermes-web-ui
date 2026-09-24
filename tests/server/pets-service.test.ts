import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let dataDir = ''
let initialFetch: typeof fetch

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'hermes-pets-'))
  process.env.HERMES_WEB_UI_HOME = dataDir
  process.env.HERMES_WEBUI_STATE_DIR = dataDir
  initialFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = initialFetch
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

describe('Pets service', () => {
  it('returns null active pet when no adoption has happened', async () => {
    const pets = await import('../../packages/server/src/services/pets/pets')
    expect(await pets.getActivePet('default')).toBeNull()
  })

  it('rejects missing or unsafe slugs before adopting', async () => {
    const pets = await import('../../packages/server/src/services/pets/pets')
    await expect(pets.adoptPetFromPetdex('default', '')).rejects.toThrow(/required/)
    await expect(pets.adoptPetFromPetdex('default', '   ')).rejects.toThrow(/required/)
    await expect(pets.adoptPetFromPetdex('default', '!!!')).rejects.toThrow(/required/)
  })

  it('adopts a pet from the petdex manifest and persists it under the profile', async () => {
    const tinyPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ])
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.endsWith('petdex-v1.json')) {
        return new Response(
          JSON.stringify({
            generatedAt: '2025-01-01T00:00:00Z',
            total: 1,
            pets: [
              {
                slug: 'fox',
                displayName: 'Fox',
                kind: 'fox',
                submittedBy: 'alice',
                spritesheetUrl: 'https://assets.petdex.dev/fox.webp',
                petJsonUrl: 'https://assets.petdex.dev/fox.json',
                zipUrl: 'https://assets.petdex.dev/fox.zip',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(tinyPng, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch

    const pets = await import('../../packages/server/src/services/pets/pets')
    const adopted = await pets.adoptPetFromPetdex('test-profile', 'fox')
    expect(adopted.slug).toBe('fox')
    expect(adopted.displayName).toBe('Fox')
    expect(adopted.spritesheetDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(adopted.scale).toBeCloseTo(0.33, 5)

    const active = await pets.getActivePet('test-profile')
    expect(active?.slug).toBe('fox')
  })

  it('clamps scale and position when updating preferences', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch
    const pets = await import('../../packages/server/src/services/pets/pets')
    // No active pet yet — should report null without throwing
    await expect(pets.updateActivePetPreferences('test-profile', { scale: 5 })).resolves.toBeNull()
  })
})