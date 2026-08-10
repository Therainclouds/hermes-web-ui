import MarkdownIt from 'markdown-it'
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

/** 触发一次浏览器下载。内联实现，避免工具模块依赖 API 客户端链。 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 将一次群聊自由讨论整理为规范的 Word(.docx) 报告，
 * 便于用户下载归档。
 * 纯前端生成，无后端协议改动。
 */

export interface DiscussionJudgeNoteLike {
  round: number
  converged: boolean
  stalled: boolean
  progress?: boolean
  assessment: string
  suggestion: string
}

export interface DiscussionReportInput {
  goal: string
  status: string
  currentRound: number
  maxRounds: number
  agentOrder: string[]
  judgeNotes: DiscussionJudgeNoteLike[]
  /** reporter 生成的最终统一意见报告（Markdown 文本）。 */
  reportText: string
  generatedAt: number
  /** 裁判评估失败时记录的原始错误，用于在报告中明示缺失原因。 */
  lastError?: string
}

export interface DiscussionReportLabels {
  docTitle: string
  goalLabel: string
  metaLabel: string
  statusLabel: string
  roundsLabel: string
  maxRoundsLabel: string
  agentsLabel: string
  judgeLabel: string
  judgeNotesMissingLabel: string
  reportLabel: string
  roundLabel: (round: number) => string
  convergedLabel: string
  stalledLabel: string
  progressLabel: string
  assessmentLabel: string
  suggestionLabel: string
  generatedBy: string
  statusLabels: Record<string, string>
}

const DEFAULT_STATUS_LABELS: Record<string, string> = {
  pending: '等待开始',
  running: '进行中',
  paused: '已暂停',
  converged: '已达成共识',
  max_rounds: '已达上限',
  stopped: '已停止',
  failed: '失败',
}

const DEFAULT_LABELS: DiscussionReportLabels = {
  docTitle: '群聊自由讨论报告',
  goalLabel: '讨论目标',
  metaLabel: '讨论信息',
  statusLabel: '结束状态',
  roundsLabel: '实际轮数',
  maxRoundsLabel: '最大轮数',
  agentsLabel: '参与 Agent',
  judgeLabel: '各轮裁判评估',
  judgeNotesMissingLabel: '本场讨论裁判评估缺失',
  reportLabel: '统一意见报告',
  roundLabel: round => `第 ${round} 轮`,
  convergedLabel: '已收敛',
  stalledLabel: '停滞',
  progressLabel: '有进展',
  assessmentLabel: '评估',
  suggestionLabel: '建议',
  generatedBy: '由 Hermes Studio 群聊自由讨论自动生成',
  statusLabels: DEFAULT_STATUS_LABELS,
}

function resolveLabels(labels?: Partial<DiscussionReportLabels>): DiscussionReportLabels {
  return { ...DEFAULT_LABELS, ...labels, statusLabels: { ...DEFAULT_STATUS_LABELS, ...labels?.statusLabels } }
}

function judgeStatusText(note: DiscussionJudgeNoteLike, labels: DiscussionReportLabels): string {
  const parts: string[] = []
  if (note.converged) parts.push(labels.convergedLabel)
  else if (note.stalled) parts.push(labels.stalledLabel)
  else parts.push('—')
  if (note.progress) parts.push(labels.progressLabel)
  return parts.join(' · ')
}

// ─── Word(.docx) 报告 ───────────────────────────────────────

const MD = new MarkdownIt({ html: false, linkify: true, breaks: true })

// 极简科技风主题色：深藏青主色 + 强调蓝 + 暖橙提示
const COLOR_PRIMARY = '1F3864'
const COLOR_SECONDARY = '2E74B5'
const COLOR_BODY = '333333'
const COLOR_NOTICE = 'B4550A'
const COLOR_TABLE_BORDER = 'C9D4E4'
const COLOR_TABLE_LABEL_BG = 'EEF2F9'

const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
}

/** 从文件名中剔除系统非法字符并截断，避免下载失败。 */
export function sanitizeFileName(name: string, maxLength = 24): string {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || '讨论报告').slice(0, maxLength)
}

