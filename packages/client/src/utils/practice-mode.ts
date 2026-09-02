/**
 * 口语对练模式（speech-practice）纯函数工具集。
 *
 * 口语对练 = Chat 侧实时语音对话（Omni-Realtime 通道）的一个专用场景：
 *   - 用户在「新建对话」选择口语对练并手动填写练习方向；
 *   - 会话按 `buildRealtimeInstructions(soul, { scenario })` 下发对练守则，
 *     模型每一轮用户发言后调用 `submit_practice_feedback` 工具提交结构化打分；
 *   - 客户端把逐轮打分累积成练习数据，结束时用 `buildPracticeReportMarkdown`
 *     生成确定性 Markdown 分析报告。
 *
 * 本模块保持纯函数、无副作用，便于单元测试；工具列表常量见
 * `api/hermes/omni-tools.ts`（PRACTICE_REALTIME_TOOLS）。
 */

export type PracticeLanguage = 'zh' | 'en' | 'ja' | 'ko'
export type PracticeDifficulty = 'beginner' | 'intermediate' | 'advanced'

export interface PracticeSessionConfig {
  /** 练习目标语言：教练与用户全程用该语言对练。 */
  language: PracticeLanguage
  /** 手动输入的练习方向（主题 / 场景 / 目标），可留空表示自由对话。 */
  direction: string
  /** 难度档位。 */
  difficulty: PracticeDifficulty
  /** 练习时长（分钟）；0 / undefined = 不限时。设置后倒计时到点自动结束并生成报告。 */
  durationMinutes?: number
}

/** 语言 → 供模型指令/报告使用的中文名（模型指令本身固定为中文，见下方说明）。 */
export const PRACTICE_LANGUAGE_LABELS: Record<PracticeLanguage, string> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
}

export const PRACTICE_DIFFICULTY_LABELS: Record<PracticeDifficulty, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '高级',
}

/** 用户输入方向注入指令前的截断长度。 */
const DIRECTION_LIMIT = 120

/**
 * 口语对练专属教练人格——替代用户 Agent 的 SOUL.md 注入。
 *
 * 用户 SOUL 是「工作台助理」人格（中文回复、记忆/技能/任务行为准则等），
 * 与「目标语言口语教练」直接冲突：人格声明打架会导致教练角色不稳定、
 * 混入助理式行为（主动报工作台状态、用中文长篇解释等）。因此对练场景
 * 不读取 SOUL.md，用这段固定教练人格作为 buildRealtimeInstructions 的
 * soul 位输入；工具守则与历史摘要仍正常叠加。
 */
export const PRACTICE_COACH_SOUL = [
  '你是一名专业、耐心的口语陪练教练，任务是陪用户练习目标语言的口语表达。',
  '你不扮演任何工作台助理人格；除按守则用中文简短解释语法/词汇外，全程使用目标语言交流。',
  '点评具体、诚实、有区分度，善于用提问引导用户持续开口。',
].join('\n')

/**
 * 拼接口语对练场景块（追加在 buildRealtimeInstructions 的 scenario 参数里）。
 *
 * 与 omni-tools.ts 中 `submit_practice_feedback` 工具的 description / 参数
 * 描述保持同一契约——守则文案与工具列表在这里刻意互相引用（仓库既有先例：
 * OmniRealtimeStage 注释「此处守则文案与其保持一致」）。
 *
 * 模型指令文案固定为中文（与 SOUL 兜底人格、工具守则一致的既有做法），
 * 但要求模型实际「说」目标语言；UI 侧对应用户展示走 i18n。
 *
 * @param cameraOn 会话开始时摄像头是否开启。开启时额外要求模型给出
 *   bodyLanguage（肢体语言/仪态）维度评分——模型只在“看得到用户画面”时
 *   才能填该维度，否则一律不填。
 */
