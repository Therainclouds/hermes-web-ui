<script setup lang="ts">
/**
 * ExpertsView - 专家中心列表页
 * 结构：Hero + 分类 Chips + Featured 轮播 + Tabs + 卡片网格
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NEmpty, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useExpertsStore } from '@/stores/hermes/experts'
import * as expertsApi from '@/api/hermes/experts'
import type { ExpertCatalogItem, InstalledExpertRow } from '@/api/hermes/experts'
import {
  ExpertCard,
  ExpertFeaturedCarousel,
  ExpertHero,
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

// Only used by the v-else branch (published + team tabs). The installed
// tab renders its own <template> above. Typed explicitly so the template
// can access catalog-only fields (slug) without TS widening to the union.
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
</script>

<template>
  <div class="experts-view">
    <ExpertHero
      :search="expertsStore.searchQuery"
      :loading="expertsStore.loading"
      @update:search="(v) => (expertsStore.searchQuery = v)"
      @refresh="handleRefresh"
    />

    <div class="chips">
      <button
        class="chip"
        :class="{ active: !expertsStore.categoryFilter }"
        @click="setCategory(null)"
      >
        {{ t('experts.allCategories') }}
      </button>
      <button
        v-for="cat in expertsStore.categories"
        :key="cat"
        class="chip"
        :class="{ active: expertsStore.categoryFilter === cat }"
        @click="setCategory(cat)"
      >
        {{ cat }}
      </button>
      <span class="chip-divider" />
      <button
        class="chip featured"
        :class="{ active: expertsStore.featuredOnly }"
        @click="expertsStore.featuredOnly = !expertsStore.featuredOnly"
      >
        ★ {{ t('experts.featured') }}
      </button>
    </div>

    <ExpertFeaturedCarousel
      v-if="!expertsStore.featuredOnly && activeTab === 'published'"
      :items="expertsStore.catalog"
      @open="openDetail"
    />

    <div class="tab-bar">
      <button class="tab" :class="{ active: activeTab === 'published' }" @click="activeTab = 'published'">
        {{ t('experts.tabPublished') }}
        <span class="tab-count">({{ publishedItems.length }})</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'team' }" @click="activeTab = 'team'">
        {{ t('experts.tabTeam') }}
        <span class="tab-count">({{ teamItems.length }})</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'installed' }" @click="activeTab = 'installed'">
        {{ t('experts.tabInstalled') }}
        <span class="tab-count">({{ installedItems.length }})</span>
      </button>
      <span v-if="activeCategoryLabel" class="active-filter">
        {{ t('experts.filteredBy') }}: <strong>{{ activeCategoryLabel }}</strong>
      </span>
    </div>

    <div class="experts-content">
      <NSpin :show="expertsStore.loading">
        <NEmpty v-if="showEmpty" :description="emptyDescription" />
        <div v-else class="cards">
          <template v-if="activeTab === 'installed'">
            <ExpertCard
              v-for="row in visibleInstalled"
              :key="row.expert_slug"
              :item="row"
              mode="installed"
              :installed="row"
              @open="openDetail"
            />
          </template>
          <template v-else>
            <ExpertCard
              v-for="item in currentItems"
              :key="item.slug"
              :item="item"
              :mode="activeTab === 'team' ? 'team' : 'published'"
              :installed="expertsStore.findReadyInstalled(item.slug)"
              @open="openDetail"
              @start-chat="handleStartChat"
            />
          </template>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.experts-view {
  display: flex;
  flex-direction: column;
  padding: 0 20px 20px;
  min-height: calc(100 * var(--vh));
}

.chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 4px 0 14px;
}

.chip {
  height: 28px;
  padding: 0 12px;
  font-size: 12.5px;
  color: $text-secondary;
  background: transparent;
  border: 1px solid $border-light;
  border-radius: 999px;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover { color: $text-primary; border-color: $border-color; }

  &.active {
    color: var(--text-on-accent);
    background: $accent-primary;
    border-color: $accent-primary;
  }

  &.featured.active { background: var(--warning); border-color: var(--warning); }
}

.chip-divider {
  width: 1px;
  height: 18px;
  background: $border-color;
  margin: 0 4px;
}

.tab-bar {
  display: flex;
  align-items: center;
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
  display: flex;
  align-items: center;
  gap: 4px;
  transition: color $transition-fast;
}

.tab:hover { color: $text-primary; }

.tab.active {
  color: $accent-primary;
  border-bottom-color: $accent-primary;
}

.tab-count {
  font-size: 11px;
  color: $text-muted;
}

.active-filter {
  margin-left: auto;
  font-size: 12px;
  color: $text-muted;
}

.experts-content {
  flex: 1;
  padding-bottom: 30px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  gap: 12px;
}
</style>
