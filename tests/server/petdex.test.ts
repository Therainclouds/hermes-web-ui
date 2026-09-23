import { describe, expect, it } from 'vitest'
import {
  assertPetdexAssetUrl,
  fetchPetdexAsset,
  fetchPetdexManifest,
} from '../../packages/server/src/services/pets/petdex'

describe('Petdex URL safety', () => {
  it('accepts the canonical petdex.dev host and subdomains over HTTPS', () => {
    expect(() => assertPetdexAssetUrl('https://petdex.dev/sprite.webp')).not.toThrow()
    expect(() => assertPetdexAssetUrl('https://assets.petdex.dev/sprite.webp')).not.toThrow()
  })

  it('rejects non-HTTPS or non-petdex hosts', () => {
    expect(() => assertPetdexAssetUrl('http://petdex.dev/sprite.webp')).toThrow(/Unsupported/)
    expect(() => assertPetdexAssetUrl('https://example.com/sprite.webp')).toThrow(/Unsupported/)
  })

  it('rejects malformed URLs', () => {
    expect(() => assertPetdexAssetUrl('not a url')).toThrow()
  })
})

describe('fetchPetdexAsset', () => {
  it('surfaces upstream status errors with a clear message', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch
    try {
      await expect(
        fetchPetdexAsset('https://assets.petdex.dev/missing.webp'),
      ).rejects.toThrow(/petdex asset request failed/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('rejects oversized content-length before downloading the body', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      const headers = new Headers({ 'content-length': String(11 * 1024 * 1024) })
      return new Response('payload', { status: 200, headers })
    }) as typeof fetch
    try {
      await expect(
        fetchPetdexAsset('https://assets.petdex.dev/huge.webp'),
      ).rejects.toThrow(/too large/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('fetchPetdexManifest normalization', () => {
  it('drops malformed entries and accepts valid manifests', async () => {
    const original = globalThis.fetch
    const validPayload = {
      generatedAt: '2025-01-01T00:00:00Z',
      total: 2,
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
        {
          // missing spritesheetUrl → dropped
          slug: 'broken',
        },
      ],
    }
    globalThis.fetch = (async () => new Response(JSON.stringify(validPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      const manifest = await fetchPetdexManifest({ force: true })
      expect(manifest.pets.map(p => p.slug)).toEqual(['fox'])
      expect(manifest.total).toBe(2)
      expect(manifest.pets[0].previewUrl).toContain('/api/hermes/petdex/asset?url=')
    } finally {
      globalThis.fetch = original
    }
  })

  it('rejects manifests with no valid pets', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ pets: [{}] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      await expect(fetchPetdexManifest({ force: true })).rejects.toThrow(/no pets/)
    } finally {
      globalThis.fetch = original
    }
  })
})