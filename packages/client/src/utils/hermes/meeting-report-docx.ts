import MarkdownIt from 'markdown-it'
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

/**
 * 将会议报告 Markdown 转换为极致样式的 .docx 文档。
 *
 * 视觉对齐 packages/client/src/utils/report-html.ts 的渐变/标题色/表格/引用块样式，
 * 但承载格式为 Word 原生结构（可编辑、可复用样式、可被企业模板套版）。
 *
 * Markdown 元素缺位时静默跳过（不报错、不补位）—— 与 HTML 版行为一致。
 */

const COLOR_PRIMARY = '6366F1' // 渐变条起点（与 HTML 版 --primary 一致）
const COLOR_SECONDARY = '2E74B5'
const COLOR_BODY = '1E293B'
const COLOR_TEXT_SECONDARY = '64748B'
const COLOR_TEXT_LIGHT = '94A3B8'
const COLOR_BORDER = 'E2E8F0'
const COLOR_BG_SOFT = 'F8FAFC'
const COLOR_CODE_BG = 'F1F5F9'

const DOC_DEFAULT_FONT = { ascii: 'Calibri', eastAsia: 'Microsoft YaHei', hAnsi: 'Calibri' }

const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
}

const MD_OPTIONS = new MarkdownIt({ html: false, linkify: true, breaks: true })

interface MdTokenLike {
  type: string
  tag: string
  content: string
  hidden: boolean
  children: Array<{ type?: string; content?: string }> | null
}

export interface MeetingReportMeta {
  /** 是否展示生成时间 + 来源行（默认 true）。 */
  showMeta?: boolean
}

export interface MeetingReportLabels {
  /** 顶部副标题前缀，例如 "会议报告 · "。 */
  subtitlePrefix: string
  /** 来源说明，例如 "Hermes Studio AI 自动生成"。 */
  generatedBy: string
  /** 页脚免责声明。 */
  footerDisclaimer: string
}

const DEFAULT_LABELS: MeetingReportLabels = {
  subtitlePrefix: '会议报告 · ',
  generatedBy: 'Hermes Studio 会议 AI 自动生成',
  footerDisclaimer: '本报告由 AI 基于会议转写内容自动生成，仅供参考',
}

function resolveLabels(labels?: Partial<MeetingReportLabels>): MeetingReportLabels {
  return { ...DEFAULT_LABELS, ...(labels || {}) }
}

function inlineText(token: MdTokenLike): string {
  if (!token.children) return token.content || ''
  return token.children.map(child => child.content || '').join('')
}

/**
 * 从文件名中剔除系统非法字符并截断，避免下载失败。
 * 与群聊讨论报告保持一致的策略，便于用户在文件名上做归档识别。
 */
export function sanitizeFileName(name: string, maxLength = 24): string {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'meeting-report').slice(0, maxLength)
}

/** 把 inline 子 token 转为 TextRun，保留 **加粗** 与 *斜体* 强调样式。 */
function inlineRuns(token: MdTokenLike, color: string = COLOR_BODY): TextRun[] {
  const runs: TextRun[] = []
  let bold = 0
  let italic = 0
  const buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('')
    buffer.length = 0
    if (text) runs.push(new TextRun({ text, bold: bold > 0, italics: italic > 0, color }))
  }
  for (const child of token.children || []) {
    switch (child.type) {
      case 'strong_open':
        flush()
        bold += 1
        break
      case 'strong_close':
        flush()
        bold = Math.max(0, bold - 1)
        break
      case 'em_open':
        flush()
        italic += 1
        break
      case 'em_close':
        flush()
        italic = Math.max(0, italic - 1)
        break
      case 'br_open':
      case 'softbreak':
        // breaks:true 下 markdown-it 把连续行合成一个段落，保留换行避免正文被合并。
        flush()
        runs.push(new TextRun({ break: 1 }))
        break
      default:
        buffer.push(child.content || '')
    }
  }
  flush()
  return runs
}

