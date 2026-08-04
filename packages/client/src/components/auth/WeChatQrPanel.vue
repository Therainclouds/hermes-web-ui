<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMessage } from '@/composables/useAppMessage'
import {
  pollTokenPlatformDeviceLoginStatus,
  requestTokenPlatformDeviceLogin,
  type TokenPlatformDeviceLoginStatus,
} from '@/api/device-login'

const { t } = useI18n()
const message = useMessage()

const HARDWARE_ID_KEY = 'hermes_device_hardware_id'
const WXLOGIN_SCRIPT_ID = 'wxlogin-sdk-script'

const emit = defineEmits<{
  approved: [result: Extract<TokenPlatformDeviceLoginStatus, { status: 'approved' }>]
  error: [error: Error]
}>()

const loading = ref(false)
const loginId = ref('')
const polling = ref(false)
const expired = ref(false)
const errorMsg = ref('')
const qrContainer = ref<HTMLDivElement | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null
let qrRequestId = 0
let wxLoginInstance: { destroy?: () => void } | null = null

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

function loadWxLoginScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(WXLOGIN_SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve()
        return
      }
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('wxLogin.js load failed')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = WXLOGIN_SCRIPT_ID
    script.src = 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js'
    script.async = true
    script.onload = () => {
      script.dataset.loaded = '1'
      resolve()
    }
    script.onerror = () => reject(new Error('wxLogin.js load failed'))
    document.head.appendChild(script)
  })
}

function clearQrContainer() {
  if (qrContainer.value) qrContainer.value.innerHTML = ''
  if (wxLoginInstance?.destroy) {
    try { wxLoginInstance.destroy() } catch { /* ignore */ }
  }
  wxLoginInstance = null
}

function createWxLogin(params: {
  appid: string
  scope?: string
  state: string
  redirect_uri: string
  style?: string
}) {
  if (!qrContainer.value) return
  const wxLogin = (window as any).WxLogin
  if (!wxLogin) {
    throw new Error('WxLogin SDK not available')
  }
  clearQrContainer()
  wxLoginInstance = new wxLogin({
    self_redirect: true, // 扫码后仅在二维码 iframe 内跳转 redirect_uri，保持 Hermes 页面不被替换
    id: 'wechat-device-qr',
    appid: params.appid,
    scope: params.scope || 'snsapi_login',
    redirect_uri: params.redirect_uri,
    state: params.state,
    style: params.style || 'white',
    href: 'data:text/css;base64,' + window.btoa('.impowerBox .qrcode{width:220px;margin:0}'),
  })
}

async function startScan() {
  loading.value = true
  errorMsg.value = ''
  expired.value = false
  const currentId = ++qrRequestId
  try {
    await loadWxLoginScript()
    if (currentId !== qrRequestId) return
    const params = await requestTokenPlatformDeviceLogin(
      getHardwareId(),
      deviceName(),
    )
    if (currentId !== qrRequestId) return
    loginId.value = params.login_id
    await nextTick()
    createWxLogin(params)
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
  clearQrContainer()
  void startScan()
}

onMounted(() => {
  void startScan()
})

onBeforeUnmount(() => {
  qrRequestId++
  stopPolling()
  clearQrContainer()
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
        <div ref="qrContainer" id="wechat-device-qr" class="qr-container" />
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
  gap: 8px;
}

.qr-container {
  width: 220px;
  height: 220px;
  border-radius: $radius-sm;
  border: 1px solid $border-color;
  background: #fff;
  overflow: hidden;

  :deep(iframe) {
    width: 220px;
    height: 220px;
  }
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
