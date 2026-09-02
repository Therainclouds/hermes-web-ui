// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  canAutoRenameMeeting,
  extractMeetingTitleFromReport,
  isAutoPlaceholderMeetingTitle,
  sanitizeMeetingTitle,
} from '../../packages/client/src/utils/meeting-title'

describe('isAutoPlaceholderMeetingTitle', () => {
  it('recognizes empty / bare "会议" placeholders', () => {
    expect(isAutoPlaceholderMeetingTitle('')).toBe(true)
    expect(isAutoPlaceholderMeetingTitle(null)).toBe(true)
    expect(isAutoPlaceholderMeetingTitle('会议')).toBe(true)
    expect(isAutoPlaceholderMeetingTitle('   ')).toBe(true)
  })

  it('recognizes default "会议 + 时间" titles', () => {
    expect(isAutoPlaceholderMeetingTitle('会议 2026/9/1 15:48:27')).toBe(true)
    expect(isAutoPlaceholderMeetingTitle('会议 2026-09-01 15:48:27')).toBe(true)
    expect(isAutoPlaceholderMeetingTitle('会议 2026.9.1 15:48:27')).toBe(true)
  })

  it('does not treat user-named meetings as placeholders', () => {
    expect(isAutoPlaceholderMeetingTitle('Q3 产品评审')).toBe(false)
    expect(isAutoPlaceholderMeetingTitle('会议纪要同步会')).toBe(false)
  })
})

describe('canAutoRenameMeeting', () => {
  it('allows renaming placeholder titles', () => {
    expect(canAutoRenameMeeting({ title: '会议 2026/9/1 15:48:27' })).toBe(true)
  })
  it('allows a previously AI-named meeting to be refined again', () => {
    expect(canAutoRenameMeeting({ title: '季度复盘会', titleAutoNamed: true })).toBe(true)
  })
  it('never renames a user-defined title', () => {
    expect(canAutoRenameMeeting({ title: '季度复盘会' })).toBe(false)
  })
})

describe('sanitizeMeetingTitle', () => {
  it('strips markdown marker and wrappers', () => {
    expect(sanitizeMeetingTitle('# 季度产品规划会')).toBe('季度产品规划会')
    expect(sanitizeMeetingTitle('「季度产品规划会」')).toBe('季度产品规划会')
    expect(sanitizeMeetingTitle('标题：季度产品规划会')).toBe('季度产品规划会')
  })
  it('removes trailing punctuation', () => {
    expect(sanitizeMeetingTitle('季度产品规划会。')).toBe('季度产品规划会')
  })
  it('returns null when empty', () => {
    expect(sanitizeMeetingTitle('')).toBeNull()
    expect(sanitizeMeetingTitle('##')).toBeNull()
  })
})

describe('extractMeetingTitleFromReport', () => {
  it('extracts the first H1 from a report that begins with a title', () => {
    const report = '# 季度产品规划会\n\n## 会议摘要\n\n本次会议…'
    expect(extractMeetingTitleFromReport(report)).toBe('季度产品规划会')
  })

  it('ignores section headings (##) and only trusts a real H1', () => {
    // 兼容旧报告：正文直接以 "## 会议摘要" 开头，不应被当作会议名
    const report = '## 会议摘要\n\n本次讨论了上线排期。'
    expect(extractMeetingTitleFromReport(report)).toBeNull()
  })

  it('extracts H1 even when preceded by a few blank lines', () => {
    const report = '\n\n# 项目周会对齐\n\n正文…'
    expect(extractMeetingTitleFromReport(report)).toBe('项目周会对齐')
  })

  it('returns null for empty/garbage input', () => {
    expect(extractMeetingTitleFromReport('')).toBeNull()
    expect(extractMeetingTitleFromReport(null)).toBeNull()
  })
})
