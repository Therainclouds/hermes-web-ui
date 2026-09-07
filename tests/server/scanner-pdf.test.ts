import { describe, expect, it } from 'vitest'
import {
  buildScannerImagePdf,
  computePageBox,
  isBilevelGray,
  packBilevel,
} from '../../packages/server/src/services/scanner/pdf'

/**
 * 1x1 white JPEG（编码后约 600 字节）。
 * 来自 libjpeg 默认 quant table；测试只关心 PDF 包装正确，不在意像素。
 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z',
  'base64',
)

/**
 * 最小 1x1 PNG（67 字节）。
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
)

describe('scanner pdf', () => {
  it('rejects empty input', async () => {
    await expect(buildScannerImagePdf([])).rejects.toThrow(/no images/)
  })

  it('builds a valid PDF 1.4 header for a single JPEG', async () => {
    const pdf = await buildScannerImagePdf([{ buffer: TINY_JPEG, mime: 'image/jpeg' }])
    expect(pdf.subarray(0, 8).toString('binary')).toBe('%PDF-1.4')
    expect(pdf.subarray(pdf.length - 6).toString('binary')).toContain('%%EOF')
  })

  it('builds a PDF containing multiple images', async () => {
    const pdf = await buildScannerImagePdf([
      { buffer: TINY_JPEG, mime: 'image/jpeg' },
      { buffer: TINY_PNG, mime: 'image/png' },
      { buffer: TINY_JPEG, mime: 'image/jpeg' },
    ])
    expect(pdf.subarray(0, 8).toString('binary')).toBe('%PDF-1.4')
    // xref table count line: `0 N` where N == 3 (catalog/pages) + 3*pages.
    const text = pdf.toString('binary')
    expect(text).toMatch(/^xref\n0 \d+$/m)
    expect(text).toContain('/Type /Catalog')
    expect(text).toContain('/Type /Pages')
    expect(text).toContain('/Subtype /Image')
  })

  it('keeps jpeg as DCTDecode and embeds bilevel png as 1bpp FlateDecode gray', async () => {
    const pdf = await buildScannerImagePdf([
      { buffer: TINY_JPEG, mime: 'image/jpeg' },
      { buffer: TINY_PNG, mime: 'image/png' },
    ])
    const text = pdf.toString('binary')
    expect(text).toContain('/DCTDecode')
    expect(text).toContain('/FlateDecode')
    expect(text).toContain('/ColorSpace /DeviceGray /BitsPerComponent 1')
  })

  it('falls back to sharp decoding when the jpeg header is unreadable', async () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
    await expect(buildScannerImagePdf([{ buffer: garbage, mime: 'image/jpeg' }])).rejects.toThrow()
  })

  it('sizes pages from the image so scans are full-bleed instead of pasted on A4', () => {
    // 1654x2339 px @200dpi ≈ A4；页面尺寸跟随图片，图片铺满整页
    const box = computePageBox({ width: 1654, height: 2339 }, { dpi: 200 })
    expect(box.pageWidth).toBeCloseTo((1654 / 200) * 72, 5)
    expect(box.pageHeight).toBeCloseTo((2339 / 200) * 72, 5)
    expect(box.x).toBe(0)
    expect(box.y).toBe(0)
    expect(box.drawWidth).toBe(box.pageWidth)
    expect(box.drawHeight).toBe(box.pageHeight)
  })

  it('keeps the A4 layout available with centered margins', () => {
    const box = computePageBox({ width: 1000, height: 500 }, { layout: 'a4' })
    expect(box.pageWidth).toBe(595)
    expect(box.pageHeight).toBe(842)
    expect(box.x).toBeGreaterThanOrEqual(36)
    expect(box.y).toBeGreaterThan(36)
    expect(box.drawWidth / box.drawHeight).toBeCloseTo(2, 5)
  })

  it('detects bilevel gray data and packs it MSB-first with 1 = white', () => {
    const binary = Buffer.from([0, 0, 255, 255, 255, 0, 0, 0, 255])
    expect(isBilevelGray(binary)).toBe(true)
    expect(isBilevelGray(Buffer.from([120, 130, 118, 125]))).toBe(false)
    // 9 px wide -> 2 bytes per row: 0b00111000, 0b10000000
    const packed = packBilevel(binary, 9, 1)
    expect(packed.length).toBe(2)
    expect(packed[0]).toBe(0b00111000)
    expect(packed[1]).toBe(0b10000000)
  })
})
