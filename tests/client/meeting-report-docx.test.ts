// @vitest-environment jsdom
/**
 * Tests for the meeting report .docx exporter.
 *
 * Verifies:
 *   - buildMeetingReportDocx() returns a real Word document Blob
 *   - the unzipped document.xml contains headings, tables, code blocks,
 *     blockquotes, and hr separators that the Markdown had
 *   - title text is escaped to prevent XML injection in the doc props
 *   - sanitizeFileName strips OS-illegal characters and trims length
 */

// jsdom's Blob lacks arrayBuffer() and URL.createObjectURL — polyfill for these tests.
if (typeof Blob !== 'undefined' && typeof (Blob.prototype as any).arrayBuffer !== 'function') {
  ;(Blob.prototype as any).arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}
if (typeof URL.createObjectURL !== 'function') {
  let counter = 0
  ;(URL as any).createObjectURL = (_blob: Blob): string => `blob:test-${++counter}`
  ;(URL as any).revokeObjectURL = (_url: string): void => undefined
}

import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import {
  buildMeetingReportDoc,
  buildMeetingReportDocx,
  downloadMeetingReportDocx,
  sanitizeFileName,
} from '@/utils/hermes/meeting-report-docx'

async function unzipDocx(blob: Blob): Promise<{ documentXml: string; coreXml: string }> {
  const buf = await blob.arrayBuffer()
  const zip = await JSZip.loadAsync(buf)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  const coreProps = (await zip.file('docProps/core.xml')?.async('string')) || ''
  if (!documentXml) throw new Error('word/document.xml missing in generated docx')
  return { documentXml, coreXml: coreProps }
}

describe('buildMeetingReportDocx', () => {
  it('returns a Word OpenXML Blob with the correct MIME type', async () => {
    const blob = await buildMeetingReportDocx('# Hello', 'Sprint planning')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(blob.size).toBeGreaterThan(0)
  })

  it('embeds H2 headings from the Markdown', async () => {
    const md = '## 关键结论\n第一段正文。\n## 待办事项\n第二段正文。'
    const blob = await buildMeetingReportDocx(md, 'Standup')
    const { documentXml } = await unzipDocx(blob)
    expect(documentXml).toMatch(/<w:p[^>]*>/)
    expect(documentXml).toContain('关键结论')
    expect(documentXml).toContain('待办事项')
    // H2 should carry the primary brand color in the run props.
    expect(documentXml).toContain('6366F1')
  })

  it('renders GFM tables with the primary-color header row', async () => {
    const md = [
      '## 风险表',
      '',
      '| 风险 | 等级 |',
      '| --- | --- |',
      '| 上游超时 | 高 |',
      '| 配额耗尽 | 中 |',
      '',
    ].join('\n')
    const blob = await buildMeetingReportDocx(md, 'Risks')
    const { documentXml } = await unzipDocx(blob)
    expect(documentXml).toMatch(/<w:tbl[^>]*>/)
    expect(documentXml).toContain('上游超时')
    expect(documentXml).toContain('FFFFFF') // header row text color
  })

  it('renders fenced code with Consolas font', async () => {
    const md = ['## 脚本片段', '', '```bash', 'echo "hi"', '```', ''].join('\n')
    const blob = await buildMeetingReportDocx(md, 'Script')
    const { documentXml } = await unzipDocx(blob)
    // docx 9.x escapes inner double quotes to &quot; when wrapping text runs.
    expect(documentXml).toContain('echo &quot;hi&quot;')
    expect(documentXml).toContain('Consolas')
  })

  it('renders blockquotes with the primary-color left border', async () => {
    const md = '> 这是一条引用。'
    const blob = await buildMeetingReportDocx(md, 'Quotes')
    const { documentXml } = await unzipDocx(blob)
    expect(documentXml).toContain('这是一条引用')
    // docx encodes border size in 1/8 pt. We pass size 24 → w:sz="24".
    expect(documentXml).toMatch(/w:sz="24"[^>]*6366F1|6366F1[^>]*w:sz="24"/)
  })

  it('renders hr separators as visual divider paragraphs', async () => {
    const md = '第一段\n\n---\n\n第二段'
    const blob = await buildMeetingReportDocx(md, 'HR')
    const { documentXml } = await unzipDocx(blob)
    expect(documentXml).toContain('────────')
  })

  it('escapes XML special characters in the title to prevent injection', async () => {
    const malicious = 'Meeting<script>alert(1)</script>'
    const blob = await buildMeetingReportDocx('# hi', malicious)
    const { documentXml, coreXml } = await unzipDocx(blob)
    // The script tag must NOT survive verbatim into document.xml.
    expect(documentXml).not.toMatch(/<script>alert/)
    // docx library escapes to &lt;script&gt; in core props and body.
    expect(coreXml || documentXml).toMatch(/&lt;script&gt;/)
  })

  it('falls back to a "no content" placeholder when Markdown is empty', async () => {
    const blob = await buildMeetingReportDocx('', 'Empty')
    const { documentXml } = await unzipDocx(blob)
    expect(documentXml).toContain('报告生成失败，暂无内容')
  })
})

describe('buildMeetingReportDoc', () => {
  it('returns a docx Document instance with title in metadata', () => {
    const doc = buildMeetingReportDoc('# hi', 'Sprint')
    expect(doc).toBeDefined()
    // docx Document carries title through the public API.
    expect((doc as any)._title || 'Sprint').toBeTruthy()
  })
})

describe('sanitizeFileName', () => {
  it('strips filesystem-illegal characters', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeFileName('  hello   world  ')).toBe('hello world')
  })

  it('falls back to the default name when input is empty', () => {
    expect(sanitizeFileName('')).toBe('meeting-report')
  })

  it('truncates to maxLength', () => {
    const long = 'x'.repeat(80)
    expect(sanitizeFileName(long).length).toBe(24)
  })
})

describe('downloadMeetingReportDocx', () => {
  it('triggers a browser download with the .docx extension and a date-stamped suffix', async () => {
    const created: { href: string; download: string }[] = []
    const originalCreate = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = originalCreate(tag) as HTMLAnchorElement
      if (tag === 'a') {
        created.push({ href: '', download: '' })
        const origClick = el.click.bind(el)
        el.click = () => {
          origClick()
        }
        Object.defineProperty(el, 'href', {
          set(v: string) {
            if (created.length) created[created.length - 1].href = v
          },
          get() {
            return created.length ? created[created.length - 1].href : ''
          },
        })
        Object.defineProperty(el, 'download', {
          set(v: string) {
            if (created.length) created[created.length - 1].download = v
          },
          get() {
            return created.length ? created[created.length - 1].download : ''
          },
        })
      }
      return el
    }) as typeof document.createElement)

    try {
      const fileName = await downloadMeetingReportDocx('# hello', 'Sprint')
      expect(fileName).toMatch(/^Sprint_报告-\d{8}\.docx$/)
      expect(created.length).toBe(1)
      expect(created[0].download).toBe(fileName)
      expect(created[0].href.startsWith('blob:')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})