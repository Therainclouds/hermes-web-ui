import { describe, expect, it } from 'vitest'
import { detectPaper } from '@/plugins/scanner/vision/paper-detector'
import { refinePaperQuad } from '@/plugins/scanner/vision/refine-quad'
import type { Quad } from '@/plugins/scanner/vision/types'

function scene(width: number, height: number, quad: Quad, foreground = 230, background = 40) {
  const data = new Uint8ClampedArray(width * height * 4)
  const gray = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = quad.every((a, i) => {
      const b = quad[(i + 1) % 4]!
      return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0
    })
    const value = inside ? foreground : background
    const index = (y * width + x) * 4
    data[index] = data[index + 1] = data[index + 2] = value
    data[index + 3] = 255
    gray[y * width + x] = value
  }
  return { width, height, data, gray }
}

describe('scanner precision regressions', () => {
  it('uses enclosed area for a large thin edge outline', async () => {
    const quad: Quad = [{ x: 80, y: 60 }, { x: 430, y: 60 }, { x: 430, y: 325 }, { x: 80, y: 325 }]
    const result = await detectPaper(scene(512, 384, quad), { strategies: ['edge'], minAreaRatio: 0.3 })
    expect(result).not.toBeNull()
    result!.quad.forEach((p, i) => {
      expect(Math.hypot(p.x * 512 - quad[i]!.x, p.y * 384 - quad[i]!.y)).toBeLessThan(3)
    })
  })

  for (const strategy of ['bright', 'edge'] as const) {
    it(`${strategy} recovers slanted four corners instead of an axis-aligned box`, async () => {
      const quad: Quad = [{ x: 100, y: 40 }, { x: 430, y: 95 }, { x: 375, y: 340 }, { x: 60, y: 285 }]
      const result = await detectPaper(scene(512, 384, quad, 190, 150), { strategies: [strategy] })
      expect(result).not.toBeNull()
      result!.quad.forEach((p, i) => {
        expect(Math.hypot(p.x * 512 - quad[i]!.x, p.y * 384 - quad[i]!.y)).toBeLessThan(5)
      })
    })
  }

  it('does not bypass full-frame minimum area when a stale prior triggers tracking', async () => {
    const small: Quad = [{ x: 100, y: 90 }, { x: 140, y: 90 }, { x: 140, y: 130 }, { x: 100, y: 130 }]
    const prior = small.map(p => ({ x: p.x / 512, y: p.y / 384 })) as Quad
    expect(await detectPaper(scene(512, 384, small), { priorQuad: prior, minAreaRatio: 0.05 })).toBeNull()
  })

  it('refines padded edges and leaves unsupported images unchanged', () => {
    const quad: Quad = [{ x: 40, y: 35 }, { x: 160, y: 35 }, { x: 160, y: 165 }, { x: 40, y: 165 }]
    const padded: Quad = [{ x: 37, y: 32 }, { x: 163, y: 32 }, { x: 163, y: 168 }, { x: 37, y: 168 }]
    const { gray } = scene(200, 200, quad)
    const result = refinePaperQuad(gray, 200, 200, padded)
    expect(result).not.toBeNull()
    result!.forEach((p, i) => expect(Math.hypot(p.x - quad[i]!.x, p.y - quad[i]!.y)).toBeLessThan(2))
    expect(refinePaperQuad(new Uint8Array(40000), 200, 200, padded)).toBeNull()
  })
})
