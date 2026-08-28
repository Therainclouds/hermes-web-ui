import type { Server, Namespace } from 'socket.io'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../logger'
import { getSceneTemplateOrDefault, type SceneTemplate } from './scene-templates'
import { prepareAnalysisSkillSection } from './skill-resolver'
import { getActiveProfileName } from '../hermes/hermes-profile'
import type { AgentBridgeOutput } from '../hermes/agent-bridge/client'

export interface FillerWord {
  word: string
  count: number
  /** 说话人（转写带 [姓名] 标注时尽量带上，做到按发言人区分） */
  speaker?: string
}

export interface GoldenQuote {
  /** 金句原文（定义：有观点、有感染力、能让人记住、可单独引用的一句话） */
  quote: string
  speaker?: string
  reason?: string
}

export interface GrammarIssue {
  quote: string
  issue: string
  speaker?: string
}

export interface AnalysisRound {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  keyPoint: string
  analysis: string
  timestamp: number
  // 演讲评分场景（Toastmasters 风格）附加字段
  fillerWords?: FillerWord[]
  goldenQuotes?: GoldenQuote[]
  grammarIssues?: GrammarIssue[]
  wotdUsed?: boolean
  score?: Record<string, number>
  timeNote?: string
  // 增量评价模式：AI 判断本段是否出现新的评价点
  hasNewPoint?: boolean
  highlights?: string[]       // 新增亮点（仅 hasNewPoint 时可能非空；最多 3 条）
  improvements?: string[]     // 新增可提升的点（最多 1 条：最重要且可落地）
  topics?: string[]           // 新增主题（仅 hasNewPoint 时可能非空）
}

/** 演讲评分场景的评估上下文：随分析批次注入提示词，供 AI 实时点评/评分。 */
export interface SpeechContext {
  wordOfTheDay?: string
  timerDurationSec?: number
  yellowAtSec?: number
  redAtSec?: number
  timerRecords?: Array<{ label: string; durationSec: number; overtimeSec: number }>
  currentRemainingSec?: number
  currentPhase?: 'green' | 'yellow' | 'red'
}

/** 服务端累积的演讲评价摘要：跨批次保留，注入后续提示词，供 AI 判断是否出现新的评价点。 */
interface SpeechSummary {
  highlights: string[]
  improvements: string[]
  topics: string[]
  score?: Record<string, number>
}

interface TranscriptSentence {
  speaker?: string
  text: string
  timestamp?: number
}

interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
}

interface ActiveSession {
  sessionId: string
  sceneTemplate: string
  profile?: string
  speechContext?: SpeechContext | null
  speechSummary?: SpeechSummary
  buffer: TranscriptSentence[]
  timer: NodeJS.Timeout | null
  isAnalyzing: boolean
}

const WINDOW_SIZE = 5
const WINDOW_INTERVAL_MS = 18_000
const NAMESPACE = '/meeting-assist'

/**
 * 各场景下触发 Agent + MCP 工具查询的关键词正则。
 * 匹配到这些信号说明对话涉及需要查询核实的专业内容，值得走慢路径。
 * 未列出的场景（如 general）始终走快速直调路径。
 */
const SCENE_TOOL_TRIGGER: Record<string, RegExp> = {
  legal: /第[\d一二三四五六七八九十百千]+条|第[\d一二三四五六七八九十百千]+款|民法典|刑法|劳动法|合同法|公司法|婚姻法|继承法|物权法|侵权法|司法解释|行政法规|部门规章|地方性法规|诉讼时效|追诉时效|仲裁时效|违约金|赔偿金|经济补偿|劳动报酬|知识产权|专利权|商标权|著作权|担保|抵押|质押|留置|不可抗力|情势变更|正当防卫|紧急避险/,
  business: /合同条款|违约责任|保密协议|竞业禁止|独家代理|排他性|对赌|估值|市盈率|净利润|营收|毛利率|报价|底价|市场价|行业规范|招投标|政府采购|反垄断|商业贿赂|尽职调查|审计|税务|发票|税率/,
  medical: /禁忌|不良反应|相互作用|配伍禁忌|剂量|用量|毫克|mg|毫升|ml|指南|共识|禁忌证|适应证|耐药|过敏|肝肾功能|孕妇|哺乳|儿童用药|药物相互作用|半衰期|血药浓度/,
}

function safeActiveProfileName(): string {
  try {
    return getActiveProfileName()
  } catch {
    return ''
  }
}

