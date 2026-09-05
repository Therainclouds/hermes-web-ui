import { describe, expect, it } from 'vitest'
import {
  accumulateStable,
  inCooldown,
  isOutlierWhileLocked,
  smoothQuad,
  isQuadSufficient,
  isStableEnough,
  quadAreaRatio,
  shouldRecapture,
} from '@/plugins/scanner/vision/capture-logic'
import type { Quad } from '@/plugins/scanner/vision/types'

const quadA: Quad = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
]
const quadB = quadA.map(p => ({ x: p.x + 0.05, y: p.y })) as Quad

describe('scanner capture logic', () => {
  it('area ratio matches normalized quad area', () => {
    expect(quadAreaRatio(quadA)).toBeCloseTo(0.64, 6)
    expect(isQuadSufficient(quadA, 0.03)).toBe(true)
    const tiny = quadA.map(p => ({ x: p.x * 0.1 + 0.4, y: p.y * 0.1 + 0.4 })) as Quad
    expect(isQuadSufficient(tiny, 0.03)).toBe(false)
    expect(isQuadSufficient(tiny, 0.001)).toBe(true)
  })

  it('accumulates stable frames within tolerance and resets otherwise', () => {
    let state = accumulateStable(null, quadA, 0.01)
    expect(state.count).toBe(1)

    state = accumulateStable(state, quadA, 0.01)
    expect(state.count).toBe(2)

    // 小抖动仍在容差内
    state = accumulateStable(state, quadB, 0.06)
    expect(state.count).toBe(3)

    // 大幅移动 -> 重置
    const far = quadA.map(p => ({ x: p.x + 0.4, y: p.y })) as Quad
    state = accumulateStable(state, far, 0.01)
    expect(state.count).toBe(1)
    expect(state.last).toEqual(far)
  })

  it('isStableEnough compares count against required frames', () => {
    expect(isStableEnough({ count: 3, last: quadA }, 4)).toBe(false)
    expect(isStableEnough({ count: 4, last: quadA }, 4)).toBe(true)
    expect(isStableEnough({ count: 9, last: quadA }, 4)).toBe(true)
  })

  it('shouldRecapture: first capture always allowed, needs real page change afterwards', () => {
    expect(shouldRecapture(null, quadA, 0.03)).toBe(true)
    const slightlyMoved = quadA.map(p => ({ x: p.x + 0.02, y: p.y })) as Quad
    // 平均位移 0.02 <= 0.03 -> 同一张纸，不重复拍
    expect(shouldRecapture(quadA, slightlyMoved, 0.03)).toBe(false)
    // 同一位移，但门槛收紧到 0.01 -> 允许重拍
    expect(shouldRecapture(quadA, slightlyMoved, 0.01)).toBe(true)
    // 大幅移动（翻页）-> 允许再次拍摄
    const moved = quadA.map(p => ({ x: p.x + 0.3, y: p.y + 0.2 })) as Quad
    expect(shouldRecapture(quadA, moved, 0.03)).toBe(true)
  })

  it('inCooldown gates capture frequency by time', () => {
    expect(inCooldown(1000, 1500, 1000)).toBe(true)
    expect(inCooldown(1000, 1500, 2499)).toBe(true)
    expect(inCooldown(1000, 1500, 2500)).toBe(false)
    expect(inCooldown(0, 1500, 1500)).toBe(false)
  })

  it('smoothQuad: returns raw quad when there is no previous frame', () => {
    expect(smoothQuad(null, quadA)).toEqual(quadA)
  })

  it('smoothQuad: alpha=1 adopts the new quad exactly', () => {
    expect(smoothQuad(quadA, quadB, 1)).toEqual(quadB)
  })

  it('smoothQuad: interpolates between previous and new corner positions', () => {
    const out = smoothQuad(quadA, quadB, 0.5)
    // 平均角点位移 = 0.05/2 = 0.025
    expect(out[0]!.x).toBeCloseTo(0.125, 6)
    expect(out[2]!.x).toBeCloseTo(0.925, 6)
    // 连续平滑两帧后更接近目标（抑制跳框）
    const mid = smoothQuad(quadA, quadB, 0.6)
    const later = smoothQuad(mid, quadB, 0.6)
    expect(Math.abs(later[0]!.x - quadB[0]!.x)).toBeLessThan(Math.abs(mid[0]!.x - quadB[0]!.x))
  })

  describe('isOutlierWhileLocked', () => {
    // 归一化位移：跳到 (x+0.35) 使四角平均位移 0.35
    const far = quadA.map(p => ({ x: p.x + 0.35, y: p.y })) as Quad

    it('未锁定时永远不判为离群（初次搜索响应优先）', () => {
      expect(isOutlierWhileLocked({
        currentQuad: quadA,
        detected: far,
        locked: false,
        jumpRejectDist: 0.30,
      })).toBe(false)
    })

    it('锁定 + 贴近（jitter）→ 不判离群，走正常平滑', () => {
      const jitter = quadA.map(p => ({ x: p.x + 0.02, y: p.y + 0.01 })) as Quad
      expect(isOutlierWhileLocked({
        currentQuad: quadA,
        detected: jitter,
        locked: true,
        jumpRejectDist: 0.30,
      })).toBe(false)
    })

    it('锁定 + 中等位移（< 阈值）→ 不判离群（慢速移动）', () => {
      const slow = quadA.map(p => ({ x: p.x + 0.10, y: p.y })) as Quad
      expect(isOutlierWhileLocked({
        currentQuad: quadA,
        detected: slow,
        locked: true,
        jumpRejectDist: 0.30,
      })).toBe(false)
    })

    it('锁定 + 远超阈值（> 阈值）→ 判离群（噪声候选 / 错选框）', () => {
      expect(isOutlierWhileLocked({
        currentQuad: quadA,
        detected: far,
        locked: true,
        jumpRejectDist: 0.30,
      })).toBe(true)
    })

    it('位移正好等于阈值 → 不判离群（边界含等）', () => {
      // 平均位移 = 0.30，刚好等于阈值，应走常规路径
      const exactly = quadA.map(p => ({ x: p.x + 0.30, y: p.y })) as Quad
      expect(isOutlierWhileLocked({
        currentQuad: quadA,
        detected: exactly,
        locked: true,
        jumpRejectDist: 0.30,
      })).toBe(false)
    })

    it('位移刚超过阈值 → 判离群', () => {
      const justOver = quadA.map(p => ({ x: p.x + 0.31, y: p.y })) as Quad
      expect(isOutlierWhileLocked({
        currentQuad: quadA,
        detected: justOver,
        locked: true,
        jumpRejectDist: 0.30,
      })).toBe(true)
    })

    it('阈值收紧后，同一远距离检测会从「可接受」变「离群」', () => {
      const medium = quadA.map(p => ({ x: p.x + 0.20, y: p.y })) as Quad
      expect(isOutlierWhileLocked({
        currentQuad: quadA, detected: medium, locked: true, jumpRejectDist: 0.30,
      })).toBe(false)
      expect(isOutlierWhileLocked({
        currentQuad: quadA, detected: medium, locked: true, jumpRejectDist: 0.15,
      })).toBe(true)
    })
  })
})
