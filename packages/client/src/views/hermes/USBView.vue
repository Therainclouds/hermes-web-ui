<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NCard, NEmpty, NSpin, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { copyUSBFileToWorkspace, fetchUSBDevices, fetchUSBHistory } from '@/api/hermes/usb'
import USBEventHistory from '@/components/hermes/usb/USBEventHistory.vue'
import USBFileBrowser from '@/components/hermes/usb/USBFileBrowser.vue'
import { useUSBStream } from '@/composables/useUSBStream'
import { useChatStore } from '@/stores/hermes/chat'
import { useMessage } from '@/composables/useAppMessage'

const { t } = useI18n()
const message = useMessage()
const usbStore = useUSBStream()
const chatStore = useChatStore()

const refreshing = ref(false)
const selectedUuid = ref('')
const agentReadBusy = ref(false)
const agentStatusTone = ref<'info' | 'success' | 'error'>('info')
const agentStatusMessage = ref('')

const devices = computed(() => usbStore.devices)
const selectedDevice = computed(() => devices.value.find(device => device.uuid === selectedUuid.value) || devices.value[0] || null)
const runtimeState = computed(() => usbStore.runtime?.state || 'idle')
const activeChatSession = computed(() => chatStore.activeSession)
const activeChatSessionName = computed(() => activeChatSession.value?.title?.trim() || activeChatSession.value?.id || '')
const canUseActiveChatSession = computed(() => {
  const session = activeChatSession.value
  if (!session) return false
  return session.source !== 'coding_agent' && session.source !== 'global_agent' && session.source !== 'workflow'
})
const agentReadHint = computed(() => {
  if (!activeChatSession.value) return t('usb.page.agent.noActiveSession')
  if (!canUseActiveChatSession.value) return t('usb.page.agent.unsupportedSession')
  return t('usb.page.agent.usingSession', { session: activeChatSessionName.value })
})

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

function setAgentStatus(tone: 'info' | 'success' | 'error', text: string) {
  agentStatusTone.value = tone
  agentStatusMessage.value = text
}