/** 错误信息截断，避免报告中出现超长堆栈。 */
function truncate(text: string, maxLength = 120): string {
  const value = String(text || '').trim()
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

/** markdown-it 块级 token 的最小投影，避免依赖第三方类型声明的内部路径。 */
interface MdTokenLike {
  type: string
  tag: string
  content: string
  hidden: boolean
  children: Array<{ type?: string; content?: string }> | null
}

function inlineText(token: MdTokenLike): string {
  if (!token.children) return token.content || ''
  return token.children.map(child => child.content || '').join('')
}

/** 把 inline 子 token 转为 TextRun，保留 **加粗** 与 *斜体* 强调样式。 */
function inlineRuns(token: MdTokenLike): TextRun[] {
  const runs: TextRun[] = []
  let bold = 0
  let italic = 0
  const buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('')
    buffer.length = 0
    if (text) runs.push(new TextRun({ text, bold: bold > 0, italics: italic > 0 }))
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
        // breaks:true 下 markdown-it 把连续行合成一个段落，这里保留换行，
        // 避免正文行被拼成一大段。
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

/** 将 Markdown 正文转换为 docx 块级元素（标题 / 段落 / 列表 / 表格 / 代码）。 */
export function markdownToDocxBlocks(markdown: string): (Paragraph | Table)[] {
  const tokens = MD.parse(markdown || '', {})
  const blocks: (Paragraph | Table)[] = []
  let listLevel = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.hidden) continue
    switch (token.type) {
      case 'heading_open': {
        const text = inlineText(tokens[index + 1])
        const heading = token.tag === 'h1'
          ? HeadingLevel.HEADING_1
          : token.tag === 'h2'
            ? HeadingLevel.HEADING_2
            : token.tag === 'h3'
              ? HeadingLevel.HEADING_3
              : HeadingLevel.HEADING_4
        blocks.push(new Paragraph({ text: text || ' ', heading }))
        index += 2 // inline + heading_close
        break
      }
      case 'paragraph_open': {
        // markdown-it 段落结构：paragraph_open > inline > paragraph_close，
        // 正文普通段落与加粗/斜体行都从这里渲染，缺失会导致报告正文大面积丢文本。
        const runs = inlineRuns(tokens[index + 1])
        if (runs.length) blocks.push(new Paragraph({ children: runs }))
        index += 2 // inline + paragraph_close
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        listLevel += 1
        break
      }
      case 'list_item_open': {
        // markdown-it 列表项内部总是 paragraph_open > inline > paragraph_close，
        // 取该项第一个 inline token 的文本作为列表内容。
        let text = ''
        let closeIdx = index
        let depth = 1
        for (let s = index + 1; s < tokens.length; s += 1) {
          if (tokens[s].type === 'inline') {
            text = inlineText(tokens[s])
            break
          }
        }
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
        blocks.push(new Paragraph({ text, bullet: { level: Math.max(0, listLevel - 1) } }))
        index = closeIdx
        break
      }
      case 'bullet_list_close':
      case 'ordered_list_close': {
        listLevel = Math.max(0, listLevel - 1)
        break
      }
      case 'table_open': {
        // markdown-it 表格结构：table_open > (thead_open > tr_open > (th_open > inline > th_close)* > tr_close)* > table_close
        const rows: TableRow[] = []
        let closeIdx = index
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
          const text = tokens[c + 1]?.type === 'inline' ? inlineText(tokens[c + 1]) : ''
          cells.push(
            new TableCell({
              shading: isHeader ? { fill: COLOR_PRIMARY } : undefined,
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: text || ' ', bold: isHeader, color: isHeader ? 'FFFFFF' : COLOR_BODY }),
                  ],
                }),
              ],
            }),
          )
        }
        if (cells.length) rows.push(new TableRow({ children: cells }))
      }
      if (rows.length) {
        blocks.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows }))
        index = closeIdx
      }
      break
    }
      case 'fence':
      case 'code_block': {
        blocks.push(new Paragraph({ children: [new TextRun({ text: token.content, font: 'Consolas' })] }))
        break
      }
      case 'blockquote_open': {
        const text = inlineText(tokens[index + 1])
        blocks.push(new Paragraph({ text, indent: { left: 360 }, style: 'Quote' }))
        index += 2 // inline + blockquote_close
        break
      }
      case 'hr': {
        blocks.push(new Paragraph({ children: [new TextRun({ text: '─────────────────────────────', color: '999999' })] }))
        break
      }
      default:
        break
    }
  }
  return blocks
}

function metaRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 26, type: WidthType.PERCENTAGE },
        shading: { fill: COLOR_TABLE_LABEL_BG },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, color: COLOR_PRIMARY })] })],
      }),
      new TableCell({
        width: { size: 74, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: value || '—', color: COLOR_BODY })] })],
      }),
    ],
  })
}

function buildMetaTable(input: DiscussionReportInput, labels: DiscussionReportLabels): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [
      metaRow(labels.statusLabel, labels.statusLabels[input.status] || input.status),
      metaRow(labels.roundsLabel, `${input.currentRound} / ${input.maxRounds}`),
      metaRow(labels.agentsLabel, input.agentOrder.join('、') || '—'),
    ],
  })
}

