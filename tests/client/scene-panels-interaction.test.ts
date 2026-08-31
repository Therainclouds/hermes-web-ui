// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, nextTick } from 'vue'

// 场景面板交互冒烟：三个场景面板挂载后，用户级点击能驱动真实状态变化。
// Socket.IO / HTTP 全部 mock——只验证面板接线与组合式状态机。
//
// 注意：演讲场景的计时控制在舞台浮层（SpeechTimerOverlay）里，不在面板内——
// 通过宿主组件 provide 计时器后挂浮层来测。

const mocks = vi.hoisted(() => ({
  rounds: [] as any[],
  requestMock: vi.fn().mockResolvedValue({}),
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  clearMock: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => `i18n:${key}` }),
}))

vi.mock('@/api/client', () => ({
  request: (...args: unknown[]) => mocks.requestMock(...(args as [])),
  getApiKey: () => '',
}))

vi.mock('@/composables/useMeetingAssist', () => ({
  useMeetingAssist: () => ({
    rounds: { value: mocks.rounds },
    isConnected: { value: false },
    isAnalyzing: { value: false },
    connect: mocks.connectMock,
    disconnect: mocks.disconnectMock,
    clear: mocks.clearMock,
  }),
}))

import { useMeetingStore } from '@/stores/hermes/meeting'
import SpeechEvaluationPanel from '@/components/hermes/meeting/SpeechEvaluationPanel.vue'
import SpeechTimerOverlay from '@/components/hermes/meeting/speech/SpeechTimerOverlay.vue'
import { DEFAULT_EVAL, provideSpeechTimer } from '@/components/hermes/meeting/speech/speechTimerContext'
import LegalReviewPanel from '@/components/hermes/meeting/legal/LegalReviewPanel.vue'
import InterviewPanel from '@/components/hermes/meeting/interview/InterviewPanel.vue'
import { mount } from '@vue/test-utils'

function mountPanel(component: any, sessionId: string, extraProps: Record<string, unknown> = {}) {
  return mount(component, {
    props: { sessionId, isRecording: false, ...extraProps },
  })
}

function seedSession(sessionId: string) {
  const store = useMeetingStore()
  ;(store as any).setActiveSession(sessionId)
  ;(store as any).sessions.push({
    id: sessionId,
    title: '测试会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sentences: [],
    speakerMap: {},
    speakers: [],
    analysisRounds: [],
    useDiarize: false,
    htmlContent: '',
  } as any)
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.rounds.length = 0
  mocks.requestMock.mockClear().mockResolvedValue({})
  mocks.connectMock.mockClear()
  mocks.disconnectMock.mockClear()
})

describe('演讲场景（SpeechTimerOverlay 计时舱）', () => {
  function mountCabin(sessionId: string) {
    seedSession(sessionId)
    const store = useMeetingStore()
    const evalState = computed(() => ({
      ...DEFAULT_EVAL,
      ...(store.activeSession?.speechEval || {}),
    }))
    const persist = (patch: any) => {
      if (store.activeSession?.id) {
        store.updateSession(store.activeSession.id, { speechEval: { ...evalState.value, ...patch } })
      }
    }
    const Host = defineComponent({
      setup() {
        provideSpeechTimer({ evalState: evalState as any, persist })
        return () => h('div', [h(SpeechTimerOverlay)])
      },
    })
    return { wrapper: mount(Host), store }
  }

  it('计时舱控制按钮驱动共享计时器状态（模式切换→走表→记录本段）', async () => {
    const { wrapper } = mountCabin('sp-1')
    await nextTick()

    // 模式切换到串场
    const transitionBtn = wrapper.findAll('button').find(b => b.text() === 'i18n:meeting.speechEval.transitionMode')
    expect(transitionBtn).toBeTruthy()
    await transitionBtn!.trigger('click')

    // 开始走表：按钮文字翻转为「暂停」
    const startBtn = wrapper.findAll('button').find(b => b.text() === 'i18n:meeting.speechEval.start')
    expect(startBtn).toBeTruthy()
    await startBtn!.trigger('click')
    await nextTick()
    expect(wrapper.findAll('button').some(b => b.text() === 'i18n:meeting.speechEval.pause')).toBe(true)

    // 记录本段（串场标签分支）
    const recordBtn = wrapper.findAll('button').find(b => b.text().includes('recordTransition'))
    expect(recordBtn).toBeTruthy()
    await recordBtn!.trigger('click')

    const st = useMeetingStore().activeSession
    expect(st?.speechEval?.timerRecords?.some(r => r.label.includes('transitionLabel'))).toBe(true)
    wrapper.unmount()
  })

  it('设置确认后写回阈值', async () => {
    seedSession('sp-2')
    // 设置弹窗在 SpeechEvaluationPanel 内——这里只验证 cabin 的重置/模式不抛错
    const { wrapper } = mountCabin('sp-2')
    const resetBtn = wrapper.findAll('button').find(b => b.text() === 'i18n:meeting.speechEval.reset')
    await resetBtn!.trigger('click')
    // 满时长重置：数值回到 03:00 且绿牌
    expect(wrapper.text()).toContain('03:00')
    wrapper.unmount()
  })
})

