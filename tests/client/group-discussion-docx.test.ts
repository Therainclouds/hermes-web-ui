// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Packer, Table } from 'docx'
import { inflateRawSync } from 'zlib'
import {
  buildDiscussionDocx,
  markdownToDocxBlocks,
  sanitizeFileName,
  type DiscussionReportInput,
} from '../../packages/client/src/utils/hermes/group-discussion-docx'

const SAMPLE: DiscussionReportInput = {
  goal: '讨论《哈姆雷特》的行动主题',
  status: 'converged',
  currentRound: 3,
  maxRounds: 8,
  agentOrder: ['Agent A', 'Agent B'],
  judgeNotes: [
    { round: 1, converged: false, stalled: false, progress: true, assessment: '双方观点已清晰', suggestion: '继续深入' },
    { round: 2, converged: false, stalled: false, progress: true, assessment: '分歧逐步化解', suggestion: '聚焦结论' },
    { round: 3, converged: true, stalled: false, progress: false, assessment: '已达成共识', suggestion: '无需继续' },
  ],
  reportText: '# 结论\n\n## 达成的一致\n\n- 观点一\n- 观点二\n\n> 引用一句\n\n`code` 行内',
  generatedAt: Date.now(),
}

describe('group discussion docx report', () => {
  it('builds a valid docx zip package', async () => {
    const doc = buildDiscussionDocx(SAMPLE)
    const buffer = await Packer.toBuffer(doc)
    // DOCX is a zip container; the magic bytes must be "PK".
    expect(Buffer.from(buffer).subarray(0, 2).toString()).toBe('PK')
    expect(buffer.byteLength).toBeGreaterThan(1000)
  })

  it('tolerates an empty report body and missing judge notes', async () => {
    const doc = buildDiscussionDocx({ ...SAMPLE, judgeNotes: [], reportText: '' })
    const buffer = await Packer.toBuffer(doc)
    expect(Buffer.from(buffer).subarray(0, 2).toString()).toBe('PK')
    const xml = extractZipEntry(Buffer.from(buffer), 'word/document.xml')
    expect(xml).toContain('报告生成失败')
    expect(xml).not.toContain('各轮裁判评估')
  })

  it('shows a notice with the reason when judge notes are missing after rounds ran', async () => {
    const doc = buildDiscussionDocx({
      ...SAMPLE,
      judgeNotes: [],
      lastError: '裁判暂不可用：已达到 Token Plan 用量上限 (2056)',
    })
    const buffer = await Packer.toBuffer(doc)
    const xml = extractZipEntry(Buffer.from(buffer), 'word/document.xml')
    expect(xml).toContain('本场讨论裁判评估缺失')
    expect(xml).toContain('Token Plan 用量上限')
  })

  it('does not show the missing-notice when judge notes exist', async () => {
    const doc = buildDiscussionDocx(SAMPLE)
    const buffer = await Packer.toBuffer(doc)
    const xml = extractZipEntry(Buffer.from(buffer), 'word/document.xml')
    expect(xml).not.toContain('本场讨论裁判评估缺失')
  })

  it('applies the deep-blue document theme', async () => {
    const doc = buildDiscussionDocx(SAMPLE)
    const buffer = await Packer.toBuffer(doc)
    const stylesXml = extractZipEntry(Buffer.from(buffer), 'word/styles.xml')
    expect(stylesXml).toContain('1F3864')
    expect(stylesXml).toContain('2E74B5')
    expect(stylesXml).toContain('Microsoft YaHei')
  })

  it('sanitizes file names from the discussion goal', () => {
    expect(sanitizeFileName('《国家为什么会失败》学习讨论')).toBe('《国家为什么会失败》学习讨论')
    expect(sanitizeFileName('A/B:C*D?')).toBe('ABCD')
    expect(sanitizeFileName('   ')).toBe('讨论报告')
    const long = '这是一个超过二十四个字符长度的讨论主题名称测试内容一二三'
    expect(sanitizeFileName(long, 24).length).toBe(24)
  })

  it('emits a Table block for markdown tables', () => {
    const blocks = markdownToDocxBlocks('| 期数 | 主题 |\n| --- | --- |\n| 第1期 | 核心论点 |')
    const table = blocks.find(block => block instanceof Table)
    expect(table).toBeInstanceOf(Table)
  })

  it('renders realistic report lists and tables into the docx body XML', async () => {
    // 真实报告结构：加粗结论 + 8 期框架表格 + 有序/无序列表 + 斜体署名
    const report = [
      '**《国家为什么会失败》学习讨论 · 汇报报告**',
      '',
      '---',
      '',
      '## 一、已达成的结论',
      '**1. 核心框架已建立**',
      '全书核心论点成立：制度是发展的关键变量。',
      '**2. 内容转化方向明确**',
      '8期框架：',
      '',
      '| 期数 | 主题 | 核心策略 |',
      '| --- | --- | --- |',
      '| 第1期 | 核心论点 | 用反常议题开场 |',
      '| 第2期 | 历史案例验证 | 英国vs西班牙 |',
      '',
      '**3. 执行策略已共识**',
      '- 采用"三集试播 + 滚动复投"节奏',
      '- 每期结尾使用"未完成的句子"作为互动钩子',
      '',
      '## 二、后续可执行行动',
      '1. 整理本次讨论记录',
      '2. 制作前两期脚本',
      '',
      '*汇报人：内容生产专家团*',
    ].join('\n')

    const doc = buildDiscussionDocx({ ...SAMPLE, reportText: report })
    const buffer = await Packer.toBuffer(doc)
    const xml = extractZipEntry(Buffer.from(buffer), 'word/document.xml')

    // 回归一：列表项文本不再为空
    expect(xml).toContain('三集试播')
    expect(xml).toContain('未完成的句子')
    expect(xml).toContain('整理本次讨论记录')
    expect(xml).toContain('制作前两期脚本')
    // 回归二：报告正文表格已渲染（8 期框架表格内容）
    expect(xml).toContain('历史案例验证')
    expect(xml).toContain('英国vs西班牙')
    // 回归三：报告正文标题与斜体署名保留
    expect(xml).toContain('已达成的结论')
    expect(xml).toContain('内容生产专家团')
    // 回归四：加粗/斜体强调样式保留（**…** → w:b，*…* → w:i）
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('1. 核心框架已建立')
  })
})

// 轻量 ZIP 解析：只提取 docx 包中指定条目，验证 Word 正文 XML 的真实内容。
// docx 为标准 ZIP（entry 存储或 deflate 压缩），无需引入额外解包依赖。
function extractZipEntry(buffer: Buffer, entryName: string): string {
  let eocd = -1
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('EOCD not found in docx')
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let n = 0; n < entryCount; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    if (name === entryName) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26)
      const localExtraLen = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      const raw = method === 8 ? inflateRawSync(data) : data
      return raw.toString('utf8')
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`entry not found in docx: ${entryName}`)
}
