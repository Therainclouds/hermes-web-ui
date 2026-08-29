import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Source-text guardrails for the speech-evaluation verbatim-transcript
 * download button.
 *
 * The 逐字稿（verbatim transcript + evaluation data）is the input the speech
 * report is generated from. This guard makes sure the download button stays
 * wired to that builder and keeps its i18n key in every primary locale — a
 * future refactor that renames the builder or drops the button will fail CI
 * loudly instead of silently losing the export.
 */

const CLIENT_SRC = 'packages/client/src'

const PANEL = `${CLIENT_SRC}/components/hermes/meeting/SpeechEvaluationPanel.vue`

describe('speech evaluation verbatim-transcript download', () => {
  it('SpeechEvaluationPanel builds the transcript-with-eval document', () => {
    const source = readFileSync(PANEL, 'utf8')
    // builder combines the meeting transcript with the evaluation block
    expect(source).toContain('buildTranscriptWithEval')
    expect(source).toContain('【演讲评估数据】')
    expect(source).toContain('session.value?.sentences')
  })

  it('SpeechEvaluationPanel exposes a download-verbatim button', () => {
    const source = readFileSync(PANEL, 'utf8')
    // handler creates a Blob and triggers a .txt download
    expect(source).toContain('function downloadVerbatim()')
    expect(source).toContain("type: 'text/plain;charset=utf-8'")
    expect(source).toContain('_逐字稿.txt')
    // button bound to the handler + i18n label
    expect(source).toContain('@click="downloadVerbatim"')
    expect(source).toContain("t('meeting.speechEval.downloadVerbatim')")
  })

  it('primary locales declare the downloadVerbatim key in the speechEval block', () => {
    const expectedLeaves = ['downloadVerbatim:', 'generateReport:', 'reportTitle:']
    for (const path of [
      'packages/client/src/i18n/locales/zh.ts',
      'packages/client/src/i18n/locales/en.ts',
      'packages/client/src/i18n/locales/zh-TW.ts',
    ]) {
      const source = readFileSync(path, 'utf8')
      const idx = source.indexOf('speechEval:')
      expect(idx, `${path} has no speechEval block`).toBeGreaterThan(-1)
      const speechEvalBlock = source.slice(idx)
      for (const leaf of expectedLeaves) {
        expect(speechEvalBlock, `${path} speechEval block missing '${leaf}'`).toContain(leaf)
      }
    }
  })
})
