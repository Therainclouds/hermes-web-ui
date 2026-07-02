<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NEmpty, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { USBEventRecord } from '@/api/hermes/usb-socket'

const props = defineProps<{
  events: USBEventRecord[]
}>()

const emit = defineEmits<{
  pickDevice: [uuid: string]
}>()

const { t } = useI18n()

const recentEvents = computed(() => props.events.slice(0, 20))

function eventTitle(event: USBEventRecord): string {
  if (event.status === 'mount_failed') return t('usb.page.history.mountFailed')
  return event.action === 'remove'
    ? t('usb.page.history.removed')
    : t('usb.page.history.mounted')
}

function eventType(event: USBEventRecord): 'success' | 'warning' | 'error' | 'info' | 'default' {
  if (event.status === 'mount_failed') return 'error'
  return event.action === 'remove' ? 'warning' : 'success'
}

function eventLabel(event: USBEventRecord): string {
  return event.label?.trim() || t('usb.notifications.unknownDevice')
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? String(ts) : date.toLocaleString()
}
</script>

<template>
  <section class="usb-history">
    <div class="section-header">
      <div class="section-title-wrap">
        <span class="section-kicker">Activity</span>
        <h3>{{ t('usb.page.history.title') }}</h3>
      </div>
      <span class="section-meta">{{ t('usb.page.history.count', { count: recentEvents.length }) }}</span>
    </div>

    <div v-if="recentEvents.length === 0" class="empty-wrap">
      <NEmpty :description="t('usb.page.history.empty')" size="small" />
    </div>

    <div v-else class="history-list">
      <article v-for="event in recentEvents" :key="event.id" class="history-item">
        <div class="history-line"></div>
        <div class="history-main">
          <div class="history-top">
            <NTag size="small" :type="eventType(event)">
              {{ eventTitle(event) }}
            </NTag>
            <span class="history-time">{{ formatTime(event.ts) }}</span>
          </div>

          <div class="history-label">{{ eventLabel(event) }}</div>
          <div class="history-path">{{ event.mountPoint || event.deviceNode }}</div>
          <div v-if="event.error" class="history-error">{{ event.error }}</div>
        </div>

        <NButton quaternary size="tiny" class="history-action" @click="emit('pickDevice', event.uuid)">
          {{ t('usb.page.history.openDevice') }}
        </NButton>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-history {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-kicker {
  color: rgba(151, 216, 255, 0.78);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.section-header h3 {
  margin: 0;
  font-size: 16px;
}

.section-meta {
  color: rgba(202, 214, 226, 0.5);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.empty-wrap {
  padding: 20px 0;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 14px 18px;
  border: 1px solid rgba(157, 204, 255, 0.1);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(10, 16, 24, 0.86), rgba(8, 12, 19, 0.92));
  position: relative;
}

.history-item::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(135deg, rgba(157, 204, 255, 0.06), transparent 36%, transparent 68%, rgba(157, 204, 255, 0.04));
}

.history-line {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 2px;
  align-self: stretch;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(127, 212, 255, 0.9), rgba(127, 212, 255, 0.15));
  box-shadow: 0 0 16px rgba(127, 212, 255, 0.35);
}

.history-main {
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.history-time,
.history-path {
  color: rgba(205, 217, 229, 0.56);
  font-size: 12px;
  word-break: break-all;
}

.history-label {
  font-weight: 600;
  color: #eef5fc;
}

.history-error {
  color: $error;
  word-break: break-word;
}

.history-action {
  position: relative;
  z-index: 1;
}

@media (max-width: $breakpoint-mobile) {
  .history-item {
    flex-direction: column;
  }
}
</style>
