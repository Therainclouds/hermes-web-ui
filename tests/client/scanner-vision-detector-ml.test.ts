import { describe, expect, it } from 'vitest'
import {
  aspectPrior,
  boxesIoU,
  candidateToDetection,
  compositeScore,
  isOrganicLabel,
  labelBoost,
  labelThresholdScale,
  normalizeMLBox,
  pipelineThreshold,
  quadFrameSides,
  type MLCandidate,
} from '@/plugins/scanner/vision/detector-ml'
import type { Quad } from '@/plugins/scanner/vision/types'

/**
 * detector-ml 的纯逻辑（标签/几何先验、IoU、复合分排序、候选→检测转换）。
 * 需要 WebGL/Worker/transformers.js 的部分（getMLPipeline/detectRectangles）
 * 在 Node 环境不可跑，不在本文件覆盖。
 */

const FULL_FRAME_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

const CENTERED_QUAD: Quad = [
  { x: 0.2, y: 0.15 },
  { x: 0.8, y: 0.15 },
  { x: 0.8, y: 0.85 },
  { x: 0.2, y: 0.85 },
]

function candidate(partial: Partial<MLCandidate> & { label: string; score: number }): MLCandidate {
  return {
    quad: CENTERED_QUAD,
    aspect: 1.4,
    areaRatio: 0.4,
    frameSides: 0,
    ...partial,
  }
}

describe('detector-ml organic/标签先验', () => {
  it('excludes organic COCO classes', () => {
    expect(isOrganicLabel('person')).toBe(true)
    expect(isOrganicLabel('dog')).toBe(true)
    expect(isOrganicLabel('potted plant')).toBe(true)
    expect(isOrganicLabel('book')).toBe(false)
    expect(isOrganicLabel('chair')).toBe(false)
  })

  it('boosts document-like labels and penalizes furniture', () => {
    expect(labelBoost('book')).toBe(1.3)
    expect(labelBoost('laptop')).toBe(1.1)
    expect(labelBoost('chair')).toBe(0.85)
    expect(labelBoost('car')).toBe(1)
  })

  it('lowers the acceptance threshold for document proxies', () => {
    expect(labelThresholdScale('book')).toBe(0.7)
    expect(labelThresholdScale('laptop')).toBe(0.85)
    expect(labelThresholdScale('car')).toBe(1)
  })

  it('keeps the pipeline threshold low enough for document proxy labels', () => {
    expect(pipelineThreshold(0.35)).toBeCloseTo(0.245)
  })
})

describe('detector-ml 几何先验', () => {
  it('favors portrait/landscape-ish rectangles over extreme slivers', () => {
    expect(aspectPrior(1.4)).toBe(1.05)
    expect(aspectPrior(0.5)).toBe(1.05)
    expect(aspectPrior(0.1)).toBe(0.8)
    expect(aspectPrior(4.0)).toBe(0.8)
  })

  it('counts frame-touching sides of a quad', () => {
    expect(quadFrameSides(FULL_FRAME_QUAD)).toBe(4)
    expect(quadFrameSides(CENTERED_QUAD)).toBe(0)
    // 单边贴框（例如纸被推到画面左缘）
    const edgeLeft: Quad = [
      { x: 0, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.9 },
      { x: 0, y: 0.9 },
    ]
    expect(quadFrameSides(edgeLeft)).toBe(1)
  })
})

describe('detector-ml 复合分与排序', () => {
  it('zeros out organic detections regardless of raw score', () => {
    expect(compositeScore(0.9, 'person', 1.4, 0)).toBe(0)
  })

  it('ranks a lower-scoring book above a high-scoring person', () => {
    const book = compositeScore(0.3, 'book', 1.4, 0)
    const person = compositeScore(0.9, 'person', 1.4, 0)
    expect(book).toBeGreaterThan(person)
    // 0.3 × 1.3（book）× 1.05（方正先验）
    expect(book).toBeCloseTo(0.3 * 1.3 * 1.05, 5)
  })

  it('penalizes boxes hugging the frame (background-like)', () => {
    const centered = compositeScore(0.5, 'car', 1.4, 0)
    const fullFrame = compositeScore(0.5, 'car', 1.4, 4)
    expect(fullFrame).toBeLessThan(centered)
    expect(fullFrame).toBeGreaterThan(0)
  })

  it('keeps composite in 0..1', () => {
    expect(compositeScore(1, 'book', 1.4, 0)).toBeLessThanOrEqual(1)
    expect(compositeScore(0, 'book', 1.4, 0)).toBe(0)
  })
})

describe('detector-ml IoU', () => {
  it('returns 1 for identical boxes and 0 for disjoint boxes', () => {
    const a = { xmin: 10, ymin: 10, xmax: 100, ymax: 100 }
    expect(boxesIoU(a, { ...a })).toBe(1)
    expect(boxesIoU(a, { xmin: 200, ymin: 200, xmax: 300, ymax: 300 })).toBe(0)
  })

  it('returns partial overlap in (0,1)', () => {
    const a = { xmin: 0, ymin: 0, xmax: 100, ymax: 100 }
    const b = { xmin: 50, ymin: 0, xmax: 150, ymax: 100 }
    expect(boxesIoU(a, b)).toBeCloseTo(1 / 3, 5)
  })
})

describe('detector-ml candidateToDetection', () => {
  it('maps a candidate to a paper-detection-compatible result with composite confidence', () => {
    const c = candidate({ label: 'book', score: 0.5, aspect: 1.0 })
    const d = candidateToDetection(c)
    expect(d.strategy).toBe('ml')
    expect(d.quad).toBe(c.quad)
    expect(d.confidence).toBe(compositeScore(c.score, c.label, c.aspect, c.frameSides))
  })
})

describe('detector-ml box normalization', () => {
  it('clips model coordinates to the actual input canvas', () => {
    expect(normalizeMLBox({ xmin: -8, ymin: 10, xmax: 120, ymax: 110 }, 100, 100)).toEqual({
      xmin: 0,
      ymin: 10,
      xmax: 100,
      ymax: 100,
    })
  })

  it('rejects invalid or empty model boxes', () => {
    expect(normalizeMLBox({ xmin: Number.NaN, ymin: 0, xmax: 10, ymax: 10 }, 100, 100)).toBeNull()
    expect(normalizeMLBox({ xmin: 20, ymin: 20, xmax: 10, ymax: 30 }, 100, 100)).toBeNull()
  })
})
