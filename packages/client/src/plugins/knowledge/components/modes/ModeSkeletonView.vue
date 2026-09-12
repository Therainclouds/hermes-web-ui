<script setup lang="ts">
/**
 * Shared placeholder for modes whose feature set lands in a later
 * round (legal / learning / batch in round 1). Renders the mode icon
 * plus a "coming soon" empty state.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NEmpty } from 'naive-ui'
import { KNOWLEDGE_MODES, type KnowledgeMode } from '../../modes'

const props = defineProps<{
  modeId: KnowledgeMode
}>()

const { t } = useI18n()

const iconPath = computed(
  () => KNOWLEDGE_MODES.find(m => m.id === props.modeId)?.iconPath ?? '',
)
</script>

<template>
  <div class="mode-skeleton">
    <svg class="skeleton-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path :d="iconPath" />
    </svg>
    <NEmpty :description="t('knowledge.modePlaceholder.comingSoon')" size="large">
      <template #extra>
        <p class="skeleton-desc">{{ t(`knowledge.modes.${modeId}.desc`) }}</p>
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