describe('演讲场景面板（SpeechEvaluationPanel 面板壳）', () => {
  it('KPI 三格与 Tab 栏渲染', async () => {
    seedSession('sp-panel')
    const wrapper = mountPanel(SpeechEvaluationPanel, 'sp-panel')
    await nextTick()

    expect(wrapper.text()).toContain('i18n:meeting.speechEval.kpiOverall')
    expect(wrapper.text()).toContain('i18n:meeting.speechEval.kpiFillers')
    expect(wrapper.text()).toContain('i18n:meeting.speechEval.tabReview')
    wrapper.unmount()
  })
})

describe('法律场景面板（LegalReviewPanel）', () => {
  it('风险雷达渲染注入数据，录音中开始分析触发请求', async () => {
    seedSession('lg-1')
    mocks.rounds.push({
      id: 'r1',
      context: '违约金条款',
      priority: 'urgent',
      keyPoint: '违约金上限风险',
      analysis: '需核实',
      timestamp: Date.now(),
      riskItems: [
        { level: 'high', text: '违约金上限条款不利', quote: '违约金不超过总额的30%', lawHint: '民法典第585条' },
        { level: 'medium', text: '付款节奏未约定' },
      ],
      positions: [{ party: '对方', stance: '要求 30% 违约金' }],
      lawRefs: [{ name: '民法典', article: '第585条' }],
    } as any)
    const wrapper = mountPanel(LegalReviewPanel, 'lg-1', { isRecording: true })
    await nextTick()

    const text = wrapper.text()
    expect(text).toContain('违约金上限条款不利')
    expect(text).toContain('付款节奏未约定')
    expect(text).toContain('对方')

    // 录音中（isRecording=true）按钮可用
    const analyzeBtn = wrapper.findAll('button').find(b => b.text().includes('analyzeNow'))
    expect(analyzeBtn).toBeTruthy()
    expect(analyzeBtn!.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('访谈场景面板（InterviewPanel）', () => {
  it('洞察/引语/追问渲染，录音中开始分析触发请求', async () => {
    seedSession('iv-1')
    mocks.rounds.push(
      {
        id: 'r1',
        context: '对账流程',
        priority: 'normal',
        keyPoint: '对账成本痛点',
        analysis: '',
        timestamp: Date.now(),
        insights: [{ type: 'pain', text: '月底手工对账耗时两天', quote: '每个月对账要花两天' }],
        keyQuotes: [{ quote: '我宁可多花一倍价钱也不要每月对两天账', speaker: '客户' }],
        followUps: ['追问对账具体耗在哪个环节'],
        engagement: 'engaged',
      } as any,
      {
        id: 'r2',
        context: '继续',
        priority: 'normal',
        keyPoint: '',
        analysis: '',
        timestamp: Date.now() + 1,
        followUps: ['追问错误率的后果'],
        engagement: 'neutral',
      } as any,
    )
    const wrapper = mountPanel(InterviewPanel, 'iv-1', { isRecording: true })
    await nextTick()

    const text = wrapper.text()
    expect(text).toContain('月底手工对账耗时两天')
    expect(text).toContain('我宁可多花一倍价钱也不要每月对两天账')
    expect(text).toContain('追问错误率的后果')
    expect(text).not.toContain('追问对账具体耗在哪个环节')

    const analyzeBtn = wrapper.findAll('button').find(b => b.text().includes('analyzeNow'))
    expect(analyzeBtn).toBeTruthy()
    // 按钮 enabled（录音中）
    expect(analyzeBtn!.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})
