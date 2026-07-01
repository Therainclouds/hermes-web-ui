<script setup lang="ts">
import { computed, h, onMounted, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchConfig } from '@/api/hermes/config'
import { useUSBStream } from '@/composables/useUSBStream'
import router from '@/router'
import { useSettingsStore } from '@/stores/hermes/settings'
import { playCompletionSound } from '@/utils/completion-sound'
import { showCompletionNotification } from '@/utils/completion-notification'

const usbStore = useUSBStream()
const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

const usbNotificationsEnabled = computed(() => settingsStore.display.notify_on_complete !== false)
const usbSoundEnabled = computed(() => settingsStore.display.bell_on_complete === true)

const NOTIFY_DEDUPE_WINDOW_MS = 2_000
const recentNotificationKeys = new Map<string, number>()

function deviceLabel(label: string | null | undefined): string {
  return label?.trim() || t('usb.notifications.unknownDevice')
}

function notificationKey(eventId: string, kind: string): string {
  return `${kind}:${eventId}`
}

function openUSBPage() {
  if (router.currentRoute.value.name === 'hermes.usb') return
  void router.push({ name: 'hermes.usb' })
}

function shouldNotify(key: string): boolean {
  const now = Date.now()
  for (const [candidate, ts] of recentNotificationKeys) {
    if (now - ts > NOTIFY_DEDUPE_WINDOW_MS) recentNotificationKeys.delete(candidate)
  }
  const last = recentNotificationKeys.get(key)
  if (last && now - last < NOTIFY_DEDUPE_WINDOW_MS) return false
  recentNotificationKeys.set(key, now)
  return true
}

function toastEvent(event: { id: string, status: string, label: string | null, action: 'add' | 'remove', error: string | null }) {
  const label = deviceLabel(event.label)
  const renderContent = (text: string) => () => h(
    'span',
    {
      style: 'cursor:pointer;text-decoration:underline;',
      onClick: openUSBPage,
    },
    text,
  )
  if (event.status === 'mount_failed') {
    message.error(renderContent(t('usb.notifications.mountFailedBody', { label, error: event.error || 'Unknown error' })))
    return
  }
  if (event.action === 'remove') {
    message.warning(renderContent(t('usb.notifications.removedBody', { label })))
    return
  }
  message.success(renderContent(t('usb.notifications.mountedBody', { label })))
}

async function systemNotify(event: { id: string, status: string, label: string | null, action: 'add' | 'remove', error: string | null }) {
  if (!usbNotificationsEnabled.value) return
  const label = deviceLabel(event.label)
  if (event.status === 'mount_failed') {
    await showCompletionNotification({
      title: t('usb.notifications.mountFailedTitle'),
      body: t('usb.notifications.mountFailedBody', { label, error: event.error || 'Unknown error' }),
      icon: '/coding-agents/hermes.png',
      tag: `usb-mount-failed-${event.id}`,
    })
    return
  }
  if (event.action === 'remove') {
    await showCompletionNotification({
      title: t('usb.notifications.removedTitle'),
      body: t('usb.notifications.removedBody', { label }),
      icon: '/coding-agents/hermes.png',
      tag: `usb-removed-${event.id}`,
    })
    return
  }
  await showCompletionNotification({
    title: t('usb.notifications.mountedTitle'),
    body: t('usb.notifications.mountedBody', { label }),
    icon: '/coding-agents/hermes.png',
    tag: `usb-mounted-${event.id}`,
  })
}

async function soundNotify() {
  if (!usbSoundEnabled.value) return
  await playCompletionSound()
}

onMounted(async () => {
  if (Object.keys(settingsStore.display || {}).length > 0) return
  try {
    const config = await fetchConfig(['display'])
    settingsStore.updateLocal('display', config.display || {})
  } catch {
    // Best-effort fetch; in-app toasts still work without settings.
  }
})

watch(
  () => usbStore.latestRealtimeEvent,
  (event) => {
    if (!event) return
    const kind = event.status === 'mount_failed' ? 'mount_failed' : event.action
    if (!shouldNotify(notificationKey(event.id, kind))) return
    toastEvent(event)
    void systemNotify(event)
    void soundNotify()
  },
)
</script>

<template>
  <span style="display: none" aria-hidden="true" />
</template>
