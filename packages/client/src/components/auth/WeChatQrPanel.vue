<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
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
const qrImage = ref('')
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
    qrImage.value = await QRCode.toDataURL(buildWeChatQrConnectUrl(params), {
      width: 220,
      margin: 1,
    })
    startPolling(params.login_id)
  } catch (err: any) {
    if (currentId !== qrRequestId) return
    errorMsg.value = err?.message || t('login.wechatQrFailed')
  } finally {
    if (currentId === qrRequestId) loading.value = false
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
  qrImage.value = ''
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
      <div v-if="qrImage" class="qr-wrap">
        <img :src="qrImage" alt="WeChat QR" class="qr-img" />
        <p class="qr-hint">{{ t('login.wechatQrHint') }}</p>
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

      <div v-else-if="errorMsg" class="qr-error">
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
  gap: 8px;
}

.qr-img {
  width: 220px;
  height: 220px;
  border-radius: $radius-sm;
  border: 1px solid $border-color;
}

.qr-hint {
  margin: 0;
  font-size: 13px;
  color: $text-muted;
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
