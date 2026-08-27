/**
 * 会议场景模板元数据。
 *
 * 单一的"模板清单 + 默认值 + 校验"模块：
 * - SceneId           合法 id 联合类型
 * - SCENE_IDS         渲染顺序固定的全部模板 id
 * - DEFAULT_SCENE_ID  兜底模板
 * - isSceneId         类型守卫
 * - normalizeSceneId  把任意输入归一化成 SceneId
 *
 * 注意：这里的"场景"只指**模板元数据**，不再承担"独立整页路由"职责。
 * 整页只有 /hermes/meeting 一个 MeetingView；模板影响的是该视图内的样式与提示，
 * 而不是切到另一个独立页面（见 docs/meeting-view-split-blueprint.md）。
 */

export type SceneId = 'general' | 'business' | 'medical' | 'legal' | 'interview'

export const SCENE_IDS: readonly SceneId[] = [
  'general',
  'business',
  'medical',
  'legal',
  'interview',
] as const

export const DEFAULT_SCENE_ID: SceneId = 'general'

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === 'string' && (SCENE_IDS as readonly string[]).includes(value)
}

export function normalizeSceneId(value: unknown): SceneId {
  return isSceneId(value) ? value : DEFAULT_SCENE_ID
}