export function buildPracticeInstructionBlock(
  config: PracticeSessionConfig,
  options: { cameraOn?: boolean } = {},
): string {
  const languageName = PRACTICE_LANGUAGE_LABELS[config.language] || '目标语言'
  const difficultyName = PRACTICE_DIFFICULTY_LABELS[config.difficulty] || '适中'
  const direction = (config.direction || '').trim().slice(0, DIRECTION_LIMIT)
  const directionLine = direction
    ? `练习方向：${direction}。围绕该方向出题、引导并点评，不要跑题；方向较长时按其主要意图理解。`
    : '练习方向：自由对话。你可以结合用户当前表达内容自然延展话题，引导用户持续开口。'

  const difficultyTips: string[] = []
  if (config.difficulty === 'beginner') {
    difficultyTips.push('说慢一点、句子短一点，多给提示与鼓励，每轮聚焦一个点。')
  }
  if (config.difficulty === 'advanced') {
    difficultyTips.push('使用更地道、更丰富的表达，追问细节，鼓励用户展开论述。')
  }

  // 定时练习：客户端在倒计时结束时会自动结束会话并生成报告；让教练按节奏
  // 分配轮次、在时间过半与最后阶段主动收束，避免被切断在长篇回复中间。
  const durationMinutes = Number(config.durationMinutes) || 0
  const pacingTips: string[] = []
  if (durationMinutes > 0) {
    pacingTips.push(
      `- 本次练习定时 ${durationMinutes} 分钟，到点会自动结束并生成报告：控制节奏，时间过半时用目标语言提醒用户剩余时间。`,
      `- 最后约 1 分钟引导用户做一句整场总结，并在此时调用 submit_practice_feedback 提交收尾评分（overall 视为整场评分），不要开启需要长时间展开的新话题。`,
    )
  }

  const cameraTips: string[] = options.cameraOn
    ? [
        '- 摄像头已开启，你能看到用户的画面：每轮在语言维度之外，还要对肢体语言 / 仪态 / 眼神交流打分'
        + '（submit_practice_feedback 的 bodyLanguage，1-10 整数），并在口头点评或 comment 里给一句相关建议。',
        '- 如果你看不到用户画面（摄像头实际未开启 / 图像中断），一律不要填写 bodyLanguage。',
      ]
    : [
        '- 摄像头未开启，你看不到用户画面：不要填写 bodyLanguage 维度，也不要编造任何关于肢体语言的评价。',
      ]

  // 语言纪律（用户反馈：选了英语却用中文说话时，教练会顺着中文聊跑题）。
  // 放在守则靠前位置并明确给“用户切换语言”的应对动作，避免模型镜像用户语言。
  const languageDiscipline = [
    `- 语言纪律（最重要，任何情况下不得违反）：你只能用${languageName}输出——包括回复、点评、提问、鼓励。`,
    `- 用户用${languageName}以外的语言说话（例如选了英语却说中文）：先用${languageName}说一句简短提醒（表达“我们练的是${languageName}，请用${languageName}再说一遍”）；`
    + `如果用户确实没听懂题目，再用中文简要解释一两句，随后引导用户用${languageName}重说。绝对不要顺着用户的母语整段聊天、脱离对练场景。`,
    '- 用户表示理解不了题目时：用目标语言降速、换更简单的说法示范，而不是放弃目标语言。',
  ].join('\n')

  return [
    '【口语对练模式 · 行为守则（优先级最高，覆盖以上通用约束中与本段冲突的部分，尤其是「默认用中文回答」那条——口语对练必须使用目标语言）】',
    `- 你现在是用户的${languageName}口语陪练教练。${directionLine}`,
    `- 全程使用${languageName}与用户对话（难度：${difficultyName}）。`,
    ...languageDiscipline.split('\n'),
    ...difficultyTips.map(tip => `  - ${tip}`),
    ...cameraTips,
    ...pacingTips,
    '- 每轮用户发言结束后：先用目标语言给出一句话的简短口头点评，然后立刻调用 submit_practice_feedback 提交本轮结构化打分'
    + '（overall 及 fluency / pronunciation / grammar / vocabulary / content，1-10 整数，另附 comment / strengths / improvements / example）。'
    + '打分必须诚实、具体、有区分度——不要每轮都打高分或雷同分数。',
    '- 每轮只聚焦 1-2 个最重要的可提升点，用 example 字段给出更自然、更地道的说法示范。',
    '- 点评之后要继续推进练习：根据练习方向与用户当前水平，提出一个自然的后续问题或小任务，引导用户多说。',
    '- 每 4-6 轮可以自然切换到同方向下的一个小话题，避免长期重复同一问法。',
    '- 当用户说「结束 / 今天先到这里 / 再见」等收尾语时：先用目标语言说一两句整场总结'
    + '（总体表现 + 最值得继续练的一点），再调用 submit_practice_feedback 提交收尾评分'
    + '（此时 overall 视为整场评分，其余维度给整场平均观感），之后不必再提问。',
    '- 上面通用约束里「不要调用 query_hermes_agent」的限制在本模式解除：'
    + '用户的问题若涉及真实工作台 / MCP / 文件系统等操作，先调用工具查证再回答；'
    + '纯口语练习内容不需要调用工具。',
    '- 你的回复会被语音朗读：口语化、可读，不要使用 Markdown 标记；口头点评本身不要逐字重复评分数字。',
  ].join('\n')
}

