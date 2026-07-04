<script setup lang="ts">
/**
 * ExpertsView - 专家中心列表页
 * 结构：page-header + 分类 Chips + Featured 轮播 + NTabs + 卡片网格
 */
import { computed, onMounted } from 'vue'
import { NEmpty, NInput, NSpin, NTabPane, NTabs, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useExpertsStore } from '@/stores/hermes/experts'
import * as expertsApi from '@/api/hermes/experts'
import type { ExpertCatalogItem, InstalledExpertRow } from '@/api/hermes/experts'
import {
  ExpertCard,
  ExpertFeaturedCarousel,
} from '@/views/hermes/experts'

const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const expertsStore = useExpertsStore()

const activeTab = computed<'published' | 'team' | 'installed'>({
  get: () => expertsStore.categoryFilter === '__team__'
    ? 'team'
    : expertsStore.categoryFilter === '__installed__'
      ? 'installed'
      : 'published',
  set: (v) => {
    if (v === 'team') expertsStore.categoryFilter = '__team__'
    else if (v === 'installed') expertsStore.categoryFilter = '__installed__'
    else expertsStore.categoryFilter = null
  },
})

const publishedItems = computed(() => expertsStore.catalog.filter((c) => c.kind === 'expert'))
const teamItems = computed(() => expertsStore.catalog.filter((c) => c.kind === 'team'))
const installedItems = computed(() => expertsStore.installed)

function applySearchFilter<T extends { name: string; summary: string; category: string }>(items: T[]): T[] {
  const q = expertsStore.searchQuery.trim().toLowerCase()
  if (!q) return items
  return items.filter((it) =>
    [it.name, it.summary, it.category].some((v) => String(v || '').toLowerCase().includes(q)),
  )
}

function filterInstalled(items: InstalledExpertRow[]): InstalledExpertRow[] {
  const q = expertsStore.searchQuery.trim().toLowerCase()
  if (!q) return items
  return items.filter((it) =>
    [it.expert_name, it.category].some((v) => String(v || '').toLowerCase().includes(q)),
  )
}

function applyCategoryFilter<T extends { category: string }>(items: T[]): T[] {
  const filter = expertsStore.categoryFilter
  if (!filter || filter === '__team__' || filter === '__installed__') return items
  return items.filter((it) => it.category === filter)
}

function applyFeaturedFilter<T extends { is_featured?: boolean }>(items: T[]): T[] {
  return expertsStore.featuredOnly ? items.filter((it) => it.is_featured) : items
}

const visiblePublished = computed(() => applyFeaturedFilter(applyCategoryFilter(applySearchFilter(publishedItems.value))))
const visibleTeam = computed(() => applyFeaturedFilter(applyCategoryFilter(applySearchFilter(teamItems.value))))
const visibleInstalled = computed(() => filterInstalled(installedItems.value))

const currentItems = computed<ExpertCatalogItem[]>(() => {
  if (activeTab.value === 'team') return visibleTeam.value
  return visiblePublished.value
})

const activeCategoryLabel = computed(() => {
  const f = expertsStore.categoryFilter
  if (!f || f === '__team__' || f === '__installed__') return null
  return f
})

const showEmpty = computed(() => !expertsStore.loading && currentItems.value.length === 0)

const emptyDescription = computed(() => {
  if (activeTab.value === 'installed') return t('experts.installedEmpty')
  if (expertsStore.searchQuery.trim()) return t('experts.emptySearch')
  return t('experts.empty')
})

const totalExperts = computed(() => publishedItems.value.length + teamItems.value.length + installedItems.value.length)

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

async function handleStartChat(slug: string) {
  const installed = expertsStore.findReadyInstalled(slug)
  if (!installed) return
  const binding = expertsStore.bindings.find((b) => b.expert_slug === slug)
  if (!binding) {
    message.warning(t('experts.detail.noBinding'))
    return
  }
  try {
    localStorage.setItem('hermes_active_profile_name', binding.profile_name)
    await expertsApi.activateExpertProfile(binding.profile_name)
    message.success(t('experts.detail.startChatSuccess'))
    router.push({ name: 'hermes.chat' })
  } catch {
    message.error(t('experts.detail.startChatFailed'))
  }
}

function setCategory(cat: string | null) {
  expertsStore.categoryFilter = cat
}

function clearSearch() {
  expertsStore.searchQuery = ''
}
</script>

