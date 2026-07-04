<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NBreadcrumb, NBreadcrumbItem, NButton, NEmpty, NProgress, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  downloadUSBFile,
  fetchUSBFileBlob,
  fetchUSBDiskUsage,
  listUSBFiles,
  statUSBPath,
  type USBDiskUsage,
  type USBFileEntry,
  type USBFileStat,
} from '@/api/hermes/usb'
import type { USBDeviceRecord } from '@/api/hermes/usb-socket'
import { copyToClipboard } from '@/utils/clipboard'
import { useMessage } from '@/composables/useAppMessage'

const props = defineProps<{
  device: USBDeviceRecord | null
  agentReadEnabled?: boolean
  agentReadBusy?: boolean
  agentReadHint?: string
}>()

const emit = defineEmits<{
  readWithAgent: [{ path: string, name: string }]
}>()

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const previewLoading = ref(false)
const usageLoading = ref(false)
const currentPath = ref('/')
const entries = ref<USBFileEntry[]>([])
const selectedEntry = ref<USBFileEntry | null>(null)
const selectedStat = ref<USBFileStat | null>(null)
const previewText = ref('')
const previewImageUrl = ref('')
const usage = ref<USBDiskUsage | null>(null)
const errorMessage = ref('')

const breadcrumbSegments = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  return parts.map((segment, index) => ({
    label: segment,
    path: `/${parts.slice(0, index + 1).join('/')}`,
  }))
})

const selectedAbsolutePath = computed(() => {
  if (!props.device) return ''
  const relativePath = selectedStat.value?.path || currentPath.value
  return relativePath === '/'
    ? props.device.mountPoint
    : `${props.device.mountPoint}${relativePath}`
})

const usagePercent = computed(() => {
  if (!usage.value?.usedBytes || !usage.value?.totalBytes) return 0
  if (usage.value.totalBytes <= 0) return 0
  return Math.min(100, Math.round((usage.value.usedBytes / usage.value.totalBytes) * 100))
})

const selectedFileName = computed(() => selectedStat.value?.name || selectedEntry.value?.name || '')

function resetPreview() {
  previewText.value = ''
  if (previewImageUrl.value) {
    URL.revokeObjectURL(previewImageUrl.value)
  }
  previewImageUrl.value = ''
}

function resetState() {
  currentPath.value = '/'
  entries.value = []
  selectedEntry.value = null
  selectedStat.value = null
  usage.value = null
  errorMessage.value = ''
  resetPreview()
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

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path)
}

function isTextPath(path: string): boolean {
  return /\.(txt|md|json|log|ya?ml|toml|ini|csv|ts|tsx|js|jsx|css|scss|html|xml|py|java|go|rs|sh)$/i.test(path)
}

async function loadUsage(uuid: string) {
  usageLoading.value = true
  try {
    usage.value = (await fetchUSBDiskUsage(uuid)).usage
  } catch (error: any) {
    message.error(error?.message || t('usb.page.loadFailed'))
  } finally {
    usageLoading.value = false
  }
}