async function handleReadWithAgent(payload: { path: string, name: string }) {
  const session = activeChatSession.value
  const device = selectedDevice.value
  if (!device || !session || !canUseActiveChatSession.value) {
    const fallback = !session
      ? t('usb.page.agent.noActiveSession')
      : t('usb.page.agent.unsupportedSession')
    setAgentStatus('error', fallback)
    message.error(fallback)
    return
  }

  agentReadBusy.value = true
  try {
    setAgentStatus('info', t('usb.page.agent.copying'))
    const copied = await copyUSBFileToWorkspace(device.uuid, payload.path, session.id)
    if (activeChatSession.value?.id === session.id) {
      activeChatSession.value.workspace = copied.workspace
    }
    setAgentStatus('info', t('usb.page.agent.starting'))
    const promptPath = copied.relativeWorkspacePath.replace(/\\/g, '/')
    await chatStore.sendMessage(t('usb.page.agent.readPrompt', { path: promptPath }))
    const successText = t('usb.page.agent.started', { session: activeChatSessionName.value })
    setAgentStatus('success', successText)
    message.success(successText)
  } catch (error: any) {
    const failureText = error?.message || t('usb.page.agent.failed')
    setAgentStatus('error', failureText)
    message.error(failureText)
  } finally {
    agentReadBusy.value = false
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
    <section class="overview-shell">
      <div class="overview-panel">
        <div class="overview-copy">
          <div class="overview-kicker">USB Console</div>
          <div class="overview-title-row">
            <h2 class="page-title">{{ t('usb.page.title') }}</h2>
            <NTag round :type="runtimeTagType()" class="runtime-badge">
              {{ t(`usb.page.runtime.${runtimeState}`) }}
            </NTag>
          </div>
          <p class="page-subtitle">{{ t('usb.page.subtitle') }}</p>
          <div class="session-line">
            <span class="session-dot"></span>
            <span>{{ agentReadHint }}</span>
          </div>
        </div>

        <div class="overview-tools">
          <NButton size="small" type="primary" ghost :loading="refreshing" @click="refreshSnapshot">
            {{ t('usb.page.refresh') }}
          </NButton>
        </div>
      </div>

      <div class="metric-grid">
        <article class="metric-card">
          <span class="metric-label">{{ t('usb.page.deviceCount', { count: devices.length }) }}</span>
          <strong class="metric-value">{{ devices.length }}</strong>
          <span class="metric-meta">{{ t('usb.page.details') }}</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">{{ t('usb.page.unreadCount', { count: usbStore.unreadCount }) }}</span>
          <strong class="metric-value">{{ usbStore.unreadCount }}</strong>
          <span class="metric-meta">{{ t('usb.page.history.title') }}</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">{{ t('usb.page.lastHeartbeatAt') }}</span>
          <strong class="metric-value metric-value--time">{{ formatTime(usbStore.runtime?.lastHeartbeatAt || null) }}</strong>
          <span class="metric-meta">{{ t(`usb.page.runtime.${runtimeState}`) }}</span>
        </article>
      </div>
    </section>

    <NSpin :show="refreshing && devices.length === 0" class="usb-spin">
      <div v-if="agentStatusMessage" class="agent-status" :class="`is-${agentStatusTone}`">
        {{ agentStatusMessage }}
      </div>

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
        <section class="device-stage">
          <div class="section-heading">
            <div>
              <h3>{{ t('usb.page.details') }}</h3>
              <p>{{ selectedDevice ? deviceTitle(selectedDevice) : t('usb.page.selectDevice') }}</p>
            </div>
            <span class="section-meta">{{ t('usb.page.deviceCount', { count: devices.length }) }}</span>
          </div>

          <div class="device-grid">
            <button
              v-for="device in devices"
              :key="device.uuid"
              type="button"
              class="device-card"
              :class="{ active: selectedDevice?.uuid === device.uuid }"
              @click="selectedUuid = device.uuid"
            >
              <div class="device-card-head">
                <span class="device-signal"></span>
                <div class="device-card-copy">
                  <strong>{{ deviceTitle(device) }}</strong>
                  <span class="device-card-meta">{{ device.mountPoint }}</span>
                </div>
                <NTag size="small" round :type="device.status === 'mount_failed' ? 'error' : 'success'">
                  {{ t(`usb.page.status.${device.status}`) }}
                </NTag>
              </div>

              <div class="device-card-grid">
                <div>
                  <span>{{ t('usb.page.fsType') }}</span>
                  <strong>{{ device.fsType || t('usb.page.unknown') }}</strong>
                </div>
                <div>
                  <span>{{ t('usb.page.size') }}</span>
                  <strong>{{ formatBytes(device.sizeBytes) }}</strong>
                </div>
                <div>
                  <span>{{ t('usb.page.lastUpdated') }}</span>
                  <strong>{{ formatTime(device.ts) }}</strong>
                </div>
                <div>
                  <span>{{ t('usb.page.deviceNode') }}</span>
                  <strong>{{ device.deviceNode }}</strong>
                </div>
              </div>
              <div v-if="device.error" class="device-card-error">{{ device.error }}</div>
            </button>
          </div>
        </section>

        <div class="workspace-grid">
          <NCard class="browser-column surface-card surface-card--browser" :bordered="false">
            <USBFileBrowser
              :device="selectedDevice"
              :agent-read-enabled="canUseActiveChatSession"
              :agent-read-busy="agentReadBusy"
              :agent-read-hint="agentReadHint"
              @read-with-agent="handleReadWithAgent"
            />
          </NCard>

          <aside class="side-column">
            <NCard class="side-card surface-card" :bordered="false">
              <template #header>
                <div class="card-header">
                  <span>{{ t('usb.page.details') }}</span>
                  <NTag v-if="selectedDevice" size="small" round :type="selectedDevice.status === 'mount_failed' ? 'error' : 'success'">
                    {{ t(`usb.page.status.${selectedDevice.status}`) }}
                  </NTag>
                </div>
              </template>
              <div v-if="selectedDevice" class="detail-list">
                <div><span>{{ t('usb.page.name') }}</span><strong>{{ deviceTitle(selectedDevice) }}</strong></div>
                <div><span>{{ t('usb.page.mountPoint') }}</span><strong>{{ selectedDevice.mountPoint }}</strong></div>
                <div><span>{{ t('usb.page.fsType') }}</span><strong>{{ selectedDevice.fsType || t('usb.page.unknown') }}</strong></div>
                <div><span>{{ t('usb.page.vendor') }}</span><strong>{{ selectedDevice.vendor || t('usb.page.unknown') }}</strong></div>
                <div><span>{{ t('usb.page.model') }}</span><strong>{{ selectedDevice.model || t('usb.page.unknown') }}</strong></div>
                <div><span>{{ t('usb.page.serial') }}</span><strong>{{ selectedDevice.serial || t('usb.page.unknown') }}</strong></div>
                <div v-if="selectedDevice.error" class="detail-error">
                  <span>{{ t('usb.page.lastError') }}</span>
                  <strong>{{ selectedDevice.error }}</strong>
                </div>
              </div>
              <NEmpty v-else :description="t('usb.page.selectDevice')" size="small" />
            </NCard>

            <NCard class="side-card surface-card" :bordered="false">
              <template #header>
                <div class="card-header">
                  <span>{{ t('usb.page.runtimeTitle') }}</span>
                  <span class="section-meta">{{ t(`usb.page.runtime.${runtimeState}`) }}</span>
                </div>
              </template>
              <div class="detail-list">
                <div><span>{{ t('usb.page.runtimeLabel') }}</span><strong>{{ t(`usb.page.runtime.${runtimeState}`) }}</strong></div>
                <div><span>{{ t('usb.page.lastReadyAt') }}</span><strong>{{ formatTime(usbStore.runtime?.lastReadyAt || null) }}</strong></div>
                <div><span>{{ t('usb.page.lastHeartbeatAt') }}</span><strong>{{ formatTime(usbStore.runtime?.lastHeartbeatAt || null) }}</strong></div>
                <div><span>{{ t('usb.page.lastError') }}</span><strong>{{ usbStore.runtime?.lastError || t('usb.page.none') }}</strong></div>
              </div>
            </NCard>

            <NCard class="side-card surface-card surface-card--history" :bordered="false">
              <USBEventHistory :events="usbStore.history" @pick-device="selectedUuid = $event" />
            </NCard>
          </aside>
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
  gap: 18px;
  height: 100%;
  min-height: 0;
}

.overview-shell {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.9fr);
  gap: 14px;
}

