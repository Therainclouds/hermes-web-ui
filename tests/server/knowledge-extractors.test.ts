/**
 * Tests for the knowledge plugin text extractors.
 *
 * Fixtures:
 *   - tests/server/fixtures/knowledge/sample.md  (committed)
 *   - tests/server/fixtures/knowledge/sample.txt (committed)
 *   - Minimal PDF and DOCX are generated in beforeAll to avoid
 *     committing binary blobs.
 */

import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  extract,
  countTokens,
  ExtractError,
  ensureBuiltinExtractorsRegistered,
  getRegisteredExtensions,
} from '../../packages/server/src/services/knowledge/extractors/index'

const FIXTURES_DIR = join(__dirname, 'fixtures', 'knowledge')

describe('knowledge extractors', () => {
  beforeAll(() => {
    ensureBuiltinExtractorsRegistered()
  })

  describe('registry', () => {
    it('registers md, txt, pdf, docx extensions', () => {
      const exts = getRegisteredExtensions()
      expect(exts).toContain('.md')
      expect(exts).toContain('.txt')
      expect(exts).toContain('.pdf')
      expect(exts).toContain('.docx')
    })

    it('unknown extension returns metadata-only sentinel', async () => {
      const result = await extract('/tmp/somefile.xyz')
      expect(result).toEqual({ text: '', tokenCount: 0 })
    })
  })

  describe('countTokens', () => {
    it('uses cl100k_base encoding', () => {
      expect(countTokens('Hello world')).toBe(2)
    })

    it('returns 0 for empty string', () => {
      expect(countTokens('')).toBe(0)
    })
  })

  describe('markdown extractor', () => {
    it('extracts text and strips front-matter', async () => {
      const result = await extract(join(FIXTURES_DIR, 'sample.md'))
      expect(result.text.length).toBeGreaterThan(0)
      expect(result.tokenCount).toBeGreaterThan(0)
      // Front-matter should be stripped (no "title: Test Document" in output).
      expect(result.text).not.toContain('title: Test Document')
      // Content should be present.
      expect(result.text).toContain('transformer architecture')
    })

    it('is deterministic', async () => {
      const a = await extract(join(FIXTURES_DIR, 'sample.md'))
      const b = await extract(join(FIXTURES_DIR, 'sample.md'))
      expect(a.text).toBe(b.text)
      expect(a.tokenCount).toBe(b.tokenCount)
    })
  })

  describe('text extractor', () => {
    it('extracts plain text and counts tokens', async () => {
      const result = await extract(join(FIXTURES_DIR, 'sample.txt'))
      expect(result.text.length).toBeGreaterThan(0)
      expect(result.tokenCount).toBeGreaterThan(0)
      expect(result.text).toContain('quick brown fox')
    })

    it('is deterministic', async () => {
      const a = await extract(join(FIXTURES_DIR, 'sample.txt'))
      const b = await extract(join(FIXTURES_DIR, 'sample.txt'))
      expect(a.text).toBe(b.text)
      expect(a.tokenCount).toBe(b.tokenCount)
    })
  })

  describe('pdf extractor', () => {
    let tempDir: string
    let pdfPath: string
    let corruptPdfPath: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'hermes-knowledge-extractors-pdf-'))

      // Generate a minimal valid PDF with a single text page.
      // Hand-crafted PDF 1.4 structure — parseable by pdfjs-dist.
      const stream = 'BT /F1 12 Tf 100 700 Td (Hello from the knowledge plugin test) Tj ET'
      const streamLen = Buffer.byteLength(stream, 'ascii')

      const pdf = [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
        '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
        '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
        `5 0 obj<</Length ${streamLen}>>stream\n${stream}\nendstream\nendobj`,
      ].join('\n')

      // Build xref table.
      const lines = pdf.split('\n')
      let offset = 0
      const offsets: number[] = []
      for (const line of lines) {
        const m = /^(\d+) 0 obj/.exec(line)
        if (m) offsets[Number(m[1])] = offset
        offset += line.length + 1
      }

      const xrefStart = offset
      const xref = [
        'xref',
        `0 ${offsets.length}`,
        '0000000000 65535 f ',
      ]
      for (let i = 1; i < offsets.length; i++) {
        xref.push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n `)
      }
      xref.push('trailer<</Size ' + offsets.length + '/Root 1 0 R>>')
      xref.push('startxref')
      xref.push(String(xrefStart))
      xref.push('%%EOF')

      const fullPdf = pdf + '\n' + xref.join('\n')

      pdfPath = join(tempDir, 'test.pdf')
      writeFileSync(pdfPath, fullPdf, 'ascii')

      // Corrupt PDF — just random bytes with PDF header.
      corruptPdfPath = join(tempDir, 'corrupt.pdf')
      writeFileSync(corruptPdfPath, '%PDF-1.4\ngarbage data that is not valid pdf content')
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    it('extracts text from a valid PDF', async () => {
      const result = await extract(pdfPath)
      expect(result.text).toContain('Hello from the knowledge plugin test')
      expect(result.tokenCount).toBeGreaterThan(0)
    }, 30000)

    it('throws ExtractError with kind=corrupt for invalid PDF', async () => {
      await expect(extract(corruptPdfPath)).rejects.toThrow(ExtractError)
    }, 30000)
  })

  describe('docx extractor', () => {
    let tempDir: string
    let docxPath: string
    let corruptDocxPath: string

    beforeAll(async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'hermes-knowledge-extractors-docx-'))

      // Generate a minimal valid DOCX: ZIP with word/document.xml.
      // Dynamic import because vitest transforms source to ESM.
      const jszipMod = (await import('jszip')) as unknown as {
        default: { loadAsync(data: Uint8Array): Promise<{ file(name: string): { async(type: 'string'): Promise<string> } | null; generateAsync(opts: Record<string, unknown>): Promise<Buffer> }> }
        loadAsync(data: Uint8Array): Promise<{ file(name: string): { async(type: 'string'): Promise<string> } | null; generateAsync(opts: Record<string, unknown>): Promise<Buffer> }>
      }
      const JSZip = jszipMod.default ?? jszipMod
      const zip = new JSZip()

      zip.file('[Content_Types].xml', [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '</Types>',
      ].join(''))

      zip.file('word/document.xml', [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:t>Hello from the DOCX extractor test.</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Knowledge plugin supports Word documents.</w:t></w:r></w:p>',
        '</w:body>',
        '</w:document>',
      ].join(''))

      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      docxPath = join(tempDir, 'test.docx')
      writeFileSync(docxPath, buf)

      // Corrupt DOCX — random bytes.
      corruptDocxPath = join(tempDir, 'corrupt.docx')
      writeFileSync(corruptDocxPath, 'this is not a zip file at all')
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    it('extracts text from a valid DOCX', async () => {
      const result = await extract(docxPath)
      expect(result.text).toContain('Hello from the DOCX extractor test')
      expect(result.text).toContain('Knowledge plugin supports Word documents')
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    it('throws ExtractError with kind=corrupt for invalid DOCX', async () => {
      await expect(extract(corruptDocxPath)).rejects.toThrow(ExtractError)
    })
  })
})