class RealtimeAssistService {
  private io: Server | null = null
  private nsp: Namespace | null = null
  private sessions = new Map<string, ActiveSession>()

  init(io: Server): void {
    this.io = io
    this.nsp = io.of(NAMESPACE)

    this.nsp.on('connection', (socket) => {
      logger.info('[meeting-assist] client connected: %s', socket.id)

      socket.on('join', (sessionId: string) => {
        socket.join(`meeting:${sessionId}`)
        logger.info('[meeting-assist] socket %s joined meeting:%s', socket.id, sessionId)
      })

      socket.on('leave', (sessionId: string) => {
        socket.leave(`meeting:${sessionId}`)
      })

      socket.on('disconnect', () => {
        logger.debug('[meeting-assist] client disconnected: %s', socket.id)
      })
    })

    logger.info('[meeting-assist] namespace registered: %s', NAMESPACE)
  }

  async startSession(sessionId: string, sceneTemplate: string, profile?: string, speechContext?: SpeechContext): Promise<void> {
    if (this.sessions.has(sessionId)) {
      logger.info('[meeting-assist] session %s already active, resetting buffer', sessionId)
      this.stopSession(sessionId)
    }

    this.sessions.set(sessionId, {
      sessionId,
      sceneTemplate,
      profile,
      speechContext: speechContext || null,
      buffer: [],
      timer: null,
      isAnalyzing: false,
    })

    logger.info('[meeting-assist] session started: %s (scene: %s, profile: %s)', sessionId, sceneTemplate, profile || '(active)')
  }

