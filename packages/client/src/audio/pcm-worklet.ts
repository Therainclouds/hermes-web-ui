/// <reference lib="webworker" />

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
 */

// The AudioWorklet global types are not exposed in the project's default TS
// lib set. Declare the minimum surface we need rather than pulling in a full
// DOM lib for a single worker file.
declare const sampleRate: number
interface AudioWorkletNodeOptions {
  numberOfInputs?: number
  numberOfOutputs?: number
  outputChannelCount?: number[]
  processorOptions?: unknown
}
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

class PCMProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
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

export {}