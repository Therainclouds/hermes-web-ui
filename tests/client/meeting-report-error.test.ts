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
  it('maps the OpenAI "empty stream with no finish_reason" message to the friendly i18n key', () => {
    expect(classifyReportError('Provider returned an empty stream with no finish_reason'))
      .toBe('meeting.reportPanel.errorEmptyStream')
  })

  it('matches regardless of case', () => {
    expect(classifyReportError('PROVIDER RETURNED AN EMPTY STREAM WITH NO FINISH_REASON'))
      .toBe('meeting.reportPanel.errorEmptyStream')
  })

  it('matches Anthropic-style stream interrupt messages', () => {
    expect(classifyReportError('stream ended unexpectedly'))
      .toBe('meeting.reportPanel.errorEmptyStream')
    expect(classifyReportError('connection reset by peer (stream closed)'))
      .toBe('meeting.reportPanel.errorEmptyStream')
  })

  it('falls back to generic key for unknown errors', () => {
    expect(classifyReportError('LLM API error 500: internal server error'))
      .toBe('meeting.reportPanel.errorGeneric')
    expect(classifyReportError('TypeError: fetch failed'))
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
