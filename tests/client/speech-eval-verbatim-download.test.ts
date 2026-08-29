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
 *
 * v0.8 场景定制化（S4）：builder 移入 useSpeechEvalReport.ts，按钮经
 * SpeechEvalReportSection 组件渲染；面板保留事件转发。
 */

const CLIENT_SRC = 'packages/client/src'

const PANEL = `${CLIENT_SRC}/components/hermes/meeting/SpeechEvaluationPanel.vue`
const REPORT_COMPOSABLE = `${CLIENT_SRC}/composables/useSpeechEvalReport.ts`
const REPORT_SECTION = `${CLIENT_SRC}/components/hermes/meeting/speech/right-panel/SpeechEvalReportSection.vue`

describe('speech evaluation verbatim-transcript download', () => {
  it('useSpeechEvalReport builds the transcript-with-eval document', () => {
    const source = readFileSync(REPORT_COMPOSABLE, 'utf8')
    // builder combines the meeting transcript with the evaluation block
    expect(source).toContain('buildTranscriptWithEval')
    expect(source).toContain('【演讲评估数据】')
    expect(source).toContain("session?.sentences")
  })

  it('the download-verbatim flow creates a .txt download', () => {
    const source = readFileSync(REPORT_COMPOSABLE, 'utf8')
    // handler creates a Blob and triggers a .txt download
    expect(source).toContain('function downloadVerbatim()')
    expect(source).toContain("type: 'text/plain;charset=utf-8'")
    expect(source).toContain('_逐字稿.txt')
  })

  it('panel keeps the button wired through the report section', () => {
    const panel = readFileSync(PANEL, 'utf8')
    expect(panel).toContain('@download-verbatim="downloadVerbatim"')

    const section = readFileSync(REPORT_SECTION, 'utf8')
    // button bound to the handler + i18n label
    expect(section).toContain("@click=\"emit('download-verbatim')\"")
    expect(section).toContain("t('meeting.speechEval.downloadVerbatim')")
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
