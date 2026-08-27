<script setup lang="ts">
// 复用 useMeetingAssist 的 Socket.IO 连接；但转写展示来自 store.session.sentences
// （rounds 是分析轮次，不是句子流；之前误用 rounds 现在修掉）

import { computed, ref, watch, nextTick } from 'vue'
import { NSpin, NEmpty } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { useMeetingStore } from '@/stores/hermes/meeting'

const props = defineProps<{
  sessionId: string
  fontSize?: 'normal' | 'large'
}>()

const { t } = useI18n()

const { isConnected, connect, disconnect } = useMeetingAssist(props.sessionId)
const meetingStore = useMeetingStore()

const session = computed(() =>
  meetingStore.sessions.find(s => s.id === props.sessionId),
)

const sentences = computed(() => session.value?.sentences ?? [])

const finalSentences = computed(() =>
  sentences.value.map((s, i) => ({
    idx: i,
    text: s.text,
    speaker: s.speaker,
    time: new Date(s.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
  })),
)

const scrollEl = ref<HTMLElement | null>(null)
watch(
  () => finalSentences.value.length,
  async () => {
    await nextTick()
    if (scrollEl.value) {
      scrollEl.value.scrollTop = scrollEl.value.scrollHeight
    }
  },
)

const fontClass = computed(() =>
  props.fontSize === 'large' ? 'scene-transcript__sentence--large' : '',
)

defineExpose({ connect, disconnect, isConnected })
</script>

<template>
  <section class="scene-transcript">
    <header class="scene-transcript__bar">
      <span>{{ t('meeting.transcript.title') }}</span>
      <span v-if="!isConnected" class="scene-transcript__hint">
        <NSpin size="small" /> {{ t('meeting.transcript.connecting') }}
      </span>
      <span v-else class="scene-transcript__hint">
        🟢 {{ t('meeting.transcript.live') }}
      </span>
    </header>
    <div ref="scrollEl" class="scene-transcript__body">
      <NEmpty
        v-if="finalSentences.length === 0"
        :description="t('meeting.transcript.empty')"
        class="scene-transcript__empty"
      />
      <ol v-else class="scene-transcript__list">
        <li
          v-for="s in finalSentences"
          :key="s.idx"
          class="scene-transcript__sentence"
          :class="fontClass"
        >
          <span class="scene-transcript__time">{{ s.time }}</span>
          <span v-if="s.speaker" class="scene-transcript__speaker">{{ s.speaker }}</span>
          <span class="scene-transcript__text">{{ s.text }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.scene-transcript {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--card-color, #fff);
  border-radius: 8px;
}
.scene-transcript__bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--divider-color, #e0e0e0);
  font-size: 13px;
  color: var(--text-color-2, #666);
}
.scene-transcript__hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.scene-transcript__body {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}
.scene-transcript__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.scene-transcript__sentence {
  display: flex;
  gap: 10px;
  align-items: baseline;
  line-height: 1.55;
}
.scene-transcript__time {
  font-variant-numeric: tabular-nums;
  color: var(--text-color-3, #999);
  font-size: 12px;
  flex-shrink: 0;
}
.scene-transcript__speaker {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--primary-color, #333);
  font-weight: 600;
}
.scene-transcript__text {
  flex: 1;
}
.scene-transcript__sentence--large .scene-transcript__text {
  font-size: 18px;
  line-height: 1.7;
}
.scene-transcript__empty {
  padding-top: 40px;
}
</style>