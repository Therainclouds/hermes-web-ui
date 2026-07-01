<script setup lang="ts">
/**
 * ExpertFeaturedCarousel - Featured 横向滚动区
 * - 纯 CSS scroll-snap，不引入额外依赖
 */
import { computed, ref } from 'vue'
import { NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ExpertCover from './ExpertCover.vue'
import type { ExpertCatalogItem } from '@/api/hermes/experts'

const props = defineProps<{
  items: ExpertCatalogItem[]
}>()

const emit = defineEmits<{
  (e: 'open', slug: string): void
}>()

const { t } = useI18n()
const scroller = ref<HTMLElement | null>(null)

const featured = computed(() => props.items.filter((it) => it.is_featured))

function scrollBy(delta: number) {
  scroller.value?.scrollBy({ left: delta, behavior: 'smooth' })
}
</script>

<template>
  <section v-if="featured.length > 0" class="featured">
    <div class="featured-head">
      <div class="head-text">
        <span class="kicker">{{ t('experts.featured') }}</span>
        <span class="count">{{ featured.length }}</span>
      </div>
      <div class="head-nav">
        <button class="nav-btn" aria-label="prev" @click="scrollBy(-360)">‹</button>
        <button class="nav-btn" aria-label="next" @click="scrollBy(360)">›</button>
      </div>
    </div>

    <div ref="scroller" class="scroller">
      <article
        v-for="item in featured"
        :key="item.slug"
        class="featured-card"
        tabindex="0"
        @click="emit('open', item.slug)"
        @keyup.enter="emit('open', item.slug)"
      >
        <ExpertCover :name="item.name" :slug="item.slug" :icon-url="item.icon_url" :cover-url="item.cover_url" size="lg" />
        <div class="featured-meta">
          <div class="featured-title-row">
            <span class="featured-name">{{ item.name }}</span>
            <NTag size="tiny" :bordered="false">{{ item.category }}</NTag>
          </div>
          <p class="featured-summary">{{ item.summary }}</p>
          <span class="featured-version">v{{ item.latest_version?.version || '-' }}</span>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.featured {
  margin: 4px 0 18px;
}

.featured-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.head-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.kicker {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: $text-muted;
}

.count {
  font-size: 11px;
  color: $text-muted;
  background: var(--bg-secondary);
  padding: 1px 8px;
  border-radius: 999px;
}

.head-nav {
  display: flex;
  gap: 6px;
}

.nav-btn {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid $border-color;
  background: $bg-card;
  color: $text-secondary;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    background: var(--bg-secondary);
    color: $text-primary;
  }
}

.scroller {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: thin;
  padding-bottom: 6px;

  &::-webkit-scrollbar { height: 6px; }
  &::-webkit-scrollbar-thumb { background: $border-color; border-radius: 3px; }
}

.featured-card {
  flex: 0 0 320px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  cursor: pointer;
  scroll-snap-align: start;
  transition: all $transition-fast;

  &:hover,
  &:focus-visible {
    border-color: $border-color;
    box-shadow: 0 6px 18px rgba(var(--text-primary-rgb), 0.06);
    transform: translateY(-1px);
  }
}

.featured-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.featured-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.featured-name {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.featured-summary {
  margin: 0;
  font-size: 12.5px;
  color: $text-secondary;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.featured-version {
  font-size: 11px;
  color: $text-muted;
  font-family: $font-code;
}
</style>