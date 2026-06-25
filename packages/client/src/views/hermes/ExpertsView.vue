<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCard, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useExpertsStore } from '@/stores/hermes/experts'
import type { ExpertCatalogItem, InstalledExpertRow } from '@/api/hermes/experts'

const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const expertsStore = useExpertsStore()

const activeTab = ref<'published' | 'team' | 'installed'>('published')

const publishedItems = computed(() => expertsStore.catalog.filter((c) => c.kind === 'expert'))
const teamItems = computed(() => expertsStore.catalog.filter((c) => c.kind === 'team'))
const installedItems = computed(() => expertsStore.installed)

onMounted(async () => {
  await expertsStore.fetchConfig()
  await Promise.all([expertsStore.fetchCatalog(), expertsStore.fetchInstalled()])
})

async function handleRefresh() {
  try {
    await expertsStore.refreshCatalog()
    await expertsStore.fetchInstalled()
    message.success(t('experts.refreshed'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('experts.refreshFailed'))
  }
}

function openDetail(slug: string) {
  router.push({ name: 'hermes.expertDetail', params: { slug } })
}

function isInstalled(slug: string): boolean {
  return !!expertsStore.findInstalled(slug)
}

function statusLabel(row: InstalledExpertRow): string {
  if (row.status === 'installed') return t('experts.status.installed')
  if (row.status === 'failed') return t('experts.status.failed')
  if (row.status === 'downloading') return t('experts.status.downloading')
  if (row.status === 'verifying') return t('experts.status.verifying')
  if (row.status === 'extracting') return t('experts.status.extracting')
  if (row.status === 'installing_profile') return t('experts.status.installing_profile')
  return row.status
}

function renderCard(item: ExpertCatalogItem) {
  return item
}
</script>

<template>
  <div class="experts-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('experts.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" :loading="expertsStore.loading" @click="handleRefresh">
          {{ t('experts.refresh') }}
        </NButton>
      </div>
    </header>

    <div class="tab-bar">
      <button
        class="tab"
        :class="{ active: activeTab === 'published' }"
        @click="activeTab = 'published'"
      >
        {{ t('experts.tabPublished') }} ({{ publishedItems.length }})
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'team' }"
        @click="activeTab = 'team'"
      >
        {{ t('experts.tabTeam') }} ({{ teamItems.length }})
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'installed' }"
        @click="activeTab = 'installed'"
      >
        {{ t('experts.tabInstalled') }} ({{ installedItems.length }})
      </button>
    </div>

    <div class="experts-content">
      <NSpin :show="expertsStore.loading">
        <div v-if="activeTab === 'published'" class="cards">
          <NEmpty v-if="publishedItems.length === 0" :description="t('experts.empty')" />
          <NCard
            v-for="item in publishedItems.map(renderCard)"
            :key="item.slug"
            class="card"
            hoverable
            @click="openDetail(item.slug)"
          >
            <template #header>
              <div class="card-head">
                <span class="name">{{ item.name }}</span>
                <NTag size="tiny" type="success" :bordered="false">{{ item.latest_version?.version || '-' }}</NTag>
              </div>
            </template>
            <template #header-extra>
              <NTag v-if="isInstalled(item.slug)" size="tiny" type="info" :bordered="false">
                {{ t('experts.status.installed') }}
              </NTag>
            </template>
            <div class="summary">{{ item.summary }}</div>
            <div class="meta">
              <NTag size="tiny" :bordered="false">{{ item.category }}</NTag>
            </div>
          </NCard>
        </div>

        <div v-else-if="activeTab === 'team'" class="cards">
          <NEmpty v-if="teamItems.length === 0" :description="t('experts.empty')" />
          <NCard
            v-for="item in teamItems.map(renderCard)"
            :key="item.slug"
            class="card"
            hoverable
            @click="openDetail(item.slug)"
          >
            <template #header>
              <div class="card-head">
                <span class="name">{{ item.name }}</span>
                <NTag size="tiny" type="success" :bordered="false">{{ item.latest_version?.version || '-' }}</NTag>
              </div>
            </template>
            <template #header-extra>
              <NTag v-if="isInstalled(item.slug)" size="tiny" type="info" :bordered="false">
                {{ t('experts.status.installed') }}
              </NTag>
            </template>
            <div class="summary">{{ item.summary }}</div>
            <div class="meta">
              <NTag size="tiny" :bordered="false">{{ item.category }}</NTag>
              <NTag size="tiny" :bordered="false" type="warning">{{ t('experts.kind.team') }}</NTag>
            </div>
          </NCard>
        </div>

        <div v-else class="cards">
          <NEmpty v-if="installedItems.length === 0" :description="t('experts.installedEmpty')" />
          <NCard
            v-for="row in installedItems"
            :key="row.expert_slug"
            class="card"
            hoverable
            @click="openDetail(row.expert_slug)"
          >
            <template #header>
              <div class="card-head">
                <span class="name">{{ row.expert_name || row.expert_slug }}</span>
                <NTag size="tiny" type="success" :bordered="false">{{ row.installed_version }}</NTag>
              </div>
            </template>
            <template #header-extra>
              <NTag size="tiny" :bordered="false" :type="row.status === 'installed' ? 'info' : row.status === 'failed' ? 'error' : 'default'">
                {{ statusLabel(row) }}
              </NTag>
            </template>
            <div class="summary">{{ row.kind }} · {{ row.category }}</div>
            <div v-if="row.status === 'failed'" class="error">
              {{ t('experts.lastError') }}: {{ row.last_error }}
            </div>
          </NCard>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.experts-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
  padding: 0 20px 20px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 0 12px;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: $text-primary;
  margin: 0;
}

.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid $border-color;
  margin-bottom: 14px;
}

.tab {
  border: none;
  background: transparent;
  color: $text-secondary;
  font-size: 13px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tab.active {
  color: $accent-primary;
  border-bottom-color: $accent-primary;
}

.experts-content {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 30px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 12px;
}

.card {
  cursor: pointer;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name {
  font-weight: 600;
  color: $text-primary;
}

.summary {
  font-size: 13px;
  color: $text-secondary;
  margin-bottom: 8px;
}

.meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.error {
  margin-top: 6px;
  font-size: 12px;
  color: $error;
}
</style>
