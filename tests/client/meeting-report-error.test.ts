/**
 * Tests for the report-error classification helper used by MeetingAgentPanel.
 *
 * The user-visible goal: when the LLM provider returns an upstream stream
 * interruption (OpenAI Python SDK raises "Provider returned an empty stream with
 * no finish_reason"), the UI should show a friendly "please retry" message
 * instead of dumping the raw error. classifyReportError maps raw messages to
 * the right i18n key.
 */
import { describe, expect, it } from 'vitest'
import { classifyReportError } from '@/components/hermes/meeting/report-error'

describe('classifyReportError', () => {
  it('maps the OpenAI "empty stream with no finish_reason" message to the stream-interrupted key', () => {
    expect(classifyReportError('Provider returned an empty stream with no finish_reason'))
      .toBe('meeting.reportPanel.errorLLMStreamInterrupted')
  })

  it('matches regardless of case', () => {
    expect(classifyReportError('PROVIDER RETURNED AN EMPTY STREAM WITH NO FINISH_REASON'))
      .toBe('meeting.reportPanel.errorLLMStreamInterrupted')
  })

  it('matches Anthropic-style stream interrupt messages', () => {
    expect(classifyReportError('stream ended unexpectedly'))
      .toBe('meeting.reportPanel.errorLLMStreamInterrupted')
    expect(classifyReportError('connection reset by peer (stream closed)'))
      .toBe('meeting.reportPanel.errorLLMStreamInterrupted')
  })

  it('classifies LLM network errors (DNS / TCP / HTTP) separately from stream interrupts', () => {
    expect(classifyReportError('fetch failed: ECONNREFUSED 1.2.3.4:443'))
      .toBe('meeting.reportPanel.errorLLMNetwork')
    expect(classifyReportError('Request timeout (provider API)'))
      .toBe('meeting.reportPanel.errorLLMNetwork')
    expect(classifyReportError('provider returned status code 502'))
      .toBe('meeting.reportPanel.errorLLMNetwork')
    expect(classifyReportError('rate limited (429)'))
      .toBe('meeting.reportPanel.errorLLMNetwork')
  })

  it('classifies Hermes Agent bridge unavailable errors distinctly', () => {
    expect(classifyReportError('AgentBridge: bridge_pool refused connection'))
      .toBe('meeting.reportPanel.errorAgentUnavailable')
    expect(classifyReportError('EAI_AGAIN while dialing unix socket bridge.sock'))
      .toBe('meeting.reportPanel.errorAgentUnavailable')
  })

  it('classifies Hermes Agent run failures distinctly', () => {
    expect(classifyReportError('AIAgent: tool_call failed (NoSuchTool)'))
      .toBe('meeting.reportPanel.errorAgentFailed')
    expect(classifyReportError('agent run failed: skill execution error'))
      .toBe('meeting.reportPanel.errorAgentFailed')
  })

  it('classifies merged "both paths failed" errors distinctly', () => {
    // service 抛出的 ReportStreamBothFailed 错误，前端归一化到专属 key。
    expect(classifyReportError('ReportStreamBothFailed: agent: x | fallback: y'))
      .toBe('meeting.reportPanel.errorBothFailed')
  })

  it('falls back to generic key for unknown errors', () => {
    // 注意：HTTP 5xx / 4xx 已经被 errorLLMNetwork 截胡（更具体的分类优于 generic），
    // 所以这里用一些真正没有命中任何模式的消息来验证 generic 兜底。
    expect(classifyReportError('something completely unrelated happened'))
      .toBe('meeting.reportPanel.errorGeneric')
    expect(classifyReportError('ValueError: shape mismatch'))
      .toBe('meeting.reportPanel.errorGeneric')
    expect(classifyReportError(''))
      .toBe('meeting.reportPanel.errorGeneric')
  })

  it('does not over-match (substrings must include the stream keyword)', () => {
    // 'no finish_reason' alone (without 'empty stream') should NOT match —
    // protects against accidental matches in unrelated error messages.
    expect(classifyReportError('no finish_reason was set'))
      .toBe('meeting.reportPanel.errorGeneric')
  })
})
