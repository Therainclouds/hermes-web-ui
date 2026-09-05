import { quadArea, quadCornerDelta } from './quad'
import type { Quad } from './types'

/**
 * 动态捕捉的纯逻辑（可单测）：
 * 面积门槛、连续稳定帧累计、翻页后允许再次拍摄的判定、选框平滑。
 */

/** 归一化四边形（0..1 空间）的面积比例。 */
export function quadAreaRatio(quad: Quad): number {
  return quadArea(quad)
}

/** 归一化面积是否达到纸张门槛。 */
export function isQuadSufficient(quad: Quad, minAreaRatio: number): boolean {
  return quadAreaRatio(quad) >= minAreaRatio
}

/**
 * 连续帧选框的指数平滑：抑制角点逐帧抖动 / 候选交替导致的跳框，
 * 让选框像扫描大师一样平滑追随。alpha = 新检测权重（0..1，越大越跟手）。
 * prev 为 null（首次/重置后）直接采用 next。
 */
export function smoothQuad(prev: Quad | null, next: Quad, alpha = 0.6): Quad {
  if (!prev) return next
  const lerp = (a: number, b: number) => a + (b - a) * alpha
  return [
    { x: lerp(prev[0]!.x, next[0]!.x), y: lerp(prev[0]!.y, next[0]!.y) },
    { x: lerp(prev[1]!.x, next[1]!.x), y: lerp(prev[1]!.y, next[1]!.y) },
    { x: lerp(prev[2]!.x, next[2]!.x), y: lerp(prev[2]!.y, next[2]!.y) },
    { x: lerp(prev[3]!.x, next[3]!.x), y: lerp(prev[3]!.y, next[3]!.y) },
  ] as unknown as Quad
}

/** 稳定累计状态。 */
export interface StableAccumulator {
  count: number
  last: Quad | null
}

/**
 * 累计稳定帧：quad 与上一帧平均角点位移 <= tolerance 时 count+1，否则重置为 1。
 * 返回新的累计状态（纯函数，调用方持有状态）。
 */
export function accumulateStable(
  prev: StableAccumulator | null,
  quad: Quad,
  tolerance: number,
): StableAccumulator {
  if (prev && prev.last) {
    if (quadCornerDelta(prev.last, quad) <= tolerance) {
      return { count: prev.count + 1, last: quad }
    }
  }
  return { count: 1, last: quad }
}

/** 连续稳定帧数是否足够触发自动拍摄。 */
export function isStableEnough(acc: StableAccumulator, minStableFrames: number): boolean {
  return acc.count >= minStableFrames
}

/**
 * 是否允许再次拍摄：从未拍过，或当前四边形与上次拍摄的位移足够大（翻页了）。
 * changeThreshold 为归一化平均角点位移门槛。
 */
export function shouldRecapture(
  lastCaptured: Quad | null,
  current: Quad,
  changeThreshold: number,
): boolean {
  if (!lastCaptured) return true
  return quadCornerDelta(lastCaptured, current) > changeThreshold
}

/** 是否处于拍摄冷却期。 */
export function inCooldown(lastCapturedAt: number, cooldownMs: number, now: number): boolean {
  return now - lastCapturedAt < cooldownMs
}

/**
 * 锁定态离群点判定：连续稳定识别后，某一帧检测突然远离当前选框时，
 * 该次检测视为噪声候选（杂波 / 错识别 / AI 抖动），调用方应保持当前选框
 * 不动、不计入稳定累计。
 *
 * 仅在「locked=true」且已知当前选框时生效；非锁定态（初次搜索）保持原行为
 * （即使新检测离当前较远也应正常跟随，由后续稳定累计把关）。
 *
 * jumpRejectDist 用归一化平均角点位移度量（与 quadCornerDelta 同尺度）：
 *   - 相机抖动：< 0.05，正常
 *   - 目标慢速移动：0.05~0.15，正常
 *   - 临时错选框 / 离群候选：> 0.30，判定为离群
 */
export function isOutlierWhileLocked(opts: {
  currentQuad: Quad
  detected: Quad
  locked: boolean
  jumpRejectDist: number
}): boolean {
  if (!opts.locked) return false
  return quadCornerDelta(opts.currentQuad, opts.detected) > opts.jumpRejectDist
}

/**
 * 锁定态 sticky 升级判定：一旦连续有效命中达到 lockHits 即进入锁定；
 * 锁定后保持 sticky（即使中间出现几帧 miss / 抖动也不退出），
 * 直到调用方在选框真正清掉时显式把 currentlyLocked 设回 false。
 *
 * 这是「连续识别到一个位置就保持锁定」的关键 —— 之前的实现用 stable.count
 * 触发，但 stabilityTolerance 极严苛时根本到不了阈值，锁定态事实上从未激活。
 */
export function shouldStayLocked(opts: {
  currentlyLocked: boolean
  consecutiveHits: number
  lockHits: number
}): boolean {
  if (opts.currentlyLocked) return true
  return opts.consecutiveHits >= opts.lockHits
}

/**
 * 计算清除选框所需的连续 miss 帧数：锁定态给更长的容忍窗口
 * （覆盖 Otsu 闪烁 / 摄像头自动曝光 / ML 冷却等亚秒级瞬时丢失），
 * 初次搜索阶段保持较短的阈值以尽快响应「目标真的走了」。
 */
export function hideAfterMisses(opts: {
  locked: boolean
  baseHideAfterMisses: number
  lockHideAfterMisses: number
}): number {
  return opts.locked ? opts.lockHideAfterMisses : opts.baseHideAfterMisses
}
