<script setup lang="ts">
/**
 * USBView - USB 设备中心
 * 结构：page-header + 概览 stats + 设备网格 + 工作区两栏
 */
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NSpin, NTag } from 'naive-ui'
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
    <header class="page-header">
      <div class="header-title-block">
        <div class="title-row">
          <h2 class="header-title">{{ t('usb.page.title') }}</h2>
          <NTag round :type="runtimeTagType()" size="small">
            {{ t(`usb.page.runtime.${runtimeState}`) }}
          </NTag>
        </div>
        <span class="header-subtitle">{{ t('usb.page.subtitle') }}</span>
        <span class="header-session">
          <span class="session-dot" />
          <span>{{ agentReadHint }}</span>
        </span>
      </div>
      <div class="header-actions">
        <NButton size="small" type="primary" :loading="refreshing" @click="refreshSnapshot">
          {{ t('usb.page.refresh') }}
        </NButton>
      </div>
    </header>

    <div class="usb-content">
      <NSpin :show="refreshing && devices.length === 0">
        <div v-if="agentStatusMessage" class="agent-status" :class="`is-${agentStatusTone}`">
          {{ agentStatusMessage }}
        </div>

        <!-- Stat summary -->
        <section class="stat-bar">
          <div class="stat-cell">
            <span class="stat-label">{{ t('usb.page.details') }}</span>
            <strong class="stat-value">{{ devices.length }}</strong>
            <span class="stat-meta">{{ t('usb.page.deviceCount', { count: devices.length }) }}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">{{ t('usb.page.history.title') }}</span>
            <strong class="stat-value">{{ usbStore.unreadCount }}</strong>
            <span class="stat-meta">{{ t('usb.page.unreadCount', { count: usbStore.unreadCount }) }}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">{{ t('usb.page.lastHeartbeatAt') }}</span>
            <strong class="stat-value stat-value--time">{{ formatTime(usbStore.runtime?.lastHeartbeatAt || null) }}</strong>
            <span class="stat-meta">{{ t(`usb.page.runtime.${runtimeState}`) }}</span>
          </div>
        </section>

        <!-- Empty -->
        <section v-if="devices.length === 0" class="page-empty">
          <NEmpty :description="t('usb.page.empty')">
            <template #extra>
              <NButton size="small" type="primary" :loading="refreshing" @click="refreshSnapshot">
                {{ t('usb.page.refresh') }}
              </NButton>
            </template>
          </NEmpty>
        </section>

        <template v-else>
          <!-- Device grid -->
          <section class="usb-section">
            <div class="section-heading">
              <h3 class="section-title">{{ t('usb.page.details') }}</h3>
              <span class="section-meta">{{ selectedDevice ? deviceTitle(selectedDevice) : t('usb.page.selectDevice') }}</span>
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
                  <span class="device-signal" :class="`is-${device.status}`" />
                  <div class="device-card-copy">
                    <strong>{{ deviceTitle(device) }}</strong>
                    <span class="device-card-meta">{{ device.mountPoint }}</span>
                  </div>
                  <NTag size="small" round :type="device.status === 'mount_failed' ? 'error' : 'success'">
                    {{ t(`usb.page.status.${device.status}`) }}
                  </NTag>
                </div>

                <dl class="device-card-grid">
                  <div>
                    <dt>{{ t('usb.page.fsType') }}</dt>
                    <dd>{{ device.fsType || t('usb.page.unknown') }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('usb.page.size') }}</dt>
                    <dd>{{ formatBytes(device.sizeBytes) }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('usb.page.lastUpdated') }}</dt>
                    <dd>{{ formatTime(device.ts) }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('usb.page.deviceNode') }}</dt>
                    <dd>{{ device.deviceNode }}</dd>
                  </div>
                </dl>
                <div v-if="device.error" class="device-card-error">{{ device.error }}</div>
              </button>
            </div>
          </section>

          <!-- Workspace -->
          <section class="workspace-grid">
            <div class="browser-column">
              <USBFileBrowser
                :device="selectedDevice"
                :agent-read-enabled="canUseActiveChatSession"
                :agent-read-busy="agentReadBusy"
                :agent-read-hint="agentReadHint"
                @read-with-agent="handleReadWithAgent"
              />
            </div>

            <aside class="side-column">
              <div class="side-card">
                <div class="side-card-head">
                  <span class="side-card-title">{{ t('usb.page.details') }}</span>
                  <NTag
                    v-if="selectedDevice"
                    size="small"
                    round
                    :type="selectedDevice.status === 'mount_failed' ? 'error' : 'success'"
                  >
                    {{ t(`usb.page.status.${selectedDevice.status}`) }}
                  </NTag>
                </div>
                <dl v-if="selectedDevice" class="detail-list">
                  <div><dt>{{ t('usb.page.name') }}</dt><dd>{{ deviceTitle(selectedDevice) }}</dd></div>
                  <div><dt>{{ t('usb.page.mountPoint') }}</dt><dd>{{ selectedDevice.mountPoint }}</dd></div>
                  <div><dt>{{ t('usb.page.fsType') }}</dt><dd>{{ selectedDevice.fsType || t('usb.page.unknown') }}</dd></div>
                  <div><dt>{{ t('usb.page.vendor') }}</dt><dd>{{ selectedDevice.vendor || t('usb.page.unknown') }}</dd></div>
                  <div><dt>{{ t('usb.page.model') }}</dt><dd>{{ selectedDevice.model || t('usb.page.unknown') }}</dd></div>
                  <div><dt>{{ t('usb.page.serial') }}</dt><dd>{{ selectedDevice.serial || t('usb.page.unknown') }}</dd></div>
                  <div v-if="selectedDevice.error" class="detail-error">
                    <dt>{{ t('usb.page.lastError') }}</dt>
                    <dd>{{ selectedDevice.error }}</dd>
                  </div>
                </dl>
                <NEmpty v-else :description="t('usb.page.selectDevice')" size="small" />
              </div>

              <div class="side-card">
                <div class="side-card-head">
                  <span class="side-card-title">{{ t('usb.page.runtimeTitle') }}</span>
                  <span class="section-meta">{{ t(`usb.page.runtime.${runtimeState}`) }}</span>
                </div>
                <dl class="detail-list">
                  <div><dt>{{ t('usb.page.runtimeLabel') }}</dt><dd>{{ t(`usb.page.runtime.${runtimeState}`) }}</dd></div>
                  <div><dt>{{ t('usb.page.lastReadyAt') }}</dt><dd>{{ formatTime(usbStore.runtime?.lastReadyAt || null) }}</dd></div>
                  <div><dt>{{ t('usb.page.lastHeartbeatAt') }}</dt><dd>{{ formatTime(usbStore.runtime?.lastHeartbeatAt || null) }}</dd></div>
                  <div><dt>{{ t('usb.page.lastError') }}</dt><dd>{{ usbStore.runtime?.lastError || t('usb.page.none') }}</dd></div>
                </dl>
              </div>

              <div class="side-card side-card--history">
                <USBEventHistory :events="usbStore.history" @pick-device="selectedUuid = $event" />
              </div>
            </aside>
          </section>
        </template>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-view {
  display: flex;
  flex-direction: column;
  height: calc(100 * var(--vh));
}

