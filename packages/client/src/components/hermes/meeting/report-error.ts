/**
 * 报告生成错误归一化：把 provider / SDK 抛出的原始错误字符串映射到 i18n key。
 * 提取成纯函数以便单测覆盖，并保证组件代码里不掺杂匹配逻辑。
 *
 * 返回值：i18n key，由调用方 t(...) 翻译。
 */
export type ReportErrorKey =
  | 'meeting.reportPanel.errorEmptyStream'
  | 'meeting.reportPanel.errorGeneric'

const EMPTY_STREAM_PATTERN = /empty stream.*no finish_reason|stream ended unexpectedly|stream.*reset|stream.*closed/i

export function classifyReportError(rawMessage: string): ReportErrorKey {
  if (EMPTY_STREAM_PATTERN.test(rawMessage)) {
    return 'meeting.reportPanel.errorEmptyStream'
  }
  return 'meeting.reportPanel.errorGeneric'
}
