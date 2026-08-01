import type { Server, Namespace } from 'socket.io'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../logger'
import { getSceneTemplateOrDefault, type SceneTemplate } from './scene-templates'
import { prepareAnalysisSkillSection } from './skill-resolver'
import { getActiveProfileName } from '../hermes/hermes-profile'
import type { AgentBridgeOutput } from '../hermes/agent-bridge/client'

export interface AnalysisRound {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  analysis: string
  timestamp: number
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
  buffer: TranscriptSentence[]
  timer: NodeJS.Timeout | null
  isAnalyzing: boolean
}

const WINDOW_SIZE = 5
const WINDOW_INTERVAL_MS = 18_000
const NAMESPACE = '/meeting-assist'

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

  async startSession(sessionId: string, sceneTemplate: string, profile?: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      logger.info('[meeting-assist] session %s already active, resetting buffer', sessionId)
      this.stopSession(sessionId)
    }

    this.sessions.set(sessionId, {
      sessionId,
      sceneTemplate,
      profile,
      buffer: [],
      timer: null,
      isAnalyzing: false,
    })

    logger.info('[meeting-assist] session started: %s (scene: %s, profile: %s)', sessionId, sceneTemplate, profile || '(active)')
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
      const round = await this.analyzeBatch(sentences, session.sceneTemplate, session.profile)
      if (round) {
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

  private async analyzeBatch(sentences: TranscriptSentence[], sceneTemplateId: string, profile?: string): Promise<AnalysisRound | null> {
    const config = await this.loadLLMConfig()
    if (!config) {
      logger.warn('[meeting-assist] LLM config not available, skipping analysis')
      return null
    }

    const template = getSceneTemplateOrDefault(sceneTemplateId)
    const transcriptText = sentences
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')

    // 动态加载 profile 下的会议分析技能并追加到 system prompt。
    const skillSection = await prepareAnalysisSkillSection(profile)
    const systemPrompt = skillSection
      ? `${template.systemPrompt}\n\n${skillSection}`
      : template.systemPrompt

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `以下是最近的对话内容：\n\n${transcriptText}` },
      ],
      temperature: 0.3,
      max_tokens: 800,
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
    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
      const parsed = JSON.parse(cleaned)

      // Skip empty analysis
      if (!parsed || typeof parsed.analysis !== 'string' || !parsed.analysis.trim()) {
        return null
      }

      const now = Date.now()
      return {
        id: `round-${now}`,
        context: typeof parsed.context === 'string' ? parsed.context.slice(0, 200) : '',
        priority: (['normal', 'attention', 'urgent'].includes(parsed.priority) ? parsed.priority : 'normal') as AnalysisRound['priority'],
        analysis: parsed.analysis.slice(0, 800),
        timestamp: now,
      }
    } catch {
      logger.warn('[meeting-assist] failed to parse LLM response as JSON: %s', raw.slice(0, 100))
      return null
    }
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

export const realtimeAssistService = new RealtimeAssistService()
