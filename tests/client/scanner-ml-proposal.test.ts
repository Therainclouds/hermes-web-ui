import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { detectPaper } from '@/plugins/scanner/vision/paper-detector'
import { detectRectangles } from '@/plugins/scanner/vision/detector-ml'

vi.mock('@/plugins/scanner/vision/detector-ml', async importOriginal => {
  const original = await importOriginal<typeof import('@/plugins/scanner/vision/detector-ml')>()
  return { ...original, getMLStatus: () => ({ state: 'ready' }), isMLRetryCooldown: () => false, detectRectangles: vi.fn() }
})

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(100000)
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { putImageData() {} } } })
  vi.stubGlobal('ImageData', class {})
  vi.mocked(detectRectangles).mockResolvedValue([{
    quad: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }],
    score: 0.99, label: 'book', aspect: 1, areaRatio: 0.36, frameSides: 0,
  }])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('does not accept a high-confidence ML rectangle without document edges', async () => {
  const data = new Uint8ClampedArray(200 * 200 * 4).fill(120)
  expect(await detectPaper({ width: 200, height: 200, data }, { strategies: ['ml'] })).toBeNull()
  expect(detectRectangles).toHaveBeenCalled()
})
