/**
 * 报告生成错误归一化：把 provider / SDK / agent bridge 抛出的原始错误字符串
 * 映射到 i18n key。提取成纯函数以便单测覆盖，并保证组件代码里不掺杂匹配逻辑。
 *
 * 返回值：i18n key，由调用方 t(...) 翻译。
 *
 * 命中顺序自上而下（更具体的优先）。新增类型时同时在三类 locale 文件里加 key。
 */
export type ReportErrorKey =
  | 'meeting.reportPanel.errorBothFailed'
  | 'meeting.reportPanel.errorAgentUnavailable'
  | 'meeting.reportPanel.errorAgentFailed'
  | 'meeting.reportPanel.errorLLMStreamInterrupted'
  | 'meeting.reportPanel.errorLLMNetwork'
  | 'meeting.reportPanel.errorEmptyStream'
  | 'meeting.reportPanel.errorGeneric'

// 两路（agent + direct LLM）都失败的合并错误——服务器端兜底抛出的最终异常。
const BOTH_FAILED_PATTERN = /ReportStreamBothFailed|agent:.*\|.*fallback:/i

// Hermes Agent bridge 不可达 / 未启动 / 启动失败（用户系统层面问题，非 provider 问题）。
const AGENT_UNAVAILABLE_PATTERN =
  /\bAgentBridge\b|bridge not (?:available|running|reachable)|bridge_pool|EAI_AGAIN|ECONNREFUSED.*bridge|socket.*(?:bridge|unix)/i

// Agent path 自己抛错（非 LLM 提供商问题，而是 agent 内部工具/技能/memory 出错）。
const AGENT_FAILED_PATTERN = /\bagent\b.*(?:failed|error|exception)|AIAgent\b|tool_call.*(?:failed|error)/i

// LLM 流被中途切断（典型：provider SSE 关闭未发送 finish_reason）。
const LLM_STREAM_INTERRUPTED_PATTERN =
  /empty stream.*no finish_reason|stream ended unexpectedly|stream.*reset|stream.*closed|finish_reason.*missing/i

// LLM 网络层问题（DNS / TCP / TLS / HTTP 4xx-5xx）。
const LLM_NETWORK_PATTERN =
  /\b(?:ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|HTTPError|429|5\d\d)\b|timeout.*(?:llm|provider|api)|status code (?:4|5)\d\d/i

// 向后兼容：旧的空流模式（在 LLM_STREAM_INTERRUPTED 下重新覆盖一遍）。
const EMPTY_STREAM_PATTERN = LLM_STREAM_INTERRUPTED_PATTERN

export function classifyReportError(rawMessage: string): ReportErrorKey {
  if (BOTH_FAILED_PATTERN.test(rawMessage)) return 'meeting.reportPanel.errorBothFailed'
  if (AGENT_UNAVAILABLE_PATTERN.test(rawMessage)) return 'meeting.reportPanel.errorAgentUnavailable'
  if (AGENT_FAILED_PATTERN.test(rawMessage) && !LLM_STREAM_INTERRUPTED_PATTERN.test(rawMessage)) {
    return 'meeting.reportPanel.errorAgentFailed'
  }
  if (LLM_NETWORK_PATTERN.test(rawMessage)) return 'meeting.reportPanel.errorLLMNetwork'
  if (EMPTY_STREAM_PATTERN.test(rawMessage)) return 'meeting.reportPanel.errorLLMStreamInterrupted'
  // 兼容老报告脚本里未明确分类的「empty stream」直引。
  return 'meeting.reportPanel.errorGeneric'
}

// 显式导出旧 key 别名，老测试可继续引用。
export const REPORT_ERROR_EMPTY_STREAM_KEY = 'meeting.reportPanel.errorEmptyStream' as const
export const REPORT_ERROR_GENERIC_KEY = 'meeting.reportPanel.errorGeneric' as const
