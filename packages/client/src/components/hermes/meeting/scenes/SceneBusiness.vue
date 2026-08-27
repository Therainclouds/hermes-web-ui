<script setup lang="ts">
// Business 场景页面骨架。
// AgendaTimeline / DecisionPanel / KPIStrip 三个场景专属子组件留待后续 PR 补齐。
// 本文件先搭好三栏布局 + 占位说明，方便 designer / PM 在浏览器里看到结构。

import SceneHeader from './shared/SceneHeader.vue'
import SceneControlBar from './shared/SceneControlBar.vue'
import SceneTranscript from './shared/SceneTranscript.vue'
import type { SceneId } from '.'

defineProps<{
  sessionId: string
  sceneId?: SceneId
}>()

defineEmits<{
  (e: 'open-settings'): void
  (e: 'close-session'): void
}>()

const isRecording = false
const isPaused = false
const isBusy = false
</script>

<template>
  <div class="scene-business">
    <SceneHeader
      :session-id="sessionId"
      @open-settings="$emit('open-settings')"
      @close-session="$emit('close-session')"
    />
    <div class="scene-business__body">
      <aside class="scene-business__agenda scene-business__panel">
        <h3 class="scene-business__panel-title">议程</h3>
        <p class="scene-business__placeholder">
          AgendaTimeline 子组件待后续 PR 实现（参见 docs/design/meeting-scenes/SceneBusiness.md §3）
        </p>
      </aside>
      <main class="scene-business__transcript">
        <SceneTranscript :session-id="sessionId" />
      </main>
      <aside class="scene-business__decisions scene-business__panel">
        <h3 class="scene-business__panel-title">决策项</h3>
        <p class="scene-business__placeholder">
          DecisionPanel 子组件待后续 PR 实现
        </p>
      </aside>
    </div>
    <section class="scene-business__kpis">
      <h3 class="scene-business__panel-title">KPI</h3>
      <p class="scene-business__placeholder">
        KPIStrip 子组件待后续 PR 实现
      </p>
    </section>
    <SceneControlBar
      :session-id="sessionId"
      :is-recording="isRecording"
      :is-paused="isPaused"
      :is-busy="isBusy"
    />
  </div>
</template>

<style scoped>
.scene-business {
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  height: 100%;
  min-height: 0;
}
.scene-business__body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 320px;
  gap: 16px;
  padding: 16px 20px;
  min-height: 0;
  overflow: hidden;
}
.scene-business__agenda,
.scene-business__decisions {
  min-height: 0;
  overflow: auto;
}
.scene-business__transcript {
  min-height: 0;
  overflow: hidden;
}
.scene-business__kpis {
  padding: 12px 20px;
  border-top: 1px solid var(--divider-color, #e0e0e0);
  background: var(--action-color, #f5f5f5);
}
.scene-business__panel {
  background: var(--card-color, #fff);
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 8px;
  padding: 12px 14px;
}
.scene-business__panel-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color-2, #666);
}
.scene-business__placeholder {
  margin: 0;
  color: var(--text-color-3, #999);
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 1280px) {
  .scene-business__body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(180px, 1fr) auto;
  }
  .scene-business__agenda,
  .scene-business__decisions {
    max-height: 200px;
  }
}
</style>