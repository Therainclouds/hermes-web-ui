<script setup lang="ts">
/**
 * Learning mode — round-1 skeleton. Round 2 adds the backlink (双链)
 * panel: bidirectional document references derived from the citation
 * log plus chunk-level co-occurrence.
 */
import { useI18n } from 'vue-i18n'
import { NEmpty } from 'naive-ui'
import { KNOWLEDGE_MODES } from '../../modes'

const { t } = useI18n()
const iconPath = KNOWLEDGE_MODES.find(m => m.id === 'learning')?.iconPath ?? ''
</script>

<template>
  <div class="mode-skeleton">
    <svg class="skeleton-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path :d="iconPath" />
    </svg>
    <NEmpty :description="t('knowledge.modePlaceholder.comingSoon')" size="large">
      <template #extra>
        <p class="skeleton-desc">{{ t('knowledge.modes.learning.desc') }}</p>
      </template>
    </NEmpty>
  </div>
</template>

<style scoped>
.mode-skeleton {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 48px 24px;
  opacity: 0.9;
}
.skeleton-icon {
  width: 40px;
  height: 40px;
  opacity: 0.4;
}
.skeleton-desc {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.6;
}
</style>
