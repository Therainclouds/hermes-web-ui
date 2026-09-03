/**
 * 实时对话（Omni-Realtime）instructions 组合工具。
 *
 * 实时对话的人格来自当前激活 profile 的 SOUL.md（经 /api/hermes/memory 下发），
 * 在其上叠加语音场景行为约束与工具使用守则。纯函数、无副作用，便于单测。
 *
 * 拼接顺序（沿用 RealtimeDialogPanel 的 `——` 分隔符风格）：
 *   {soul} → {实时补充指令} → {工具守则} → 可选 {历史摘要} / {会议上下文}
 *   → 可选 {场景块（scenario，追加在最末，优先级最高）}
 */

/** SOUL.md 注入上限（与 omni-tools 中 per-section 记忆上限 1500 一致）。 */
export const SOUL_LIMIT = 1500
/** 历史摘要注入上限（字符）。 */
export const HISTORY_LIMIT = 3000
/** 已用音频轮次达到模型上限该比例时提示接近上下文极限。 */
export const CONTEXT_WARNING_RATIO = 0.8
/** 历史回注最多携带的消息条数。 */
export const HISTORY_MAX_MESSAGES = 20

/** SOUL.md 为空（未配置人格）时的回落人格。 */
export const DEFAULT_SOUL_FALLBACK =
  '你是 Quanta，贯穿用户工作台的中文语音助手。回答口语化、简洁自然，适合直接朗读。'

/** 语音场景行为约束（叠加在人格之后，无论 soul 是否存在都生效）。 */
const REALTIME_SUPPLEMENT = [
  '——',
  '实时对话补充指令（优先级高于人格描述中的输出格式要求）：',
  '- 你的回复将通过语音直接朗读：请用简洁、自然、口语化的中文回答（除非用户明确使用其他语言），不要使用 Markdown 标记（标题 / 列表 / 代码块）。',
  '- 回答控制在两三句话以内，除非用户明确要求详细说明。',
  '- 你可以调用的工具以下发给你的工具列表为准，不要引用人格描述中提到的其他工具或技能名称。',
  // 用户反馈（realtime agent 模式）：此前这里笼统地禁用 query_hermes_agent，
  // 与下方 TOOL_REFERENCE / TOOL_RULES 的「涉及工具操作必须调用 query_hermes_agent」
  // 直接冲突——模型在「该不该调用」之间摇摆，结果是用空参数反复调用同一个工具
  // （query_hermes_agent {} → question 必填 → 重试风暴），每次重试都是一轮新
  // response，发声被反复打断。Agent 模式的本意就是语音驱动真实工作台能力，因此
  // 改为「可以用，但只做一问一答式短查询」：调用必须带完整 question；只有
  // 文件/写盘/长任务这类产物给不到语音里的操作才引导回文字对话页，而不是空转。
  '- 用户要求真实操作（查内存/端口占用、读目录文件、跑命令、查工作台数据等）时，可以调用 query_hermes_agent：把用户的口语整理成一个具体、完整的问题放进 question 参数（例如「查看这台电脑的内存占用」），一次只问一件事，禁止传空参数；拿到结果后用一两句口语总结关键结论即可。',
  '- 需要「生成文件 / 写工作区 / 跑长任务」这类产物给不到语音里的操作时，不要调用工具空转，直接告诉用户"我这边语音回不来文件，请回文字对话页或到工作区继续"。',
].join('\n')

/** 工具使用守则（原 OmniRealtimeStage.REALTIME_INSTRUCTIONS 的工具段）。 */
const TOOL_REFERENCE = [
  '你可以调用以下工具查询工作台的实时事实：',
  '- query_agent_memory：查询 Agent 的长期记忆（memory 记忆 / user 用户画像 / soul 人格）。',
  '- list_agent_skills / read_skill_detail：查看当前 Agent 已配置的技能及其 SKILL.md。',
  '- list_recent_sessions：查看最近的对话会话列表。',
  '- list_jobs：查看当前的定时任务与自动化任务。',
  '- query_hermes_agent：把一个具体问题丢给后端 Hermes Agent 跑一次，它会用上当前 profile 的 MCP 工具 / 技能 / 终端 / 文件系统等真实能力，再把最终回复文本返回给你。当用户问的问题需要真实工具操作或工作区读取时优先调用它。',
].join('\n')

