<script setup lang="ts">
import SceneHeader from './shared/SceneHeader.vue'
import SceneControlBar from './shared/SceneControlBar.vue'
import SceneTranscript from './shared/SceneTranscript.vue'
import MeetingAgentPanel from '@/components/hermes/meeting/MeetingAgentPanel.vue'
import type { SceneId } from '.'

defineProps<{
  sessionId: string
  sceneId?: SceneId
}>()

defineEmits<{
  (e: 'open-settings'): void
  (e: 'close-session'): void
}>()

// 占位：录音状态由父组件（MeetingView）维护，本场景页面不重复持有。
// 后续 PR-2 会把录音控制也下放到 shared/SceneControlBar 内部。
const isRecording = false
const isPaused = false
const isBusy = false
</script>

<template>
  <div class="scene-general">
    <SceneHeader
      :session-id="sessionId"
      @open-settings="$emit('open-settings')"
      @close-session="$emit('close-session')"
    />
    <div class="scene-general__body">
      <SceneTranscript :session-id="sessionId" class="scene-general__transcript" />
      <MeetingAgentPanel
        :session-id="sessionId"
        scene-template="general"
        class="scene-general__agent"
      />
    </div>
    <SceneControlBar
      :session-id="sessionId"
      :is-recording="isRecording"
      :is-paused="isPaused"
      :is-busy="isBusy"
    />
  </div>
</template>

<style scoped>
.scene-general {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
  min-height: 0;
}
.scene-general__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(380px, 40%);
  gap: 16px;
  padding: 16px 20px;
  min-height: 0;
  overflow: hidden;
}
.scene-general__transcript,
.scene-general__agent {
  min-height: 0;
  overflow: auto;
}
@media (max-width: 1280px) {
  .scene-general__body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(180px, 1fr) minmax(220px, 1fr);
  }
}
</style>