import { qwenSpeechJson, qwenSpeechUrl, speechSignal } from '../qwen-speech'
import { cleanTtsText, clampTtsText } from './text'
import type { CloudTtsProviderOptions, TtsProvider } from './types'

export const qwenTtsProvider: TtsProvider<CloudTtsProviderOptions> = {
  id: 'qwen',
  async synthesize(req, options) {
    const text = clampTtsText(cleanTtsText(req.text))
    if (!text) throw new Error('Qwen TTS text is empty')
    const signal = speechSignal(req.signal, req.timeoutMs)
    const result = await qwenSpeechJson(qwenSpeechUrl(options.baseUrl, 'tts'), options.apiKey || '', {
      model: options.model || 'qwen3-tts-flash', input: {
        text, voice: options.voice || 'Cherry', language_type: options.language || 'Auto',
      },
    }, signal)
    const rawUrl = result.output?.audio?.url
    if (typeof rawUrl !== 'string') throw new Error('Qwen TTS returned no audio URL')
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.aliyuncs.com')) {
      throw new Error('Qwen TTS returned an unsupported audio URL')
    }
    // Signed result URLs authenticate themselves; never forward the API key.
    const response = await fetch(url, { signal, redirect: 'error' })
    if (!response.ok) throw new Error(`Qwen TTS audio download returned HTTP ${response.status}`)
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body as any) {
      size += chunk.length
      if (size > 20 * 1024 * 1024) throw new Error('Qwen TTS audio exceeds 20 MiB')
      chunks.push(chunk)
    }
    const audio = Buffer.concat(chunks)
    if (!audio.length) throw new Error('Qwen TTS returned empty audio')
    return { audio, contentType: response.headers.get('content-type')?.split(';')[0] || 'audio/wav', engine: 'qwen', provider: 'qwen' }
  },
}
