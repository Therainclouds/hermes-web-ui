/**
 * PCM AudioWorklet processor for the meeting recorder.
 *
 * Replaces the deprecated ScriptProcessorNode. Runs on the audio rendering
 * thread (off the main UI thread), so it doesn't compete with Vue reactivity
 * or websocket framing for CPU.
 *
 * Each render quantum (~128 frames at the AudioContext sample rate) we post
 * the first channel's Float32 buffer back to the main thread, where the
 * consumer resamples to 16 kHz and converts to Int16 PCM before forwarding
 * to the ASR websocket.
 *
 * IMPORTANT: This file is the compiled JS copy, kept in sync with the TS
 * source at  packages/client/src/audio/pcm-worklet.ts.
 * It lives in public/ so Vite copies it as a static asset, avoiding the
 * build-time data: URL inline problem that breaks CSP with addModule().
 */

class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) {
      return true
    }
    const channel = input[0]
    if (!channel || channel.length === 0) {
      return true
    }
    // Copy — the underlying buffer is reused by the audio thread.
    const copy = new Float32Array(channel.length)
    copy.set(channel)
    this.port.postMessage(
      { samples: copy, sourceSampleRate: sampleRate },
      [copy.buffer],
    )
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
