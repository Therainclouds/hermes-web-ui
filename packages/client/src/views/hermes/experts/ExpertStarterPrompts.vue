<script setup lang="ts">
/**
 * ExpertStarterPrompts - 启动提示列表
 * - 用于详情页与未来可能的卡片预览
 */
import { useI18n } from 'vue-i18n'

defineProps<{
  prompts: string[]
}>()

const { t } = useI18n()
</script>

<template>
  <ul v-if="prompts && prompts.length > 0" class="starter-prompts">
    <li v-for="(prompt, i) in prompts" :key="i" class="starter-item">
      <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>
      <span class="text">{{ prompt }}</span>
    </li>
  </ul>
  <p v-else class="empty">{{ t('experts.detail.noStarterPrompts') }}</p>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.starter-prompts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.starter-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border-radius: $radius-sm;
  border-left: 2px solid $accent-primary;
}

.idx {
  font-family: $font-code;
  font-size: 11px;
  color: $text-muted;
  min-width: 22px;
}

.text {
  font-size: 13px;
  color: $text-primary;
  line-height: 1.55;
}

.empty {
  margin: 0;
  font-size: 12.5px;
  color: $text-muted;
}
</style>