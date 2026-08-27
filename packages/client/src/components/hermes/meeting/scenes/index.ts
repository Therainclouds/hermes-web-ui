// Meeting 场景页面注册表
//
// 每个 sceneId 对应一个独立 .vue 组件，由 Vite 拆分为独立 chunk。
// 调度壳（MeetingView.vue）通过 resolveSceneComponent 拿到组件并 <component :is> 渲染。
//
// 命名约束：
// - 文件名：Scene<PascalCase>.vue
// - 导出：defineComponent default export
// - props：{ sessionId: string, sceneId: SceneId }
// - 不依赖 MeetingView.vue 的 wizard 状态（那些留在调度壳或拆到 MeetingSetupView）

import { defineAsyncComponent, type Component } from 'vue'

export type SceneId =
  | 'general'
  | 'business'
  | 'speech'
  | 'medical'
  | 'legal'
  | 'interview'

export const SCENE_IDS: readonly SceneId[] = [
  'general',
  'business',
  'speech',
  'medical',
  'legal',
  'interview',
] as const

export const DEFAULT_SCENE_ID: SceneId = 'general'

const registry: Record<SceneId, () => Promise<{ default: Component }>> = {
  general: () => import('./SceneGeneral.vue'),
  business: () => import('./SceneBusiness.vue'),
  speech: () => import('./SceneSpeech.vue'),
  // medical / legal / interview 后续按 docs/design/meeting-scenes/Scene*.md 实现
  medical: () => import('./SceneGeneral.vue'),   // 占位：未来单独实现
  legal: () => import('./SceneGeneral.vue'),
  interview: () => import('./SceneGeneral.vue'),
}

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === 'string' && (SCENE_IDS as readonly string[]).includes(value)
}

export function resolveSceneComponent(id: SceneId) {
  return defineAsyncComponent(registry[id])
}

export function normalizeSceneId(raw: unknown): SceneId {
  return isSceneId(raw) ? raw : DEFAULT_SCENE_ID
}