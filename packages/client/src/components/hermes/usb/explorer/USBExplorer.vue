<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { listUSBFiles, downloadUSBFile, type USBFileEntry } from '@/api/hermes/usb'
import type { USBDeviceRecord } from '@/api/hermes/usb-socket'
import { copyToClipboard } from '@/utils/clipboard'
import { normalizeExplorerPath, parentExplorerPath, explorerBaseName } from '@/utils/usb-format'
import { useMessage } from '@/composables/useAppMessage'
import USBExplorerToolbar, { type ExplorerViewMode } from './USBExplorerToolbar.vue'
import USBExplorerBreadcrumb from './USBExplorerBreadcrumb.vue'
import USBExplorerTree from './USBExplorerTree.vue'
import USBExplorerList from './USBExplorerList.vue'
import USBExplorerPreview from './USBExplorerPreview.vue'
import USBExplorerContextMenu from './USBExplorerContextMenu.vue'

const props = defineProps<{
  device: USBDeviceRecord | null
  agentReadEnabled: boolean
  agentReadBusy: boolean
  agentReadHint: string
}>()

const emit = defineEmits<{
  readWithAgent: [payload: { path: string, name: string }]
}>()

const { t } = useI18n()
const message = useMessage()

const currentPath = ref('/')
const entries = ref<USBFileEntry[]>([])
const selectedEntry = ref<USBFileEntry | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const searchTerm = ref('')
const viewMode = ref<ExplorerViewMode>('list')
const addressValue = ref('/')
const addressEditing = ref(false)

const backStack = ref<string[]>([])
const forwardStack = ref<string[]>([])

const contextShow = ref(false)
const contextX = ref(0)
const contextY = ref(0)
const contextEntry = ref<USBFileEntry | null>(null)

const canBack = computed(() => backStack.value.length > 0)
const canForward = computed(() => forwardStack.value.length > 0)
const canUp = computed(() => currentPath.value !== '/' && currentPath.value !== '')

function resetNavigation() {
  backStack.value = []
  forwardStack.value = []
  currentPath.value = '/'
  selectedEntry.value = null
  searchTerm.value = ''
  addressEditing.value = false
  addressValue.value = '/'
}

function pushHistory(targetPath: string) {
  if (targetPath === currentPath.value) return
  backStack.value.push(currentPath.value)
  forwardStack.value = []
  currentPath.value = targetPath
  addressValue.value = targetPath
}

function navigateBack() {
  if (!canBack.value) return
  const previous = backStack.value.pop() || '/'
  forwardStack.value.push(currentPath.value)
  currentPath.value = previous
  addressValue.value = previous
}

function navigateForward() {
  if (!canForward.value) return
  const next = forwardStack.value.pop() || '/'
  backStack.value.push(currentPath.value)
  currentPath.value = next
  addressValue.value = next
}

function navigateUp() {
  if (!canUp.value) return
  pushHistory(parentExplorerPath(currentPath.value))
}

function navigateTo(targetPath: string) {
  const normalized = normalizeExplorerPath(targetPath)
  pushHistory(normalized)
}

function startEditAddress() {
  addressValue.value = currentPath.value
  addressEditing.value = true
}

function submitAddress() {
  const normalized = normalizeExplorerPath(addressValue.value)
  addressValue.value = normalized
  addressEditing.value = false
  pushHistory(normalized)
}

function cancelEditAddress() {
  addressEditing.value = false
  addressValue.value = currentPath.value
}

function updateAddress(value: string) {
  addressValue.value = value
}

function updateSearch(value: string) {
  searchTerm.value = value
}

function toggleView(mode: ExplorerViewMode) {
  viewMode.value = mode
}

async function loadCurrent() {
  if (!props.device) {
    entries.value = []
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await listUSBFiles(props.device.uuid, currentPath.value)
    currentPath.value = response.path || currentPath.value
    addressValue.value = currentPath.value
    entries.value = response.entries
    selectedEntry.value = response.entries.find(entry => entry.path === selectedEntry.value?.path) || null
  } catch (error: any) {
    errorMessage.value = error?.message || t('usb.explorer.errors.loadFailed')
  } finally {
    loading.value = false
  }
}

function handleSelect(entry: USBFileEntry) {
  selectedEntry.value = entry
}

async function handleOpen(entry: USBFileEntry) {
  if (entry.isDir) {
    navigateTo(entry.path)
    return
  }
  selectedEntry.value = entry
}

function handleContext(event: MouseEvent, entry: USBFileEntry) {
  event.preventDefault()
  contextEntry.value = entry
  contextX.value = event.clientX
  contextY.value = event.clientY
  contextShow.value = true
}

function closeContext() {
  contextShow.value = false
}

function refreshCurrent() {
  void loadCurrent()
}

