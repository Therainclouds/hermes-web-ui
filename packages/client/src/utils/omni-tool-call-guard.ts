/**
 * Omni-Realtime 工具调用护栏（纯函数，无副作用，便于单测）。
 *
 * 背景：realtime（OmniRealtimeStage / SpeechPracticeStage）的 function
 * calling 曾出现「query_hermes_agent 参数 {} → {"error": "question 必填"}」
 * 风暴——模型反复用空参数调用同一个工具，每次失败后重试，形成死循环：
 *   - 上游（DashScope Omni-Realtime 兼容层 / Python 代理）偶尔把工具参数
 *     以 JSON 对象而非 JSON 字符串下发，或先发一个带空 arguments 的占位
 *     事件（conversation.item.created）而把真正带参的
 *     response.function_call_arguments.done 当作重复丢弃 → 客户端收到的
 *     永远是 `{}`；
 *   - 客户端把非字符串 arguments 一律当成 `{}` 执行 → 必填参数（question）
 *     缺失报错 → 模型认为自己明明给了参数却失败，于是重复调用 → 每次都
 *     触发一轮新 response，TTS 发声被反复打断。
 *
 * 本模块在客户端兜底：
 *   1. normalizeToolArguments —— 对象参数重新字符串化，不再退化成 `{}`；
 *   2. missingRequiredArgs —— 按下发到模型的工具 schema 校验必填参数，
 *      缺参的调用不执行（返回明确错误），让模型带着完整参数重新提问；
 *   3. 连续 N 次相同坏参数调用 → 判定无效重试循环，返回「停止重试」指令。
 */

/** 同一个工具 + 完全相同参数连续失败多少次后判定为死循环、不再执行。 */
export const MAX_MALFORMED_CALL_STREAK = 3

export interface OmniToolLike {
  type?: unknown
  name?: unknown
  parameters?: { required?: unknown; properties?: Record<string, unknown> }
}

/**
 * 把上游 function_call 事件里的 `arguments` 字段规整成 JSON 字符串。
 *
 * OpenAI-Realtime 的线协议里 arguments 是 JSON 字符串；DashScope 的
 * Omni-Realtime 兼容层偶尔直接给对象。对象必须重新 JSON.stringify，
 * 否则调用方把非字符串当作 `{}`，模型明明给了 question 也会被当成空参
 * 调用执行 → 报「question 必填」→ 模型重试 → 死循环。
 */
export function normalizeToolArguments(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || '{}'
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '{}'
    }
  }
  return '{}'
}

/**
 * 解析工具参数字符串为对象；空串视为 {}；非法 JSON / 非对象返回 null。
 */
export function parseToolArgsJson(argsJson: string): Record<string, unknown> | null {
  if (!argsJson || !argsJson.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(argsJson)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * 对照下发给模型（options.tools，扁平 OpenAI-Realtime 格式）的工具 schema，
 * 返回缺失 / 为空的必填参数名列表。schema 没声明 required 时返回 []。
 */
export function missingRequiredArgs(
  tools: readonly unknown[] | undefined,
  name: string,
  parsed: Record<string, unknown>,
): string[] {
  const def = (tools || []).find(tool =>
    tool && typeof tool === 'object' && (tool as OmniToolLike).name === name,
  ) as OmniToolLike | undefined
  const required = Array.isArray(def?.parameters?.required)
    ? (def.parameters.required as unknown[])
    : []
  const missing: string[] = []
  for (const key of required) {
    const raw = parsed[String(key)]
    const empty = typeof raw === 'string'
      ? raw.trim() === ''
      : raw === undefined || raw === null
    if (empty) missing.push(String(key))
  }
  return missing
}
