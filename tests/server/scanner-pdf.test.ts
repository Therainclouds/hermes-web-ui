import { describe, expect, it } from 'vitest'
import { buildScannerImagePdf } from '../../packages/server/src/services/scanner/pdf'

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
  it('rejects empty input', () => {
    expect(() => buildScannerImagePdf([])).toThrow(/no images/)
  })

  it('builds a valid PDF 1.4 header for a single JPEG', () => {
    const pdf = buildScannerImagePdf([{ buffer: TINY_JPEG, mime: 'image/jpeg' }])
    expect(pdf.subarray(0, 8).toString('binary')).toBe('%PDF-1.4')
    expect(pdf.subarray(pdf.length - 6).toString('binary')).toContain('%%EOF')
  })

  it('builds a PDF containing multiple images', () => {
    const pdf = buildScannerImagePdf([
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

  it('uses DCTDecode for jpeg and FlateDecode for png', () => {
    const pdf = buildScannerImagePdf([
      { buffer: TINY_JPEG, mime: 'image/jpeg' },
      { buffer: TINY_PNG, mime: 'image/png' },
    ])
    const text = pdf.toString('binary')
    expect(text).toContain('/DCTDecode')
    expect(text).toContain('/FlateDecode')
  })

  it('falls back to default dimensions when image header is unreadable', () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
    const pdf = buildScannerImagePdf([{ buffer: garbage, mime: 'image/jpeg' }])
    expect(pdf.subarray(0, 8).toString('binary')).toBe('%PDF-1.4')
  })
})