  /** 更新会话的演讲评分上下文（计时记录、每日一词等），后续分析批次会带上最新数据。 */
  updateSpeechContext(sessionId: string, speechContext: SpeechContext): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.speechContext = speechContext
  }

  /** 立即触发一次分析（忽略窗口大小/间隔计时），供"开始分析"按钮使用。 */
  flushNow(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    void this.flush(session)
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    session.buffer = []
    this.sessions.delete(sessionId)
    logger.info('[meeting-assist] session stopped: %s', sessionId)
  }

  pushSentence(sessionId: string, sentence: TranscriptSentence): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.buffer.push(sentence)

    // Flush when buffer reaches window size
    if (session.buffer.length >= WINDOW_SIZE) {
      void this.flush(session)
      return
    }

    // Otherwise set/reset interval timer
    if (!session.timer) {
      session.timer = setTimeout(() => {
        session.timer = null
        void this.flush(session)
      }, WINDOW_INTERVAL_MS)
    }
  }

  private async flush(session: ActiveSession): Promise<void> {
    if (session.isAnalyzing) return
    if (session.buffer.length === 0) return

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    const sentences = session.buffer.splice(0)
    session.isAnalyzing = true

    // Notify clients that analysis is in progress
    this.nsp?.to(`meeting:${session.sessionId}`).emit('analyzing', true)

    try {
      const round = await this.analyzeBatch(sentences, session.sceneTemplate, session.profile, session.speechContext, session.speechSummary)
      if (round) {
        // 演讲评分场景：把本轮新增的亮点/改进点/主题/评分累积进会话摘要，供下一批提示词使用
        this.accumulateSpeechSummary(session, round)
        this.nsp?.to(`meeting:${session.sessionId}`).emit('analysis', round)
      }
    } catch (err) {
      logger.error(err, '[meeting-assist] analysis failed for session %s', session.sessionId)
      this.nsp?.to(`meeting:${session.sessionId}`).emit('error', String(err))
    } finally {
      session.isAnalyzing = false
      this.nsp?.to(`meeting:${session.sessionId}`).emit('analyzing', false)
    }
  }

  /** 将本轮演讲评分的新增内容合并进会话摘要（去重），供后续批次判断"是否出现新的评价点"。 */
  private accumulateSpeechSummary(session: ActiveSession, round: AnalysisRound): void {
    if (session.sceneTemplate !== 'speech') return
    const summary = session.speechSummary || { highlights: [], improvements: [], topics: [] }
    const pushUnique = (list: string[] | undefined, target: string[]) => {
      for (const item of list || []) {
        const s = item?.trim()
        if (s && !target.includes(s)) target.push(s)
      }
    }
    pushUnique(round.highlights, summary.highlights)
    pushUnique(round.improvements, summary.improvements)
    pushUnique(round.topics, summary.topics)
    if (round.score && Object.keys(round.score).length > 0) {
      summary.score = round.score
    }
    session.speechSummary = summary
  }

  private async analyzeBatch(
    sentences: TranscriptSentence[],
    sceneTemplateId: string,
    profile?: string,
    speechContext?: SpeechContext | null,
    speechSummary?: SpeechSummary,
  ): Promise<AnalysisRound | null> {
    const template = getSceneTemplateOrDefault(sceneTemplateId)
    const transcriptText = sentences
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')

    const resolvedProfile = (profile || safeActiveProfileName() || 'default').trim() || 'default'

    // 实时提示始终走直调 LLM 快速路径（~3s），不走 Agent。
    // Agent + MCP 工具查询仅用于报告生成（需要真实法条/数据核实的深度分析）。
    return this.analyzeBatchViaDirectLLM(transcriptText, template, resolvedProfile, speechContext, speechSummary)
  }

  /**
   * 判断当前对话内容是否需要走 Agent + MCP 工具路径。
   * 根据场景查找对应的触发正则，未配置的场景始终走快速路径。
   */
  private needsToolLookup(sceneTemplateId: string, transcriptText: string): boolean {
    const re = SCENE_TOOL_TRIGGER[sceneTemplateId]
    if (!re) return false
    return re.test(transcriptText)
  }

  /**
   * 经过 Hermes Agent 进行实时分析，可调用 MCP 工具（如法规查询）。
   * 20s 超时限制，超时或 bridge 不可用时由上层回退到直调 LLM。
   */
  private async analyzeBatchViaAgent(transcriptText: string, template: SceneTemplate, profile: string): Promise<AnalysisRound | null> {
    const { AgentBridgeClient } = await import('../hermes/agent-bridge/client')
    const bridge = new AgentBridgeClient({ connectRetryMs: 1500 })
    const agentSessionId = `meeting-analyze-${Date.now()}`

    try {
      const started = await bridge.chat(
        agentSessionId,
        `以下是最近的对话内容：\n\n${transcriptText}`,
        undefined,
        template.systemPrompt,
        profile,
        { source: 'meeting-asr' },
      )

      let finalText = ''
      for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 20_000 })) {
        if (chunk.delta) finalText += chunk.delta
        if (chunk.done) {
          // 部分 bridge 不增量返回 delta，从 result 提取
          if (!finalText.trim()) {
            const result = chunk.result as { final_response?: string } | undefined
            finalText = result?.final_response || chunk.output || ''
          }
          break
        }
        if (chunk.status === 'error') {
          throw new Error(chunk.error || 'Agent analysis run failed')
        }
      }

      if (!finalText.trim()) throw new Error('Agent analysis produced no output')
      return this.parseAnalysis(finalText)
    } finally {
      void bridge.destroy(agentSessionId, profile).catch(() => {})
    }
  }

  /**
   * 回退路径：直接调用 LLM API 进行实时分析（不经过 Agent）。
   */
  private async analyzeBatchViaDirectLLM(
    transcriptText: string,
    template: SceneTemplate,
    profile: string,
    speechContext?: SpeechContext | null,
    speechSummary?: SpeechSummary,
  ): Promise<AnalysisRound | null> {
    const config = await this.loadLLMConfig()
    if (!config) {
      logger.warn('[meeting-assist] LLM config not available, skipping analysis')
      return null
    }

    // 动态加载 profile 下的会议分析技能并追加到 system prompt。
    const skillSection = await prepareAnalysisSkillSection(profile)
    let systemPrompt = skillSection
      ? `${template.systemPrompt}\n\n${skillSection}`
      : template.systemPrompt

    // 演讲评分场景：把计时记录/每日一词/当前倒计时/已累积评价注入提示词。
    if (template.id === 'speech') {
      const lines: string[] = ['', '【当前演讲评估上下文（请据此点评与评分）】']
      if (speechContext) {
        const ctx = speechContext
        if (ctx.wordOfTheDay) lines.push(`- 每日一词：${ctx.wordOfTheDay}`)
        if (ctx.timerDurationSec) {
          lines.push(`- 计时设置：单环节标准时长 ${ctx.timerDurationSec} 秒；黄牌触发剩余 ${ctx.yellowAtSec ?? 30} 秒；红牌触发剩余 ${ctx.redAtSec ?? 10} 秒`)
        }
        if (ctx.currentRemainingSec != null) {
          lines.push(`- 当前倒计时：剩余 ${Math.round(ctx.currentRemainingSec)} 秒（${ctx.currentPhase || 'green'}）`)
        }
        if (ctx.timerRecords && ctx.timerRecords.length > 0) {
          lines.push('- 已记录环节用时：')
          for (const r of ctx.timerRecords) {
            const overtime = r.overtimeSec > 0 ? `（超时 ${r.overtimeSec} 秒）` : ''
            lines.push(`  - ${r.label}：${r.durationSec} 秒${overtime}`)
          }
        }
      }
      if (speechSummary) {
        if (speechSummary.highlights.length > 0) {
          lines.push(`- 已累积亮点：${speechSummary.highlights.join('；')}`)
        }
        if (speechSummary.improvements.length > 0) {
          lines.push(`- 已累积改进点：${speechSummary.improvements.join('；')}`)
        }
        if (speechSummary.topics.length > 0) {
          lines.push(`- 已出现主题：${speechSummary.topics.join('；')}`)
        }
        if (speechSummary.score && Object.keys(speechSummary.score).length > 0) {
          lines.push(`- 当前评分：${JSON.stringify(speechSummary.score)}`)
        }
      }
      systemPrompt = `${systemPrompt}\n${lines.join('\n')}`
    }

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `以下是最近的对话内容：\n\n${transcriptText}` },
      ],
      temperature: 0.3,
      // 演讲评分场景需要输出评分表/赘语/语法等多字段 JSON，给更大输出空间。
      max_tokens: template.id === 'speech' ? 1200 : 800,
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`)
    }

    const data = await response.json() as any
    const content = data?.choices?.[0]?.message?.content || '{}'

    return this.parseAnalysis(content)
  }

  private parseAnalysis(raw: string): AnalysisRound | null {
    return parseAnalysisResponse(raw)
  }

  /**
   * Generate final report using streaming. Returns an async generator of text chunks.
   *
   * 优先经过 Hermes Agent，这样可以复用用户为该 profile 训练好的系统提示词、技能与记忆；
   * 当 bridge 不可用或尚未产出任何内容时，自动回退到直调 LLM，用户无感知。
   */
  async *generateReportStream(sessionId: string, transcript: string, sceneTemplateId: string, profile?: string): AsyncGenerator<string> {
    const template = getSceneTemplateOrDefault(sceneTemplateId)
    const resolvedProfile = (profile || safeActiveProfileName() || 'default').trim() || 'default'

    let yieldedAny = false
    try {
      for await (const chunk of this.generateReportViaAgent(sessionId, transcript, template, resolvedProfile)) {
        yieldedAny = true
        yield chunk
      }
      return
    } catch (err) {
      // 已经向客户端流出过内容时不能再回退（避免重复输出），原样抛出。
      if (yieldedAny) throw err
      logger.warn('[meeting-assist] agent report path unavailable, falling back to direct LLM: %s', err instanceof Error ? err.message : String(err))
    }

    yield* this.generateReportViaDirectLLM(transcript, template, resolvedProfile)
  }

  /**
   * 经过 Hermes Agent bridge 生成报告，复用用户训练好的 profile（系统提示词 / 技能 / 记忆）。
   * 场景的 reportPrompt 作为任务级 instructions 叠加在用户 agent 之上。
   */
  private async *generateReportViaAgent(sessionId: string, transcript: string, template: SceneTemplate, profile: string): AsyncGenerator<string> {
    const { AgentBridgeClient } = await import('../hermes/agent-bridge/client')
    // 较短的连接重试窗口：bridge 不可用时快速失败，便于上层回退到直调 LLM。
    const bridge = new AgentBridgeClient({ connectRetryMs: 1500 })
    const agentSessionId = `meeting-report-${sessionId}`

    try {
      const started = await bridge.chat(
        agentSessionId,
        `以下是完整的会议转写内容：\n\n${transcript}`,
        undefined,
        template.reportPrompt,
        profile,
        { source: 'meeting-asr' },
      )

      let lastChunk: AgentBridgeOutput | null = null
      let yieldedAny = false
      for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 180_000 })) {
        lastChunk = chunk
        if (chunk.delta) {
          yieldedAny = true
          yield chunk.delta
        }
        if (chunk.done) break
      }

      if (lastChunk?.status === 'error') {
        throw new Error(lastChunk.error || 'Agent report run failed')
      }

      // 部分 bridge/运行不会增量返回 delta，回退到从 result 提取最终文本。
      if (!yieldedAny) {
        const result = lastChunk?.result as { final_response?: string } | undefined
        const finalText = (result?.final_response || lastChunk?.output || '').trim()
        if (finalText) yield finalText
        else throw new Error('Agent report produced no output')
      }
    } finally {
      // 报告生成是一次性场景，结束后立即销毁临时会话，避免占用 bridge 资源。
      void bridge.destroy(agentSessionId, profile).catch(() => {})
    }
  }

  /**
   * 回退路径：直接调用 LLM API 生成报告（不经过 Hermes Agent）。
   * 保留 profile 下会议分析技能的动态注入。
   */
  private async *generateReportViaDirectLLM(transcript: string, template: SceneTemplate, profile: string): AsyncGenerator<string> {
    const config = await this.loadLLMConfig()
    if (!config) throw new Error('LLM config not available')

    // 动态加载 profile 下的会议分析技能并追加到报告 system prompt。
    const skillSection = await prepareAnalysisSkillSection(profile)
    const reportPrompt = skillSection
      ? `${template.reportPrompt}\n\n${skillSection}`
      : template.reportPrompt

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: reportPrompt },
        { role: 'user', content: `以下是完整的会议转写内容：\n\n${transcript}` },
      ],
      temperature: 0.4,
      max_tokens: 4000,
      stream: true,
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let yieldedAny = false

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        // 兼容 "data: {...}" 和 "data:{...}" 两种格式
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        try {
          const chunk = JSON.parse(payload)
          // 标准 OpenAI 流式：delta.content；部分端点：message.content
          const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
          if (delta) {
            yieldedAny = true
            yield delta
          }
        } catch {
          console.warn('[report-stream] 无法解析的 SSE 块:', payload.slice(0, 200))
        }
      }
    }

    // 流式未产出任何内容时，回退到非流式调用（与分析接口相同的可靠路径）
    if (!yieldedAny) {
      console.warn('[report-stream] 流式响应为空，回退到非流式调用')
      const fallbackBody = { ...body, stream: false }
      const fallbackRes = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(fallbackBody),
      })
      if (!fallbackRes.ok) {
        const text = await fallbackRes.text().catch(() => '')
        throw new Error(`LLM API error ${fallbackRes.status}: ${text.slice(0, 200)}`)
      }
      const data = await fallbackRes.json() as any
      const content = data?.choices?.[0]?.message?.content
      if (content) yield content
    }
  }

  private async loadLLMConfig(): Promise<LLMConfig | null> {
    const dataDir = path.join(process.cwd(), 'data', 'meeting-asr')
    const configFile = path.join(dataDir, 'config.json')

    try {
      const content = await fs.readFile(configFile, 'utf-8')
      const stored = JSON.parse(content)

      const apiKey = stored?.llm?.api_key || stored?.asr?.dashscope_api_key
      if (!apiKey) return null

      return {
        apiKey,
        baseUrl: stored?.llm?.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: stored?.llm?.model || 'qwen-plus',
      }
    } catch {
      return null
    }
  }
}

/**
 * 把 LLM 返回的原始文本解析为 AnalysisRound（纯函数，便于单测）。
 *
 * 兼容：
 * - 旧版字段 goodPhrases（string[] 或 {quote, speaker?, reason?}[]）→ 归一化为 goldenQuotes；
 * - fillerWords / grammarIssues 上的 speaker 字段（按发言人区分）；
 * - markdown 代码围栏包裹的 JSON。
 */
export function parseAnalysisResponse(raw: string): AnalysisRound | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
    const parsed = JSON.parse(cleaned)

    const keyPoint = typeof parsed.keyPoint === 'string' ? parsed.keyPoint.trim() : ''
    const analysis = typeof parsed.analysis === 'string' ? parsed.analysis.trim() : ''
    const fillerWords = Array.isArray(parsed.fillerWords)
      ? parsed.fillerWords
          .filter((f: any) => f && typeof f.word === 'string' && Number.isFinite(Number(f.count)))
          .slice(0, 20)
          .map((f: any) => ({
            word: f.word.slice(0, 30),
            count: Math.max(0, Math.round(Number(f.count))),
            ...(typeof f.speaker === 'string' && f.speaker.trim() ? { speaker: f.speaker.trim().slice(0, 30) } : {}),
          }))
      : undefined
    const goldenQuotes = normalizeGoldenQuotes(parsed.goldenQuotes ?? parsed.goodPhrases)
    const grammarIssues = Array.isArray(parsed.grammarIssues)
      ? parsed.grammarIssues
          .filter((g: any) => g && typeof g.quote === 'string')
          .slice(0, 10)
          .map((g: any) => ({
            quote: g.quote.slice(0, 120),
            issue: typeof g.issue === 'string' ? g.issue.slice(0, 200) : '',
            ...(typeof g.speaker === 'string' && g.speaker.trim() ? { speaker: g.speaker.trim().slice(0, 30) } : {}),
          }))
      : undefined
    const score = parsed.score && typeof parsed.score === 'object' && !Array.isArray(parsed.score)
      ? Object.fromEntries(
          Object.entries(parsed.score)
            .filter(([, v]) => Number.isFinite(Number(v)))
            .map(([k, v]) => [k.slice(0, 20), Math.max(0, Math.min(100, Math.round(Number(v))))]),
        )
      : undefined
    const hasNewPoint = typeof parsed.hasNewPoint === 'boolean' ? parsed.hasNewPoint : undefined
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights.filter((h: any) => typeof h === 'string').slice(0, 8).map((h: string) => h.slice(0, 120))
      : undefined
    const improvements = Array.isArray(parsed.improvements)
      ? parsed.improvements.filter((i: any) => typeof i === 'string').slice(0, 8).map((i: string) => i.slice(0, 120))
      : undefined
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.filter((tp: any) => typeof tp === 'string').slice(0, 8).map((tp: string) => tp.slice(0, 80))
      : undefined

    // 演讲评分场景：只要有任何一项内容就保留该轮（评分/赘语/金句/新评价点也算）。
    const hasSpeechContent = !!keyPoint || !!analysis || !!fillerWords?.length || !!goldenQuotes?.length
      || !!grammarIssues?.length || !!score || !!highlights?.length || !!improvements?.length || !!topics?.length || hasNewPoint === true
    if (!parsed || !hasSpeechContent) {
      return null
    }

    const now = Date.now()
    return {
      id: `round-${now}`,
      context: typeof parsed.context === 'string' ? parsed.context.slice(0, 200) : '',
      priority: (['normal', 'attention', 'urgent'].includes(parsed.priority) ? parsed.priority : 'normal') as AnalysisRound['priority'],
      keyPoint: keyPoint.slice(0, 120),
      analysis: analysis.slice(0, 500),
      timestamp: now,
      ...(fillerWords ? { fillerWords } : {}),
      ...(goldenQuotes ? { goldenQuotes } : {}),
      ...(grammarIssues ? { grammarIssues } : {}),
      ...(typeof parsed.wotdUsed === 'boolean' ? { wotdUsed: parsed.wotdUsed } : {}),
      ...(score ? { score } : {}),
      ...(typeof parsed.timeNote === 'string' ? { timeNote: parsed.timeNote.slice(0, 200) } : {}),
      ...(hasNewPoint !== undefined ? { hasNewPoint } : {}),
      ...(highlights ? { highlights } : {}),
      ...(improvements ? { improvements } : {}),
      ...(topics ? { topics } : {}),
    }
  } catch {
    logger.warn('[meeting-assist] failed to parse LLM response as JSON: %s', raw.slice(0, 100))
    return null
  }
}

/** 归一化金句列表：兼容 string[] 与 {quote, speaker?, reason?}[] 两种模型输出。 */
function normalizeGoldenQuotes(raw: unknown): GoldenQuote[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: GoldenQuote[] = []
  for (const q of raw) {
    if (typeof q === 'string') {
      const s = q.trim()
      if (s) out.push({ quote: s.slice(0, 120) })
    } else if (q && typeof q === 'object' && typeof q.quote === 'string') {
      const quote = q.quote.trim().slice(0, 120)
      if (!quote) continue
      out.push({
        quote,
        ...(typeof q.speaker === 'string' && q.speaker.trim() ? { speaker: q.speaker.trim().slice(0, 30) } : {}),
        ...(typeof q.reason === 'string' && q.reason.trim() ? { reason: q.reason.trim().slice(0, 120) } : {}),
      })
    }
    if (out.length >= 10) break
  }
  return out.length ? out : undefined
}

export const realtimeAssistService = new RealtimeAssistService()
