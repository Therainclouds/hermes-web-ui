<script setup lang="ts">
/**
 * ExpertCard - 统一专家卡片
 * - 三种 mode: 'published' | 'team' | 'installed'
 * - 状态徽章 + 升级提示 + 快捷"开始对话"
 */
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ExpertCover from './ExpertCover.vue'
import type { ExpertCatalogItem, InstalledExpertRow } from '@/api/hermes/experts'

const props = defineProps<{
  item: ExpertCatalogItem | InstalledExpertRow
  mode: 'published' | 'team' | 'installed'
  installed?: InstalledExpertRow | null
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'open', slug: string): void
  (e: 'start-chat', slug: string): void
}>()

const { t } = useI18n()

const isCatalog = computed(() => props.mode !== 'installed')
const slug = computed(() =>
  isCatalog.value ? (props.item as ExpertCatalogItem).slug : (props.item as InstalledExpertRow).expert_slug,
)
const name = computed(() =>
  isCatalog.value
    ? (props.item as ExpertCatalogItem).name
    : (props.item as InstalledExpertRow).expert_name || (props.item as InstalledExpertRow).expert_slug,
)
const category = computed(() =>
  isCatalog.value
    ? (props.item as ExpertCatalogItem).category
    : (props.item as InstalledExpertRow).category,
)
const summary = computed(() =>
  isCatalog.value
    ? (props.item as ExpertCatalogItem).summary
    : `${(props.item as InstalledExpertRow).kind} · ${(props.item as InstalledExpertRow).category}`,
)
const iconUrl = computed(() =>
  isCatalog.value ? (props.item as ExpertCatalogItem).icon_url : null,
)
const version = computed(() => {
  if (isCatalog.value) {
    return (props.item as ExpertCatalogItem).latest_version?.version || '-'
  }
  return (props.item as InstalledExpertRow).installed_version
})

const installedReady = computed(() => props.installed?.status === 'installed')

const hasUpgrade = computed(() => {
  if (!props.installed || isCatalog.value) return false
  const latest = (props.item as ExpertCatalogItem)?.latest_version?.version
  return !!latest && latest !== props.installed.installed_version
})

const statusInfo = computed(() => {
  if (props.mode !== 'installed' || isCatalog.value) return null
  const row = props.item as InstalledExpertRow
  const s = row.status
  if (s === 'installed') return { type: 'success' as const, label: t('experts.status.installed') }
  if (s === 'failed') return { type: 'error' as const, label: t('experts.status.failed') }
  if (s === 'downloading') return { type: 'info' as const, label: t('experts.status.downloading') }
  if (s === 'verifying') return { type: 'info' as const, label: t('experts.status.verifying') }
  if (s === 'extracting') return { type: 'info' as const, label: t('experts.status.extracting') }
  if (s === 'installing_profile') return { type: 'warning' as const, label: t('experts.status.installing_profile') }
  return { type: 'default' as const, label: s }
})

const errorText = computed(() => {
  if (props.mode !== 'installed' || isCatalog.value) return null
  const row = props.item as InstalledExpertRow
  return row.status === 'failed' && row.last_error ? `${t('experts.lastError')}: ${row.last_error}` : null
})

function handleOpen() {
  emit('open', slug.value)
}
function handleStartChat(e: Event) {
  e.stopPropagation()
  emit('start-chat', slug.value)
}
</script>

<template>
  <article class="expert-card" tabindex="0" @click="handleOpen" @keyup.enter="handleOpen">
    <div class="cover-wrap">
      <ExpertCover :name="name" :slug="slug" :icon-url="iconUrl" size="md" />
      <div class="cover-badges">
        <NTag v-if="mode === 'team' || (mode === 'installed' && !isCatalog && (item as InstalledExpertRow).kind === 'team')"
              size="tiny" :bordered="false" type="warning">
          {{ t('experts.kind.team') }}
        </NTag>
      </div>
    </div>

    <div class="meta">
      <div class="meta-top">
        <span class="name" :title="name">{{ name }}</span>
        <NTag size="tiny" :bordered="false" class="version">{{ version }}</NTag>
      </div>

      <p class="summary" :title="summary">{{ summary }}</p>

      <div v-if="errorText" class="error">{{ errorText }}</div>

      <div class="meta-bottom">
        <div class="tags">
          <NTag size="tiny" :bordered="false">{{ category }}</NTag>
          <NTag v-if="statusInfo" size="tiny" :bordered="false" :type="statusInfo.type">
            {{ statusInfo.label }}
          </NTag>
          <NTag v-else-if="installedReady" size="tiny" :bordered="false" type="info">
            {{ t('experts.status.installed') }}
          </NTag>
          <NTag v-if="hasUpgrade" size="tiny" :bordered="false" type="warning">
            {{ t('experts.upgradeAvailable') }}
          </NTag>
        </div>

        <NButton
          v-if="installedReady"
          size="tiny"
          type="primary"
          class="quick-start"
          :loading="busy"
          @click="handleStartChat"
        >
          {{ t('experts.detail.startChat') }}
        </NButton>
      </div>
    </div>
  </article>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.expert-card {
  display: flex;
  gap: 14px;
  padding: 14px;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  cursor: pointer;
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;
  outline: none;

  &:hover,
  &:focus-visible {
    border-color: $border-color;
    box-shadow: 0 6px 18px rgba(var(--text-primary-rgb), 0.06);
    transform: translateY(-1px);
  }
}

.cover-wrap {
  position: relative;
}

.cover-badges {
  position: absolute;
  top: -6px;
  right: -6px;
  display: flex;
  gap: 4px;
}

.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.version {
  flex-shrink: 0;
}

.summary {
  margin: 0;
  font-size: 12.5px;
  color: $text-secondary;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.error {
  margin: 0;
  font-size: 12px;
  color: $error;
  line-height: 1.4;
}

.meta-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}

.quick-start {
  flex-shrink: 0;
}
</style>
