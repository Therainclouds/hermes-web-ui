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

  it('OmniRealtimeProxy uses the qwen3.5 audio.input/output.format shape and semantic_vad', () => {
    const source = readFileSync(`${PY_APP}/omni_realtime_proxy.py`, 'utf8')
    // New (qwen3.5) audio config shape per the docs.
    expect(source).toContain('"audio": {')
    expect(source).toContain('"input": {')
    expect(source).toContain('"output": {')
    expect(source).toContain('"sample_rate": settings.omni_realtime_input_sample_rate')
    expect(source).toContain('"sample_rate": settings.omni_realtime_output_sample_rate')
    // VAD per docs: semantic_vad for qwen3.5 family, server_vad fallback for qwen3.
    expect(source).toContain('"semantic_vad"')
    expect(source).toContain('_is_qwen35_family')
    // `session.finish` close event per docs.
    expect(source).toContain('"type": "session.finish"')
    // Tool calling is incompatible with enable_search; the proxy must not
    // forward enable_search when tools are present.
    expect(source).toMatch(/session\.pop\(\s*["']enable_search["']/)
  })

  it('OmniRealtimeProxy rewrites the WSS URL with WorkspaceId when configured', () => {
    const source = readFileSync(`${PY_APP}/omni_realtime_proxy.py`, 'utf8')
    expect(source).toContain('settings.omni_realtime_workspace_id')
    expect(source).toContain('cn-beijing.maas.aliyuncs.com')
  })

  it('Python config exposes omni-realtime defaults overridable by env', () => {
    const source = readFileSync(`${PY_APP}/config.py`, 'utf8')
    expect(source).toMatch(/omni_realtime_ws_url:\s*str\s*=\s*os\.environ\.get\(/)
    expect(source).toMatch(/omni_realtime_model:\s*str\s*=\s*os\.environ\.get\(/)
    expect(source).toMatch(/omni_realtime_voice:\s*str\s*=\s*os\.environ\.get\(/)
    // default model must be the user-requested qwen3.5 omni flash realtime
    expect(source).toContain('qwen3.5-omni-flash-realtime')
    // New per the Bailian docs: input/output sample rates + workspace-id
    // override for region-routed WSS endpoints.
    expect(source).toMatch(/omni_realtime_input_sample_rate:\s*int/)
    expect(source).toMatch(/omni_realtime_output_sample_rate:\s*int/)
    expect(source).toMatch(/omni_realtime_workspace_id:\s*str/)
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
    // InlineRealtimePanel (the meeting-side thin wrapper around the shared
    // useOmniRealtime audio chain) is mounted into MeetingRightPanel's realtime slot
    expect(source).toContain('<InlineRealtimePanel')
    expect(source).toContain('has-dashscope-key')
  })

  it('MeetingView feeds the current meeting context (transcript + time) into the realtime dialog', () => {
    const source = readFileSync(`${CLIENT_SRC}/views/hermes/MeetingView.vue`, 'utf8')
    // context builder: title / start time / speakers / timestamped verbatim transcript
    expect(source).toContain('realtimeMeetingContext')
    expect(source).toContain('meetingStore.activeSession')
    expect(source).toContain('会议标题')
    expect(source).toContain('逐字稿')
    // the panel receives it as a prop
    expect(source).toMatch(/meeting-context="realtimeMeetingContext"/)
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

  it('InlineRealtimePanel implements push-to-talk and soul-based instructions', () => {
    const source = readFileSync(
      `${CLIENT_SRC}/components/hermes/meeting/InlineRealtimePanel.vue`,
      'utf8',
    )
    // receives the DashScope-key availability as a prop from MeetingView
    expect(source).toContain('hasDashscopeKey')
    // receives the current meeting context (transcript + time) as a prop
    expect(source).toContain('meetingContext')
    // meeting context + SOUL.md persona are combined through the shared
    // buildRealtimeInstructions path (same injection seam as the Chat stage)
    expect(source).toContain('buildRealtimeInstructions')
    expect(source).toContain('meetingContext:')
    // speak/release handlers
    expect(source).toContain('togglePush')
    expect(source).toContain('releasePush')
    // delegates WS lifecycle to useOmniRealtime (covered in the next test)
    expect(source).toContain('useOmniRealtime')
    // passes the user-supplied voice through to the server; instructions are
    // composed from soul + meeting context (optionally user extras)
    expect(source).toMatch(/voice:\s*selectedVoice/)
    expect(source).toContain('baseInstructions')
  })

  it('MeetingView forwards the DashScope key availability to RealtimeDialogPanel', () => {
    const source = readFileSync(`${CLIENT_SRC}/views/hermes/MeetingView.vue`, 'utf8')
    expect(source).toContain('meetingStore.asrConfig.dashscopeApiKey')
    expect(source).toMatch(/has-dashscope-key=.*dashscopeApiKey/)
  })

  it('useOmniRealtime composable wires binary PCM16 audio both directions', () => {
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    // 16 kHz input / 24 kHz output PCM16 mono matches the Omni-Realtime
    // wire spec (per Bailian docs the input defaults to 16 kHz; output
    // defaults to 24 kHz — both must match the audio.input/output.format
    // sample_rate sent upstream or DashScope rejects the audio stream).
    expect(source).toContain('INPUT_SAMPLE_RATE = 16_000')
    expect(source).toContain('OUTPUT_SAMPLE_RATE = 24_000')
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

  it('useOmniRealtime instantiates the playback AudioContext and flushes incrementally', () => {
    // Regression guard for the v0.7.19 silent-output bug: `playbackCtx` was
    // declared but never created, and `flushPendingToSlot()` was only invoked
    // on `response_done` — every binary frame accumulated into `pendingSamples`
    // and was thrown away, so text transcripts worked but no audio ever played.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    // the playback context must be created (not just declared)
    expect(source).toMatch(/new\s+(?:Ctor|window\.AudioContext|webkitAudioContext)/)
    // ...and resumed so the first frame isn't blocked by autoplay policy
    expect(source).toContain('await playbackCtx.resume()')
    // binary PCM frames must schedule playback incrementally (per chunk,
    // not only on response_done) — otherwise the user hears nothing until
    // the model has already finished its turn
    const messageHandlerMatch = source.match(/ws\.onmessage\s*=\s*\(event[^)]*\)\s*=>\s*\{([\s\S]*?)\n\s\s\s\s\}/)
    expect(messageHandlerMatch, 'ws.onmessage handler missing').not.toBeNull()
    const messageBody = messageHandlerMatch![1]
    expect(messageBody, 'ws.onmessage must flush playback per chunk').toMatch(/appendPcmChunk[\s\S]*?flushPendingToSlot/)
    // barge-in must stop every scheduled source, not just the latest one
    expect(source).toMatch(/stopPlayback[\s\S]*?scheduledSources/)
  })

  it('useOmniRealtime keeps browser echo cancellation enabled on capture', () => {
    // Regression guard for the self-interrupt / speaker-echo bug: with
    // `echoCancellation: { ideal: false }` the mic captured the assistant's
    // playback, the upstream VAD heard that echo as a new user turn, and
    // `maybeBargeIn` cancelled our own playback in a tight loop.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    const getUserMediaBlock = source.match(/getUserMedia\(\{([\s\S]*?)\}\)/)
    expect(getUserMediaBlock, 'getUserMedia call missing').not.toBeNull()
    const block = getUserMediaBlock![1]
    expect(
      block,
      'echoCancellation must be enabled (true / { ideal: true }) so the mic does not capture the assistant\'s speaker output',
    ).toMatch(/echoCancellation\s*:\s*(?:true|\{\s*ideal\s*:\s*true\s*\})/)
    // and it must NOT be explicitly disabled
    expect(block).not.toMatch(/echoCancellation\s*:\s*\{\s*ideal\s*:\s*false\s*\}/)
  })

  it('omni-realtime voice pickers only offer voices valid for qwen3.5-omni-flash-realtime', () => {
    // Regression guard: Cherry / Chelsie / Adam are not in the
    // `qwen3.5-omni-flash-realtime` voice catalogue — DashScope rejects
    // them with `1007 InvalidParameter: Voice 'X' is not supported.`
    const disallowed = ['Cherry', 'Chelsie', 'Adam']
    const pickers = [
      `${CLIENT_SRC}/components/hermes/chat/OmniRealtimeStage.vue`,
      `${CLIENT_SRC}/components/hermes/meeting/InlineRealtimePanel.vue`,
    ]
    for (const path of pickers) {
      const source = readFileSync(path, 'utf8')
      for (const voice of disallowed) {
        expect(
          source,
          `${path} must not offer '${voice}' as a voice option (not supported by qwen3.5-omni-flash-realtime)`,
        ).not.toMatch(new RegExp(`value:\\s*['"]${voice}['"]`))
      }
      // Each picker must also have a non-empty default that's actually in its
      // own options list — otherwise the user starts on a broken voice.
      const defaultMatch = source.match(/selectedVoice\s*=\s*ref(?:<string>)?\(['"]([\w]+)['"]\)/)
      expect(defaultMatch, `${path} has no selectedVoice default`).not.toBeNull()
      const defaultVoice = defaultMatch![1]
      expect(
        source.includes(`value: '${defaultVoice}'`),
        `${path} default voice '${defaultVoice}' is not in its own voiceOptions`,
      ).toBe(true)
    }
  })

  it('omni-realtime server default voice is valid for qwen3.5-omni-flash-realtime', () => {
    const source = readFileSync(`${PY_APP}/config.py`, 'utf8')
    // Slice the file at the `omni_realtime_voice:` field and stop at the
    // closing paren of its `os.environ.get(...)` call so we don't pick up
    // neighbouring fields' defaults.
    const startIdx = source.indexOf('omni_realtime_voice:')
    expect(startIdx, 'omni_realtime_voice field not found').toBeGreaterThan(-1)
    const tail = source.slice(startIdx)
    const endIdx = tail.indexOf('\n    )')
    expect(endIdx, 'omni_realtime_voice closing paren not found').toBeGreaterThan(-1)
    const window = tail.slice(0, endIdx)
    // Collect every standalone `"..."` literal in the window; the env var
    // name comes first and the default is the LAST one.
    const literals = window.match(/^\s*"([\w]+)"\s*,?\s*$/mg) ?? []
    expect(literals.length, 'omni_realtime_voice default literal not found').toBeGreaterThan(1)
    const defaultVoice = literals[literals.length - 1].match(/"([\w]+)"/)![1]
    expect(
      ['Tina', 'Serena', 'Ethan', 'Jennifer', 'Ryan'].includes(defaultVoice),
      `omni_realtime_voice default '${defaultVoice}' is not in the qwen3.5 catalogue`,
    ).toBe(true)
  })

  it('OmniRealtimeStage hides the hands-free hint while AI audio is still playing', () => {
    // Regression guard: `phase` flips to 'ready' the moment upstream emits
    // `response_done`, but the last queued buffer can still be playing
    // through the speakers for a while after that. The caption must not
    // fall through to the hands-free hint during that tail — otherwise it
    // covers the AI's transcript / subtitle text until playback ends.
    const composable = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    // composable must expose a reactive "is output playing" signal
    expect(composable).toContain('isOutputPlaying')
    // ...backed by a counter that increments on schedule and decrements on
    // `onended` — using a ref rather than `Set.size` so the value stays
    // reactive across Vue components
    expect(composable).toMatch(/playingSourceCount\.value\s*\+=\s*1/)
    expect(composable).toMatch(/playingSourceCount\.value\s*=\s*Math\.max\(0,\s*playingSourceCount\.value\s*-\s*1\)/)

    const stage = readFileSync(`${CLIENT_SRC}/components/hermes/chat/OmniRealtimeStage.vue`, 'utf8')
    // the caption must consult the live playback signal BEFORE falling
    // through to the hands-free hint
    const captionMatch = stage.match(/const\s+caption\s*=\s*computed\(\(\)\s*=>\s*\{([\s\S]*?)\n\}\)/)
    expect(captionMatch, 'caption computed not found').not.toBeNull()
    const body = captionMatch![1]
    const isOutputCheckIdx = body.indexOf('omni.isOutputPlaying.value')
    const hintIdx = body.indexOf("t('omniRealtime.handsFreeHint')")
    expect(isOutputCheckIdx, 'caption must check omni.isOutputPlaying').toBeGreaterThan(-1)
    expect(hintIdx, 'caption must fall through to handsFreeHint').toBeGreaterThan(-1)
    expect(
      isOutputCheckIdx < hintIdx,
      'isOutputPlaying check must come BEFORE the handsFreeHint fallback so audio playback hides the hint',
    ).toBe(true)
  })

  it('useOmniRealtime drops assistant audio frames between cancel and the upstream confirmation', () => {
    // Regression guard: when the user barges in mid-response, upstream
    // keeps emitting audio deltas for a few frames after `response.cancel`
    // lands. Without a drop window, those frames get appended + flushed
    // as fresh `AudioBufferSourceNode`s and the user hears the tail of
    // the cancelled reply overlap the new one — exactly the "audio keeps
    // playing until the end" symptom in the bug report.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')

    // 1. There must be a `droppingAssistantAudio` flag declared at module
    //    scope inside the composable closure.
    expect(source).toMatch(/let\s+droppingAssistantAudio\s*=/)

    // 2. The flag must be flipped on in every path that sends `cancel`
    //    upstream — at minimum in `maybeBargeIn`, which is the auto-barge-in
    //    path the user hits in hands-free mode.
    const maybeBargeInBody = source.match(/function\s+maybeBargeIn[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(
      maybeBargeInBody,
      'maybeBargeIn must set droppingAssistantAudio so the tail of the cancelled reply is dropped',
    ).toMatch(/droppingAssistantAudio\s*=\s*true/)
    expect(
      maybeBargeInBody,
      'maybeBargeIn must still send the upstream cancel frame',
    ).toMatch(/type:\s*['"]cancel['"]/)

    // 3. The flag must be cleared on the upstream confirmation event so
    //    the next turn's audio plays normally.
    expect(
      source,
      'response_done handler must clear droppingAssistantAudio once the previous response has fully drained',
    ).toMatch(/response_done[\s\S]{0,400}droppingAssistantAudio\s*=\s*false/)

    // 4. The binary WS handler must early-return while the flag is set —
    //    otherwise the dropped frames still reach `flushPendingToSlot`
    //    and re-create playback sources.
    const onMessageBody = source.match(/ws\.onmessage\s*=\s*\(event[^)]*\)\s*=>\s*\{([\s\S]*?)\n\s\s\s\s\}/)?.[0] ?? ''
    expect(
      onMessageBody,
      'binary-frame branch in ws.onmessage must check droppingAssistantAudio before flushing',
    ).toMatch(/droppingAssistantAudio[\s\S]{0,200}return/)
  })

  it('useOmniRealtime barge-ins locally so the user does not wait for server VAD', () => {
    // Regression guard: the upstream server VAD takes 100–300 ms to emit
    // `listening` after the user starts speaking. During that window the
    // AI audio keeps playing and the user perceives the interrupt as
    // broken. We trigger `maybeBargeIn` directly off the local mic peak
    // (analyser tick) so the response feels real-time.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')

    // 1. Module-scope threshold + debounce constants.
    expect(source).toMatch(/const\s+LOCAL_BARGE_IN_THRESHOLD\s*=/)
    expect(source).toMatch(/const\s+LOCAL_BARGE_IN_DEBOUNCE_MS\s*=/)

    // 2. Per-session debounce timestamp + consecutive-frame streak counters.
    expect(source).toMatch(/let\s+lastLocalBargeInAt\s*=/)
    expect(source).toMatch(/let\s+bargeInStreak\s*=/)

    // 3. The analyser tick must call maybeBargeIn once the local mic peak
    //    stays above the threshold for several frames — the streak + phase
    //    check makes sure we don't fire on a single residual-echo frame.
    const tickBody = source.match(/const\s+tick\s*=\s*\(\)\s*:\s*void\s*=>\s*\{([\s\S]*?)\n\s\s\}\)/)?.[0] ?? ''
    expect(tickBody, 'analyser tick not found').not.toBe('')
    expect(
      tickBody,
      'analyser tick must trigger maybeBargeIn when the local mic peak exceeds the threshold (so barge-in is real-time, not waiting on server VAD)',
    ).toMatch(/maybeBargeIn\(\)/)
    expect(
      tickBody,
      'tick must guard on phase.value === "speaking" so we only interrupt while the AI is actively talking',
    ).toMatch(/phase\.value\s*===\s*['"]speaking['"]/)
    expect(
      tickBody,
      'tick must consult the debounce timer to avoid re-interrupting on the same speech burst',
    ).toMatch(/lastLocalBargeInAt/)
  })

  it('useOmniRealtime barge-in fires during the tail-drain window (phase already "ready" while audio still plays)', () => {
    // Regression guard: `response_done` flips `phase` back to 'ready' the
    // moment upstream finishes generating, which is well before the last
    // queued buffer actually finishes playing through the speakers. The old
    // gate `phase === 'speaking'` therefore swallowed the most common
    // interrupt moment — the user speaking right after the AI stops
    // talking — and the AI's audio tail kept playing over them.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')

    // 1. maybeBargeIn must gate on real playback (isOutputPlaying), not just phase.
    const maybeBargeInBody = source.match(/function\s+maybeBargeIn[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(
      maybeBargeInBody,
      'maybeBargeIn must fire while audio is actually playing even if phase already flipped back to ready',
    ).toMatch(/!isOutputPlaying\.value\s*&&\s*phase\.value\s*!==\s*['"]speaking['"]/)

    // 2. `response.cancel` must only be sent while an upstream response is
    //    in flight (`phase === 'speaking'`) — in the tail-drain window there
    //    is nothing upstream to cancel, and cancel-with-no-active-response
    //    can surface an upstream error that would kill the session.
    expect(
      maybeBargeInBody,
      'maybeBargeIn must skip the upstream cancel when phase is not "speaking" (tail-drain window)',
    ).toMatch(/if\s*\(\s*phase\.value\s*!==\s*['"]speaking['"]\s*\)\s*return[\s\S]*?droppingAssistantAudio\s*=\s*true/)

    // 3. The local analyser tick must use the same gate so real-time
    //    barge-in (before the server VAD answers) works in the drain window too.
    const tickBody = source.match(/const\s+tick\s*=\s*\(\)\s*:\s*void\s*=>\s*\{([\s\S]*?)\n\s\s\}\)/)?.[0] ?? ''
    expect(tickBody, 'analyser tick not found').not.toBe('')
    expect(
      tickBody,
      'analyser tick must gate barge-in on isOutputPlaying OR phase === "speaking"',
    ).toMatch(/isOutputPlaying\.value\s*\|\|\s*phase\.value\s*===\s*['"]speaking['"]/)
  })

  it('useOmniRealtime cuts leftover playback when a new response starts', () => {
    // Regression guard: when the next response begins, the previous
    // response's audio may still be playing or queued (e.g. the user spoke
    // during the tail-drain window, or a function-call continuation arrived
    // before the old tail drained). `flushPendingToSlot` chains each new
    // chunk behind `nextPlayTime`, so without stopping the old sources the
    // new reply's audio queues behind the old tail — the user hears the
    // previous segment while the subtitles already show the new response.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    const responseStartedMatch = source.match(
      /case\s+['"]response_started['"][\s\S]*?\n\s*case\s+['"]response_done['"]/,
    )
    expect(responseStartedMatch, 'response_started handler not found').not.toBeNull()
    expect(
      responseStartedMatch![0],
      'response_started must stop leftover playback so the new response audio does not queue behind the old tail',
    ).toMatch(/stopPlayback\(\)/)
  })

  it('useOmniRealtime routes assistant audio through a master gain so barge-in can mute instantly', () => {
    // The OpenAI Realtime reference pattern is: every assistant source
    // goes through one `GainNode` and barge-in is `gain.value = 0`. Just
    // calling `src.stop()` per source lets the Web Audio destination keep
    // draining its render-quantum buffer for tens of ms, which is the
    // "new audio waits for the old audio to finish" symptom.
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')

    // 1. A `masterGain` node is declared inside the composable closure.
    expect(source).toMatch(/let\s+masterGain\s*:\s*GainNode\s*\|\s*null\s*=\s*null/)

    // 2. `ensurePlaybackContext` must build the gain node, connect it to
    //    `destination`, and start at gain = 1.
    const ensureBody = source.match(/async function ensurePlaybackContext[\s\S]*?return playbackCtx\n  \}/)?.[0] ?? ''
    expect(ensureBody, 'ensurePlaybackContext not found').not.toBe('')
    expect(ensureBody).toMatch(/masterGain\s*=\s*playbackCtx\.createGain\(\)/)
    expect(ensureBody).toMatch(/masterGain\.gain\.value\s*=\s*1/)
    expect(ensureBody).toMatch(/masterGain\.connect\(\s*playbackCtx\.destination\s*\)/)

    // 3. `flushPendingToSlot` must connect each new source to the gain
    //    node (not directly to destination), and reset gain to 1 so a
    //    prior barge-in's mute doesn't silence the new turn.
    const flushBody = source.match(/function flushPendingToSlot[\s\S]*?pendingLength\s*=\s*0\n  \}/)?.[0] ?? ''
    expect(flushBody, 'flushPendingToSlot not found').not.toBe('')
    expect(
      flushBody,
      'new sources must connect through masterGain so barge-in can mute them',
    ).toMatch(/src\.connect\(\s*masterGain\s*\?/)
    expect(
      flushBody,
      'flushPendingToSlot must reset masterGain to 1 so a muted playback graph does not silence the new turn',
    ).toMatch(/masterGain\.gain\.setValueAtTime\(\s*1\s*,/)

    // 4. `stopPlayback` must set the master gain to 0 BEFORE stopping
    //    individual sources — that ordering is what guarantees the user
    //    hears silence the instant they speak, not after the queued
    //    sources have all drained.
    const stopBody = source.match(/function stopPlayback[\s\S]*?nextPlayTime\s*=\s*0\n  \}/)?.[0] ?? ''
    expect(stopBody, 'stopPlayback not found').not.toBe('')
    const muteIdx = stopBody.indexOf('masterGain.gain.setValueAtTime(0')
    // Anchor on the actual loop that calls src.stop(), not the prose
    // mention in the leading comment block.
    const srcStopIdx = stopBody.search(/for\s*\(\s*const\s+src\s+of\s+scheduledSources[\s\S]*?src\.stop\(\)/)
    expect(muteIdx, 'stopPlayback must mute the master gain to 0').toBeGreaterThan(-1)
    expect(srcStopIdx, 'stopPlayback must still stop individual sources in a loop').toBeGreaterThan(-1)
    expect(
      muteIdx < srcStopIdx,
      'master gain must be muted BEFORE the scheduledSources loop, otherwise the user hears the queued tail',
    ).toBe(true)
  })
})

describe('omni-realtime camera frame wiring', () => {
  // Regression guard for the "camera opens but the model never sees the
  // user" bug: the camera stream used to be a local preview only. Frames
  // must now travel client composable → FastAPI handler → proxy →
  // `input_image_buffer.append` upstream, with DashScope's documented
  // constraints (raw base64 JPEG, audio-first) respected.
  const proxy = `${PY_APP}/omni_realtime_proxy.py`
  const handler = `${PY_APP}/main.py`

  it('proxy exposes send_image and forwards input_image_buffer.append', () => {
    const source = readFileSync(proxy, 'utf8')
    expect(source).toMatch(/async def send_image\(/)
    expect(source).toContain('input_image_buffer.append')
    // the browser canvas.toDataURL payload must be normalized to raw base64
    expect(source).toMatch(/startswith\(["']data:["']\)/)
    // DashScope requires at least one audio append before any image frame
    expect(source).toMatch(/_audio_seen/)
  })

  it('FastAPI handler relays client image frames to the proxy', () => {
    const source = readFileSync(handler, 'utf8')
    expect(source).toMatch(/mtype\s*==\s*["']image["']/)
    expect(source).toContain('proxy.send_image')
  })

  it('proxy enforces audio-before-image per commit cycle, not just per session', () => {
    // Regression guard for the "append image before append audio" error:
    // DashScope clears the audio + image buffers on every
    // `input_audio_buffer.commit` (VAD auto-commit at end-of-utterance) and
    // requires a fresh audio append before each subsequent image frame. The
    // session-level `_audio_seen` guard cannot catch a camera frame that
    // lands in the post-commit window, so the proxy must additionally track
    // audio freshness since the last commit and drop those frames locally.
    const source = readFileSync(proxy, 'utf8')

    // 1. A per-commit freshness flag, reset by default.
    expect(source).toMatch(/self\._audio_appended_since_commit\s*=\s*False/)

    // 2. send_audio re-arms it (fresh audio appended) right after _audio_seen.
    expect(source).toMatch(/self\._audio_seen\s*=\s*True\r?\n\s*self\._audio_appended_since_commit\s*=\s*True/)

    // 3. send_image consults it before forwarding.
    expect(source).toMatch(/if\s+not\s+self\._audio_appended_since_commit:/)

    // 4. The upstream event pump resets it on buffer lifecycle events
    //    (speech_started / speech_stopped / committed / cleared).
    expect(source).toMatch(/input_audio_buffer\.(?:speech_started|speech_stopped|committed|cleared)[\s\S]{0,1000}_audio_appended_since_commit\s*=\s*False/)
  })

  it('useOmniRealtime exposes sendImage and sends the image control frame', () => {
    const source = readFileSync(`${CLIENT_SRC}/composables/useOmniRealtime.ts`, 'utf8')
    expect(source).toMatch(/function sendImage\(/)
    expect(source).toMatch(/type:\s*['"]image['"]/)
    // the returned object must expose it so components can call omni.sendImage
    expect(source).toMatch(/sendImage,/)
  })

  it('OmniRealtimeStage captures camera frames as JPEG and sends them to the model', () => {
    const source = readFileSync(`${CLIENT_SRC}/components/hermes/chat/OmniRealtimeStage.vue`, 'utf8')
    // frames must be sampled from the live preview video into a canvas…
    expect(source).toContain('ctx.drawImage(video')
    // …encoded as JPEG (DashScope only accepts JPG/JPEG)…
    expect(source).toMatch(/toDataURL\(['"]image\/jpeg['"]/)
    // …and pushed through the composable to the WS
    expect(source).toContain('omni.sendImage(')
    // capture must be started once the session is live and stopped on teardown
    expect(source).toContain('startFrameCapture()')
    expect(source).toContain('stopFrameCapture()')
  })

  it('cameraActive i18n key exists in every locale', () => {
    const locales = [
      'zh', 'en', 'zh-TW', 'fr', 'ru', 'ar', 'es', 'ko', 'de', 'ja', 'pt',
    ]
    for (const locale of locales) {
      const source = readFileSync(
        `${CLIENT_SRC}/i18n/locales/${locale}.ts`,
        'utf8',
      )
      expect(
        source,
        `${locale}.ts omniRealtime block missing cameraActive`,
      ).toMatch(/cameraActive:/)
    }
  })
})

describe('omni-realtime server response-lifecycle gating', () => {
  // Regression guard for the "Conversation already has an active response"
  // upstream rejection. DashScope emits response.function_call_arguments.done
  // (which we translate to a client `function_call`) BEFORE it emits
  // response.done for the same turn. Firing response.create immediately
  // races with the still-active response; the proxy must therefore observe
  // the response lifecycle and gate response-creating actions.
  const proxy = `${PY_APP}/omni_realtime_proxy.py`

  it('proxy tracks response.active on created and clears it on done/cancelled', () => {
    const source = readFileSync(proxy, 'utf8')
    expect(source).toContain('_response_active')
    expect(source).toContain('_response_done_event')
    expect(source).toMatch(/response\.created[\s\S]{0,200}_response_active\s*=\s*True/)
    expect(source).toMatch(/response\.(?:done|cancelled)[\s\S]{0,200}_response_active\s*=\s*False/)
  })

  it('send_tool_output waits for the in-flight response to drain', () => {
    const source = readFileSync(proxy, 'utf8')
    // _await_response_done must be called inside send_tool_output before
    // the response.create is sent upstream.
    const methodBody = source.match(/async def send_tool_output[\s\S]*?async def _await_response_done/)
    expect(methodBody, 'send_tool_output method body missing').not.toBeNull()
    const body = methodBody![0]
    const gateIdx = body.indexOf('_await_response_done')
    const createIdx = body.indexOf('"type": "response.create"')
    expect(gateIdx, 'send_tool_output must gate on _await_response_done').toBeGreaterThan(-1)
    expect(createIdx, 'send_tool_output must send response.create').toBeGreaterThan(-1)
    expect(
      gateIdx < createIdx,
      '_await_response_done must run BEFORE response.create is sent upstream',
    ).toBe(true)
  })

  it('commit_audio also gates on the in-flight response', () => {
    const source = readFileSync(proxy, 'utf8')
    const methodBody = source.match(/async def commit_audio[\s\S]*?async def send_tool_output/)
    expect(methodBody, 'commit_audio method body missing').not.toBeNull()
    const body = methodBody![0]
    const gateIdx = body.indexOf('_await_response_done')
    const commitIdx = body.indexOf('"type": "input_audio_buffer.commit"')
    expect(gateIdx, 'commit_audio must gate on _await_response_done').toBeGreaterThan(-1)
    expect(commitIdx, 'commit_audio must send input_audio_buffer.commit').toBeGreaterThan(-1)
    expect(
      gateIdx < commitIdx,
      '_await_response_done must run BEFORE input_audio_buffer.commit is sent upstream',
    ).toBe(true)
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

/**
 * Realtime → Hermes Agent function-calling integration surface.
 *
 * Source-text guardrails so the wiring cannot drift silently:
 *   - The new client tool `query_hermes_agent` is declared in the OpenAI-Realtime
 *     flat format (matches what Qwen Omni Realtime models, both 3041584 and
 *     2880812, accept via session.update).
 *   - The client executor posts to the server route registered by
 *     `realtime-agent.ts`.
 *   - The server route is mounted before the proxy catch-all (see routes/index.ts)
 *     so it can never be shadowed by a generic 404 fallback.
 *   - The server controller drives Hermes Agent through `AgentBridgeClient` and
 *     carries the agent graceful-failure heuristic that already protects
 *     `meeting-asr/agent-bridge.ts` from surfacing provider errors as replies.
 */
describe('omni-realtime Hermes Agent function-calling integration', () => {
  it('omni-tools declares query_hermes_agent in the OpenAI-Realtime flat format', () => {
    const source = readFileSync(
      'packages/client/src/api/hermes/omni-tools.ts',
      'utf8',
    )
    expect(source).toContain("name: 'query_hermes_agent'")
    expect(source).toContain("type: 'function'")
    // The description must mention the runtime path (Hermes Agent + MCP / skills /
    // terminal / filesystem) so the realtime model knows when to call it.
    expect(source).toMatch(/query_hermes_agent[\s\S]{0,800}Hermes Agent/)
  })

  it('omni-tools executor posts to /api/hermes/realtime/agent-query', () => {
    const source = readFileSync(
      'packages/client/src/api/hermes/omni-tools.ts',
      'utf8',
    )
    expect(source).toContain('/api/hermes/realtime/agent-query')
    expect(source).toMatch(/fetch\(\s*'\/api\/hermes\/realtime\/agent-query'/)
    // Failure path must surface upstream error string instead of dropping it.
    expect(source).toMatch(/payload\?\.ok === false/)
  })

  it('server routes/hermes/realtime-agent.ts exports the new route', () => {
    const source = readFileSync(
      'packages/server/src/routes/hermes/realtime-agent.ts',
      'utf8',
    )
    expect(source).toContain('realtimeAgentRoutes.post(\'/api/hermes/realtime/agent-query\'')
    expect(source).toContain('ctrl.queryAgent')
  })

  it('routes/index.ts registers realtimeAgentRoutes after meetingStorageRoutes (before proxy catch-all)', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    const meetingIdx = source.indexOf('meetingStorageRoutes.routes()')
    const realtimeIdx = source.indexOf('realtimeAgentRoutes.routes()')
    expect(meetingIdx).toBeGreaterThan(-1)
    expect(realtimeIdx).toBeGreaterThan(-1)
    // Mounted after the meeting-storage routes (and the catch-all proxy lives
    // even later in this file); the relative order is the invariant that
    // prevents the catch-all from shadowing the realtime route.
    expect(realtimeIdx).toBeGreaterThan(meetingIdx)
  })

  it('realtime-agent controller drives Hermes Agent through AgentBridgeClient', () => {
    const source = readFileSync(
      'packages/server/src/controllers/hermes/realtime-agent.ts',
      'utf8',
    )
    expect(source).toContain("await import('../../services/hermes/agent-bridge/client')")
    expect(source).toContain('new AgentBridgeClient')
    // The agent graceful-failure heuristic must be reused so provider errors
    // do not leak back as success replies.
    expect(source).toContain('looksLikeStandaloneAgentFailure')
    // Output is hard-capped before crossing the WS boundary.
    expect(source).toMatch(/MAX_OUTPUT_CHARS\s*=\s*\d/)
  })

  it('useOmniRealtime forwards the tools array to the proxy (no shape munging)', () => {
    const source = readFileSync(
      'packages/client/src/composables/useOmniRealtime.ts',
      'utf8',
    )
    // The start frame must include the OpenAI-Realtime-flat `tools` array.
    expect(source).toMatch(/tools:\s*options\.tools/)
    // Function-call completion is wired to the user-provided executor and the
    // result is posted back via the OpenAI-Realtime shape (`tool_result` →
    // `function_call_output` + `response.create`, done in the Python proxy).
    expect(source).toMatch(/type:\s*'tool_result'/)
    expect(source).toMatch(/await options\.onToolCall\(name, argsJson\)/)
  })
})

/**
 * Caption + history + new-chat regressions the user reported on the Realtime
 * dialog page. Each test guards one user-visible invariant so a future
 * refactor cannot silently re-introduce the bug.
 */
describe('OmniRealtimeStage UI regressions', () => {
  it('caption no longer clamps to 2 lines', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/OmniRealtimeStage.vue',
      'utf8',
    )
    // The old `-webkit-line-clamp: 2` silently truncated every assistant reply.
    expect(source).not.toMatch(/-webkit-line-clamp:\s*2/)
    // New caption must wrap on its own and remain scrollable after ~10 lines.
    expect(source).toContain('white-space: pre-wrap')
    expect(source).toMatch(/max-height:\s*\d/)
  })

  it('right-side tool-call panel renders cards with state + duration', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/OmniRealtimeStage.vue',
      'utf8',
    )
    // Per the user's redesign: function calling no longer shows a list of
    // cards — it shows a single inline pill (spinner while running, checkmark
    // + result snippet once done). The card-panel class names must be gone
    // so a future refactor cannot silently bring back the old UI.
    expect(source).not.toMatch(/omni-stage__tools(?!\s*--|\s*-)/)
    expect(source).not.toContain('toolCallCards')
    expect(source).not.toContain('omni-stage__tool-state')
    expect(source).not.toContain('toolDurationSeconds')
    expect(source).toContain('omni-stage__tool-inline')
    expect(source).toContain('latestToolCall')
    expect(source).toContain('toolInlineResult')
  })

  it('setup card centers voice + camera + start button', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/OmniRealtimeStage.vue',
      'utf8',
    )
    // The setup card must center its children — left-aligned looked
    // asymmetric on wide viewports.
    expect(source).toMatch(/omni-stage__card\s*\{[^}]*align-items:\s*center/)
    expect(source).toMatch(/omni-stage__setup\s*\{[^}]*margin:\s*0\s+auto/)
    expect(source).toMatch(/omni-stage__field\s*\{[^}]*align-items:\s*center/)
  })

  it('persists tool calls and turns incrementally into the active session', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/chat/OmniRealtimeStage.vue',
      'utf8',
    )
    expect(source).toContain('writtenTurnIds')
    expect(source).toContain('writtenToolCallIds')
    expect(source).toContain('toolCallToMessage')
    expect(source).toContain('flushPendingPersistence')
    // Final flush must run from BOTH endSession and the unmount path so the
    // transcript survives page navigation away from the dialog.
    expect(source.match(/flushPendingPersistence\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('newChatWithRemoteCreate drives confirmNewChat realtime branch', () => {
    const panel = readFileSync(
      'packages/client/src/components/hermes/chat/ChatPanel.vue',
      'utf8',
    )
    expect(panel).toContain('newChatWithRemoteCreate')
    // The realtime drawer entry must use the persisted remote path. The
    // function bodies are split across the file (confirmNewChat passes
    // `{ persistRemote: true }`, and openOmniRealtime wires that flag to
    // newChatWithRemoteCreate), so the regex matches the whole file.
    expect(panel).toMatch(/persistRemote:\s*true/)
    expect(panel).toMatch(/openOmniRealtime\(\s*\{\s*createFresh:\s*true,\s*persistRemote:\s*true/)
  })

  it('realtime drawer exposes a Flash vs Plus model picker', () => {
    const panel = readFileSync(
      'packages/client/src/components/hermes/chat/ChatPanel.vue',
      'utf8',
    )
    // Both Qwen-Omni-Realtime model ids must appear in the drawer template.
    expect(panel).toContain('qwen3.5-omni-flash-realtime')
    expect(panel).toContain('qwen3.5-omni-plus-realtime')
    // The picker must be wired to the realtime model store on confirm so
    // OmniRealtimeStage reads the user's choice on connect.
    expect(panel).toMatch(/realtimeModelStore\.updateConfig\(\s*\{\s*model:\s*newChatRealtimeModel\.value/)
  })
})

