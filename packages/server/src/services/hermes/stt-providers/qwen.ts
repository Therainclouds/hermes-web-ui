import { qwenSpeechJson, qwenSpeechUrl, speechSignal } from '../qwen-speech'
import { SttNoSpeechDetectedError, type SttTranscribeInput, type SttTranscribeResult } from './types'

export async function transcribeQwen(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const started = Date.now()
  const model = input.settings.model || 'qwen3-asr-flash'
  const mime = input.mimeType.split(';')[0]
  if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) throw new Error('Qwen ASR requires an audio MIME type')
  const result = await qwenSpeechJson(qwenSpeechUrl(input.settings.baseUrl, 'asr'), input.secrets.apiKey || '', {
    model, stream: false,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {
      data: `data:${mime};base64,${input.audio.toString('base64')}`,
    } }] }],
    asr_options: { enable_itn: true, ...(input.settings.language ? { language: input.settings.language } : {}) },
  }, speechSignal(input.signal))
  const content = result.choices?.[0]?.message?.content
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text) throw new SttNoSpeechDetectedError('Qwen ASR detected no speech')
  return { text, provider: 'qwen', model, durationMs: Date.now() - started }
}
