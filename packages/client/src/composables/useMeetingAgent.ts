import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMeetingStore, type TranscriptSentence, type AgentMessage, type AgentConfig, type AnalysisResult } from '@/stores/hermes/meeting'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'
import { startRunViaSocket, registerSessionHandlers, type RunEvent, type StartRunRequest } from '@/api/hermes/chat'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId } from '@/api/coding-agents'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { useMessage } from '@/composables/useAppMessage'
import { tryParseJson, looksLikeHtmlDocument, escHtml, extractCorrections } from '@/composables/useMeetingAnalysis'

// 默认提示词模板
const DEFAULT_PROMPT_TEMPLATE = `你是一个专业的会议分析助手。你的任务是分析会议逐字稿，生成详细的会议分析报告。

## 工作流程

### 第一步：判断会议类型
根据逐字稿内容，判断这是什么类型的会议：
- **会议纪要**：包含议题、讨论、决策、待办事项和负责人
- **客户回访**：包含客户反馈、满意度、问题、建议
- **头脑风暴**：包含创意、想法、可行性分析
- **项目汇报**：包含进度、风险、下一步计划
- **培训分享**：包含知识点、要点、学习建议
- **其他**：根据实际内容判断

### 第二步：根据会议类型决定是否使用工具
**需要使用工具的情况**：
- 客户回访：搜索客户历史记录、产品文档、常见问题解决方案
- 项目汇报：查看项目文档、历史会议记录、风险评估模板
- 培训分享：搜索相关知识库、文档、参考资料

**不需要使用工具的情况**：
- 简单的会议纪要：直接提取关键信息
- 头脑风暴：直接分析创意和想法

### 第三步：生成分析结果并输出JSON
根据会议类型，生成JSON格式的分析结果。

## 输出格式
你的回复应包含JSON分析结果和HTML报告两部分：

**第一部分：JSON分析结果**
\`\`\`json
{
  "meeting_type": "会议类型",
  "summary": "会议摘要",
  "key_points": ["关键要点"],
  "action_items": [{"task": "待办", "assignee": "负责人", "deadline": "截止时间"}],
  "feedback": {"positive": ["积极反馈"], "negative": ["消极反馈"]},
  "decisions": ["决策"],
  "risks": ["风险"],
  "learnings": ["知识点"],
  "people_mentioned": ["人名"],
  "relationships": [{"source": "人A", "target": "人B", "relation": "关系"}],
  "topics": ["主题"]
}
\`\`\`

**第二部分：HTML报告**
\`\`\`html
<!DOCTYPE html>
<html lang="zh-CN">
...
</html>
\`\`\`

注意：
1. 根据会议类型，JSON中某些字段可以为空数组
2. HTML必须是完整的、可直接打开的网页
3. 两部分缺一不可

会议逐字稿：
{transcript}`

// 提示词模板存储 key
const PROMPT_TEMPLATE_KEY = 'hermes.meeting.promptTemplate'