async function loadDirectory(path = '/') {
  if (!props.device) return
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await listUSBFiles(props.device.uuid, path)
    currentPath.value = response.path || path
    entries.value = response.entries
  } catch (error: any) {
    errorMessage.value = error?.message || t('usb.page.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadPreview(entry: USBFileEntry) {
  if (!props.device || entry.isDir) return
  previewLoading.value = true
  selectedEntry.value = entry
  errorMessage.value = ''
  resetPreview()
  try {
    const statResponse = await statUSBPath(props.device.uuid, entry.path)
    selectedStat.value = statResponse.stat
    if (isImagePath(entry.path)) {
      const blob = await fetchUSBFileBlob(props.device.uuid, entry.path)
      previewImageUrl.value = URL.createObjectURL(blob)
    } else if (isTextPath(entry.path) && entry.size <= 512 * 1024) {
      const blob = await fetchUSBFileBlob(props.device.uuid, entry.path)
      previewText.value = await blob.text()
    }
  } catch (error: any) {
    errorMessage.value = error?.message || t('usb.page.previewFailed')
  } finally {
    previewLoading.value = false
  }
}

async function openEntry(entry: USBFileEntry) {
  selectedEntry.value = entry
  if (entry.isDir) {
    selectedStat.value = null
    resetPreview()
    await loadDirectory(entry.path)
    return
  }
  await loadPreview(entry)
}

async function refreshCurrent() {
  if (!props.device) return
  await Promise.all([
    loadDirectory(currentPath.value),
    loadUsage(props.device.uuid),
  ])
}

async function copyCurrentPath() {
  const value = selectedAbsolutePath.value || currentPath.value
  const copied = await copyToClipboard(value)
  if (copied) message.success(t('common.copied'))
  else message.error(t('usb.page.copyFailed'))
}

async function handleDownload() {
  if (!props.device || !selectedStat.value || selectedStat.value.isDir) return
  try {
    await downloadUSBFile(props.device.uuid, selectedStat.value.path, selectedStat.value.name)
    message.success(t('usb.page.downloadStarted'))
  } catch (error: any) {
    message.error(error?.message || t('usb.page.downloadFailed'))
  }
}

function handleReadWithAgent() {
  if (!selectedStat.value || selectedStat.value.isDir) return
  emit('readWithAgent', {
    path: selectedStat.value.path,
    name: selectedStat.value.name,
  })
}

watch(
  () => props.device?.uuid,
  (uuid) => {
    resetState()
    if (!uuid) return
    void Promise.all([
      loadDirectory('/'),
      loadUsage(uuid),
    ])
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  resetPreview()
})
</script>

<template>
  <section class="usb-browser">
    <div class="browser-head">
      <div class="browser-heading">
        <span class="browser-kicker">Workspace</span>
        <h3>{{ t('usb.page.browser.title') }}</h3>
        <span v-if="device" class="browser-path">{{ selectedAbsolutePath || device.mountPoint }}</span>
      </div>

      <div class="browser-actions">
        <NButton size="small" ghost :disabled="!device" @click="refreshCurrent">
          {{ t('usb.page.refresh') }}
        </NButton>
        <NButton size="small" ghost :disabled="!device" @click="copyCurrentPath">
          {{ t('usb.page.copyPath') }}
        </NButton>
        <NButton
          size="small"
          ghost
          :disabled="!selectedStat || selectedStat.isDir || !agentReadEnabled || agentReadBusy"
          :title="agentReadHint"
          @click="handleReadWithAgent"
        >
          {{ t('usb.page.readWithAgent') }}
        </NButton>
        <NButton size="small" type="primary" :disabled="!selectedStat || selectedStat.isDir" @click="handleDownload">
          {{ t('usb.page.download') }}
        </NButton>
      </div>
    </div>

    <div v-if="!device" class="browser-empty">
      <NEmpty :description="t('usb.page.selectDevice')" />
    </div>

    <template v-else>
      <div class="usage-card">
        <div class="usage-top">
          <span class="usage-label">{{ t('usb.page.capacity') }}</span>
          <span class="usage-value" v-if="usageLoading">{{ t('usb.page.loading') }}</span>
          <span class="usage-value" v-else>{{ formatBytes(usage?.usedBytes) }} / {{ formatBytes(usage?.totalBytes) }}</span>
        </div>
        <NProgress type="line" :percentage="usagePercent" :show-indicator="false" />
      </div>

      <NBreadcrumb class="browser-breadcrumb">
        <NBreadcrumbItem @click="loadDirectory('/')">
          /
        </NBreadcrumbItem>
        <NBreadcrumbItem
          v-for="segment in breadcrumbSegments"
          :key="segment.path"
          @click="loadDirectory(segment.path)"
        >
          {{ segment.label }}
        </NBreadcrumbItem>
      </NBreadcrumb>

      <div class="browser-content">
        <div class="entry-panel surface-card">
          <div class="panel-head">
            <span class="panel-title">{{ t('usb.page.browser.title') }}</span>
            <span class="panel-meta">{{ entries.length }}</span>
          </div>
          <NSpin :show="loading">
            <div v-if="errorMessage" class="panel-empty">
              <NEmpty :description="errorMessage" />
            </div>
            <div v-else-if="entries.length === 0" class="panel-empty">
              <NEmpty :description="t('usb.page.browser.emptyFolder')" />
            </div>
            <div v-else class="entry-list">
              <button
                v-for="entry in entries"
                :key="entry.path"
                type="button"
                class="entry-item"
                :class="{ active: selectedEntry?.path === entry.path }"
                @click="openEntry(entry)"
              >
                <div class="entry-main">
                  <div class="entry-copy">
                    <span class="entry-name">{{ entry.name }}</span>
                    <span class="entry-meta">{{ entry.isDir ? t('usb.page.browser.folder') : formatBytes(entry.size) }}</span>
                  </div>
                  <span class="entry-badge">{{ entry.isDir ? t('usb.page.browser.folder') : t('usb.page.browser.file') }}</span>
                </div>
                <span class="entry-time">{{ formatTime(entry.modTime) }}</span>
              </button>
            </div>
          </NSpin>
        </div>

        <div class="preview-panel surface-card">
          <div class="panel-head">
            <span class="panel-title">{{ selectedFileName || t('usb.page.browser.selectFile') }}</span>
            <span class="panel-meta">{{ selectedStat?.isDir ? t('usb.page.browser.folder') : t('usb.page.browser.file') }}</span>
          </div>
          <NSpin :show="previewLoading">
            <div v-if="!selectedEntry" class="panel-empty">
              <NEmpty :description="t('usb.page.browser.selectFile')" />
            </div>
            <div v-else class="preview-wrap">
              <dl class="stat-grid">
                <div>
                  <dt>{{ t('usb.page.name') }}</dt>
                  <dd>{{ selectedStat?.name || selectedEntry.name }}</dd>
                </div>
                <div>
                  <dt>{{ t('usb.page.type') }}</dt>
                  <dd>{{ selectedStat?.isDir ? t('usb.page.browser.folder') : t('usb.page.browser.file') }}</dd>
                </div>
                <div>
                  <dt>{{ t('usb.page.size') }}</dt>
                  <dd>{{ formatBytes(selectedStat?.size ?? selectedEntry.size) }}</dd>
                </div>
                <div>
                  <dt>{{ t('usb.page.modifiedAt') }}</dt>
                  <dd>{{ selectedStat ? formatTime(selectedStat.modTime) : formatTime(selectedEntry.modTime) }}</dd>
                </div>
              </dl>

              <div v-if="previewImageUrl" class="image-preview">
                <img :src="previewImageUrl" :alt="selectedFileName" />
              </div>
              <pre v-else-if="previewText" class="text-preview">{{ previewText }}</pre>
              <div v-else class="preview-placeholder">
                {{ t('usb.page.browser.noPreview') }}
              </div>
            </div>
          </NSpin>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-browser {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 14px 16px;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-md;
}

.browser-head,
.usage-top,
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.browser-head {
  align-items: flex-start;
}

.browser-heading {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.browser-kicker {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-muted;
}

.browser-heading h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.browser-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.browser-path {
  color: $text-muted;
  font-size: 11px;
  word-break: break-all;
  font-family: $font-code;
}

.usage-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid $border-light;
  border-radius: $radius-sm;
}

.usage-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-muted;
}

