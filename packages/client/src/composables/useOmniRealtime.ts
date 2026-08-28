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

import { ref, shallowRef, computed, onUnmounted } from 'vue'
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
}

/**
 * Same wire constants as `omni_realtime_proxy.py`. Hard-coded rather than
 * fetched at runtime so the client doesn't need an extra handshake round-trip.
 */
const TARGET_SAMPLE_RATE = 24000

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

  // --- playback queue ----------------------------------------------------
  // AI audio arrives as a stream of binary PCM16 frames; we keep appending
  // to the AudioBuffer of the next "slot" and when the current slot finishes
  // we move to the next. This avoids per-chunk glitches (no decodeAudioData
  // round-trip) at the cost of a single fixed latency (~chunk size).

  interface PlaybackSlot {
    buffer: AudioBuffer
    source: AudioBufferSourceNode | null
    startedAt: number
    scheduledEnd: number
  }
  let playbackCtx: AudioContext | null = null
  let pendingSamples: Float32Array | null = null
  let pendingLength = 0
  let currentSlot: PlaybackSlot | null = null
  let nextPlayTime = 0

  function flushPendingToSlot(): void {
    if (!playbackCtx) return
    if (!pendingSamples || pendingLength === 0) return
    const buf = playbackCtx.createBuffer(1, pendingLength, TARGET_SAMPLE_RATE)
    // slice() (not subarray()) so the copied view is ArrayBuffer-backed —
    // copyToChannel requires Float32Array<ArrayBuffer> on TS 5.7+ typed arrays.
    buf.copyToChannel(pendingSamples.slice(0, pendingLength), 0, 0)
    const slot: PlaybackSlot = {
      buffer: buf,
      source: null,
      startedAt: playbackCtx.currentTime,
      scheduledEnd: 0,
    }
    if (!currentSlot) {
      // nothing currently playing — schedule immediately
      const src = playbackCtx.createBufferSource()
      src.buffer = buf
      src.connect(playbackCtx.destination)
      const t = Math.max(playbackCtx.currentTime, nextPlayTime)
      src.start(t)
      slot.source = src
      slot.startedAt = t
      slot.scheduledEnd = t + buf.duration
      nextPlayTime = slot.scheduledEnd
      src.onended = () => {
        if (currentSlot === slot) currentSlot = null
      }
    } else {
      // queue behind the current slot
      const t = Math.max(playbackCtx.currentTime, nextPlayTime)
      const src = playbackCtx.createBufferSource()
      src.buffer = buf
      src.connect(playbackCtx.destination)
      src.start(t)
      slot.source = src
      slot.startedAt = t
      slot.scheduledEnd = t + buf.duration
      nextPlayTime = slot.scheduledEnd
      src.onended = () => {
        if (currentSlot === slot) currentSlot = null
      }
    }
    currentSlot = slot
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
    if (currentSlot?.source) {
      try { currentSlot.source.stop() } catch { /* already stopped */ }
    }
    currentSlot = null
    pendingSamples = null
    pendingLength = 0
    nextPlayTime = 0
  }

  // --- transcript handling ----------------------------------------------

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
    liveAssistantText.value = ''
  }

  function handleServerEvent(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        phase.value = 'ready'
        break
      case 'listening':
        phase.value = 'listening'
        break
      case 'speech_stopped':
        // back to ready — server VAD has closed the user's turn
        phase.value = phase.value === 'speaking' ? 'speaking' : 'ready'
        break
      case 'response_started':
        phase.value = 'speaking'
        break
      case 'response_done':
        flushPendingToSlot()
        phase.value = 'ready'
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

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: false },
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
  }

  // --- lifecycle ---------------------------------------------------------

  async function connect(opts: { model?: string; voice?: string; instructions?: string } = {}): Promise<void> {
    if (ws) return
    phase.value = 'connecting'
    errorMessage.value = ''
    turns.value = []
    liveUserText.value = ''
    liveAssistantText.value = ''

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
      }))
    }

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const view = new Int16Array(event.data)
        appendPcmChunk(view)
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
    stopCapture()
    stopPlayback()
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
    inputLevel,
    isPushing,
    isReady,
    connect,
    disconnect,
    pushStart,
    pushStop,
    abortResponse,
    clearHistory,
  }
}

export type OmniRealtime = ReturnType<typeof useOmniRealtime>