function buildJudgeNoteTable(note: DiscussionJudgeNoteLike, labels: DiscussionReportLabels): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [
      metaRow(labels.assessmentLabel, note.assessment || '—'),
      metaRow(labels.suggestionLabel, note.suggestion || '—'),
      metaRow(`${labels.assessmentLabel}/${labels.progressLabel}`, judgeStatusText(note, labels)),
    ],
  })
}

/** Document 级排版：默认字体（中文雅黑/西文 Calibri）、标题主题色。 */
const DOCUMENT_STYLES = {
  default: {
    document: {
      run: {
        font: { ascii: 'Calibri', eastAsia: 'Microsoft YaHei', hAnsi: 'Calibri' },
        size: 22, // 11pt
        color: COLOR_BODY,
      },
      paragraph: { spacing: { line: 300, after: 120 } },
    },
  },
  paragraphStyles: [
    {
      id: 'Title',
      name: 'Title',
      run: { size: 48, bold: true, color: COLOR_PRIMARY },
      paragraph: { spacing: { before: 0, after: 280 } },
    },
    {
      id: 'Heading1',
      name: 'Heading 1',
      run: { size: 30, bold: true, color: COLOR_PRIMARY },
      paragraph: { spacing: { before: 280, after: 140 }, keepNext: true },
    },
    {
      id: 'Heading2',
      name: 'Heading 2',
      run: { size: 25, bold: true, color: COLOR_SECONDARY },
      paragraph: { spacing: { before: 220, after: 120 }, keepNext: true },
    },
  ],
}

export function buildDiscussionDocx(
  input: DiscussionReportInput,
  labels?: Partial<DiscussionReportLabels>,
): Document {
  const l = resolveLabels(labels)
  const children: (Paragraph | Table)[] = []

  children.push(
    new Paragraph({
      text: l.docTitle,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
  )

  children.push(new Paragraph({ text: l.goalLabel, heading: HeadingLevel.HEADING_1 }))
  children.push(new Paragraph({ children: [new TextRun({ text: input.goal || '—', color: COLOR_BODY })] }))

  children.push(new Paragraph({ text: l.metaLabel, heading: HeadingLevel.HEADING_1 }))
  children.push(buildMetaTable(input, l))

  // 裁判评估缺失提示：讨论确实推进了轮次，但裁判每轮都失败（如配额/配置问题）
  if (input.judgeNotes.length === 0 && input.currentRound > 0) {
    const reason = input.lastError ? `（${truncate(input.lastError)}）` : ''
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${l.judgeNotesMissingLabel}${reason}`, italics: true, color: COLOR_NOTICE, size: 20 }),
        ],
        spacing: { after: 160 },
      }),
    )
  }

  if (input.judgeNotes.length) {
    children.push(new Paragraph({ text: l.judgeLabel, heading: HeadingLevel.HEADING_1 }))
    for (const note of input.judgeNotes) {
      children.push(new Paragraph({ text: l.roundLabel(note.round), heading: HeadingLevel.HEADING_2 }))
      children.push(buildJudgeNoteTable(note, l))
    }
  }

  children.push(new Paragraph({ text: l.reportLabel, heading: HeadingLevel.HEADING_1 }))
  const reportBlocks = markdownToDocxBlocks(input.reportText)
  if (reportBlocks.length) {
    children.push(...reportBlocks)
  } else {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: '（报告生成失败，暂无内容）', italics: true, color: '888888' })],
      }),
    )
  }

  children.push(
    new Paragraph({
      children: [new TextRun({ text: l.generatedBy, italics: true, color: '888888', size: 18 })],
      spacing: { before: 320 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER } },
    }),
  )

  return new Document({
    styles: DOCUMENT_STYLES,
    sections: [
      {
        properties: { page: { margin: { top: 1020, bottom: 1020, left: 1134, right: 1134 } } },
        children,
      },
    ],
  })
}

/** 打包为 .docx Blob，供前端触发下载。 */
export async function docxToBlob(doc: Document): Promise<Blob> {
  return Packer.toBlob(doc)
}

/** 直接触发一次报告下载（仅 .docx 单文件）。返回下载文件名基。 */
export async function downloadDiscussionReport(
  input: DiscussionReportInput,
  fileNameBase: string,
  labels?: Partial<DiscussionReportLabels>,
): Promise<string> {
  const doc = buildDiscussionDocx(input, labels)
  const blob = await docxToBlob(doc)
  downloadBlob(blob, `${fileNameBase}.docx`)
  return fileNameBase
}