.usage-value {
  color: $text-primary;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.browser-content {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.1fr);
  gap: 12px;
  min-height: 360px;
}

.entry-panel,
.preview-panel {
  display: flex;
  flex-direction: column;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  min-height: 0;
  overflow: hidden;
}

.panel-head {
  padding: 10px 14px;
  border-bottom: 1px solid $border-light;
  background: var(--bg-secondary);
}

.panel-title {
  font-size: 12.5px;
  font-weight: 600;
  color: $text-primary;
  word-break: break-word;
}

.panel-meta {
  font-size: 11px;
  color: $text-muted;
  font-variant-numeric: tabular-nums;
}

.entry-list {
  display: flex;
  flex-direction: column;
}

.entry-item {
  width: 100%;
  border: none;
  border-bottom: 1px solid $border-light;
  background: transparent;
  color: inherit;
  padding: 10px 14px;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition: background $transition-fast;

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: var(--bg-secondary);
  }

  &.active {
    background: var(--bg-secondary);
  }
}

.entry-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.entry-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entry-name {
  font-weight: 600;
  color: $text-primary;
  font-size: 13px;
  word-break: break-word;
}

.entry-meta {
  color: $text-muted;
  font-size: 11.5px;
}

.entry-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-primary);
  border: 1px solid $border-light;
  color: $text-muted;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.entry-time {
  color: $text-muted;
  font-size: 11.5px;
  margin-top: 4px;
  display: block;
}

.preview-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  min-height: 100%;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;

  div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    background: var(--bg-secondary);
  }

  dt {
    font-size: 10.5px;
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

.text-preview {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: 12px;
  border-radius: $radius-sm;
  border: 1px solid $border-light;
  background: var(--bg-input);
  color: $text-primary;
  font-family: $font-code;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.image-preview {
  display: flex;
  justify-content: center;
  padding: 10px;
  border: 1px dashed $border-color;
  border-radius: $radius-sm;
  background: var(--bg-secondary);

  img {
    max-width: 100%;
    max-height: 360px;
    object-fit: contain;
  }
}

.preview-placeholder {
  padding: 24px;
  text-align: center;
  color: $text-muted;
  font-size: 12.5px;
}

.panel-empty,
.browser-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  padding: 16px;
}

@media (max-width: $breakpoint-mobile) {
  .browser-content,
  .stat-grid {
    grid-template-columns: 1fr;
  }

  .browser-head,
  .usage-top,
  .panel-head {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
