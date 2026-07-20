import { ref, computed } from 'vue'
import { useMeetingStore, type TranscriptSentence, type AgentMessage, type AgentConfig, type AnalysisResult } from '@/stores/hermes/meeting'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'
import { startRunViaSocket, registerSessionHandlers, type RunEvent, type StartRunRequest } from '@/api/hermes/chat'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId } from '@/api/coding-agents'
import { meetingStorageApi } from '@/utils/meeting-storage-api'

// 默认提示词模板
const DEFAULT_PROMPT_TEMPLATE = `你是一个专业的会议分析助手。你的任务是分析会议逐字稿，生成详细的会议纪要和分析报告。

你可以使用各种工具来辅助分析，比如搜索相关信息、查看文档、调用 skill 等。

分析完成后，请以 JSON 格式返回分析结果，格式如下：
{
  "summary": "会议摘要",
  "key_points": ["要点1", "要点2"],
  "action_items": ["待办1", "待办2"],
  "topics": ["主题1", "主题2"],
  "people_mentioned": ["人员1", "人员2"],
  "relationships": [{"source": "人员1", "target": "人员2", "relation": "关系"}]
}

请确保你的分析全面、准确，并提取所有重要的信息。`

// 提示词模板存储 key
const PROMPT_TEMPLATE_KEY = 'hermes.meeting.promptTemplate'

