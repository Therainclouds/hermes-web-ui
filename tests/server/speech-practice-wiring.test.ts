import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Source-text guardrails for the speech-practice (口语对练) feature.
 *
 * Mirrors the omni-realtime-wiring.test.ts convention: these checks exist so a
 * future refactor that drops the realtime sub-mode entry, silently removes the
 * scoring tool, forgets the server route, or skips the i18n block will fail CI
 * loudly. The feature has many seams (new-chat realtime sub-modes → practice
 * stage → Omni tool list → report-save route → locale files) that are
 * invisible at runtime until a user actually opens the drawer.
 */

const CLIENT_SRC = 'packages/client/src'
const SERVER_SRC = 'packages/server/src'

const panelSource = readFileSync(`${CLIENT_SRC}/components/hermes/chat/ChatPanel.vue`, 'utf8')
const stageSource = readFileSync(`${CLIENT_SRC}/components/hermes/chat/SpeechPracticeStage.vue`, 'utf8')
const toolsSource = readFileSync(`${CLIENT_SRC}/api/hermes/omni-tools.ts`, 'utf8')
const instructionsSource = readFileSync(`${CLIENT_SRC}/utils/realtime-instructions.ts`, 'utf8')
const practiceModeSource = readFileSync(`${CLIENT_SRC}/utils/practice-mode.ts`, 'utf8')
const routesSource = readFileSync(`${SERVER_SRC}/routes/index.ts`, 'utf8')

describe('speech-practice new-chat entry (realtime sub-mode)', () => {
  it('keeps the top-level conversation mode at standard | realtime only', () => {
    // 口语对练不是顶层第三档，而是 realtime 下的一个子模式选项
    expect(panelSource).toContain('value="realtime"')
    expect(panelSource).not.toContain('newChatMode = ref<"standard" | "realtime" | "practice">')
  })

  it('realtime defaults to the agent sub-mode and offers practice via a registry', () => {
    expect(panelSource).toContain('NewChatRealtimeSubMode = "agent" | "practice"')
    expect(panelSource).toContain('const newChatRealtimeSubMode = ref<NewChatRealtimeSubMode>("agent")')
    expect(panelSource).toContain('realtimeSubModeOptions')
    expect(panelSource).toContain('omniRealtime.agentMode')
    expect(panelSource).toContain('new-chat-realtime-submode-')
    expect(panelSource).toContain('t("speechPractice.entry")')
  })

  it('shows practice config (language / direction / difficulty / duration) inside realtime', () => {
    expect(panelSource).toContain('newChatPracticeLanguage')
    expect(panelSource).toContain('newChatPracticeDirection')
    expect(panelSource).toContain('newChatPracticeDifficulty')
    expect(panelSource).toContain('data-testid="new-chat-practice-direction-field"')
    expect(panelSource).toContain('data-testid="new-chat-practice-duration-field"')
    expect(panelSource).toContain("newChatRealtimeSubMode === 'practice'")
  })

  it('shares the realtime model picker across all sub-modes and persists it', () => {
    expect(panelSource).toContain('data-testid="new-chat-realtime-model-field"')
    expect(panelSource).toContain('realtimeModelStore.updateConfig({ model: newChatRealtimeModel.value })')
  })

  it('routes the agent sub-mode to OmniRealtimeStage and practice to SpeechPracticeStage', () => {
    expect(panelSource).toContain('SpeechPracticeStage')
    expect(panelSource).toContain('showSpeechPractice && speechPracticeConfig')
    expect(panelSource).toContain(':config="speechPracticeConfig"')
    expect(panelSource).toContain('openOmniRealtime({ createFresh: true, persistRemote: true })')
    expect(panelSource).toContain('openSpeechPractice({')
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
    expect(stageSource).toContain('onToolCall: handlePracticeTool')
    expect(stageSource).toContain('executeOmniTool(name, argsJson)')
    expect(stageSource).toContain('name !== PRACTICE_TOOL_NAME')
  })
})

describe('speech-practice timer & instructions & report', () => {
  it('practice mode supports a duration with an auto-finish countdown', () => {
    expect(practiceModeSource).toContain('durationMinutes?: number')
    expect(practiceModeSource).toContain('formatPracticeCountdown')
    expect(stageSource).toContain('startCountdown')
    expect(stageSource).toContain('autoFinishByTimer')
  })

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

  it('supports camera + a body-language score dimension (skill-aware instruction block)', () => {
    expect(practiceModeSource).toContain('bodyLanguage: number | null')
    expect(practiceModeSource).toContain('options: { cameraOn?: boolean; skill?: PracticeSkill } = {}')
    expect(stageSource).toContain('speech-practice-camera')
    expect(stageSource).toContain('captureAndSendFrame')
    expect(stageSource).toContain('bodyLanguage: cameraEnabled.value ? toScore(args.bodyLanguage) : null')
    expect(stageSource).toContain('speechPractice.score.bodyLanguage')
  })
})

describe('realtime playback pre-arms the AudioContext in the user gesture', () => {
  it('useOmniRealtime exposes prearmPlayback', () => {
    const composableSource = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    expect(composableSource).toContain('async function prearmPlayback()')
    expect(composableSource).toMatch(/prearmPlayback,\n\s*connect,/)
  })

  it('chat stages call prearmPlayback from their start handlers', () => {
    expect(stageSource).toContain('omni.prearmPlayback()')
    const omniStageSource = readFileSync(`${CLIENT_SRC}/components/hermes/chat/OmniRealtimeStage.vue`, 'utf8')
    expect(omniStageSource).toContain('omni.prearmPlayback()')
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
  const requiredSpeechPracticeKeys = [
    'entry',
    'entryHint',
    'direction',
    'directionPlaceholder',
    'difficulty',
    'startSession',
    'duration',
    'durationHint',
    'cameraHint',
    'timeRemaining',
    'timeUpNotice',
    'saveReport',
    'scoreBoard',
    'reportAnalyzing',
    'reportAnalyzed',
    'aiAnalysisFailed',
  ]

  for (const locale of locales) {
    it(`adds the speechPractice + omniRealtime keys to ${locale}.ts`, () => {
      const source = readFileSync(`${CLIENT_SRC}/i18n/locales/${locale}.ts`, 'utf8')
      expect(source).toContain('speechPractice: {')
      for (const key of requiredSpeechPracticeKeys) {
        expect(source).toContain(`${key}:`)
      }
      // submode label keys on the omniRealtime namespace
      expect(source).toContain('modeLabel:')
      expect(source).toContain('agentMode:')
    })
  }
})