function safeTitle(title: string): string {
  // Word 内部用 XML，标题里的特殊字符需要转义；这里去掉控制字符即可，
  // docx 库内部会在生成 XML 时对 &、<、> 做转义。
  return String(title || '会议报告').replace(/[\u0000-\u001F]+/g, '').trim() || '会议报告'
}

function dateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nowDateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/**
 * 将 Markdown 正文转换为 docx 块级元素（标题 / 段落 / 列表 / 表格 / 代码）。
 * 行为策略与 group-discussion-docx.ts 一致，但样式按"会议报告"主题定制：
 *   - H2 加编号徽章（01、02 …）模拟 HTML 版 .report-body h2::before
 *   - 引用块：主色左边框 + 浅灰底 + 缩进
 *   - 表格：主色 header 白字，偶数行 zebra 浅灰
 *   - 代码块：Consolas + 浅灰段底
 */
function markdownToDocxBlocks(markdown: string): (Paragraph | Table)[] {
  const tokens = MD_OPTIONS.parse(markdown || '', {}) as MdTokenLike[]
  const blocks: (Paragraph | Table)[] = []
  let listLevel = 0
  let h2Counter = 0

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.hidden) continue
    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[index + 1]
        const text = inline ? inlineText(inline) : ''
        if (token.tag === 'h1') {
          blocks.push(new Paragraph({ text: text || ' ', heading: HeadingLevel.HEADING_1 }))
        } else if (token.tag === 'h2') {
          h2Counter += 1
          const badge = String(h2Counter).padStart(2, '0')
          blocks.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${badge}  `,
                  bold: true,
                  color: 'FFFFFF',
                  size: 18,
                  font: { ascii: 'Calibri', eastAsia: 'Microsoft YaHei', hAnsi: 'Calibri' },
                }),
                new TextRun({ text: text || ' ', bold: true, color: COLOR_PRIMARY, size: 24 }),
              ],
              spacing: { before: 360, after: 160 },
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER } },
              keepNext: true,
            }),
          )
        } else if (token.tag === 'h3') {
          blocks.push(
            new Paragraph({
              children: [new TextRun({ text: text || ' ', bold: true, color: COLOR_SECONDARY, size: 22 })],
              spacing: { before: 240, after: 100 },
              keepNext: true,
            }),
          )
        } else {
          blocks.push(
            new Paragraph({
              children: [new TextRun({ text: text || ' ', bold: true, color: COLOR_SECONDARY, size: 20 })],
              spacing: { before: 200, after: 100 },
              keepNext: true,
            }),
          )
        }
        index += 2 // inline + heading_close
        break
      }
      case 'paragraph_open': {
        const inline = tokens[index + 1]
        if (inline) {
          const runs = inlineRuns(inline)
          if (runs.length) {
            blocks.push(
              new Paragraph({
                children: runs,
                spacing: { line: 360, after: 120 },
              }),
            )
          }
        }
        index += 2 // inline + paragraph_close
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        listLevel += 1
        break
      }
      case 'list_item_open': {
        let text = ''
        for (let s = index + 1; s < tokens.length; s += 1) {
          if (tokens[s].type === 'inline') {
            text = inlineText(tokens[s])
            break
          }
        }
        let closeIdx = index
        let depth = 1
        for (let s = index + 1; s < tokens.length; s += 1) {
          if (tokens[s].type === 'list_item_open') depth += 1
          else if (tokens[s].type === 'list_item_close') {
            depth -= 1
            if (depth === 0) {
              closeIdx = s
              break
            }
          }
        }
        blocks.push(
          new Paragraph({
            text,
            bullet: { level: Math.max(0, listLevel - 1) },
            spacing: { line: 320, after: 80 },
          }),
        )
        index = closeIdx
        break
      }
      case 'bullet_list_close':
      case 'ordered_list_close': {
        listLevel = Math.max(0, listLevel - 1)
        break
      }
      case 'table_open': {
        const rows: TableRow[] = []
        let closeIdx = index
        let rowIndex = 0
        for (let s = index + 1; s < tokens.length; s += 1) {
          if (tokens[s].type === 'table_close') {
            closeIdx = s
            break
          }
          if (tokens[s].type !== 'tr_open') continue
          const cells: TableCell[] = []
          for (let c = s + 1; c < tokens.length && tokens[c].type !== 'tr_close'; c += 1) {
            if (tokens[c].type !== 'th_open' && tokens[c].type !== 'td_open') continue
            const isHeader = tokens[c].type === 'th_open'
            const inline = tokens[c + 1]?.type === 'inline' ? tokens[c + 1] : null
            const text = inline ? inlineText(inline) : ''
            const shadingFill = isHeader ? COLOR_PRIMARY : rowIndex % 2 === 1 ? COLOR_BG_SOFT : undefined
            cells.push(
              new TableCell({
                shading: shadingFill ? { type: ShadingType.CLEAR, fill: shadingFill, color: 'auto' } : undefined,
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: text || ' ',
                        bold: isHeader,
                        color: isHeader ? 'FFFFFF' : COLOR_BODY,
                      }),
                    ],
                  }),
                ],
              }),
            )
          }
          if (cells.length) {
            rows.push(new TableRow({ children: cells }))
            rowIndex += 1
          }
        }
        if (rows.length) {
          blocks.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: TABLE_BORDERS,
              rows,
            }),
          )
          index = closeIdx
        }
        break
      }
      case 'fence':
      case 'code_block': {
        const lines = token.content.split('\n')
        const children: TextRun[] = []
        lines.forEach((line, idx) => {
          if (idx > 0) children.push(new TextRun({ break: 1 }))
          if (line) children.push(new TextRun({ text: line, font: 'Consolas', size: 20, color: COLOR_BODY }))
        })
        blocks.push(
          new Paragraph({
            children: children.length
              ? children
              : [new TextRun({ text: token.content, font: 'Consolas', size: 20, color: COLOR_BODY })],
            shading: { type: ShadingType.CLEAR, fill: COLOR_CODE_BG, color: 'auto' },
            spacing: { line: 320, before: 100, after: 100 },
          }),
        )
        break
      }
      case 'blockquote_open': {
        // markdown-it blockquote 结构：blockquote_open > paragraph_open > inline > paragraph_close > blockquote_close
        // 必须跳过 paragraph_open 才能拿到 inline token。
        const inlineToken = tokens[index + 1]?.type === 'inline' ? tokens[index + 1] : tokens[index + 2]
        if (inlineToken) {
          const text = inlineText(inlineToken)
          blocks.push(
            new Paragraph({
              children: [new TextRun({ text: text || ' ', color: COLOR_TEXT_SECONDARY })],
              indent: { left: 360 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 24, color: COLOR_PRIMARY, space: 8 },
              },
              shading: { type: ShadingType.CLEAR, fill: COLOR_BG_SOFT, color: 'auto' },
              spacing: { line: 320, before: 80, after: 80 },
            }),
          )
        }
        // 跳过 paragraph_open + inline + paragraph_close + blockquote_close。
        index += 4
        break
      }
      case 'hr': {
        blocks.push(
          new Paragraph({
            children: [new TextRun({ text: '─────────────────────────────', color: COLOR_TEXT_LIGHT })],
            spacing: { before: 200, after: 200 },
            alignment: AlignmentType.CENTER,
          }),
        )
        break
      }
      default:
        break
    }
  }
  return blocks
}

const DOCUMENT_STYLES = {
  default: {
    document: {
      run: {
        font: DOC_DEFAULT_FONT,
        size: 22, // 11pt
        color: COLOR_BODY,
      },
      paragraph: { spacing: { line: 360, after: 120 } },
    },
  },
  paragraphStyles: [
    {
      id: 'Title',
      name: 'Title',
      run: { size: 44, bold: true, color: COLOR_PRIMARY, font: DOC_DEFAULT_FONT },
      paragraph: { spacing: { before: 0, after: 200 }, alignment: AlignmentType.CENTER },
    },
    {
      id: 'Subtitle',
      name: 'Subtitle',
      run: { size: 20, color: COLOR_TEXT_SECONDARY, italics: true, font: DOC_DEFAULT_FONT },
      paragraph: { spacing: { before: 0, after: 320 }, alignment: AlignmentType.CENTER },
    },
    {
      id: 'Heading1',
      name: 'Heading 1',
      run: { size: 32, bold: true, color: COLOR_PRIMARY, font: DOC_DEFAULT_FONT },
      paragraph: { spacing: { before: 320, after: 160 }, keepNext: true },
    },
  ],
}

/** 构造会议报告 Document，行为策略：标题 → 副标题 → 正文 → 页脚。 */
export function buildMeetingReportDoc(
  markdown: string,
  title: string,
  meta?: MeetingReportMeta,
  labels?: Partial<MeetingReportLabels>,
): Document {
  const l = resolveLabels(labels)
  const showMeta = meta?.showMeta !== false
  const children: (Paragraph | Table)[] = []

  // 1. 顶部主标题（与 HTML 版渐变标题对齐：粗体 + 主色 + 居中）。
  children.push(
    new Paragraph({
      text: safeTitle(title),
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
  )

  // 2. 副标题：会议报告 · 生成时间 · 来源
  if (showMeta) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: l.subtitlePrefix, color: COLOR_TEXT_SECONDARY }),
          new TextRun({ text: dateStamp(), color: COLOR_TEXT_SECONDARY }),
          new TextRun({ text: ' · ', color: COLOR_TEXT_LIGHT }),
          new TextRun({ text: l.generatedBy, italics: true, color: COLOR_TEXT_LIGHT }),
        ],
        // docx 9.x 还没有 HeadingLevel.SUBTITLE，用 paragraphStyles 里自定义的 id。
        style: 'Subtitle',
        alignment: AlignmentType.CENTER,
      }),
    )
  }

  // 3. 正文：markdown → 块级元素
  const blocks = markdownToDocxBlocks(markdown)
  if (blocks.length) {
    children.push(...blocks)
  } else {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: '（报告生成失败，暂无内容）',
            italics: true,
            color: COLOR_TEXT_LIGHT,
          }),
        ],
      }),
    )
  }

  // 4. 页脚：浅灰小字 + 主色上分隔线
  children.push(
    new Paragraph({
      children: [new TextRun({ text: l.footerDisclaimer, italics: true, color: COLOR_TEXT_LIGHT, size: 18 })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 360 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_PRIMARY } },
    }),
  )

  return new Document({
    creator: 'Hermes Studio',
    title: safeTitle(title),
    description: l.footerDisclaimer,
    styles: DOCUMENT_STYLES,
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children,
      },
    ],
  })
}

/** 打包为 .docx Blob，供前端触发下载。 */
export async function buildMeetingReportDocx(
  markdown: string,
  title: string,
  meta?: MeetingReportMeta,
  labels?: Partial<MeetingReportLabels>,
): Promise<Blob> {
  const doc = buildMeetingReportDoc(markdown, title, meta, labels)
  return Packer.toBlob(doc)
}

/**
 * 触发一次浏览器下载（仅 .docx 单文件）。
 * 复用群聊讨论工具的 downloadBlob 风格，独立实现以保持两个 docx 工具互不依赖。
 */
export function downloadMeetingReportDocx(
  markdown: string,
  title: string,
  meta?: MeetingReportMeta,
  labels?: Partial<MeetingReportLabels>,
): Promise<string> {
  const fileName = `${sanitizeFileName(title)}_报告-${nowDateStamp()}.docx`
  return buildMeetingReportDocx(markdown, title, meta, labels).then(blob => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    return fileName
  })
}