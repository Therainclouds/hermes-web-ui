export const OPENROUTER_APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/tangledup-ai/hermes-web-ui',
  'X-OpenRouter-Title': 'Quanthermes Web UI',
  'X-OpenRouter-Categories': 'cli-agent,personal-agent',
} as const

export function openRouterAttributionHeaders(baseUrl: string, provider?: string): Record<string, string> {
  let hostname = ''
  try { hostname = new URL(baseUrl).hostname.toLowerCase() } catch { /* Provider ID may identify a proxy. */ }
  const providerId = provider?.trim().toLowerCase().replace(/^custom[:_]/, '')
  if (hostname !== 'openrouter.ai' && !hostname.endsWith('.openrouter.ai') && providerId !== 'openrouter') return {}
  return { ...OPENROUTER_APP_HEADERS }
}
