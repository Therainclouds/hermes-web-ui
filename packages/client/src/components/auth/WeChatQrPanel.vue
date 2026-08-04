<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMessage } from '@/composables/useAppMessage'
import {
  buildWeChatQrConnectUrl,
  pollTokenPlatformDeviceLoginStatus,
  requestTokenPlatformDeviceLogin,
  type TokenPlatformDeviceLoginStatus,
} from '@/api/device-login'

const { t } = useI18n()
const message = useMessage()

const HARDWARE_ID_KEY = 'hermes_device_hardware_id'

const emit = defineEmits<{
  approved: [result: Extract<TokenPlatformDeviceLoginStatus, { status: 'approved' }>]
  error: [error: Error]
}>()

const loading = ref(false)
const qrUrl = ref('')
const loginId = ref('')
const polling = ref(false)
const expired = ref(false)
const errorMsg = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null
let qrRequestId = 0

function getHardwareId(): string {
  const existing = localStorage.getItem(HARDWARE_ID_KEY)
  if (existing) return existing
  const id = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  localStorage.setItem(HARDWARE_ID_KEY, id)
  return id
}

function deviceName(): string {
  return 'Hermes'
}

async function startScan() {
  loading.value = true
  errorMsg.value = ''
  expired.value = false
  const currentId = ++qrRequestId
  try {
    const params = await requestTokenPlatformDeviceLogin(
      getHardwareId(),
      deviceName(),
    )
    if (currentId !== qrRequestId) return
    loginId.value = params.login_id
    qrUrl.value = buildWeChatQrConnectUrl(params)
    startPolling(params.login_id)
    openQrPage()
  } catch (err: any) {
    if (currentId !== qrRequestId) return
    errorMsg.value = err?.message || t('login.wechatQrFailed')
  } finally {
    if (currentId === qrRequestId) loading.value = false
  }
}

// Open the WeChat login page (with the real QR) in a new tab. The Hermes login
// page stays open and keeps polling the device-login status.
function openQrPage() {
  if (!qrUrl.value) return
  const win = window.open(qrUrl.value, '_blank', 'noopener,noreferrer')
  if (!win) {
    // Popup blocked: show a manual link the user can click.
    message.warning(t('login.wechatQrPopupBlocked'))
  }
}

function startPolling(id: string) {
  stopPolling()
  polling.value = true
  expired.value = false
  pollTimer = setInterval(async () => {
    try {
      const result = await pollTokenPlatformDeviceLoginStatus(id)
      if (result.status === 'approved') {
        stopPolling()
        emit('approved', result)
        return
      }
      if (result.status === 'expired') {
        stopPolling()
        expired.value = true
        polling.value = false
        message.warning(t('login.wechatQrExpired'))
      }
    } catch (err: any) {
      stopPolling()
      polling.value = false
      errorMsg.value = err?.message || t('login.wechatQrFailed')
      emit('error', err)
    }
  }, 3000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  polling.value = false
}

function refresh() {
  qrUrl.value = ''
  void startScan()
}

onMounted(() => {
  void startScan()
})

onBeforeUnmount(() => {
  qrRequestId++
  stopPolling()
})
</script>

<template>
  <div class="wechat-qr-panel">
    <div v-if="loading" class="qr-loading">
      <NSpin size="small" />
      <span>{{ t('login.wechatQrLoading') }}</span>
    </div>

    <template v-else>
      <div v-if="!errorMsg" class="qr-wrap">
        <div class="qr-guide">
          <span class="qr-guide__icon">📱</span>
          <p class="qr-guide__text">{{ t('login.wechatQrOpenedHint') }}</p>
        </div>
        <a
          :href="qrUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="qr-open-btn"
        >
          {{ t('login.wechatQrOpenPage') }}
        </a>
        <div v-if="polling" class="qr-status">
          <span class="status-dot" />
          {{ t('login.wechatQrWaiting') }}
        </div>
        <div v-if="expired" class="qr-status qr-status--expired">
          {{ t('login.wechatQrExpired') }}
        </div>
        <NButton
          v-if="expired"
          size="small"
          class="qr-refresh"
          @click="refresh"
        >
          {{ t('login.wechatQrRefresh') }}
        </NButton>
      </div>

      <div v-else class="qr-error">
        <p>{{ errorMsg }}</p>
        <NButton size="small" @click="refresh">{{ t('login.wechatQrRefresh') }}</NButton>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.wechat-qr-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.qr-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: $text-muted;
  font-size: 13px;
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 24px;
  border: 1px dashed $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
}

.qr-guide__icon {
  font-size: 32px;
}

.qr-guide__text {
  margin: 0;
  font-size: 13px;
  color: $text-secondary;
  text-align: center;
  line-height: 1.6;
}

.qr-open-btn {
  display: inline-flex;
  align-items: center;
  padding: 12px 20px;
  border-radius: $radius-sm;
  background: $accent-primary;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.92;
  }
}

.qr-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-secondary;
}

.qr-status--expired {
  color: $error;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: $accent-primary;
  animation: pulse 1.2s infinite;
}

.qr-refresh {
  margin-top: 2px;
}

.qr-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: $error;
  font-size: 13px;

  p {
    margin: 0;
  }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
