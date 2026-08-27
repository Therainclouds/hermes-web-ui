<script setup lang="ts">
import SceneHeader from './shared/SceneHeader.vue'
import SceneControlBar from './shared/SceneControlBar.vue'
import SpeechEvaluationPanel from '@/components/hermes/meeting/SpeechEvaluationPanel.vue'
import type { SceneId } from '.'

defineProps<{
  sessionId: string
  sceneId?: SceneId
}>()

defineEmits<{
  (e: 'open-settings'): void
  (e: 'close-session'): void
}>()

// 占位：录音状态由父组件维护
const isRecording = false
const isPaused = false
const isBusy = false
</script>

<template>
  <div class="scene-speech">
    <SceneHeader
      :session-id="sessionId"
      @open-settings="$emit('open-settings')"
      @close-session="$emit('close-session')"
    />
    <div class="scene-speech__body">
      <SpeechEvaluationPanel :session-id="sessionId" class="scene-speech__panel" />
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
.scene-speech {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
  min-height: 0;
}
.scene-speech__body {
  padding: 16px 20px;
  min-height: 0;
  overflow: auto;
}
.scene-speech__panel {
  min-height: 0;
}
</style>