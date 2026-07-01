<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NBreadcrumb, NBreadcrumbItem, NButton, NEmpty, NProgress, NSpin, useMessage } from 'naive-ui'
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

const props = defineProps<{
  device: USBDeviceRecord | null
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
    <div class="browser-header">
      <div class="browser-heading">
        <h3>{{ t('usb.page.browser.title') }}</h3>
        <span v-if="device" class="browser-path">{{ selectedAbsolutePath || device.mountPoint }}</span>
      </div>

      <div class="browser-actions">
        <NButton size="small" :disabled="!device" @click="refreshCurrent">
          {{ t('usb.page.refresh') }}
        </NButton>
        <NButton size="small" :disabled="!device" @click="copyCurrentPath">
          {{ t('usb.page.copyPath') }}
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
          <span>{{ t('usb.page.capacity') }}</span>
          <span v-if="usageLoading">{{ t('usb.page.loading') }}</span>
          <span v-else>{{ formatBytes(usage?.usedBytes) }} / {{ formatBytes(usage?.totalBytes) }}</span>
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
        <div class="entry-panel">
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
                  <span class="entry-name">{{ entry.name }}</span>
                  <span class="entry-meta">{{ entry.isDir ? t('usb.page.browser.folder') : formatBytes(entry.size) }}</span>
                </div>
                <span class="entry-time">{{ formatTime(entry.modTime) }}</span>
              </button>
            </div>
          </NSpin>
        </div>

        <div class="preview-panel">
          <NSpin :show="previewLoading">
            <div v-if="!selectedEntry" class="panel-empty">
              <NEmpty :description="t('usb.page.browser.selectFile')" />
            </div>
            <div v-else class="preview-wrap">
              <div class="stat-grid">
                <div>
                  <span class="stat-label">{{ t('usb.page.name') }}</span>
                  <strong>{{ selectedStat?.name || selectedEntry.name }}</strong>
                </div>
                <div>
                  <span class="stat-label">{{ t('usb.page.type') }}</span>
                  <strong>{{ selectedStat?.isDir ? t('usb.page.browser.folder') : t('usb.page.browser.file') }}</strong>
                </div>
                <div>
                  <span class="stat-label">{{ t('usb.page.size') }}</span>
                  <strong>{{ formatBytes(selectedStat?.size ?? selectedEntry.size) }}</strong>
                </div>
                <div>
                  <span class="stat-label">{{ t('usb.page.modifiedAt') }}</span>
                  <strong>{{ selectedStat ? formatTime(selectedStat.modTime) : formatTime(selectedEntry.modTime) }}</strong>
                </div>
              </div>

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
  gap: 16px;
  min-height: 0;
}

.browser-header,
.usage-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.browser-heading {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.browser-heading h3 {
  margin: 0;
  font-size: 16px;
}

.browser-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.browser-path {
  color: $text-muted;
  font-size: 12px;
  word-break: break-all;
}

.usage-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-card;
}

.browser-content {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.1fr);
  gap: 16px;
  min-height: 420px;
}

.entry-panel,
.preview-panel {
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-card;
  min-height: 0;
  overflow: hidden;
}

.entry-list {
  display: flex;
  flex-direction: column;
}

.entry-item {
  width: 100%;
  border: none;
  border-bottom: 1px solid $border-color;
  background: transparent;
  color: inherit;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
}

.entry-item.active {
  background: rgba(24, 160, 88, 0.08);
}

.entry-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.entry-name {
  font-weight: 600;
  word-break: break-word;
}

.entry-meta,
.entry-time,
.stat-label,
.preview-placeholder {
  color: $text-muted;
  font-size: 12px;
}

.preview-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.stat-grid > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.text-preview {
  margin: 0;
  max-height: 420px;
  overflow: auto;
  padding: 12px;
  border-radius: 10px;
  background: $code-bg;
  white-space: pre-wrap;
  word-break: break-word;
}

.image-preview {
  display: flex;
  justify-content: center;
  padding: 12px;
  border: 1px dashed $border-color;
  border-radius: 10px;
}

.image-preview img {
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
}

.panel-empty,
.browser-empty,
.preview-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  padding: 16px;
}

@media (max-width: $breakpoint-mobile) {
  .browser-content,
  .stat-grid {
    grid-template-columns: 1fr;
  }

  .browser-header,
  .usage-top {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
