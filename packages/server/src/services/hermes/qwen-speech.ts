/** DashScope speech uses multimodal APIs, not OpenAI audio/speech. */
export function qwenSpeechUrl(baseUrl: string | undefined, kind: 'asr' | 'tts'): URL {
  const url = new URL(baseUrl || 'https://dashscope.aliyuncs.com')
  const trusted = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com']
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      (!trusted.includes(url.hostname) && !/^[a-zA-Z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname))) {
    throw new Error('Qwen speech baseUrl must be an official DashScope HTTPS endpoint')
  }
  url.pathname = kind === 'asr' ? '/compatible-mode/v1/chat/completions' : '/api/v1/services/aigc/multimodal-generation/generation'
  url.search = ''; url.hash = ''
  return url
}

export async function qwenSpeechJson(url: URL, apiKey: string, body: unknown, signal: AbortSignal): Promise<any> {
  if (!apiKey?.trim()) throw new Error('Qwen speech API key is required; save a key in this profile’s Realtime model settings')
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal, redirect: 'error',
  })
  // Do not echo upstream bodies, credentials, or signed audio URLs into logs.
  if (!response.ok) throw new Error(`Qwen speech returned HTTP ${response.status}`)
  const result = await response.json()
  if (result.code) throw new Error('Qwen speech rejected the request')
  return result
}

export function speechSignal(signal?: AbortSignal, timeoutMs = 60000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