export function useMeetingAgent(sessionId: string) {
  const meetingStore = useMeetingStore()
  const profilesStore = useProfilesStore()
  const appStore = useAppStore()
  const message = useMessage()
  const { t } = useI18n()

  const messages = ref<AgentMessage[]>([])
  const isRunning = ref(false)
  const error = ref<string | null>(null)
  const analysisResult = ref<AnalysisResult | null>(null)
  const reportHtml = ref<string>('')
  const completed = ref(false)
  const correctedSentences = ref<Array<{ index: number; original: string; corrected: string; reason?: string }> | null>(null)

  // 提示词模板
  const promptTemplate = ref(loadPromptTemplate())

  // 当前会议 session
  const session = computed(() => {
    return meetingStore.sessions.find(s => s.id === sessionId)
  })

  // Agent 配置
  const agentConfig = computed((): AgentConfig => {
    return session.value?.agentConfig || { agentType: 'hermes', profile: 'default' }
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

  // 持久化消息到 store
  function saveMessages() {
    if (sessionId) {
      meetingStore.updateSession(sessionId, { agentMessages: [...messages.value] })
    }
  }

  // 添加消息（只添加 assistant 和 tool 消息）
  function addMessage(msg: AgentMessage) {
    messages.value.push(msg)
    saveMessages()
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

    return promptTemplate.value
      .replace('{transcript}', `${speakerInfo}\n${transcript}`)
  }

  // 从 assistant 消息中提取 JSON 结果（后向前扫描，优先使用 tryParseJson）
  function extractJsonResult(): AnalysisResult | null {
    const assistantMsgs = messages.value.filter(m => m.role === 'assistant')
    if (assistantMsgs.length === 0) return null

    for (let i = assistantMsgs.length - 1; i >= 0; i--) {
      const content = assistantMsgs[i].content || ''
      const parsed = tryParseJson(content)
      if (parsed) return parsed
    }

    return null
  }

  // 从 assistant 消息中提取 HTML 内容
  function extractHtmlFromMessages(): string {
    const assistantMsgs = messages.value.filter(m => m.role === 'assistant')
    for (let i = assistantMsgs.length - 1; i >= 0; i--) {
      const content = assistantMsgs[i].content || ''
      const htmlBlock = content.match(/```html\s*([\s\S]*?)```/i)
      if (htmlBlock && looksLikeHtmlDocument(htmlBlock[1].trim())) {
        return htmlBlock[1].trim()
      }
      const htmlMatch = content.match(/(<!DOCTYPE html>[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i)
      if (htmlMatch && htmlMatch[1].length > 200) {
        return htmlMatch[1]
      }
    }
    return ''
  }

  // 生成 HTML 报告
  function generateHtmlReport(analysis: AnalysisResult): string {
    const meetingTitle = session.value?.title || '会议'
    const meetingType = (analysis as any).meeting_type || '会议分析'
    const genTime = new Date().toLocaleString('zh-CN')
    const esc = escHtml
    
    const topicsHtml = (analysis.topics || []).map(t => 
      `<span class="topic-tag">${esc(t)}</span>`
    ).join('')
    
    const keyPointsHtml = (analysis.key_points || []).map((p, i) => 
      `<div class="key-point-card">
        <div class="key-point-number">${i + 1}</div>
        <div class="key-point-text">${esc(p)}</div>
      </div>`
    ).join('')
    
    const items = analysis.action_items || []
    const actionItemsHtml = items.map(item => {
      if (typeof item === 'string') {
        return `<div class="action-item">
          <input type="checkbox" class="action-checkbox">
          <span class="action-text">${esc(item)}</span>
        </div>`
      }
      const meta = [item.assignee ? `负责人: ${esc(item.assignee)}` : '', item.deadline ? `截止: ${esc(item.deadline)}` : ''].filter(Boolean).join(' | ')
      return `<div class="action-item">
        <input type="checkbox" class="action-checkbox">
        <div>
          <div class="action-text">${esc(item.task)}</div>
          ${meta ? `<div class="action-meta">${meta}</div>` : ''}
        </div>
      </div>`
    }).join('')

    const feedbackHtml = analysis.feedback ? `
      <div class="card">
        <h2>反馈</h2>
        ${analysis.feedback.positive?.length ? `<div class="feedback-section"><h3>积极</h3>${analysis.feedback.positive.map(f => `<div class="feedback-item positive">${esc(f)}</div>`).join('')}</div>` : ''}
        ${analysis.feedback.negative?.length ? `<div class="feedback-section"><h3>待改进</h3>${analysis.feedback.negative.map(f => `<div class="feedback-item negative">${esc(f)}</div>`).join('')}</div>` : ''}
      </div>` : ''

    const decisionsHtml = analysis.decisions?.length ? `
      <div class="card">
        <h2>决策</h2>
        ${analysis.decisions.map(d => `<div class="decision-item">${esc(d)}</div>`).join('')}
      </div>` : ''

    const risksHtml = analysis.risks?.length ? `
      <div class="card">
        <h2>风险</h2>
        ${analysis.risks.map(r => `<div class="risk-item">${esc(r)}</div>`).join('')}
      </div>` : ''

    const learningsHtml = analysis.learnings?.length ? `
      <div class="card">
        <h2>知识沉淀</h2>
        ${analysis.learnings.map(l => `<div class="learning-item">${esc(l)}</div>`).join('')}
      </div>` : ''
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(meetingTitle)} - ${esc(meetingType)}报告</title>
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
      padding-bottom: 10px;
      border-bottom: 2px solid #eef0f5;
    }
    .card h3 { font-size: 16px; color: #555; margin-bottom: 10px; }
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
    .action-checkbox { width: 20px; height: 20px; cursor: pointer; margin-top: 2px; }
    .action-text { font-size: 15px; color: #333; }
    .action-meta { font-size: 12px; color: #888; margin-top: 4px; }
    .meeting-type-badge {
      display: inline-block;
      background: #667eea;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .feedback-section { margin-bottom: 15px; }
    .feedback-item {
      padding: 10px;
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 14px;
    }
    .feedback-item.positive { background: #d4edda; color: #155724; }
    .feedback-item.negative { background: #f8d7da; color: #721c24; }
    .decision-item {
      padding: 10px;
      background: #e8f4fd;
      border-radius: 8px;
      margin-bottom: 6px;
      border-left: 4px solid #2196f3;
    }
    .risk-item {
      padding: 10px;
      background: #fff3e0;
      border-radius: 8px;
      margin-bottom: 6px;
      border-left: 4px solid #ff9800;
    }
    .learning-item {
      padding: 10px;
      background: #f3e5f5;
      border-radius: 8px;
      margin-bottom: 6px;
      border-left: 4px solid #9c27b0;
    }
    .footer { text-align: center; color: rgba(255, 255, 255, 0.8); font-size: 14px; padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="meeting-type-badge">${esc(meetingType)}</div>
      <h1>${esc(meetingTitle)}</h1>
      <div class="meta">生成时间：${genTime}</div>
      <div class="summary-box">
        <strong>摘要：</strong>${esc(analysis.summary || '暂无摘要')}
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
    ${feedbackHtml}
    ${decisionsHtml}
    ${risksHtml}
    ${learningsHtml}
    <div class="footer">${esc(meetingType)}报告 · 由 Hermes Agent 生成</div>
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

    const config = agentConfig.value
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
        
        // 提取 JSON 结果
        const result = extractJsonResult()
        if (result) {
          analysisResult.value = result
          meetingStore.updateAnalysis(sessionId, result)
          
          // 优先尝试从 assistant 消息中提取 AI 生成的 HTML
          const extractedHtml = extractHtmlFromMessages()
          if (extractedHtml) {
            reportHtml.value = extractedHtml
          } else {
            // 回退到模板生成
            const html = generateHtmlReport(result)
            reportHtml.value = html
          }
          meetingStore.updateHtmlContent(sessionId, reportHtml.value)
          
          // 保存到服务器
          meetingStorageApi.saveJsonReport(sessionId, result)
            .then(() => console.log('Analysis result saved to server'))
            .catch(err => {
              console.error('Failed to save analysis result to server:', err)
              message.error(t('meeting.errorSaveReportFailed'))
            })
        }

        // 提取转录校正
        const allContent = messages.value.filter(m => m.role === 'assistant').map(m => m.content || '').join('\n')
        const corrections = extractCorrections(allContent)
        if (corrections) {
          correctedSentences.value = corrections
        }
        
        completed.value = true
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
    completed,
    correctedSentences,
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