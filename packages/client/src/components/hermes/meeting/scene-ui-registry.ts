import type { Component } from 'vue'
import type { SceneId } from './scene-templates'
import SpeechTimerOverlay from './speech/SpeechTimerOverlay.vue'
import SpeechTranscriptStrip from './speech/SpeechTranscriptStrip.vue'
import LegalReviewPanel from './legal/LegalReviewPanel.vue'
import LegalRiskStrip from './legal/LegalRiskStrip.vue'

/**
 * 场景 → UI 组件注册表（会议场景定制化的扩展点）。
 *
 * 每个场景可声明四类专属 UI，由 MeetingView / MeetingRightPanel 按
 * 当前会话的 sceneTemplate 渲染；未声明的槽位回退到通用表现：
 *
 *   - stageOverlay    波形舞台之上的场景浮层（speech = 计时器浮层）
 *   - transcriptStrip 转写区顶部的场景状态条（speech = 计时状态条）
 *   - rightPanel      右栏场景主面板（speech = SpeechEvaluationPanel，
 *                     经 MeetingRightPanel 的 speech > agent > realtime >
 *                     analysis 既有优先级分发，本注册表只提供场景面板来源）
 *   - topbarWidget    顶栏场景控件（speech = 计时模式切换 + TTS 开关）
 *
 * 新场景接入 = 写组件 + 在此注册；不改 MeetingView 主体。
 * 组件内部状态一律来自共享单例（如 useSpeechTimer）或会议 store，
 * 注册表渲染时不传 props。
 */
export interface SceneUIContribution {
  stageOverlay?: Component
  transcriptStrip?: Component
  rightPanel?: Component
  topbarWidget?: Component
}

import SpeechEvaluationPanel from './SpeechEvaluationPanel.vue'

export const SCENE_UI: Record<SceneId, SceneUIContribution> = {
  general: {},
  business: {},
  medical: {},
  legal: {
    transcriptStrip: LegalRiskStrip,
    rightPanel: LegalReviewPanel,
  },
  interview: {},
  speech: {
    stageOverlay: SpeechTimerOverlay,
    transcriptStrip: SpeechTranscriptStrip,
    rightPanel: SpeechEvaluationPanel,
  },
}
