// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MAX_MALFORMED_CALL_STREAK,
  missingRequiredArgs,
  normalizeToolArguments,
  parseToolArgsJson,
} from '@/utils/omni-tool-call-guard'
import { OMNI_REALTIME_TOOLS } from '@/api/hermes/omni-tools'

/**
 * Regression guards for the realtime `query_hermes_agent {}` storm:
 * DashScope's Omni-Realtime compatible layer occasionally hands tool-call
 * arguments out as an object instead of a JSON string, or announces a call
 * with empty arguments while the real ones are still streaming. Any of these
 * made the client execute `query_hermes_agent` with `{}` → the required
 * `question` was missing → the model retried the identical call forever
 * (each retry also chopped the TTS audio of the previous one).
 */

describe('normalizeToolArguments', () => {
  it('keeps a JSON-string payload as-is', () => {
    const raw = '{"question": "查看内存"}'
    expect(normalizeToolArguments(raw)).toBe(raw)
  })

  it('stringifies an object payload instead of falling back to {}', () => {
    // The bug: a non-string argument used to become '{}', so a call whose
    // model-generated args were an object executed with EMPTY arguments.
    const out = normalizeToolArguments({ question: '查看内存' })
    expect(out).toBe('{"question":"查看内存"}')
    expect(JSON.parse(out)).toEqual({ question: '查看内存' })
  })

  it('normalizes blank / missing / nullish payloads to {}', () => {
    expect(normalizeToolArguments('')).toBe('{}')
    expect(normalizeToolArguments('   ')).toBe('{}')
    expect(normalizeToolArguments(undefined)).toBe('{}')
    expect(normalizeToolArguments(null)).toBe('{}')
    expect(normalizeToolArguments(42)).toBe('{}')
  })
})

describe('parseToolArgsJson', () => {
  it('parses valid JSON objects', () => {
    expect(parseToolArgsJson('{"question":"x"}')).toEqual({ question: 'x' })
  })

  it('treats empty input as an empty object', () => {
    expect(parseToolArgsJson('')).toEqual({})
    expect(parseToolArgsJson('   ')).toEqual({})
  })

  it('returns null for invalid JSON or non-object payloads', () => {
    expect(parseToolArgsJson('not-json')).toBeNull()
    expect(parseToolArgsJson('[1,2]')).toBeNull()
    expect(parseToolArgsJson('"str"')).toBeNull()
  })
})

describe('missingRequiredArgs', () => {
  it('reports absent and blank required parameters', () => {
    const tools = OMNI_REALTIME_TOOLS as unknown[]
    expect(missingRequiredArgs(tools, 'query_hermes_agent', {})).toEqual(['question'])
    expect(missingRequiredArgs(tools, 'query_hermes_agent', { question: '   ' })).toEqual(['question'])
    expect(missingRequiredArgs(tools, 'query_hermes_agent', { question: null })).toEqual(['question'])
    expect(missingRequiredArgs(tools, 'query_hermes_agent', { question: undefined })).toEqual(['question'])
  })

  it('accepts a filled required parameter', () => {
    expect(missingRequiredArgs(OMNI_REALTIME_TOOLS as unknown[], 'query_hermes_agent', { question: '查看内存' }))
      .toEqual([])
  })

  it('validates multi-field required schemas', () => {
    expect(missingRequiredArgs(OMNI_REALTIME_TOOLS as unknown[], 'read_skill_detail', { category: 'dev' }))
      .toEqual(['skill'])
    expect(missingRequiredArgs(
      OMNI_REALTIME_TOOLS as unknown[],
      'read_skill_detail',
      { category: 'dev', skill: 'debug' },
    )).toEqual([])
  })

  it('treats tools without required params as always valid', () => {
    expect(missingRequiredArgs(OMNI_REALTIME_TOOLS as unknown[], 'list_jobs', {})).toEqual([])
    expect(missingRequiredArgs(undefined, 'query_hermes_agent', {})).toEqual([])
    expect(missingRequiredArgs([], 'query_hermes_agent', {})).toEqual([])
    // Unknown tools are not validated either (schema-less fallback).
    expect(missingRequiredArgs(OMNI_REALTIME_TOOLS as unknown[], 'no_such_tool', {})).toEqual([])
  })

  it('exposes a sane loop-breaking threshold', () => {
    expect(MAX_MALFORMED_CALL_STREAK).toBeGreaterThanOrEqual(3)
  })
})
