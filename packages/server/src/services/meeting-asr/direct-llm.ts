import fs from 'fs/promises'
import path from 'path'
import { logger } from '../logger'
import type { SceneTemplate } from './scene-templates'
import { prepareAnalysisSkillSection } from './skill-resolver'
import { parseAnalysisRound, type AnalysisRound, type SpeechContext } from './report-parser'

/**
 * 服务端累积的演讲评价摘要：跨批次保留，注入后续提示词，供 AI 判断是否出现新的评价点。
 * 由 realtime-assist 的 accumulateSpeechSummary 维护（源自 org 演讲功能增量评价模式）。
 */
export interface SpeechSummary {
  highlights: string[]
  improvements: string[]
  topics: string[]
  score?: Record<string, number>
}

/**
 * Direct LLM 路径（拆分自 realtime-assist.ts，行为保持一致）。
 *
 * 不经过 Hermes Agent、直接调用 OpenAI 兼容端点的所有请求都在这里：
 * 实时批次的快速分析（~3s 主路径）与报告生成的流式 fallback。
 * fetch 与 LLM 配置读取都可注入，便于单测。
 */

export interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface DirectLLMDeps {
  /** 注入 fetch 实现（单测用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入 LLM 配置读取（单测用）；默认读 dataDir/config.json。 */
  loadConfig?: () => Promise<LLMConfig | null>
}