<template>
  <div class="experts-view">
    <header class="page-header">
      <div class="header-title-block">
        <h2 class="header-title">{{ t('experts.title') }}</h2>
        <span class="header-subtitle">{{ t('experts.subtitle') }}</span>
      </div>
      <div class="header-actions">
        <NInput
          :value="expertsStore.searchQuery"
          :placeholder="t('experts.searchPlaceholder')"
          clearable
          size="small"
          class="header-search"
          @update:value="(v: string) => (expertsStore.searchQuery = v)"
        >
          <template #prefix>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </template>
        </NInput>
        <span class="header-count">{{ totalExperts }}</span>
        <button
          type="button"
          class="n-btn-base"
          :disabled="expertsStore.loading"
          @click="handleRefresh"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          <span>{{ t('experts.refresh') }}</span>
        </button>
      </div>
    </header>

    <div class="experts-content">
      <div class="chips">
        <button
          type="button"
          class="chip"
          :class="{ active: !expertsStore.categoryFilter }"
          @click="setCategory(null)"
        >
          {{ t('experts.allCategories') }}
        </button>
        <button
          v-for="cat in expertsStore.categories"
          :key="cat"
          type="button"
          class="chip"
          :class="{ active: expertsStore.categoryFilter === cat }"
          @click="setCategory(cat)"
        >
          {{ cat }}
        </button>
        <span class="chip-divider" />
        <button
          type="button"
          class="chip featured"
          :class="{ active: expertsStore.featuredOnly }"
          @click="expertsStore.featuredOnly = !expertsStore.featuredOnly"
        >
          ★ {{ t('experts.featured') }}
        </button>
        <button
          v-if="expertsStore.searchQuery"
          type="button"
          class="chip clear"
          @click="clearSearch"
        >
          ✕ {{ t('common.cancel') }}
        </button>
      </div>

      <ExpertFeaturedCarousel
        v-if="!expertsStore.featuredOnly && activeTab === 'published'"
        :items="expertsStore.catalog"
        @open="openDetail"
      />

      <NTabs
        v-model:value="activeTab"
        type="line"
        animated
        class="experts-tabs"
      >
        <NTabPane
          name="published"
          :tab="`${t('experts.tabPublished')} (${publishedItems.length})`"
        >
          <NSpin :show="expertsStore.loading">
            <NEmpty v-if="showEmpty && activeCategoryLabel == null && !expertsStore.searchQuery.trim()" :description="emptyDescription" />
            <NEmpty v-else-if="showEmpty" :description="emptyDescription">
              <template #extra>
                <button type="button" class="n-btn-base" @click="setCategory(null)">
                  {{ t('experts.allCategories') }}
                </button>
              </template>
            </NEmpty>
            <div v-else class="cards">
              <ExpertCard
                v-for="item in currentItems"
                :key="item.slug"
                :item="item"
                mode="published"
                :installed="expertsStore.findReadyInstalled(item.slug)"
                @open="openDetail"
                @start-chat="handleStartChat"
              />
            </div>
          </NSpin>
        </NTabPane>

        <NTabPane
          name="team"
          :tab="`${t('experts.tabTeam')} (${teamItems.length})`"
        >
          <NSpin :show="expertsStore.loading">
            <NEmpty v-if="visibleTeam.length === 0" :description="emptyDescription" />
            <div v-else class="cards">
              <ExpertCard
                v-for="item in visibleTeam"
                :key="item.slug"
                :item="item"
                mode="team"
                :installed="expertsStore.findReadyInstalled(item.slug)"
                @open="openDetail"
                @start-chat="handleStartChat"
              />
            </div>
          </NSpin>
        </NTabPane>

        <NTabPane
          name="installed"
          :tab="`${t('experts.tabInstalled')} (${installedItems.length})`"
        >
          <NSpin :show="expertsStore.loading">
            <NEmpty v-if="visibleInstalled.length === 0" :description="emptyDescription" />
            <div v-else class="cards">
              <ExpertCard
                v-for="row in visibleInstalled"
                :key="row.expert_slug"
                :item="row"
                mode="installed"
                :installed="row"
                @open="openDetail"
              />
            </div>
          </NSpin>
        </NTabPane>
      </NTabs>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.experts-view {
  display: flex;
  flex-direction: column;
  height: calc(100 * var(--vh));
}

// ── page-header 增强（保持全局 .page-header 的视觉基线） ───────────────
.header-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.header-subtitle {
  font-size: 12px;
  color: $text-muted;
  line-height: 1.4;
}

.header-actions {
  gap: 10px;
}

.header-search {
  width: 280px;
}

.header-count {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--bg-secondary);
  color: $text-muted;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

// 复用项目原生 n 按钮视觉，仅在 scoped 内提供 layout helper
.n-btn-base {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  font-size: 12.5px;
  font-family: inherit;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover:not(:disabled) {
    color: $text-primary;
    background: var(--bg-secondary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

// ── 内容区 ────────────────────────────────────────────────────────────
.experts-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
}

// ── chips 行 ──────────────────────────────────────────────────────────
.chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 4px 0 12px;
}

.chip {
  height: 28px;
  padding: 0 12px;
  font-size: 12.5px;
  font-family: inherit;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-light;
  border-radius: 999px;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    border-color: $border-color;
  }

  &.active {
    color: var(--text-on-accent);
    background: $accent-primary;
    border-color: $accent-primary;
  }

  &.featured.active {
    color: var(--text-on-accent);
    background: $warning;
    border-color: $warning;
  }

  &.clear {
    color: $text-muted;
    border-style: dashed;

    &:hover {
      color: $text-primary;
    }
  }
}

.chip-divider {
  width: 1px;
  height: 18px;
  background: $border-color;
  margin: 0 4px;
}

// ── NTabs 主题对齐 ───────────────────────────────────────────────────
.experts-tabs :deep(.n-tabs-nav) {
  padding-bottom: 1px;
}

.experts-tabs :deep(.n-tabs-tab) {
  font-size: 13px;
  padding: 8px 12px;
}

// ── 卡片网格 ─────────────────────────────────────────────────────────
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  gap: 12px;
  padding-top: 4px;
}

// ── 响应式 ────────────────────────────────────────────────────────────
@media (max-width: $breakpoint-mobile) {
  .header-search {
    width: 100%;
  }

  .chips {
    padding-bottom: 8px;
  }
}
</style>
