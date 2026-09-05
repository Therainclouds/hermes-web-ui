import { describe, expect, it } from 'vitest'
import {
  accumulateStable,
  hideAfterMisses,
  inCooldown,
  isOutlierWhileLocked,
  smoothQuad,
  isQuadSufficient,
  isStableEnough,
  quadAreaRatio,
  shouldRecapture,
  shouldStayLocked,
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

  describe('shouldStayLocked (sticky 锁定升级)', () => {
    // 回归：之前用 stable.count 触发，但 stabilityTolerance=0.012 在 Otsu / 相机抖动
    // 下根本到不了 3，锁定态事实上从未激活 → HIDE_AFTER_MISSES=3 仍是真实行为。
    // 改为 hits 触发且 sticky 后，hits 累计到阈值即进入锁定并保持。

    it('未锁定 + 命中数 < 阈值 → 不锁定', () => {
      expect(shouldStayLocked({
        currentlyLocked: false, consecutiveHits: 0, lockHits: 3,
      })).toBe(false)
      expect(shouldStayLocked({
        currentlyLocked: false, consecutiveHits: 2, lockHits: 3,
      })).toBe(false)
    })

    it('未锁定 + 命中数 = 阈值 → 升级锁定', () => {
      expect(shouldStayLocked({
        currentlyLocked: false, consecutiveHits: 3, lockHits: 3,
      })).toBe(true)
    })

    it('未锁定 + 命中数 > 阈值 → 升级锁定', () => {
      expect(shouldStayLocked({
        currentlyLocked: false, consecutiveHits: 5, lockHits: 3,
      })).toBe(true)
    })

    it('已锁定 → 保持锁定（即使命中数降到 0，对应「中间出现几帧 miss」）', () => {
      // 这是 sticky 的关键：选框锁定后，即使几帧检测失败导致 hits 在
      // onDetectionLoss 里被清零，下一帧命中 hits=1 时也应继续保持锁定。
      expect(shouldStayLocked({
        currentlyLocked: true, consecutiveHits: 0, lockHits: 3,
      })).toBe(true)
      expect(shouldStayLocked({
        currentlyLocked: true, consecutiveHits: 1, lockHits: 3,
      })).toBe(true)
    })

    it('锁定升级后，hits 重置不影响 sticky 状态（这是 fix flicker 的核心）', () => {
      let locked = false
      // 连续 3 帧命中 → 锁定
      locked = shouldStayLocked({ currentlyLocked: locked, consecutiveHits: 3, lockHits: 3 })
      expect(locked).toBe(true)
      // 中间 1 帧 miss（hits 在 onDetectionLoss 重置为 0）
      locked = shouldStayLocked({ currentlyLocked: locked, consecutiveHits: 0, lockHits: 3 })
      // 仍然锁定 ←─ 这一行就是用户修复「闪烁」的关键
      expect(locked).toBe(true)
      // 恢复 1 帧命中（hits=1）
      locked = shouldStayLocked({ currentlyLocked: locked, consecutiveHits: 1, lockHits: 3 })
      expect(locked).toBe(true)
    })
  })

  describe('hideAfterMisses (miss 容忍阈值)', () => {
    it('未锁定 → 用基础阈值（响应优先）', () => {
      expect(hideAfterMisses({
        locked: false, baseHideAfterMisses: 3, lockHideAfterMisses: 12,
      })).toBe(3)
    })

    it('已锁定 → 用更长的容忍阈值（覆盖 Otsu 抖动 / ML 冷却）', () => {
      expect(hideAfterMisses({
        locked: true, baseHideAfterMisses: 3, lockHideAfterMisses: 12,
      })).toBe(12)
    })

    it('自定义阈值也按 locked 分流', () => {
      expect(hideAfterMisses({
        locked: false, baseHideAfterMisses: 5, lockHideAfterMisses: 20,
      })).toBe(5)
      expect(hideAfterMisses({
        locked: true, baseHideAfterMisses: 5, lockHideAfterMisses: 20,
      })).toBe(20)
    })
  })
})