const TOOL_RULES = [
  '工具使用守则：',
  '1. 涉及工作台数据或工具操作时必须调用工具获取事实，禁止凭空编造。',
  '2. 拿到结果后用口语简短总结关键结论；结果为空或出错时如实说明。',
  '3. 一次只调用一个必要的工具；回答完再考虑是否需要下一个。',
].join('\n')

function truncate(value: string, limit: number, suffix: string): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…${suffix}`
}

/**
 * 组合实时对话的完整 instructions。
 *
 * @param soul 当前激活 profile 的 SOUL.md 内容；空串 / undefined 时回落默认人格
 * @param extras 可选追加块：
 *  - `history`：历史对话摘要（serializeChatHistory 的输出，已有会话切语音 /
 *    断线续聊场景）；
 *  - `meetingContext`：会议上下文（标题 / 时间 / 带时间戳逐字稿，会议侧
 *    实时对话面板注入）。两者语义不同，分别标注，互不混用。
 *  - `scenario`：场景块（如口语对练的行为守则与评分契约），原样追加在
 *    所有既有块之后。调用方负责按场景维护其文案（例如与下发的工具列表
 *    保持一致），本函数不解释其内容。
 */
export function buildRealtimeInstructions(
  soul: string | null | undefined,
  extras: {
    history?: string
    meetingContext?: string
    /** 场景块原文，追加在所有既有块之后；空串/undefined 时不追加。 */
    scenario?: string
  } = {},
): string {
  const baseSoul = (soul || '').trim() || DEFAULT_SOUL_FALLBACK
  const soulSnippet = truncate(baseSoul, SOUL_LIMIT, '（人格描述已截断）')
  const parts = [soulSnippet, REALTIME_SUPPLEMENT, TOOL_REFERENCE, TOOL_RULES]
  const trimmedHistory = (extras.history || '').trim()
  if (trimmedHistory) {
    parts.push(`——\n以下是最近对话的摘要，回答时请结合这些背景：\n${trimmedHistory}`)
  }
  const trimmedContext = (extras.meetingContext || '').trim()
  if (trimmedContext) {
    parts.push(
      '——\n以下是开启本实时对话时所在的会议上下文（逐字稿带时间戳）。请结合这些内容回答，'
      + '不要编造上下文之外的事实；若用户问题与会议无关也可以正常闲聊。\n'
      + trimmedContext,
    )
  }
  const trimmedScenario = (extras.scenario || '').trim()
  if (trimmedScenario) {
    parts.push(`——\n${trimmedScenario}`)
  }
  return parts.join('\n\n')
}

/**
 * 把 chat session 的历史消息序列化为文本摘要（供已有会话切换语音 / 断线续聊时注入）。
 *
 * 只保留 user / assistant 消息（tool 调用记录对实时模型无意义），从最新一条往回
 * 收集直到超过条数或字符预算，输出按时间正序排列。
 */
export function serializeChatHistory(
  messages: Array<{ role: string; content: string }>,
  options: { maxMessages?: number; maxChars?: number } = {},
): string {
  const maxMessages = options.maxMessages ?? HISTORY_MAX_MESSAGES
  const maxChars = options.maxChars ?? HISTORY_LIMIT
  const eligible = (messages || []).filter(m =>
    (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim(),
  )
  const picked: string[] = []
  let used = 0
  for (let i = eligible.length - 1; i >= 0 && picked.length < maxMessages; i -= 1) {
    const m = eligible[i]!
    const line = `${m.role === 'user' ? '[用户]' : '[助手]'}: ${m.content.trim().replace(/\s+/g, ' ')}`
    if (used + line.length > maxChars && picked.length > 0) break
    picked.unshift(line)
    used += line.length + 1
  }
  return truncate(picked.join('\n'), maxChars, '（更早的对话已省略）')
}

/**
 * 实时对话已完成的用户轮次数（近上限告警只计 user 轮次——DashScope 的
 * audioTurns 按一次发言计数，turns 数组里 user/assistant 各占一条）。
 */
export function countUserTurns(turns: Array<{ role: 'user' | 'assistant' }>): number {
  return (turns || []).filter(t => t.role === 'user').length
}