/** 练习中「一轮」的转写记录（与 useOmniRealtime 的 turns 形状同构）。 */
export interface PracticeTurnRecord {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

/** 模型经 submit_practice_feedback 提交的一轮结构化评分。 */
export interface PracticeFeedbackRecord {
  /** 被点评的用户轮次序号（从 1 起）；无法归属时为 0。 */
  round: number
  overall: number
  fluency: number | null
  pronunciation: number | null
  grammar: number | null
  vocabulary: number | null
  content: number | null
  /** 肢体语言/仪态评分（仅摄像头开启时模型会填；否则为 null）。 */
  bodyLanguage: number | null
  comment: string
  strengths: string
  improvements: string
  example: string
  /** 评分被记录的时间戳。 */
  at: number
}

export interface PracticeReportInput {
  config: PracticeSessionConfig
  startedAt: number
  endedAt: number
  turns: PracticeTurnRecord[]
  feedback: PracticeFeedbackRecord[]
}

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 平均分保留 1 位小数；无有效样本返回 null。 */
function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  const sum = nums.reduce((acc, n) => acc + n, 0)
  return Math.round((sum / nums.length) * 10) / 10
}

function fmtScore(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

function minMax(values: Array<number | null | undefined>): { min: string; max: string } {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return { min: '—', max: '—' }
  return { min: String(Math.min(...nums)), max: String(Math.max(...nums)) }
}

/** 单轮评分记录里的文本字段，去掉首尾空白。 */
function cleanText(value: string | undefined | null): string {
  return (value || '').trim()
}

/**
 * 生成口语对练的 Markdown 分析报告（确定性、无 AI 流式依赖）。
 *
 * 与 utils/speech-export.ts 同款先例：导出文件内部标题固定为中文硬编码，
 * 不参与 UI i18n（导出物是离线阅读文件）。正文内容（点评、示范、转写）由
 * 模型按练习目标语言产出，原样保留。
 */
export function buildPracticeReportMarkdown(input: PracticeReportInput): string {
  const cfg = input.config
  const languageName = PRACTICE_LANGUAGE_LABELS[cfg.language] || cfg.language
  const difficultyName = PRACTICE_DIFFICULTY_LABELS[cfg.difficulty] || cfg.difficulty
  const direction = (cfg.direction || '').trim()

  const userTurns = input.turns.filter(t => t.role === 'user')
  const feedbackByRound = new Map<number, PracticeFeedbackRecord>()
  const unattached: PracticeFeedbackRecord[] = []
  for (const f of input.feedback || []) {
    if (f.round > 0) feedbackByRound.set(f.round, f)
    else unattached.push(f)
  }

  const scoreKeys = ['overall', 'fluency', 'pronunciation', 'grammar', 'vocabulary', 'content'] as const
  const dimensionNames: Record<string, string> = {
    overall: '总分',
    fluency: '流利度',
    pronunciation: '发音语调',
    grammar: '语法准确',
    vocabulary: '词汇表达',
    content: '内容逻辑',
    bodyLanguage: '肢体语言',
  }

  const out: string[] = ['# 🗣️ 口语对练分析报告']
  const durationMinutes = Number(cfg.durationMinutes) || 0
  out.push('', '> 练习语言：' + languageName
    + (direction ? ` ｜ 练习方向：${direction}` : ' ｜ 练习方向：自由对话')
    + ` ｜ 难度：${difficultyName}`
    + (durationMinutes > 0 ? ` ｜ 定时：${durationMinutes} 分钟` : ''))
  out.push('', `> 开始：${fmtDateTime(input.startedAt)} ｜ 结束：${fmtDateTime(input.endedAt)}`
    + ` ｜ 用户发言 ${userTurns.length} 轮 ｜ 已评分 ${feedbackByRound.size + unattached.length} 轮`)

  const validFeedback = [...feedbackByRound.values(), ...unattached]
  const scoredRounds = validFeedback.length
  if (scoredRounds > 0) {
    const withOverall = validFeedback.filter(f => typeof f.overall === 'number')
    const avgOverall = withOverall.length
      ? Math.round((withOverall.reduce((acc, f) => acc + f.overall, 0) / withOverall.length) * 10) / 10
      : null
    out.push('', `## 一、综合评分${avgOverall != null ? `（整场平均 ${avgOverall}/10）` : ''}`, '')
    out.push('| 维度 | 平均 | 最高 | 最低 |', '| --- | --- | --- | --- |')
    const rows: Array<(typeof scoreKeys)[number] | 'bodyLanguage'> = [...scoreKeys]
    // 肢体语言维度只在「至少有一轮填了该分」（摄像头开启时模型才会填）才入表
    if (validFeedback.some(f => f.bodyLanguage != null)) rows.push('bodyLanguage')
    for (const key of rows) {
      const samples = validFeedback.map(f => f[key])
      const avg = average(samples)
      const { min, max } = minMax(samples)
      out.push(`| ${dimensionNames[key]} | ${avg != null ? `${avg}/10` : '—'} | ${max} | ${min} |`)
    }
  }

  if (userTurns.length > 0 || unattached.length > 0) {
    out.push('', '## 二、逐轮点评')
    const rounds: Array<{ user?: PracticeTurnRecord; assistant?: PracticeTurnRecord; feedback?: PracticeFeedbackRecord }> = []
    let userIdx = 0
    // 归并对话：把每条 user 轮次及紧随其后的 assistant 轮次、以及归属该轮的点评拼成一轮。
    for (const turn of input.turns || []) {
      if (turn.role === 'user') {
        userIdx += 1
        rounds.push({ user: turn, feedback: feedbackByRound.get(userIdx) })
      } else if (rounds.length > 0 && !rounds[rounds.length - 1]!.assistant) {
        rounds[rounds.length - 1]!.assistant = turn
      }
    }
    let appendedAny = false
    rounds.forEach((entry, index) => {
      if (!entry.user) return
      const roundNo = index + 1
      const userText = (entry.user.text || '').trim()
      const feedback = entry.feedback
      appendedAny = true
      out.push('', `### 第 ${roundNo} 轮`, '', `**用户：** ${userText}`)
      if (feedback) {
        out.push('', `**评分：** 总分 ${fmtScore(feedback.overall)}/10 ｜ 流利度 ${fmtScore(feedback.fluency)}/10`
          + ` ｜ 发音语调 ${fmtScore(feedback.pronunciation)}/10 ｜ 语法 ${fmtScore(feedback.grammar)}/10`
          + ` ｜ 词汇 ${fmtScore(feedback.vocabulary)}/10 ｜ 内容 ${fmtScore(feedback.content)}/10`
          + (feedback.bodyLanguage != null ? ` ｜ 肢体语言 ${fmtScore(feedback.bodyLanguage)}/10` : ''))
        const comment = cleanText(feedback.comment)
        const strengths = cleanText(feedback.strengths)
        const improvements = cleanText(feedback.improvements)
        const example = cleanText(feedback.example)
        if (comment) out.push('', `**点评：** ${comment}`)
        if (strengths) out.push('', `- ✨ 亮点：${strengths}`)
        if (improvements) out.push('', `- 💡 可提升点：${improvements}`)
        if (example) out.push('', `- ✍️ 更地道的说法：${example}`)
      }
      const assistantText = (entry.assistant?.text || '').trim()
      if (assistantText) out.push('', `**教练：** ${assistantText}`)
    })
    if (!appendedAny && unattached.length === 0) {
      out.push('', '（暂无对话轮次）')
    }
    for (const f of unattached) {
      const comment = cleanText(f.comment)
      out.push('', `### 补充点评（未归属轮次）`, `**评分：** 总分 ${fmtScore(f.overall)}/10`
        + (f.bodyLanguage != null ? ` ｜ 肢体语言 ${fmtScore(f.bodyLanguage)}/10` : ''))
      if (comment) out.push('', `**点评：** ${comment}`)
    }
  }

  if (userTurns.length > 0) {
    out.push('', '## 三、对话记录')
    let userIdx = 0
    for (const turn of input.turns || []) {
      const text = (turn.text || '').trim()
      if (!text) continue
      if (turn.role === 'user') {
        userIdx += 1
        out.push('', `### 第 ${userIdx} 轮 · 用户`, '', text)
      } else {
        out.push('', '**教练：**', '', text)
      }
    }
  }

  if (scoredRounds === 0) {
    out.push('', '## 备注', '', '本次练习没有产生评分（可能过早结束或模型未调用评分工具）。对话记录仍保留在上方。')
  }

  return out.join('\n')
}

/** 报告默认文件名（不含扩展名），如 `口语对练-英语-20240825-1530`。 */
export function practiceReportFileStem(config: PracticeSessionConfig, ts: number): string {
  const languageName = PRACTICE_LANGUAGE_LABELS[config.language] || config.language
  const date = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  const direction = (config.direction || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 20)
  return `口语对练-${languageName}${direction ? `-${direction}` : ''}-${stamp}`
}

/**
 * 练习倒计时显示文本：`mm:ss`，≥ 1 小时时用 `h:mm:ss`。
 * 负数 / 0 一律归零为 `00:00`。纯展示用，便于单测。
 */
export function formatPracticeCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(minutes)}:${pad(seconds)}`
}
