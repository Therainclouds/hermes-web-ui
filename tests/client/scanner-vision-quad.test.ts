import { describe, expect, it } from 'vitest'
import {
  computeOutputSize,
  cornersToQuad,
  quadArea,
  quadCornerDelta,
  quadNaturalSize,
  quadToCorners,
  scaleQuad,
} from '@/plugins/scanner/vision/quad'
import type { Quad } from '@/plugins/scanner/vision/types'

const unitSquare: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

const tilted: Quad = [
  { x: 0.1, y: 0.05 },
  { x: 0.9, y: 0.08 },
  { x: 0.85, y: 0.95 },
  { x: 0.05, y: 0.9 },
]

describe('scanner vision quad helpers', () => {
  it('computes the normalized area of a quad', () => {
    expect(quadArea(unitSquare)).toBeCloseTo(1, 6)
    // 平移不改变面积
    const shifted = unitSquare.map(p => ({ x: p.x + 0.5, y: p.y - 2 })) as Quad
    expect(quadArea(shifted)).toBeCloseTo(1, 6)
    // 面积恒 >= 0
    expect(quadArea(tilted)).toBeGreaterThan(0.4)
  })

  it('natural size uses opposite-edge maximum', () => {
    const { width, height } = quadNaturalSize(unitSquare)
    expect(width).toBeCloseTo(1)
    expect(height).toBeCloseTo(1)
    const wide = quadNaturalSize([
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 },
    ] as Quad)
    expect(wide.width).toBeCloseTo(2)
    expect(wide.height).toBeCloseTo(1)
  })

  it('round-trips corners <-> quad', () => {
    const corners = quadToCorners(tilted)
    const back = cornersToQuad(corners)
    for (let i = 0; i < 4; i++) {
      expect(back[i]!.x).toBeCloseTo(tilted[i]!.x)
      expect(back[i]!.y).toBeCloseTo(tilted[i]!.y)
    }
  })

  it('scales quads', () => {
    const scaled = scaleQuad(unitSquare, 800, 600)
    expect(scaled[1]!.x).toBe(800)
    expect(scaled[2]!.y).toBe(600)
  })

  it('measures corner delta and reports 0 for identical quads', () => {
    expect(quadCornerDelta(unitSquare, unitSquare)).toBe(0)
    const moved = unitSquare.map(p => ({ x: p.x + 0.1, y: p.y })) as Quad
    expect(quadCornerDelta(unitSquare, moved)).toBeCloseTo(0.1)
  })

  it('computeOutputSize respects maxEdge and natural aspect', () => {
    const big = scaleQuad(unitSquare, 4000, 2000)
    const { width, height } = computeOutputSize(big, { maxEdge: 2000 })
    expect(Math.max(width, height)).toBeLessThanOrEqual(2000)
    expect(width / height).toBeCloseTo(2, 1)
  })

  it('computeOutputSize can force an aspect ratio', () => {
    // 用大坐标避免像素取整把比例吃掉
    const big = scaleQuad(tilted, 2600, 2600)
    const square = computeOutputSize(big, { maxEdge: 3000, aspectRatio: 1 })
    expect(Math.abs(square.width / square.height - 1)).toBeLessThan(0.02)
    const a4 = computeOutputSize(big, { maxEdge: 3000, aspectRatio: 1 / Math.sqrt(2) })
    expect(Math.abs(a4.width / a4.height - 1 / Math.sqrt(2))).toBeLessThan(0.02)
  })

  it('computeOutputSize never returns degenerate sizes', () => {
    const degenerate = computeOutputSize(
      [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 0.001, y: 0.001 }, { x: 0, y: 0.001 }] as Quad,
      { maxEdge: 100 },
    )
    expect(degenerate.width).toBeGreaterThanOrEqual(2)
    expect(degenerate.height).toBeGreaterThanOrEqual(2)
  })
})
