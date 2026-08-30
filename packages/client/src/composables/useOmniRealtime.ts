/**
 * Omni-Realtime client composable.
 *
 * Wraps the `/ws/omni-realtime` WebSocket exposed by the meeting backend
 * (which itself proxies DashScope's `qwen3.5-omni-flash-realtime` model)
 * and handles:
 *
 *   - Audio capture: microphone → Float32 → resample to 24 kHz → Int16 PCM →
 *     binary WebSocket frames.
 *   - Audio playback: binary WebSocket frames (raw PCM16 @ 24 kHz) → scheduled
 *     into a Web Audio buffer that plays through the default output device.
 *   - Conversation transcript rendering via server-emitted JSON events.
 *
 * The DashScope audio format on the wire is fixed at 24 kHz / 16-bit / mono —
 * matching `omni_realtime_proxy.SAMPLE_RATE`. We resample on both ends so
 * that the user-facing AudioContext can run at whatever rate the browser
 * picked (typically 44.1 / 48 kHz).
 */

import { ref, shallowRef, computed, onUnmounted, watch } from 'vue'
import { getApiKey } from '@/api/client'

export type OmniRealtimePhase =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'   // server VAD says user is speaking
  | 'speaking'    // AI is streaming audio back
  | 'error'
  | 'closed'

export interface OmniDialogTurn {
  /** 'user' for mic input, 'assistant' for AI responses. */
  role: 'user' | 'assistant'
  /** Final transcript text (post-ASR for user, post-LLM for assistant). */
  text: string
  /** Streaming build-up of the current turn (cleared on commit). */
  partial: string
  /** Epoch ms of when this turn started. */
  timestamp: number
}

export interface UseOmniRealtimeOptions {
  /** Push-to-talk release handler — UI fires this to commit audio & request reply. */
  onTurnCommitted?: (text: string) => void
  onError?: (message: string) => void
  /**
   * Hands-free mode: mic audio streams continuously (server VAD owns turn
   * detection) instead of waiting for push-to-talk gating.
   */
  handsFree?: boolean
  /**
   * Auto barge-in: when the server VAD hears the user while the assistant is
   * still talking, stop local playback and cancel the in-flight response.
   */
  autoBargeIn?: boolean
  /**
   * Function-calling tools (OpenAI-Realtime flat format) sent with the start
   * frame; the proxy writes them into session.update.
   */
  tools?: Array<Record<string, unknown> | { type: 'function'; name: string; description: string; parameters: unknown }>
  /**
   * Client-side executor for model-initiated function calls. The returned
   * string is sent back upstream as the tool output.
   */
  onToolCall?: (name: string, argsJson: string) => Promise<string> | string
}

/**
 * Same wire constants as `omni_realtime_proxy.py`. Hard-coded rather than
 * fetched at runtime so the client doesn't need an extra handshake round-trip.
 */
const TARGET_SAMPLE_RATE = 24000

/**
 * Local barge-in: the upstream server VAD takes 100–300 ms to emit
 * `listening`, during which the AI audio keeps playing and the user
 * perceives the interrupt as broken. To make the response feel real-time we
 * additionally trigger `maybeBargeIn` directly off the local mic input
 * peak — once it crosses this threshold we stop AI audio immediately and
 * send the upstream cancel in parallel.
 *
 * AEC is enabled in `getUserMedia`, so the residual echo from the AI's own
 * playback sits well below this value during normal speaker volume; normal
 * speech comfortably exceeds it. Raise this number if you see echo-driven
 * self-interrupt loops on a particular platform; lower it if the user has
 * to speak loudly before the AI yields.
 */
const LOCAL_BARGE_IN_THRESHOLD = 0.15
/**
 * Debounce window after a local barge-in so a single loud echo frame
 * doesn't trigger a second interrupt while the AI is still tearing down.
 */
const LOCAL_BARGE_IN_DEBOUNCE_MS = 600

/**
 * Resample a Float32 buffer from `sourceSampleRate` to `targetSampleRate`
 * using linear interpolation. Quality is adequate for speech-to-text
 * purposes; the upstream model itself does the heavy lifting on features.
 */
function resampleLinear(input: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  if (sourceSampleRate === targetSampleRate) return input
  const ratio = sourceSampleRate / targetSampleRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = i * ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(input.length - 1, lo + 1)
    const frac = srcIdx - lo
    out[i] = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac
  }
  return out
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = (pcm[i] ?? 0) / (pcm[i]! < 0 ? 0x8000 : 0x7fff)
  }
  return out
}