export function useMeetingAgent(sessionId: string) {
  const meetingStore = useMeetingStore()
  const profilesStore = useProfilesStore()
  const appStore = useAppStore()

  const messages = ref<AgentMessage[]>([])
  const isRunning = ref(false)
  const error = ref<string | null>(null)
  const analysisResult = ref<AnalysisResult | null>(null)
  const reportHtml = ref<string>('')

  // 提示词模板
  const promptTemplate = ref(loadPromptTemplate())

  // 当前会议 session
  const session = computed(() => {
    return meetingStore.sessions.find(s => s.id === sessionId)
  })

  // Agent 配置
  const agentConfig = computed((): AgentConfig | undefined => {
    return session.value?.agentConfig
  })

  // 加载提示词模板
  function loadPromptTemplate(): string {
    try {
      const saved = localStorage.getItem(PROMPT_TEMPLATE_KEY)
      return saved || DEFAULT_PROMPT_TEMPLATE
    } catch {
      return DEFAULT_PROMPT_TEMPLATE
    }
  }

  // 保存提示词模板
  function savePromptTemplate(template: string) {
    try {
      localStorage.setItem(PROMPT_TEMPLATE_KEY, template)
      promptTemplate.value = template
    } catch {}
  }

  // 重置提示词模板为默认
  function resetPromptTemplate() {
    promptTemplate.value = DEFAULT_PROMPT_TEMPLATE
    localStorage.removeItem(PROMPT_TEMPLATE_KEY)
  }

  // 生成唯一 ID
  function uid(): string {
    return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  // 添加消息（只添加 assistant 和 tool 消息）
  function addMessage(msg: AgentMessage) {
    messages.value.push(msg)
  }

  // 格式化逐字稿
  function formatTranscript(sentences: TranscriptSentence[]): string {
    return sentences.map(s => {
      const speaker = s.speaker ? `[${s.speaker}] ` : ''
      return `${speaker}${s.text}`
    }).join('\n')
  }

  // 构建分析 prompt
  function buildAnalysisPrompt(sentences: TranscriptSentence[]): string {
    const transcript = formatTranscript(sentences)
    const speakers = session.value?.speakers || []
    
    let speakerInfo = ''
    if (speakers.length > 0) {
      speakerInfo = `\n说话人信息：\n${speakers.map(s => `- ${s.id}: ${s.displayName}`).join('\n')}\n`
    }

    return `请分析以下会议逐字稿，生成详细的会议纪要。
${speakerInfo}
逐字稿内容：
${transcript}

请开始分析。`
  }

  // 从 assistant 消息中提取 JSON 结果
  function extractJsonResult(): AnalysisResult | null {
    const assistantMsgs = messages.value.filter(m => m.role === 'assistant')
    if (assistantMsgs.length === 0) return null

    const lastMsg = assistantMsgs[assistantMsgs.length - 1]
    const content = lastMsg.content

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      console.error('Failed to parse JSON from agent response:', e)
    }

    return null
  }

  // 生成 HTML 报告
  function generateHtmlReport(analysis: AnalysisResult): string {
    const meetingTitle = session.value?.title || '会议'
    const genTime = new Date().toLocaleString('zh-CN')
    
    const topicsHtml = (analysis.topics || []).map(t => 
      `<span class="topic-tag">${t}</span>`
    ).join('')
    
    const keyPointsHtml = (analysis.key_points || []).map((p, i) => 
      `<div class="key-point-card">
        <div class="key-point-number">${i + 1}</div>
        <div class="key-point-text">${p}</div>
      </div>`
    ).join('')
    
    const actionItemsHtml = (analysis.action_items || []).map(item =>
      `<div class="action-item">
        <input type="checkbox" class="action-checkbox">
        <span class="action-text">${item}</span>
      </div>`
    ).join('')
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${meetingTitle} - 会议分析报告</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    .header {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
    }
    .header h1 { font-size: 28px; color: #1a1a2e; margin-bottom: 10px; }
    .header .meta { color: #666; font-size: 14px; }
    .summary-box {
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      border-radius: 12px;
      padding: 20px;
      margin-top: 15px;
      font-size: 16px;
      line-height: 1.6;
      color: #333;
    }
    .topics-container { margin-top: 15px; display: flex; flex-wrap: wrap; gap: 8px; }
    .topic-tag {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 14px;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
    }
    .card h2 {
      font-size: 20px;
      color: #1a1a2e;
      margin-bottom: 20px;
    }
    .key-point-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      background: #f8f9fa;
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .key-point-number {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      flex-shrink: 0;
    }
    .key-point-text { font-size: 15px; line-height: 1.5; color: #333; }
    .action-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: #fff3cd;
      border-radius: 8px;
      margin-bottom: 10px;
      border-left: 4px solid #ffc107;
    }
    .action-checkbox { width: 20px; height: 20px; cursor: pointer; }
    .action-text { font-size: 15px; color: #333; }
    .footer { text-align: center; color: rgba(255, 255, 255, 0.8); font-size: 14px; padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${meetingTitle}</h1>
      <div class="meta">生成时间：${genTime}</div>
      <div class="summary-box">
        <strong>摘要：</strong>${analysis.summary || '暂无摘要'}
      </div>
      ${topicsHtml ? `<div class="topics-container">${topicsHtml}</div>` : ''}
    </div>
    <div class="card">
      <h2>关键要点</h2>
      ${keyPointsHtml || '<p>暂无关键要点</p>'}
    </div>
    <div class="card">
      <h2>待办事项</h2>
      ${actionItemsHtml || '<p>暂无待办事项</p>'}
    </div>
    <div class="footer">会议分析报告 · 由 Hermes Agent 生成</div>
  </div>
</body>
</html>`
  }

  // 发送消息到 agent（不显示用户消息泡泡）
  async function sendMessage(content: string, instructions?: string) {
    if (!content.trim() || !session.value) return

    // 不添加用户消息到显示列表
    isRunning.value = true
    error.value = null

    try {
      await sendToAgent(content.trim(), instructions)
    } catch (err: any) {
      error.value = err.message || '发送失败'
    } finally {
      isRunning.value = false
    }
  }

  // 发送到 agent (核心逻辑)
  async function sendToAgent(content: string, instructions?: string) {
    if (!session.value) return

    const config = agentConfig.value as AgentConfig | undefined
    const agentSessionId = session.value.agentSessionId || `meeting-agent-${sessionId}`

    if (!session.value.agentSessionId) {
      meetingStore.updateSession(sessionId, { agentSessionId: agentSessionId })
    }

    const profile = config?.profile || profilesStore.activeProfileName || 'default'

    const payload: StartRunRequest = {
      input: content,
      session_id: agentSessionId,
      profile,
      model: config?.model,
      provider: config?.provider,
      source: config?.agentType === 'hermes' ? 'cli' : 'coding_agent',
      instructions: instructions || promptTemplate.value,
    }

    if (config?.agentType === 'claude-code' || config?.agentType === 'codex') {
      const codingAgentId: ChatCodingAgentId = config.agentType === 'claude-code' ? 'claude-code' : 'codex'
      const codingAgentMode = config.codingAgentMode || 'scoped'
      
      payload.coding_agent_id = codingAgentId
      payload.mode = codingAgentMode

      if (codingAgentMode === 'scoped') {
        const providerGroup = config.provider ? appStore.modelGroups.find(g => g.provider === config.provider) : undefined
        if (providerGroup) {
          payload.baseUrl = providerGroup.base_url
          payload.apiKey = providerGroup.api_key
          payload.apiMode = normalizeCodingAgentApiMode(
            providerGroup.api_mode,
            inferCodingAgentApiMode(providerGroup.provider, providerGroup.base_url)
          )
        }
      }
    }

    let activeAssistantMessageId: string | null = null

    const cleanup = registerSessionHandlers(agentSessionId, {
      onMessageDelta: (evt: RunEvent) => {
        const text = evt.delta || ''
        if (!text) return

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.content += text
          }
        } else {
          const newId = uid()
          activeAssistantMessageId = newId
          addMessage({
            id: newId,
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            status: 'sent'
          })
        }
      },
      onReasoningDelta: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.reasoning = (msg.reasoning || '') + text
          }
        }
      },
      onThinkingDelta: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.reasoning = (msg.reasoning || '') + text
          }
        }
      },
      onReasoningAvailable: () => {},
      onToolStarted: (evt: RunEvent) => {
        const toolId = uid()
        addMessage({
          id: toolId,
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: evt.tool || evt.name,
          toolStatus: 'running',
          toolArgs: (evt as any).arguments,
          toolPreview: evt.preview,
          _expanded: false, // 默认折叠
        })
        activeAssistantMessageId = null
      },
      onToolCompleted: (evt: RunEvent) => {
        const toolMsg = [...messages.value].reverse().find(
          m => m.role === 'tool' && m.toolStatus === 'running' && m.toolName === (evt.tool || evt.name)
        )
        if (toolMsg) {
          toolMsg.toolStatus = evt.error ? 'error' : 'done'
          toolMsg.toolResult = (evt as any).result
          toolMsg.toolDuration = (evt as any).duration
        }
      },
      onRunStarted: () => {
        isRunning.value = true
        activeAssistantMessageId = null
      },
      onRunCompleted: (_evt: RunEvent) => {
        isRunning.value = false
        activeAssistantMessageId = null
        cleanup()
        
        // 提取 JSON 结果并生成报告
        const result = extractJsonResult()
        if (result) {
          analysisResult.value = result
          meetingStore.updateAnalysis(sessionId, result)
          
          // 生成 HTML 报告
          const html = generateHtmlReport(result)
          reportHtml.value = html
          meetingStore.updateHtmlContent(sessionId, html)
          
          // 保存到服务器
          meetingStorageApi.saveJsonReport(sessionId, result)
            .then(() => console.log('Analysis result saved to server'))
            .catch(err => console.error('Failed to save analysis result to server:', err))
        }
      },
      onRunFailed: (evt: RunEvent) => {
        const errorMsg = evt.error || '运行失败'
        error.value = errorMsg
        isRunning.value = false
        activeAssistantMessageId = null
        cleanup()
        
        addMessage({
          id: uid(),
          role: 'system',
          content: `错误: ${errorMsg}`,
          timestamp: Date.now(),
          status: 'error'
        })
      },
      onCompressionStarted: () => {},
      onCompressionCompleted: () => {},
      onAbortStarted: () => {},
      onAbortCompleted: () => {
        isRunning.value = false
        cleanup()
      },
      onUsageUpdated: () => {},
    })

    const ctrl = startRunViaSocket(
      payload,
      () => {},
      () => {
        isRunning.value = false
        cleanup()
      },
      (err: Error) => {
        error.value = err.message
        isRunning.value = false
        cleanup()
      }
    )

    return ctrl
  }

  // 开始分析逐字稿
  async function startAnalysis(sentences: TranscriptSentence[]) {
    if (!sentences.length) {
      error.value = '没有可分析的逐字稿'
      return
    }

    // 清空之前的结果
    messages.value = []
    analysisResult.value = null
    reportHtml.value = ''
    error.value = null

    const prompt = buildAnalysisPrompt(sentences)
    await sendMessage(prompt)
  }

  // 中止运行
  function abortRun() {
    isRunning.value = false
  }

  // 清空所有
  function clearAll() {
    messages.value = []
    analysisResult.value = null
    reportHtml.value = ''
    error.value = null
  }

  // 初始化
  function init() {
    if (session.value?.analysisResult) {
      analysisResult.value = session.value.analysisResult
    }
    if (session.value?.htmlContent) {
      reportHtml.value = session.value.htmlContent
    }
  }

  init()

  return {
    messages,
    isRunning,
    error,
    analysisResult,
    reportHtml,
    agentConfig,
    promptTemplate,
    sendMessage,
    startAnalysis,
    abortRun,
    clearAll,
    savePromptTemplate,
    resetPromptTemplate,
  }
}