.overview-panel,
.metric-card,
.surface-card,
.device-card {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(157, 204, 255, 0.14);
  background:
    linear-gradient(180deg, rgba(11, 17, 26, 0.96), rgba(8, 12, 18, 0.94)),
    radial-gradient(circle at top right, rgba(96, 190, 255, 0.18), transparent 38%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    0 20px 48px rgba(0, 0, 0, 0.28);
}

.overview-panel {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  min-height: 188px;
  padding: 24px 26px;
  border-radius: 24px;
}

.overview-panel::after,
.metric-card::after,
.surface-card::after,
.device-card::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(135deg, rgba(157, 204, 255, 0.08), transparent 36%, transparent 64%, rgba(157, 204, 255, 0.05));
  opacity: 0.8;
}

.overview-copy,
.overview-tools {
  position: relative;
  z-index: 1;
}

.overview-copy {
  min-width: 0;
}

.overview-kicker {
  margin-bottom: 10px;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(151, 216, 255, 0.88);
}

.overview-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.page-title {
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.runtime-badge {
  background: rgba(120, 194, 255, 0.08);
}

.page-subtitle {
  margin: 10px 0 0;
  max-width: 720px;
  color: rgba(205, 217, 229, 0.7);
  font-size: 14px;
  line-height: 1.7;
}

.session-line {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding: 10px 12px;
  border-radius: 999px;
  background: rgba(129, 198, 255, 0.08);
  border: 1px solid rgba(129, 198, 255, 0.12);
  color: rgba(220, 231, 243, 0.78);
  font-size: 12px;
}

.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #78c2ff;
  box-shadow: 0 0 14px rgba(120, 194, 255, 0.8);
}