export function useOmniRealtime(options: UseOmniRealtimeOptions = {}) {
  const phase = ref<OmniRealtimePhase>('idle')
  const errorMessage = ref('')
  /** Sorted transcript of completed turns (user + assistant). */
  const turns = ref<OmniDialogTurn[]>([])
  /** Per-role live build-up, cleared whenever the upstream emits a *done* event. */
  const liveUserText = ref('')
  const liveAssistantText = ref('')
  /** Name of the function call currently being executed (empty otherwise). */
  const activeTool = ref('')

  const isReady = computed(() => phase.value === 'ready' || phase.value === 'listening' || phase.value === 'speaking')
  const isPushing = shallowRef(false)

  // --- internals ---------------------------------------------------------

  let ws: WebSocket | null = null
  let audioContext: AudioContext | null = null
  let micStream: MediaStream | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let workletNode: AudioWorkletNode | null = null
  let analyser: AnalyserNode | null = null
  let inputLevelRaf: number | null = null
  const inputLevel = ref(0)
  /** Timestamp of the last locally-triggered barge-in (used for debounce). */
  let lastLocalBargeInAt = 0
  /** Consecutive frames the mic peak has stayed above the barge-in threshold. */
  let bargeInStreak = 0

  // --- playback queue ----------------------------------------------------
  // AI audio arrives as a stream of binary PCM16 frames; we keep appending
  // to the AudioBuffer of the next "slot" and when the current slot finishes
  // we move to the next. This avoids per-chunk glitches (no decodeAudioData
  // round-trip) at the cost of a single fixed latency (~chunk size).

  let playbackCtx: AudioContext | null = null
  let masterGain: GainNode | null = null
  let pendingSamples: Float32Array | null = null
  let pendingLength = 0
  /** All scheduled-but-not-yet-ended playback sources; cleared on barge-in. */
  const scheduledSources = new Set<AudioBufferSourceNode>()
  /**
   * Reactive count of sources that have been scheduled but not yet finished
   * playing. Exposed as `isOutputPlaying` so the UI can tell the difference
   * between "phase flipped back to ready" (upstream done sending audio) and
   * "all queued audio has actually finished playing through the speakers".
   */
  const playingSourceCount = ref(0)
  const isOutputPlaying = computed(() => playingSourceCount.value > 0)
  let nextPlayTime = 0
  /**
   * True between sending `{type:"cancel"}` upstream and the upstream
   * confirming the response is finished (`response.done` /
   * `response.cancelled`). During that window any binary audio frame that
   * arrives belongs to the *cancelled* response — if we let it through,
   * `flushPendingToSlot()` schedules a fresh `AudioBufferSourceNode` and
   * the user hears the tail of the old audio overlap with the new reply.
   * We drop those frames here and resume normal playback on the
   * confirmation event.
   */
  let droppingAssistantAudio = false

  /**
   * Once the last queued audio source finishes playing through the
   * speakers, the assistant's subtitle text is no longer useful — clear it
   * so the caption falls through to the next state. Without this watch,
   * `commitAssistantTurn` clears `liveAssistantText` on the upstream
   * `transcript` event, which fires well before the audio actually drains,
   * so the user sees the subtitles vanish mid-playback.
   */
  watch(isOutputPlaying, (playing) => {
    if (!playing) {
      liveAssistantText.value = ''
    }
  })

  /**
   * Lazily build a playback AudioContext and resume it. We do this inside the
   * user gesture that opened the session so the first binary frame can play
   * without a `NotAllowedError` from the browser autoplay policy. Returns
   * `null` when Web Audio is unavailable (e.g. SSR / unsupported browser) —
   * callers must then drop the audio silently.
   */
  async function ensurePlaybackContext(): Promise<AudioContext | null> {
    if (playbackCtx) return playbackCtx
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    playbackCtx = new Ctor()
    // All assistant sources route through this gain node rather than
    // straight to `destination`, so barge-in can mute the playback graph
    // instantly with a single `gain.value = 0` — far more reliable than
    // calling `src.stop()` on every queued source and waiting for the
    // audio destination to drain its render-quantum buffer.
    masterGain = playbackCtx.createGain()
    masterGain.gain.value = 1
    masterGain.connect(playbackCtx.destination)
    if (playbackCtx.state === 'suspended') {
      try { await playbackCtx.resume() } catch { /* ignore — will be surfaced on play() */ }
    }
    return playbackCtx
  }

  function flushPendingToSlot(): void {
    if (!playbackCtx) return
    if (!pendingSamples || pendingLength === 0) return
    const buf = playbackCtx.createBuffer(1, pendingLength, TARGET_SAMPLE_RATE)
    // slice() (not subarray()) so the copied view is ArrayBuffer-backed —
    // copyToChannel requires Float32Array<ArrayBuffer> on TS 5.7+ typed arrays.
    buf.copyToChannel(pendingSamples.slice(0, pendingLength), 0, 0)
    const src = playbackCtx.createBufferSource()
    src.buffer = buf
    src.connect(masterGain ?? playbackCtx.destination)
    // Restore master gain to 1 in case a previous barge-in muted it.
    if (masterGain) {
      masterGain.gain.cancelScheduledValues(playbackCtx.currentTime)
      masterGain.gain.setValueAtTime(1, playbackCtx.currentTime)
    }
    const t = Math.max(playbackCtx.currentTime, nextPlayTime)
    src.start(t)
    nextPlayTime = t + buf.duration
    scheduledSources.add(src)
    playingSourceCount.value += 1
    src.onended = () => {
      if (scheduledSources.delete(src)) {
        playingSourceCount.value = Math.max(0, playingSourceCount.value - 1)
      }
    }
    pendingSamples = null
    pendingLength = 0
  }

  function appendPcmChunk(pcm16: Int16Array): void {
    const samples = int16ToFloat32(pcm16)
    if (!pendingSamples || pendingSamples.length < pendingLength + samples.length) {
      const grown = new Float32Array(Math.max(pendingLength + samples.length, pendingSamples?.length ?? 0, pendingLength + samples.length))
      if (pendingSamples) grown.set(pendingSamples.subarray(0, pendingLength))
      pendingSamples = grown
    }
    pendingSamples.set(samples, pendingLength)
    pendingLength += samples.length
  }

  function stopPlayback(): void {
    // Mute the entire playback graph first — this is the only way to get
    // an audible "instant silence" the moment the user barges in. Just
    // calling `src.stop()` on each scheduled source leaves the speaker
    // output buffer draining for one render quantum (~3 ms at 48 kHz) which
    // compounds to ~50–100 ms of perceptible old-audio tail across a
    // long-ish reply. Setting `masterGain.gain.value = 0` cuts the signal
    // path immediately; `flushPendingToSlot` resets it back to 1 on the
    // next turn's first chunk.
    if (masterGain && playbackCtx) {
      masterGain.gain.cancelScheduledValues(playbackCtx.currentTime)
      masterGain.gain.setValueAtTime(0, playbackCtx.currentTime)
    }
    for (const src of scheduledSources) {
      try { src.stop() } catch { /* already stopped */ }
    }
    scheduledSources.clear()
    // Reset the count immediately; the `onended` handlers from `src.stop()`
    // will fire and find an empty set (the `delete` returns false), so they
    // won't double-decrement.
    playingSourceCount.value = 0
    pendingSamples = null
    pendingLength = 0
    nextPlayTime = 0
  }

  // --- transcript handling ----------------------------------------------

  /**
   * Barge-in: the user started speaking while the assistant was still
   * talking. Drop queued/playing assistant audio and cancel the upstream
   * response so the model can listen and re-answer.
   */
  function maybeBargeIn(): void {
    if (!options.autoBargeIn) return
    // `phase` flips back to 'ready' the moment upstream emits `response_done`,
    // which is well before the last queued buffer finishes playing through
    // the speakers. Gating on `phase === 'speaking'` alone therefore misses
    // the user speaking during that tail-drain window — the most common
    // interrupt moment — and the AI keeps talking over them. Barge-in must
    // also fire whenever audio is *actually* playing (`isOutputPlaying`).
    if (!isOutputPlaying.value && phase.value !== 'speaking') return
    stopPlayback()
    // A cancelled response never emits a final `transcript` event, so drop
    // the partial build-up instead of leaving it dangling.
    liveAssistantText.value = ''
    // During the tail-drain window the upstream response has already fully
    // drained — there is nothing left to cancel, and `response.cancel` with
    // no active response can surface an upstream error. Silence the local
    // playback graph only; the user's turn will create a fresh response.
    if (phase.value !== 'speaking') return
    droppingAssistantAudio = true
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
    }
  }

  function commitUserTurn(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    turns.value.push({ role: 'user', text: trimmed, partial: '', timestamp: Date.now() })
    liveUserText.value = ''
    options.onTurnCommitted?.(trimmed)
  }

  function commitAssistantTurn(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    turns.value.push({ role: 'assistant', text: trimmed, partial: '', timestamp: Date.now() })
    // Note: `liveAssistantText` is intentionally NOT cleared here — the
    // final transcript arrives BEFORE the audio drains, and we want the
    // caption to keep showing the subtitles until playback actually ends.
    // The `watch(isOutputPlaying, ...)` above clears it once the last
    // scheduled source finishes playing through the speakers.
  }

  /** Execute a model-initiated function call locally and return the output upstream. */
  async function handleFunctionCall(msg: { [k: string]: unknown }): Promise<void> {
    const callId = String(msg.call_id ?? '')
    const name = String(msg.name ?? '')
    if (!callId || !name) return
    const argsJson = typeof msg.arguments === 'string' ? msg.arguments : '{}'

    let output: string
    if (!options.onToolCall) {
      output = JSON.stringify({ error: '该会话未配置工具执行器' })
    } else {
      activeTool.value = name
      try {
        output = await options.onToolCall(name, argsJson)
      } catch (cause) {
        output = JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        activeTool.value = ''
      }
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'tool_result', call_id: callId, output }))
    } catch { /* ignore — the socket is closing */ }
  }

  function handleServerEvent(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        phase.value = 'ready'
        break
      case 'listening':
        maybeBargeIn()
        phase.value = 'listening'
        break
      case 'speech_stopped':
        // back to ready — server VAD has closed the user's turn
        phase.value = phase.value === 'speaking' ? 'speaking' : 'ready'
        break
      case 'response_started':
        phase.value = 'speaking'
        // A new response is beginning upstream — any audio still playing or
        // queued belongs to the previous (already-finished) response. Cut it
        // now: `flushPendingToSlot` schedules each chunk at
        // `Math.max(currentTime, nextPlayTime)`, so without this the new
        // reply's audio chains behind the old tail and the user hears the
        // previous segment while the subtitles already show the new one.
        stopPlayback()
        // Start the new turn with a clean caption. The watch on
        // `isOutputPlaying` already clears `liveAssistantText` once the
        // previous turn's audio finishes, but in the gap between turns
        // (or for text-only responses where no audio is ever scheduled)
        // we need an explicit reset here.
        liveAssistantText.value = ''
        break
      case 'response_done':
        flushPendingToSlot()
        phase.value = 'ready'
        // The cancelled response has fully drained upstream — any binary
        // audio frame from now on belongs to the next turn.
        droppingAssistantAudio = false
        break
      case 'user_transcript':
        commitUserTurn(String(msg.text ?? ''))
        break
      case 'transcript_delta':
        liveAssistantText.value = (liveAssistantText.value || '') + String(msg.text ?? '')
        break
      case 'transcript':
        commitAssistantTurn(String(msg.text ?? ''))
        break
      case 'function_call':
        void handleFunctionCall(msg)
        break
      case 'error': {
        const m = String(msg.message ?? 'unknown error')
        errorMessage.value = m
        phase.value = 'error'
        options.onError?.(m)
        break
      }
      case 'stopped':
        phase.value = 'closed'
        break
      case 'pong':
        break
      default:
        break
    }
  }

  // --- capture -----------------------------------------------------------

  async function ensureCaptureContext(): Promise<AudioContext> {
    if (audioContext) return audioContext
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioContext = new Ctor({ sampleRate: 48000 })
    // The worklet source rate is whatever AudioContext picked; we resample
    // to 24 kHz in the message handler below.
    await audioContext.audioWorklet.addModule('/audio/pcm-worklet.js')
    return audioContext
  }

  async function startCapture(): Promise<void> {
    if (micStream) return
    const ctx = await ensureCaptureContext()
    if (ctx.state === 'suspended') await ctx.resume()

    // Browser-level acoustic echo cancellation MUST stay on: the assistant's
    // TTS audio is played through `playbackCtx.destination` (the system
    // speakers) right next to the mic, and without AEC the upstream VAD
    // hears that echo as a new user turn, triggers a `listening` event,
    // and we cancel our own playback in a self-interrupting loop.
    // We deliberately keep NS / AGC off so the Omni model still gets raw
    // input for downstream processing — AEC is the only constraint we need.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    })

    micSource = ctx.createMediaStreamSource(micStream)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 256

    workletNode = new AudioWorkletNode(ctx, 'pcm-processor')
    micSource.connect(analyser)
    analyser.connect(workletNode)
    // do NOT connect to destination — would echo.

    workletNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sourceSampleRate: number }>) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !isPushing.value) return
      const { samples, sourceSampleRate } = event.data
      const resampled = resampleLinear(samples, sourceSampleRate, TARGET_SAMPLE_RATE)
      const int16 = float32ToInt16(resampled)
      // int16.buffer types as ArrayBufferLike (SharedArrayBuffer possible on
      // generic typed arrays); WebSocket.send only accepts ArrayBuffer, and we
      // always allocate fresh buffers here, so the cast is safe.
      ws.send(int16.buffer as ArrayBuffer)
    }

    // visual feedback: simple peak level derived from analyser
    const buf = new Uint8Array(analyser.frequencyBinCount)
    const tick = (): void => {
      if (!analyser) return
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i += 1) {
        const v = Math.abs(((buf[i] ?? 128) - 128) / 128)
        if (v > peak) peak = v
      }
      inputLevel.value = peak
      // Client-side barge-in: the upstream server VAD takes 100–300 ms to
      // emit `listening`, during which the AI audio keeps playing and the
      // user perceives the interrupt as "broken". Trigger `maybeBargeIn`
      // directly off the local mic input peak so the response feels
      // real-time. AEC is enabled above so the residual echo after the
      // AI's own playback is well below `LOCAL_BARGE_IN_THRESHOLD`; we
      // still require the peak to clear the threshold for several
      // consecutive frames (hysteresis) so a single loud echo frame can't
      // start a self-interrupt loop.
      if (peak >= LOCAL_BARGE_IN_THRESHOLD) {
        bargeInStreak += 1
      } else {
        bargeInStreak = 0
      }
      if (
        bargeInStreak >= 3
        && options.autoBargeIn
        // Same tail-drain caveat as `maybeBargeIn`: `phase` is already
        // 'ready' while the last queued buffer still plays, so the local
        // peak must also gate on real playback, not just phase.
        && (isOutputPlaying.value || phase.value === 'speaking')
        && performance.now() - lastLocalBargeInAt > LOCAL_BARGE_IN_DEBOUNCE_MS
      ) {
        lastLocalBargeInAt = performance.now()
        bargeInStreak = 0
        maybeBargeIn()
      }
      inputLevelRaf = requestAnimationFrame(tick)
    }
    inputLevelRaf = requestAnimationFrame(tick)
  }

  function stopCapture(): void {
    if (inputLevelRaf !== null) {
      cancelAnimationFrame(inputLevelRaf)
      inputLevelRaf = null
    }
    if (workletNode) {
      try { workletNode.disconnect() } catch { /* ignore */ }
      workletNode = null
    }
    if (micSource) {
      try { micSource.disconnect() } catch { /* ignore */ }
      micSource = null
    }
    if (analyser) {
      try { analyser.disconnect() } catch { /* ignore */ }
      analyser = null
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop())
      micStream = null
    }
    if (audioContext) {
      audioContext.close().catch(() => { /* ignore */ })
      audioContext = null
    }
    inputLevel.value = 0
    // Reset client-side barge-in state so a fresh capture session starts
    // with a clean slate (and so a loud echo tail across a stop/start
    // cycle can't fire a spurious interrupt).
    bargeInStreak = 0
    lastLocalBargeInAt = 0
  }

  // --- lifecycle ---------------------------------------------------------

  async function connect(opts: { model?: string; voice?: string; instructions?: string } = {}): Promise<void> {
    if (ws) return
    phase.value = 'connecting'
    errorMessage.value = ''
    turns.value = []
    liveUserText.value = ''
    liveAssistantText.value = ''
    activeTool.value = ''
    // Reset client-side barge-in bookkeeping for the new session.
    bargeInStreak = 0
    lastLocalBargeInAt = 0
    droppingAssistantAudio = false

    const apiKey = getApiKey()
    // Browsers can't set Authorization on a WS handshake directly, so we let
    // the WS upgrade go through and rely on the Node proxy. Auth is enforced
    // upstream via the api-key middleware.
    void apiKey

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws/omni-realtime`
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      // Hands-free: stream mic audio as soon as the capture worklet is up;
      // the server VAD decides when a turn starts/ends.
      if (options.handsFree) isPushing.value = true
      // Pre-arm the playback AudioContext inside this user-gesture tick so the
      // first binary frame can be scheduled without an autoplay rejection.
      void ensurePlaybackContext()
      try {
        startCapture().catch(err => {
          errorMessage.value = String((err as Error).message ?? err)
          phase.value = 'error'
          options.onError?.(errorMessage.value)
        })
      } catch (err) {
        errorMessage.value = String((err as Error).message ?? err)
        phase.value = 'error'
      }
      ws?.send(JSON.stringify({
        type: 'start',
        model: opts.model,
        voice: opts.voice,
        instructions: opts.instructions,
        tools: options.tools,
      }))
    }

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // Drop the tail of any cancelled response: upstream keeps emitting
        // audio deltas for a few frames after `response.cancel` lands, and
        // without this guard the user hears the old reply overlap the new
        // one (the freshly-flushed source starts immediately rather than
        // waiting behind the now-stopped-but-still-decoding tail).
        if (droppingAssistantAudio) return
        const view = new Int16Array(event.data)
        appendPcmChunk(view)
        // Flush every chunk so the user hears the model as it streams rather
        // than a single buffered blast after `response_done` — the queue
        // (`nextPlayTime` + `scheduledSources`) chains slots back-to-back.
        flushPendingToSlot()
        return
      }
      try {
        const msg = JSON.parse(event.data)
        handleServerEvent(msg)
      } catch (err) {
        console.warn('[omni-realtime] failed to parse event', err)
      }
    }

    ws.onerror = () => {
      // The browser doesn't expose the actual error; surface a generic one.
      errorMessage.value = 'Realtime session error'
      phase.value = 'error'
      options.onError?.(errorMessage.value)
    }

    ws.onclose = () => {
      stopCapture()
      stopPlayback()
      if (playbackCtx) {
        playbackCtx.close().catch(() => { /* ignore */ })
        playbackCtx = null
      }
      masterGain = null
      ws = null
      if (phase.value !== 'error') phase.value = 'closed'
    }
  }

  function disconnect(): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'stop' })) } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (ws) {
        try { ws.close() } catch { /* ignore */ }
        ws = null
      }
    }, 100)
    isPushing.value = false
    stopCapture()
    stopPlayback()
    if (playbackCtx) {
      playbackCtx.close().catch(() => { /* ignore */ })
      playbackCtx = null
    }
    masterGain = null
    phase.value = 'closed'
  }

  /** Begin streaming mic audio upstream. */
  function pushStart(): void {
    isPushing.value = true
  }

  /** Stop streaming mic audio and ask the model to reply. */
  function pushStop(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      isPushing.value = false
      return
    }
    isPushing.value = false
    try { ws.send(JSON.stringify({ type: 'commit' })) } catch { /* ignore */ }
  }

  /**
   * Toggle the upstream mic feed without committing a turn (hands-free mute).
   * Unlike `pushStop`, no `commit` control frame is sent.
   */
  function setMicStreaming(active: boolean): void {
    isPushing.value = active
  }

  /** Stop assistant playback and cancel the in-flight response (manual barge-in). */
  function interrupt(): void {
    stopPlayback()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
  }

  /**
   * Send one JPEG camera frame to the model.
   *
   * Accepts either a full `data:image/jpeg;base64,...` data URL (what
   * `canvas.toDataURL` produces) or raw base64 — the server strips the
   * prefix before forwarding as `input_image_buffer.append`. Frames are
   * dropped silently while the socket is not open.
   *
   * DashScope constraints: JPG/JPEG only, ≤256 KB base64, ~1 fps
   * recommended, and audio must already be streaming (hands-free capture
   * starts on `ws.onopen`, so this holds for this app).
   */
  function sendImage(image: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!image) return
    const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image
    if (!payload) return
    // Debug aid for the camera pipeline: confirm frames leave the browser.
    // Open DevTools → Console to see one line per frame while the camera is on.
    console.debug(`[omni-realtime] camera frame sent (${payload.length} base64 chars)`)
    try { ws.send(JSON.stringify({ type: 'image', image: payload })) } catch { /* ignore */ }
  }

  function abortResponse(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
  }

  function clearHistory(): void {
    turns.value = []
    liveUserText.value = ''
    liveAssistantText.value = ''
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    phase,
    errorMessage,
    turns,
    liveUserText,
    liveAssistantText,
    activeTool,
    inputLevel,
    isPushing,
    isReady,
    isOutputPlaying,
    connect,
    disconnect,
    pushStart,
    pushStop,
    setMicStreaming,
    interrupt,
    abortResponse,
    clearHistory,
    sendImage,
  }
}

export type OmniRealtime = ReturnType<typeof useOmniRealtime>
