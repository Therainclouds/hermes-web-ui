<script setup lang="ts">
// Meeting 调度壳（新路由：/hermes/meeting/scene/:scene?）
//
// 职责：
// 1. 决定当前 sessionId / sceneId
// 2. 通过 scenes 注册表加载对应场景组件
// 3. 把录音 / 暂停 / 停止 / 出报告等控制事件分发到 MeetingView 现有逻辑
//
// 设计原则：
// - 不复制 MeetingView.vue 的 wizard / ASR 配置 / SSE 状态
// - 不破坏现有 /hermes/meeting 路由
// - 本视图只接管"录音进行中的页面渲染"
//
// 后续 PR：
// - 把 ASR 配置 / OSS 配置 / 创建会议 wizard 拆到独立 MeetingSetupView
// - 把录音控制 / 转写状态机抽到 useMeetingController composable

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  resolveSceneComponent,
  normalizeSceneId,
  type SceneId,
} from '@/components/hermes/meeting/scenes'
import { useMeetingStore } from '@/stores/hermes/meeting'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const meetingStore = useMeetingStore()

// 优先级：URL :scene 参数 > activeSession.sceneTemplate > 'general'
const sceneId = computed<SceneId>(() => {
  const raw = route.params.scene ?? meetingStore.activeSession?.sceneTemplate
  return normalizeSceneId(raw)
})

const SceneComponent = computed(() => resolveSceneComponent(sceneId.value))

const sessionId = computed(() => meetingStore.activeSession?.id ?? '')

function onOpenSettings() {
  // 临时：跳回老 MeetingView 的设置入口
  // 后续 PR：拆 MeetingSetupView 后跳那里
  router.push('/hermes/meeting')
}

function onCloseSession() {
  meetingStore.setActiveSession('')
  router.push('/hermes/meeting')
}
</script>

<template>
  <div class="meeting-scene-shell">
    <component
      :is="SceneComponent"
      :session-id="sessionId"
      :scene-id="sceneId"
      @open-settings="onOpenSettings"
      @close-session="onCloseSession"
    />
    <p v-if="!sessionId" class="meeting-scene-shell__empty">
      {{ t('meeting.sceneShell.noActiveSession') }}
    </p>
  </div>
</template>

<style scoped>
.meeting-scene-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.meeting-scene-shell__empty {
  margin: 40px;
  color: var(--text-color-3, #999);
  text-align: center;
}
</style>