/** 墙钟毫秒 → HH:mm:ss（环节时间线展示用）。 */
function fmtClock(ms: number): string {
  if (!Number.isFinite(ms)) return '??:??:??'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 读取 meeting-asr 持久化目录里的 LLM 配置（config.json）。
 *
 * Mirror MeetingASRService.getDataDir() default so we read from the same
 * root as the rest of the meeting-asr persistent state (config.json,
 * analysis.json, .env). Keep the literal here in sync if the default ever
 * moves; the helper lives on MeetingASRService.
 */
export async function loadLLMConfig(dataDir?: string): Promise<LLMConfig | null> {
  const dir = dataDir || path.join(process.cwd(), 'data', 'meeting-asr')
  const configFile = path.join(dir, 'config.json')

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

async function resolveConfig(deps?: DirectLLMDeps): Promise<LLMConfig | null> {
  if (deps?.loadConfig) return deps.loadConfig()
  return loadLLMConfig()
}

/**
 * 回退路径：直接调用 LLM API 进行实时分析（不经过 Agent）。
 */
export async function analyzeViaDirectLLM(
  transcriptText: string,
  template: SceneTemplate,
  profile: string,
  speechContext?: SpeechContext | null,
  speechSummary?: SpeechSummary,
  deps?: DirectLLMDeps,
): Promise<AnalysisRound | null> {
  const config = await resolveConfig(deps)
  if (!config) {
    logger.warn('[meeting-assist] LLM config not available, skipping analysis')
    return null
  }

  // 动态加载 profile 下的会议分析技能并追加到 system prompt。
  // 演讲评分场景使用自成一体的专业提示词（3+1 反馈 / 金句定义 / 赘语阈值 / 说人话鼓励式点评等），
  // 不追加通用会议分析技能，避免其通用方法论稀释演讲点评风格。
  const skillSection = template.id === 'speech' ? '' : await prepareAnalysisSkillSection(profile, template.id)
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
      if (ctx.speakerTimeline && ctx.speakerTimeline.length > 0) {
        lines.push('- 环节与发言人时间线（计时员人工登记，转写中的 [姓名] 已按此标注）：')
        for (const e of ctx.speakerTimeline) {
          const name = e.segment ? `${e.segment}/${e.speaker}` : e.speaker
          lines.push(`  - ${name}：${fmtClock(e.startMs)} - ${fmtClock(e.endMs)}`)
        }
        lines.push('- 赘语/金句/语法问题的 speaker 字段必须使用时间线中的演讲者姓名（禁止输出"说话人1"这类编号），分析点评也直接称呼姓名。')
      } else {
        // 无时间线且转写无 [姓名] 标注时明确禁止编造：LLM 在无归属信息的转写上
        // 会自行虚构姓名（如"张三"），误导用户以为系统真的识别到了演讲者。
        lines.push('- 本次未提供演讲者时间线，转写也没有 [姓名] 标注：speaker 字段一律留空字符串，禁止编造或猜测任何姓名（如"张三""发言人"）。')
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
    // 用户手动记录（语法官/肢体语言观察）：AI 点评必须结合这些人工观察
    const mn = speechContext?.manualNotes
    if (mn?.goodPhrases?.length) {
      lines.push(`- 手动记录金句：${mn.goodPhrases.join('；')}（点评时呼应这些被标记的句子）`)
    }
    if (mn?.grammarNotes?.length) {
      lines.push(`- 手动语法/用词记录：${mn.grammarNotes.join('；')}（核实后可纳入 grammarIssues）`)
    }
    if (mn?.bodyNotes?.length) {
      lines.push(`- 肢体语言观察（人工记录，你看不到画面，务必结合）：${mn.bodyNotes.join('；')}`)
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

  const doFetch = deps?.fetchImpl ?? fetch
  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
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

  // H1 赘语阈值：实际发言时长 = 设置时长 - 当前倒计时（缺省不启用阈值过滤）
  let speechDurationSec: number | undefined
  if (template.id === 'speech' && speechContext) {
    const { timerDurationSec, currentRemainingSec } = speechContext
    if (typeof timerDurationSec === 'number' && typeof currentRemainingSec === 'number') {
      const elapsed = timerDurationSec - currentRemainingSec
      if (elapsed > 0) speechDurationSec = elapsed
    }
  }

  return parseAnalysisRound(content, { speechDurationSec })
}

/**
 * 回退路径：直接调用 LLM API 生成报告（不经过 Hermes Agent）。
 * 保留 profile 下会议分析技能的动态注入。
 */
export async function* streamDirectLLMReport(
  transcript: string,
  template: SceneTemplate,
  profile: string,
  deps?: DirectLLMDeps,
): AsyncGenerator<string> {
  const config = await resolveConfig(deps)
  if (!config) throw new Error('LLM config not available')

  // 动态加载 profile 下的会议分析技能并追加到报告 system prompt。
  // 演讲评分场景不追加通用会议分析技能：报告要求是公众号风格、不是正式文档，
  // 通用技能的会议纪要式结构会稀释该风格（见 analyzeViaDirectLLM 同款注释）。
  const skillSection = template.id === 'speech' ? '' : await prepareAnalysisSkillSection(profile, template.id)
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

  const doFetch = deps?.fetchImpl ?? fetch
  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
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
    if (done) {
      // 流结束时把 buffer 里剩余的最后一行（可能是不带换行的最后一条 data:）flush 出去。
      // 否则最后一段 chunk 会留在 buffer 里永远不到前端。
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              const chunk = JSON.parse(payload)
              // provider 也可能把错误放在流里（{error: {...}}），这种帧必须立即抛错
              // 让外层 fallback / 上层 catch 处理，否则会被静默忽略。
              if (chunk?.error) {
                throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error)))
              }
              const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
              if (delta) {
                yieldedAny = true
                yield delta
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                console.warn('[report-stream] 无法解析的 SSE 块:', payload.slice(0, 200))
              } else {
                throw err
              }
            }
          }
        }
      }
      break
    }

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
        // provider 也可能把错误放在流里（{error: {...}}），这种帧必须立即抛错
        // 让外层 fallback / 上层 catch 处理，否则会被静默忽略。
        if (chunk?.error) {
          throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error)))
        }
        // 标准 OpenAI 流式：delta.content；部分端点：message.content
        const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
        if (delta) {
          yieldedAny = true
          yield delta
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.warn('[report-stream] 无法解析的 SSE 块:', payload.slice(0, 200))
        } else {
          throw err
        }
      }
    }
  }

  // 流式未产出任何内容时，回退到非流式调用（与分析接口相同的可靠路径）
  if (!yieldedAny) {
    console.warn('[report-stream] 流式响应为空，回退到非流式调用')
    const fallbackBody = { ...body, stream: false }
    const fallbackRes = await doFetch(`${config.baseUrl}/chat/completions`, {
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
