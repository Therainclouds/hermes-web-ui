import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Source-text guardrails for the Omni-Realtime realtime-dialog feature.
 *
 * These checks exist so a future refactor that forgets to register the new
 * WebSocket endpoint, lose the i18n key, or silently drop the client-side
 * capture/playback wiring will fail CI loudly — the Omni feature has a lot
 * of moving parts (Python proxy → FastAPI route → Node WS upgrade handler
 * → Vue component → i18n key) and a broken seam is invisible at runtime
 * until a user actually clicks the button.
 */

const CLIENT_SRC = 'packages/client/src'
const SERVER_SRC = 'packages/server/src'
const PY_APP = `${SERVER_SRC}/services/meeting-asr/python-backend/app`

describe('omni-realtime endpoint wiring', () => {
  it('Node bootstrap forwards /ws/omni-realtime to the ASR backend', () => {
    const source = readFileSync(`${SERVER_SRC}/index.ts`, 'utf8')
    expect(source).toContain("req.url === '/ws/omni-realtime'")
    // also caught by the catch-all destructure so unhandled upgrades are dropped
    expect(source).toContain("url.pathname !== '/ws/omni-realtime'")
  })

  it('FastAPI exposes the /ws/omni-realtime WebSocket route', () => {
    const source = readFileSync(`${PY_APP}/main.py`, 'utf8')
    expect(source).toMatch(/@app\.websocket\(['"]\/ws\/omni-realtime['"]\)/)
    // handler must read the OmniRealtimeProxy from the module
    expect(source).toContain('OmniRealtimeProxy')
    expect(source).toContain('translate_omni_event')
  })

  it('OmniRealtimeProxy translates upstream events for the frontend', () => {
    const source = readFileSync(`${PY_APP}/omni_realtime_proxy.py`, 'utf8')
    // protocol translator function
    expect(source).toMatch(/def translate_event\(/)
    // base64 audio delta → raw PCM16 bytes (per OpenAI-Realtime spec)
    expect(source).toContain('response.audio.delta')
    expect(source).toContain('base64.b64decode')
    // upstream URL defaults to dashscope realtime endpoint
    expect(source).toContain('wss://dashscope.aliyuncs.com/api-ws/v1/realtime')
  })

  it('Python config exposes omni-realtime defaults overridable by env', () => {
    const source = readFileSync(`${PY_APP}/config.py`, 'utf8')
    expect(source).toMatch(/omni_realtime_ws_url:\s*str\s*=\s*os\.environ\.get\(/)
    expect(source).toMatch(/omni_realtime_model:\s*str\s*=\s*os\.environ\.get\(/)
    expect(source).toMatch(/omni_realtime_voice:\s*str\s*=\s*os\.environ\.get\(/)
    // default model must be the user-requested qwen3.5 omni flash realtime
    expect(source).toContain('qwen3.5-omni-flash-realtime')
  })
})

describe('omni-realtime client wiring', () => {
  it('MeetingTopBar exposes the realtime-dialog button', () => {
    const source = readFileSync(
      `${CLIENT_SRC}/components/hermes/meeting/MeetingTopBar.vue`,
      'utf8',
    )
    expect(source).toContain("t('meeting.realtime.tabLabel')")
    expect(source).toContain("t('meeting.realtime.tabTooltip')")
    expect(source).toContain('toggle-realtime-dialog')
  })

  it('MeetingView wires the realtime-dialog toggle from MeetingTopBar', () => {
    const source = readFileSync(`${CLIENT_SRC}/views/hermes/MeetingView.vue`, 'utf8')
    // kebab-case attr binding in template + reactive ref in script
    expect(source).toContain('show-realtime-dialog=')
    expect(source).toContain('showRealtimeDialog')
    expect(source).toMatch(/@toggle-realtime-dialog="showRealtimeDialog/)
    // RealtimeDialogPanel is mounted into MeetingRightPanel's realtime slot
    expect(source).toContain('<RealtimeDialogPanel')
    expect(source).toContain('has-dashscope-key')
  })

  it('MeetingRightPanel accepts showRealtimeDialog and a realtime slot', () => {
    const source = readFileSync(
      `${CLIENT_SRC}/components/hermes/meeting/MeetingRightPanel.vue`,
      'utf8',
    )
    expect(source).toContain('showRealtimeDialog')
    // The four-way slot dispatch (speech > agent > realtime > analysis)
    expect(source).toContain('<slot name="realtime"')
  })

  it('RealtimeDialogPanel implements push-to-talk and renders the conversation', () => {
    const source = readFileSync(
      `${CLIENT_SRC}/components/hermes/meeting/RealtimeDialogPanel.vue`,
      'utf8',
    )
    // receives the DashScope-key availability as a prop from MeetingView
    expect(source).toContain('hasDashscopeKey')
    // speak/release handlers
    expect(source).toContain('togglePush')
    expect(source).toContain('releasePush')
    // delegates WS lifecycle to useOmniRealtime (covered in the next test)
    expect(source).toContain('useOmniRealtime')
    // passes the user-supplied voice + instructions through to the server
    expect(source).toMatch(/voice:\s*selectedVoice/)
    expect(source).toMatch(/instructions:\s*instructions/)
  })

  it('MeetingView forwards the DashScope key availability to RealtimeDialogPanel', () => {
    const source = readFileSync(`${CLIENT_SRC}/views/hermes/MeetingView.vue`, 'utf8')
    expect(source).toContain('meetingStore.asrConfig.dashscopeApiKey')
    expect(source).toMatch(/has-dashscope-key=.*dashscopeApiKey/)
  })

  it('useOmniRealtime composable wires binary PCM16 audio both directions', () => {
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    // 24 kHz PCM16 mono matches the Omni-Realtime wire spec
    expect(source).toContain('TARGET_SAMPLE_RATE = 24000')
    // linear resample on capture + playback so AudioContext can run at native rate
    expect(source).toContain('resampleLinear')
    expect(source).toContain('float32ToInt16')
    expect(source).toContain('int16ToFloat32')
    // connects to the Node WS proxy
    expect(source).toContain('/ws/omni-realtime')
    // opens with the documented `{type:"start"}` control frame
    expect(source).toMatch(/type:\s*['"]start['"]/)
    // push-to-talk uses commit/cancel control frames; client also handles pong
    expect(source).toContain("type: 'commit'")
    expect(source).toContain("type: 'cancel'")
    expect(source).toContain('pong')
  })
})

describe('omni-realtime i18n keys present in primary locales', () => {
  // Each expected leaf must appear (as a property name) in the realtime
  // block. We pair the leaf with the colon that follows the key so we don't
  // false-match unrelated English strings elsewhere in the file.
  const expectedLeaves = [
    'title:',
    'tabLabel:',
    'tabTooltip:',
    'startSession:',
    'pushToTalk:',
    'idle:',
    'ready:',
    'error:',
  ]

  it.each([
    'packages/client/src/i18n/locales/zh.ts',
    'packages/client/src/i18n/locales/en.ts',
    'packages/client/src/i18n/locales/zh-TW.ts',
  ])('%s declares every realtime key', (path) => {
    const source = readFileSync(path, 'utf8')
    // Slice from the realtime: { block onward so we don't accidentally match
    // top-level keys with the same leaf (e.g. 'title:' appears elsewhere).
    const idx = source.indexOf('realtime:')
    expect(idx, `${path} has no realtime block`).toBeGreaterThan(-1)
    const realtimeBlock = source.slice(idx)
    for (const leaf of expectedLeaves) {
      expect(realtimeBlock, `${path} realtime block missing '${leaf}'`).toContain(leaf)
    }
  })
})