async function copyEntryPath(entry: USBFileEntry) {
  if (!props.device) return
  const absolute = entry.isDir
    ? `${props.device.mountPoint}${entry.path}`
    : `${props.device.mountPoint}${entry.path}`
  const ok = await copyToClipboard(absolute)
  if (ok) message.success(t('common.copied'))
  else message.error(t('usb.explorer.errors.copyFailed'))
}

async function copyEntryName(entry: USBFileEntry) {
  const ok = await copyToClipboard(entry.name)
  if (ok) message.success(t('common.copied'))
  else message.error(t('usb.explorer.errors.copyFailed'))
}

async function downloadEntry(entry: USBFileEntry) {
  if (!props.device || entry.isDir) return
  try {
    await downloadUSBFile(props.device.uuid, entry.path, entry.name)
    message.success(t('usb.page.downloadStarted'))
  } catch (error: any) {
    message.error(error?.message || t('usb.explorer.errors.downloadFailed'))
  }
}

function readEntryWithAgent(entry: USBFileEntry) {
  if (entry.isDir) return
  emit('readWithAgent', { path: entry.path, name: entry.name })
}

function openEntryNewTab(entry: USBFileEntry) {
  if (!props.device || entry.isDir) return
  window.open(`/api/usb/devices/${encodeURIComponent(props.device.uuid)}/read?path=${encodeURIComponent(entry.path)}`, '_blank')
}

watch(
  () => props.device?.uuid,
  () => {
    resetNavigation()
    void loadCurrent()
  },
  { immediate: true },
)

watch(
  () => currentPath.value,
  () => {
    void loadCurrent()
  },
)

watch(
  () => props.device?.label,
  (label) => {
    if (label && currentPath.value === '/') {
      addressValue.value = label
    }
  },
)
</script>

<template>
  <section class="usb-explorer">
    <USBExplorerToolbar
      :can-back="canBack"
      :can-forward="canForward"
      :can-up="canUp"
      :search-value="searchTerm"
      :address-value="addressValue"
      :address-editing="addressEditing"
      :view-mode="viewMode"
      @back="navigateBack"
      @forward="navigateForward"
      @up="navigateUp"
      @refresh="refreshCurrent"
      @update:search="updateSearch"
      @update:address="updateAddress"
      @start-edit-address="startEditAddress"
      @cancel-edit-address="cancelEditAddress"
      @submit-address="submitAddress"
      @toggle-view="toggleView"
    />

    <USBExplorerBreadcrumb :current-path="currentPath" @navigate="navigateTo" />

    <div class="explorer-grid">
      <aside class="explorer-tree">
        <USBExplorerTree
          :uuid="props.device?.uuid || ''"
          :current-path="currentPath"
          @navigate="navigateTo"
        />
      </aside>

      <main class="explorer-main">
        <USBExplorerList
          :entries="entries"
          :loading="loading"
          :selected-path="selectedEntry?.path || ''"
          :view-mode="viewMode"
          :search-term="searchTerm"
          :error-message="errorMessage"
          @select="handleSelect"
          @open="handleOpen"
          @context="handleContext"
        />
      </main>

      <aside class="explorer-preview">
        <USBExplorerPreview
          :device="props.device"
          :entry="selectedEntry"
          :agent-read-enabled="props.agentReadEnabled"
          :agent-read-busy="props.agentReadBusy"
          :agent-read-hint="props.agentReadHint"
          @read-with-agent="emit('readWithAgent', $event)"
        />
      </aside>
    </div>

    <USBExplorerContextMenu
      :show="contextShow"
      :x="contextX"
      :y="contextY"
      :entry="contextEntry"
      :device-label="props.device?.label || ''"
      :mount-point="props.device?.mountPoint || ''"
      :agent-read-enabled="props.agentReadEnabled"
      :agent-read-busy="props.agentReadBusy"
      @update:show="closeContext"
      @open="handleOpen"
      @copy-path="copyEntryPath"
      @copy-name="copyEntryName"
      @download="downloadEntry"
      @read-with-agent="readEntryWithAgent"
      @refresh="refreshCurrent"
    />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.explorer-grid {
  display: grid;
  grid-template-columns: minmax(180px, 220px) minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 12px;
  align-items: stretch;
  min-height: 420px;
}

.explorer-tree,
.explorer-main,
.explorer-preview {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.explorer-main {
  min-height: 420px;
}

@media (max-width: $breakpoint-mobile) {
  .explorer-grid {
    grid-template-columns: 1fr;
    grid-template-areas:
      'tree'
      'main'
      'preview';
  }
  .explorer-tree { grid-area: tree; }
  .explorer-main { grid-area: main; }
  .explorer-preview { grid-area: preview; }
}
</style>