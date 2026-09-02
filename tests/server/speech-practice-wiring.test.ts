import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Source-text guardrails for the speech-practice (口语对练) feature.
 *
 * Mirrors the omni-realtime-wiring.test.ts convention: these checks exist so a
 * future refactor that drops the new-chat entry, silently removes the scoring
 * tool, forgets the server route, or skips the i18n block will fail CI loudly.
 * The feature has many seams (new-chat drawer → practice stage → Omni tool
 * list → report-save route → locale files) that are invisible at runtime
 * until a user actually opens the drawer.
 */

const CLIENT_SRC = 'packages/client/src'
const SERVER_SRC = 'packages/server/src'

const panelSource = readFileSync(`${CLIENT_SRC}/components/hermes/chat/ChatPanel.vue`, 'utf8')
const stageSource = readFileSync(`${CLIENT_SRC}/components/hermes/chat/SpeechPracticeStage.vue`, 'utf8')
const toolsSource = readFileSync(`${CLIENT_SRC}/api/hermes/omni-tools.ts`, 'utf8')
const instructionsSource = readFileSync(`${CLIENT_SRC}/utils/realtime-instructions.ts`, 'utf8')
const practiceModeSource = readFileSync(`${CLIENT_SRC}/utils/practice-mode.ts`, 'utf8')
const routesSource = readFileSync(`${SERVER_SRC}/routes/index.ts`, 'utf8')

describe('speech-practice new-chat entry', () => {
  it('ChatPanel renders the practice radio option with a test id', () => {
    expect(panelSource).toContain('value="practice"')
    expect(panelSource).toContain('data-testid="new-chat-practice-option"')
    expect(panelSource).toContain('t("speechPractice.entry")')
  })

  it('ChatPanel collects language / direction / difficulty before starting', () => {
    expect(panelSource).toContain('newChatPracticeLanguage')
    expect(panelSource).toContain('newChatPracticeDirection')
    expect(panelSource).toContain('newChatPracticeDifficulty')
    expect(panelSource).toContain('data-testid="new-chat-practice-direction-field"')
  })

  it('ChatPanel mounts SpeechPracticeStage in the teleport with the config', () => {
    expect(panelSource).toContain('SpeechPracticeStage')
    expect(panelSource).toContain('showSpeechPractice && speechPracticeConfig')
    expect(panelSource).toContain(':config="speechPracticeConfig"')
  })
})

describe('speech-practice scoring keeps the agent toolchain', () => {
  it('PRACTICE_REALTIME_TOOLS keeps every base tool and adds submit_practice_feedback', () => {
    expect(toolsSource).toContain('PRACTICE_REALTIME_TOOLS')
    expect(toolsSource).toContain('submit_practice_feedback')
    // agent capability must survive: base tools spread into the practice list
    expect(toolsSource).toMatch(/PRACTICE_REALTIME_TOOLS[^=]*=\s*\[\s*\.\.\.OMNI_REALTIME_TOOLS/)
    expect(toolsSource).toContain('query_hermes_agent')
  })

  it('the practice stage executes the scoring tool locally and delegates the rest', () => {
    expect(stageSource).toContain("onToolCall: handlePracticeTool")
    expect(stageSource).toContain('executeOmniTool(name, argsJson)')
    expect(stageSource).toContain("name !== PRACTICE_TOOL_NAME")
  })
})

describe('speech-practice instructions & report', () => {
  it('buildRealtimeInstructions accepts a scenario block appended last', () => {
    expect(instructionsSource).toContain('scenario?: string')
    expect(instructionsSource).toContain("(extras.scenario || '').trim()")
  })

  it('practice-mode exposes the config types, instruction block and md builder', () => {
    expect(practiceModeSource).toContain('export interface PracticeSessionConfig')
    expect(practiceModeSource).toContain('export function buildPracticeInstructionBlock')
    expect(practiceModeSource).toContain('export function buildPracticeReportMarkdown')
    expect(practiceModeSource).toContain('submit_practice_feedback')
  })
})

describe('speech-practice report persistence wiring', () => {
  it('registers the report route before the proxy catch-all', () => {
    expect(routesSource).toContain("import { speechPracticeRoutes } from './hermes/speech-practice'")
    expect(routesSource).toContain('app.use(speechPracticeRoutes.routes())')
  })

  it('the download route already serves markdown via the upload dir', () => {
    const downloadSource = readFileSync(`${SERVER_SRC}/routes/hermes/download.ts`, 'utf8')
    expect(downloadSource).toContain("'.md': 'text/markdown'")
    expect(downloadSource).toContain('isInUploadDir')
  })
})

describe('speech-practice i18n presence', () => {
  const locales = ['zh', 'en', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar']
  const requiredKeys = [
    'entry',
    'entryHint',
    'direction',
    'directionPlaceholder',
    'difficulty',
    'startSession',
    'saveReport',
    'scoreBoard',
  ]

  for (const locale of locales) {
    it(`adds the speechPractice block to ${locale}.ts`, () => {
      const source = readFileSync(`${CLIENT_SRC}/i18n/locales/${locale}.ts`, 'utf8')
      expect(source).toContain('speechPractice: {')
      for (const key of requiredKeys) {
        expect(source).toContain(`${key}:`)
      }
    })
  }
})
