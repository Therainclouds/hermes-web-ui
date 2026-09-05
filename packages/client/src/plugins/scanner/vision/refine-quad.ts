import type { Pt, Quad } from './types'

/** Fit each coarse contour edge to nearby grayscale gradients, in pixel space.
 * The bounded normal search removes morphology padding without jumping to text.
 * Unsupported/degenerate fits preserve the caller's original contour.
 */
export function refinePaperQuad(gray: Uint8Array, width: number, height: number, quad: Quad): Quad | null {
  const radius = Math.max(3, Math.min(8, Math.round(Math.max(width, height) * 0.015)))
  const sample = (x: number, y: number): number => {
    const px = Math.max(0, Math.min(width - 1, x)), py = Math.max(0, Math.min(height - 1, y))
    const ix = Math.floor(px), iy = Math.floor(py)
    const jx = Math.min(width - 1, ix + 1), jy = Math.min(height - 1, iy + 1)
    const fx = px - ix, fy = py - iy
    return (gray[iy * width + ix]! * (1 - fx) + gray[iy * width + jx]! * fx) * (1 - fy)
      + (gray[jy * width + ix]! * (1 - fx) + gray[jy * width + jx]! * fx) * fy
  }
  const lines: Array<{ point: Pt; direction: Pt }> = []
  for (let side = 0; side < 4; side++) {
    const a = quad[side]!, b = quad[(side + 1) % 4]!
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < 12) return null
    const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length
    const nx = -dy, ny = dx
    const points: Array<Pt & { offset: number }> = []
    const count = Math.max(12, Math.min(64, Math.round(length / 3)))
    for (let i = 0; i < count; i++) {
      const t = 0.1 + 0.8 * i / (count - 1)
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
      let best = 6, offset: number | null = null
      for (let d = -radius; d <= radius; d++) {
        const px = x + nx * d, py = y + ny * d
        if (px < 2 || py < 2 || px >= width - 2 || py >= height - 2) continue
        const gradient = Math.abs(sample(px + nx * 0.75, py + ny * 0.75) - sample(px - nx * 0.75, py - ny * 0.75))
        const score = gradient - Math.abs(d) * 0.25
        if (score > best) { best = score; offset = d }
      }
      if (offset !== null) points.push({ x: x + nx * offset, y: y + ny * offset, offset })
    }
    if (points.length < count * 0.6) return null
    const offsets = points.map(p => p.offset).sort((a, b) => a - b)
    const median = offsets[Math.floor(offsets.length / 2)]!
    const inliers = points.filter(p => Math.abs(p.offset - median) <= 2.5)
    if (inliers.length < count * 0.5) return null
    const cx = inliers.reduce((s, p) => s + p.x, 0) / inliers.length
    const cy = inliers.reduce((s, p) => s + p.y, 0) / inliers.length
    let xx = 0, xy = 0, yy = 0
    for (const p of inliers) { xx += (p.x - cx) ** 2; xy += (p.x - cx) * (p.y - cy); yy += (p.y - cy) ** 2 }
    const angle = Math.atan2(2 * xy, xx - yy) / 2
    lines.push({ point: { x: cx, y: cy }, direction: { x: Math.cos(angle), y: Math.sin(angle) } })
  }
  const result: Pt[] = []
  for (let i = 0; i < 4; i++) {
    const a = lines[(i + 3) % 4]!, b = lines[i]!
    const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x
    if (Math.abs(cross) < 0.2) return null
    const t = ((b.point.x - a.point.x) * b.direction.y - (b.point.y - a.point.y) * b.direction.x) / cross
    const p = { x: a.point.x + a.direction.x * t, y: a.point.y + a.direction.y * t }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return null
    if (Math.hypot(p.x - quad[i]!.x, p.y - quad[i]!.y) > radius * 2.5) return null
    result.push(p)
  }
  // Reject folded/non-convex results rather than passing them to the warp.
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = result[i]!, b = result[(i + 1) % 4]!, c = result[(i + 2) % 4]!
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1 || (sign && Math.sign(cross) !== sign)) return null
    sign = Math.sign(cross)
  }
  return [result[0]!, result[1]!, result[2]!, result[3]!]
}
