export type ModelProviderErrorKind =
  | 'billing_required'
  | 'auth_invalid'
  | 'quota_exceeded'
  | 'unknown'

export interface ModelProviderErrorInfo {
  kind: ModelProviderErrorKind
  rawMessage: string
}

const BILLING_PATTERNS = [
  /\b(?:401|402|403|429)\b[\s\S]{0,120}\b(?:billing|payment|credit|quota|balance|subscription|insufficient_balance)\b/i,
  /\b(?:billing|payment|credit|quota|balance|subscription|insufficient_balance)\b[\s\S]{0,120}\b(?:401|402|403|429)\b/i,
  /(?:欠费|余额不足|额度不足|请充值|账单异常|订阅失效|已停用计费)/i,
]

const AUTH_PATTERNS = [
  /\b(?:401|403)\b[\s\S]{0,120}\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b/i,
  /\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b[\s\S]{0,120}\b(?:401|403)\b/i,
  /(?:认证失败|鉴权失败|密钥无效|apikey 无效|api key 无效)/i,
]

const QUOTA_PATTERNS = [
  /\b429\b[\s\S]{0,120}\b(?:rate limit|too many requests|quota)\b/i,
  /\b(?:rate limit|too many requests|quota)\b[\s\S]{0,120}\b429\b/i,
  /(?:限流|请求过多)/i,
]

function normalizeMessage(input: unknown): string {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim()
  if (input == null) return ''
  if (typeof input !== 'object') return String(input).trim()
  try {
    return JSON.stringify(input)
  } catch {
    return String(input).trim()
  }
}

export function classifyModelProviderError(input: unknown): ModelProviderErrorInfo | null {
  const rawMessage = normalizeMessage(input)
  if (!rawMessage) return null

  if (BILLING_PATTERNS.some((pattern) => pattern.test(rawMessage))) {
    return { kind: 'billing_required', rawMessage }
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(rawMessage))) {
    return { kind: 'auth_invalid', rawMessage }
  }
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(rawMessage))) {
    return { kind: 'quota_exceeded', rawMessage }
  }

  return null
}
