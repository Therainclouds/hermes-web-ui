<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { NovelJob } from '../../../../shared/trpg-novel'
defineProps<{ usage?: NovelJob['tokenUsage'] }>()
const { t } = useI18n()
</script>
<template>
  <p class="token-usage" role="status" v-if="usage">{{ t('trpg.harness.tokenUsage', { total: (usage.inputTokens + usage.outputTokens).toLocaleString(), input: usage.inputTokens.toLocaleString(), output: usage.outputTokens.toLocaleString() }) }} · {{ t(usage.estimatedCalls ? 'trpg.harness.tokenEstimated' : 'trpg.harness.tokenReported') }}<small v-if="usage.incompleteCalls || usage.untrackedCalls"> · {{ t('trpg.harness.tokenPartial', { failed: usage.incompleteCalls, old: usage.untrackedCalls }) }}</small></p>
  <p class="token-usage" v-else>{{ t('trpg.harness.tokenUnavailable') }}</p>
</template>
<style scoped>.token-usage { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }</style>