// ── Page header 增强 ────────────────────────────────────────────────
.header-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-subtitle {
  font-size: 12px;
  color: $text-muted;
  line-height: 1.4;
}

.header-session {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-muted;
  margin-top: 2px;
}

.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent-info);
}

// ── 内容区 ────────────────────────────────────────────────────────────
.usb-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

// ── 状态条 ────────────────────────────────────────────────────────────
.stat-bar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-md;
}

.stat-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-muted;
}

.stat-value {
  font-size: 22px;
  font-weight: 600;
  color: $text-primary;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.stat-value--time {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  word-break: break-word;
}

.stat-meta {
  font-size: 11px;
  color: $text-muted;
}

// ── Agent status banner ────────────────────────────────────────────
.agent-status {
  padding: 10px 14px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--bg-secondary);
  font-size: 12.5px;
  color: $text-secondary;
}

.agent-status.is-info {
  border-color: rgba(var(--accent-info-rgb), 0.4);
  color: var(--accent-info);
}

.agent-status.is-success {
  border-color: rgba(var(--success-rgb), 0.4);
  color: $success;
}

.agent-status.is-error {
  border-color: rgba(var(--error-rgb), 0.4);
  color: $error;
}

// ── Section 通用 ────────────────────────────────────────────────────
.usb-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
  letter-spacing: 0.01em;
}

.section-meta {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-muted;
}

// ── 设备网格 ─────────────────────────────────────────────────────────
.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.device-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 14px;
  text-align: left;
  color: inherit;
  font-family: inherit;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  cursor: pointer;
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;

  &:hover {
    border-color: $border-color;
    box-shadow: 0 4px 14px rgba(var(--text-primary-rgb), 0.05);
    transform: translateY(-1px);
  }

  &.active {
    border-color: $border-color;
    background: var(--bg-secondary);
    box-shadow: 0 0 0 1px rgba(var(--text-primary-rgb), 0.04);
  }
}

.device-card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.device-signal {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 999px;
  background: $text-muted;

  &.is-mounted { background: $success; }
  &.is-mount_failed { background: $error; }
  &.is-ejecting,
  &.is-removing { background: $warning; }
}

.device-card-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  strong {
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
    word-break: break-word;
  }
}

.device-card-meta {
  font-size: 12px;
  color: $text-muted;
  word-break: break-all;
}

.device-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
  margin: 0;

  div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 8px;
    border-top: 1px dashed $border-light;
  }

  dt {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: $text-muted;
  }

  dd {
    margin: 0;
    font-size: 12.5px;
    color: $text-primary;
    word-break: break-word;
  }
}

.device-card-error {
  font-size: 12px;
  color: $error;
  word-break: break-word;
}

// ── Workspace two-column ────────────────────────────────────────────
.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.92fr);
  gap: 16px;
  align-items: start;
}

.browser-column,
.side-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.side-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-md;
}

.side-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid $border-light;
}

.side-card-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: $text-secondary;
}

.detail-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;

  div {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 12.5px;
  }

  dt {
    flex: 0 0 96px;
    color: $text-muted;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: $text-primary;
    word-break: break-word;
  }
}

.detail-error dd {
  color: $error;
}

// ── Empty state ──────────────────────────────────────────────────────
.page-empty {
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
}

// ── 响应式 ────────────────────────────────────────────────────────────
@media (max-width: $breakpoint-mobile) {
  .stat-bar,
  .device-card-grid,
  .workspace-grid {
    grid-template-columns: 1fr;
  }

  .header-session,
  .header-subtitle {
    display: none;
  }
}
</style>
