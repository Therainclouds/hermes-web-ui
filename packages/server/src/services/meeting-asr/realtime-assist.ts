import type { Server, Namespace } from 'socket.io'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../logger'
import { getSceneTemplateOrDefault } from './scene-templates'

export interface AssistHint {
  id: string
  type: 'prediction' | 'atmosphere' | 'risk' | 'suggestion'
  level: 'info' | 'warning' | 'critical'
  text: string
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
  buffer: TranscriptSentence[]
  timer: NodeJS.Timeout | null
  isAnalyzing: boolean
}

const WINDOW_SIZE = 5
const WINDOW_INTERVAL_MS = 18_000
const NAMESPACE = '/meeting-assist'

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

  async startSession(sessionId: string, sceneTemplate: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      logger.info('[meeting-assist] session %s already active, resetting buffer', sessionId)
      this.stopSession(sessionId)
    }

    this.sessions.set(sessionId, {
      sessionId,
      sceneTemplate,
      buffer: [],
      timer: null,
      isAnalyzing: false,
    })

    logger.info('[meeting-assist] session started: %s (scene: %s)', sessionId, sceneTemplate)
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
      const hints = await this.analyzeBatch(sentences, session.sceneTemplate)
      if (hints.length > 0) {
        this.nsp?.to(`meeting:${session.sessionId}`).emit('hints', hints)
      }
    } catch (err) {
      logger.error(err, '[meeting-assist] analysis failed for session %s', session.sessionId)
      this.nsp?.to(`meeting:${session.sessionId}`).emit('error', String(err))
    } finally {
      session.isAnalyzing = false
      this.nsp?.to(`meeting:${session.sessionId}`).emit('analyzing', false)
    }
  }

  private async analyzeBatch(sentences: TranscriptSentence[], sceneTemplateId: string): Promise<AssistHint[]> {
    const config = await this.loadLLMConfig()
    if (!config) {
      logger.warn('[meeting-assist] LLM config not available, skipping analysis')
      return []
    }

    const template = getSceneTemplateOrDefault(sceneTemplateId)
    const transcriptText = sentences
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: template.systemPrompt },
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
    const content = data?.choices?.[0]?.message?.content || '[]'

    return this.parseHints(content)
  }

  private parseHints(raw: string): AssistHint[] {
    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) return []

      const now = Date.now()
      return parsed
        .filter((item: any) => item && typeof item.text === 'string')
        .slice(0, 4)
        .map((item: any, index: number): AssistHint => ({
          id: `hint-${now}-${index}`,
          type: (['prediction', 'atmosphere', 'risk', 'suggestion'].includes(item.type) ? item.type : 'suggestion') as AssistHint['type'],
          level: (['info', 'warning', 'critical'].includes(item.level) ? item.level : 'info') as AssistHint['level'],
          text: String(item.text).slice(0, 500),
          timestamp: now,
        }))
    } catch {
      logger.warn('[meeting-assist] failed to parse LLM response as JSON: %s', raw.slice(0, 100))
      return []
    }
  }

  /**
   * Generate final report using streaming. Returns an async generator of text chunks.
   */
  async *generateReportStream(sessionId: string, transcript: string, sceneTemplateId: string): AsyncGenerator<string> {
    const config = await this.loadLLMConfig()
    if (!config) throw new Error('LLM config not available')

    const template = getSceneTemplateOrDefault(sceneTemplateId)

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: template.reportPrompt },
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

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') return

        try {
          const chunk = JSON.parse(payload)
          const delta = chunk?.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch {
          // skip malformed SSE chunks
        }
      }
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
