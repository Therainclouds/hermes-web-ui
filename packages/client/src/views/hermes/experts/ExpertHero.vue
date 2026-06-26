<script setup lang="ts">
/**
 * ExpertHero - 列表页顶部 Hero 区
 * - 标题/副标题 + 搜索 + 刷新
 */
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'

defineProps<{
  search: string
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:search', value: string): void
  (e: 'refresh'): void
}>()

const { t } = useI18n()

function onSearchInput(value: string) {
  emit('update:search', value)
}
</script>

<template>
  <section class="hero">
    <div class="hero-text">
      <h1 class="title">{{ t('experts.title') }}</h1>
      <p class="subtitle">{{ t('experts.subtitle') }}</p>
    </div>

    <div class="hero-actions">
      <NInput
        :value="search"
        :placeholder="t('experts.searchPlaceholder')"
        clearable
        class="search-input"
        @update:value="onSearchInput"
      >
        <template #prefix>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </template>
      </NInput>
      <NButton :loading="loading" @click="emit('refresh')">
        {{ t('experts.refresh') }}
      </NButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 0 20px;
  border-bottom: 1px solid $border-light;
  margin-bottom: 16px;
}

.hero-text {
  min-width: 0;
}

.title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: $text-primary;
  letter-spacing: -0.01em;
}

.subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: $text-secondary;
  max-width: 56ch;
  line-height: 1.5;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.search-input {
  width: 280px;
}

@media (max-width: $breakpoint-mobile) {
  .hero {
    flex-direction: column;
    align-items: stretch;
  }
  .hero-actions { width: 100%; }
  .search-input { width: 100%; }
}
</style>