<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NCard, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchUSBDevices, fetchUSBHistory } from '@/api/hermes/usb'
import USBEventHistory from '@/components/hermes/usb/USBEventHistory.vue'
import USBFileBrowser from '@/components/hermes/usb/USBFileBrowser.vue'
import { useUSBStream } from '@/composables/useUSBStream'

const { t } = useI18n()
const message = useMessage()
const usbStore = useUSBStream()

const refreshing = ref(false)
const selectedUuid = ref('')

const devices = computed(() => usbStore.devices)
const selectedDevice = computed(() => devices.value.find(device => device.uuid === selectedUuid.value) || devices.value[0] || null)
const runtimeState = computed(() => usbStore.runtime?.state || 'idle')

function runtimeTagType() {
  if (runtimeState.value === 'running') return 'success'
  if (runtimeState.value === 'error') return 'error'
  if (runtimeState.value === 'unsupported') return 'warning'
  return 'default'
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return t('usb.page.unknown')
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let next = value
  let unitIndex = 0
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024
    unitIndex += 1
  }
  return `${next.toFixed(next >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatTime(value: string | null): string {
  if (!value) return t('usb.page.unknown')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function deviceTitle(device: typeof devices.value[number]): string {
  return device.label?.trim() || device.uuid
}

async function refreshSnapshot() {
  refreshing.value = true
  try {
    const [deviceResponse, historyResponse] = await Promise.all([
      fetchUSBDevices(),
      fetchUSBHistory('24h'),
    ])
    usbStore.hydrate({
      runtime: deviceResponse.runtime,
      devices: deviceResponse.devices,
      events: historyResponse.events,
    })
  } catch (error: any) {
    message.error(error?.message || t('usb.page.loadFailed'))
  } finally {
    refreshing.value = false
  }
}

watch(
  devices,
  (nextDevices) => {
    if (nextDevices.length === 0) {
      selectedUuid.value = ''
      return
    }
    if (!nextDevices.some(device => device.uuid === selectedUuid.value)) {
      selectedUuid.value = nextDevices[0]?.uuid || ''
    }
  },
  { immediate: true },
)

onMounted(() => {
  usbStore.clearUnread()
})
</script>

<template>
  <div class="usb-view">
    <header class="page-header">
      <div>
        <h2 class="page-title">{{ t('usb.page.title') }}</h2>
        <p class="page-subtitle">{{ t('usb.page.subtitle') }}</p>
      </div>

      <div class="page-actions">
        <NTag :type="runtimeTagType()">
          {{ t(`usb.page.runtime.${runtimeState}`) }}
        </NTag>
        <span class="runtime-meta">{{ t('usb.page.deviceCount', { count: devices.length }) }}</span>
        <span class="runtime-meta">{{ t('usb.page.unreadCount', { count: usbStore.unreadCount }) }}</span>
        <NButton size="small" type="primary" :loading="refreshing" @click="refreshSnapshot">
          {{ t('usb.page.refresh') }}
        </NButton>
      </div>
    </header>

    <NSpin :show="refreshing && devices.length === 0" class="usb-spin">
      <div v-if="devices.length === 0" class="page-empty">
        <NEmpty :description="t('usb.page.empty')">
          <template #extra>
            <NButton size="small" type="primary" :loading="refreshing" @click="refreshSnapshot">
              {{ t('usb.page.refresh') }}
            </NButton>
          </template>
        </NEmpty>
      </div>

      <template v-else>
        <section class="device-grid">
          <button
            v-for="device in devices"
            :key="device.uuid"
            type="button"
            class="device-card"
            :class="{ active: selectedDevice?.uuid === device.uuid }"
            @click="selectedUuid = device.uuid"
          >
            <div class="device-card-top">
              <strong>{{ deviceTitle(device) }}</strong>
              <NTag size="small" :type="device.status === 'mount_failed' ? 'error' : 'success'">
                {{ t(`usb.page.status.${device.status}`) }}
              </NTag>
            </div>
            <div class="device-card-meta">{{ device.mountPoint }}</div>
            <div class="device-card-grid">
              <span>{{ t('usb.page.fsType') }}: {{ device.fsType || t('usb.page.unknown') }}</span>
              <span>{{ t('usb.page.size') }}: {{ formatBytes(device.sizeBytes) }}</span>
              <span>{{ t('usb.page.lastUpdated') }}: {{ formatTime(device.ts) }}</span>
              <span>{{ t('usb.page.deviceNode') }}: {{ device.deviceNode }}</span>
            </div>
            <div v-if="device.error" class="device-card-error">{{ device.error }}</div>
          </button>
        </section>

        <div class="page-content">
          <div class="browser-column">
            <USBFileBrowser :device="selectedDevice" />
          </div>

          <div class="side-column">
            <NCard :title="t('usb.page.details')">
              <div v-if="selectedDevice" class="detail-list">
                <div><span>{{ t('usb.page.name') }}</span><strong>{{ deviceTitle(selectedDevice) }}</strong></div>
                <div><span>{{ t('usb.page.mountPoint') }}</span><strong>{{ selectedDevice.mountPoint }}</strong></div>
                <div><span>{{ t('usb.page.fsType') }}</span><strong>{{ selectedDevice.fsType || t('usb.page.unknown') }}</strong></div>
                <div><span>{{ t('usb.page.vendor') }}</span><strong>{{ selectedDevice.vendor || t('usb.page.unknown') }}</strong></div>
                <div><span>{{ t('usb.page.model') }}</span><strong>{{ selectedDevice.model || t('usb.page.unknown') }}</strong></div>
                <div><span>{{ t('usb.page.serial') }}</span><strong>{{ selectedDevice.serial || t('usb.page.unknown') }}</strong></div>
              </div>
              <NEmpty v-else :description="t('usb.page.selectDevice')" size="small" />
            </NCard>

            <NCard :title="t('usb.page.runtimeTitle')">
              <div class="detail-list">
                <div><span>{{ t('usb.page.runtimeLabel') }}</span><strong>{{ t(`usb.page.runtime.${runtimeState}`) }}</strong></div>
                <div><span>{{ t('usb.page.lastReadyAt') }}</span><strong>{{ formatTime(usbStore.runtime?.lastReadyAt || null) }}</strong></div>
                <div><span>{{ t('usb.page.lastHeartbeatAt') }}</span><strong>{{ formatTime(usbStore.runtime?.lastHeartbeatAt || null) }}</strong></div>
                <div><span>{{ t('usb.page.lastError') }}</span><strong>{{ usbStore.runtime?.lastError || t('usb.page.none') }}</strong></div>
              </div>
            </NCard>

            <NCard>
              <USBEventHistory :events="usbStore.history" @pick-device="selectedUuid = $event" />
            </NCard>
          </div>
        </div>
      </template>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-title {
  margin: 0;
  font-size: 24px;
}

.page-subtitle {
  margin: 6px 0 0;
  color: $text-muted;
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.runtime-meta {
  color: $text-muted;
  font-size: 13px;
}

.page-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 420px;
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.device-card {
  border: 1px solid $border-color;
  border-radius: 14px;
  background: $bg-card;
  color: inherit;
  text-align: left;
  padding: 14px;
  cursor: pointer;
}

.device-card.active {
  border-color: $accent-primary;
  box-shadow: 0 0 0 1px rgba(24, 160, 88, 0.2);
}

.device-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.device-card-meta,
.device-card-grid,
.device-card-error {
  font-size: 13px;
  color: $text-muted;
}

.device-card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}

.device-card-error {
  color: $error;
  margin-top: 8px;
}

.page-content {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(300px, 0.9fr);
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.browser-column,
.side-column {
  min-width: 0;
  min-height: 0;
}

.side-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-list > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-list span {
  color: $text-muted;
  font-size: 12px;
}

@media (max-width: $breakpoint-mobile) {
  .page-header,
  .page-content,
  .device-card-grid {
    grid-template-columns: 1fr;
  }

  .page-header {
    flex-direction: column;
  }

  .page-actions {
    justify-content: flex-start;
  }

  .page-content {
    display: flex;
    flex-direction: column;
  }
}
</style>