.overview-tools {
  display: flex;
  justify-content: flex-end;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.metric-card {
  min-width: 0;
  padding: 18px 18px 16px;
  border-radius: 22px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.metric-card > * {
  position: relative;
  z-index: 1;
}

.metric-label,
.metric-meta {
  color: rgba(202, 214, 226, 0.56);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.metric-value {
  font-size: 26px;
  line-height: 1.1;
  color: #f1f6fb;
}

.metric-value--time {
  font-size: 15px;
  line-height: 1.45;
  word-break: break-word;
}

.page-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 420px;
}

.agent-status {
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid rgba(157, 204, 255, 0.14);
  background: rgba(10, 15, 23, 0.82);
  backdrop-filter: blur(10px);
  font-size: 13px;
}

.agent-status.is-info {
  border-color: rgba(120, 194, 255, 0.28);
  color: #d9ecff;
}

.agent-status.is-success {
  border-color: rgba(102, 210, 162, 0.34);
  color: $success;
}

.agent-status.is-error {
  border-color: rgba(208, 48, 80, 0.35);
  color: $error;
}

.device-stage {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-heading,
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-heading h3,
.card-header span:first-child {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.section-heading p {
  margin: 5px 0 0;
  color: rgba(202, 214, 226, 0.62);
  font-size: 13px;
}

.section-meta {
  color: rgba(202, 214, 226, 0.5);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}

.device-card {
  color: inherit;
  text-align: left;
  padding: 16px 16px 15px;
  border-radius: 20px;
  cursor: pointer;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    background 0.18s ease;
}

.device-card:hover {
  transform: translateY(-2px);
  border-color: rgba(129, 198, 255, 0.34);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 18px 36px rgba(0, 0, 0, 0.28),
    0 0 0 1px rgba(129, 198, 255, 0.06);
}

.device-card.active {
  border-color: rgba(129, 198, 255, 0.55);
  background:
    linear-gradient(180deg, rgba(14, 22, 32, 0.98), rgba(8, 13, 19, 0.98)),
    radial-gradient(circle at top right, rgba(120, 194, 255, 0.22), transparent 42%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(129, 198, 255, 0.12),
    0 16px 34px rgba(0, 0, 0, 0.32);
}

.device-card > * {
  position: relative;
  z-index: 1;
}

.device-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.device-signal {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 999px;
  background: #7fd4ff;
  box-shadow: 0 0 0 4px rgba(127, 212, 255, 0.12), 0 0 18px rgba(127, 212, 255, 0.65);
}

.device-card-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.device-card-copy strong {
  font-size: 15px;
}

.device-card-meta {
  font-size: 12px;
  color: rgba(205, 217, 229, 0.62);
  word-break: break-all;
}

.device-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.device-card-grid > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 10px;
  border-top: 1px solid rgba(157, 204, 255, 0.08);
}

.device-card-grid span {
  color: rgba(202, 214, 226, 0.52);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.device-card-grid strong {
  font-size: 13px;
  color: #edf4fb;
  word-break: break-word;
}

.device-card-error {
  color: $error;
  margin-top: 10px;
  font-size: 12px;
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.92fr);
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.browser-column,
.side-column {
  min-width: 0;
  min-height: 0;
}

.surface-card {
  border-radius: 22px;
}

.surface-card--browser {
  min-height: 0;
}

.surface-card--history {
  flex: 1;
  min-height: 0;
}

.browser-column :deep(.n-card__content),
.side-card :deep(.n-card__content) {
  padding: 18px;
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
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(157, 204, 255, 0.08);
}

.detail-list span {
  color: rgba(202, 214, 226, 0.5);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.detail-list strong {
  color: #edf4fb;
  font-size: 13px;
  word-break: break-word;
}

.detail-error strong {
  color: $error;
  word-break: break-word;
}

@media (max-width: $breakpoint-mobile) {
  .overview-shell,
  .metric-grid,
  .device-card-grid {
    grid-template-columns: 1fr;
  }

  .overview-panel,
  .workspace-grid {
    display: flex;
    flex-direction: column;
  }

  .overview-panel {
    min-height: auto;
    padding: 20px 18px;
  }

  .overview-tools {
    justify-content: flex-start;
  }

  .page-title {
    font-size: 25px;
  }
}
</style>
