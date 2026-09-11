<script setup lang="ts">
import { NAlert, NButton, NCard, NInput, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { KnowledgeSettings } from '../api'

const { t } = useI18n()

const props = defineProps<{
  settings: KnowledgeSettings | null
  apiKeyInput: string
  savingKey: boolean
  canSave: boolean
  validationError: string | null
}>()

const emit = defineEmits<{
  (e: 'update:apiKeyInput', value: string): void
  (e: 'save'): void
}>()

function onInput(value: string): void {
  emit('update:apiKeyInput', value)
}
</script>

<template>
  <NCard :title="t('knowledge.settings.title')" size="small" class="knowledge-settings-card">
    <NAlert v-if="props.settings && !props.settings.enabled" type="warning" class="settings-alert">
      {{ t('knowledge.settings.pluginDisabled') }}
    </NAlert>
    <template v-else>
      <p class="settings-status">
        <template v-if="props.settings?.keyConfigured">
          {{ t('knowledge.settings.keyConfigured', { hint: props.settings.keyHint ?? '????' }) }}
        </template>
        <template v-else>
          {{ t('knowledge.settings.notConfigured') }}
        </template>
      </p>
      <NSpace align="center" :wrap="false">
        <NInput
          :value="props.apiKeyInput"
          type="password"
          show-password-on="click"
          :placeholder="t('knowledge.settings.apiKeyPlaceholder')"
          style="width: 360px"
          @update:value="onInput"
        />
        <NButton
          type="primary"
          size="small"
          :loading="props.savingKey"
          :disabled="!props.canSave"
          @click="emit('save')"
        >
          {{ t('knowledge.settings.save') }}
        </NButton>
      </NSpace>
      <p v-if="props.validationError" class="settings-error">
        {{ props.validationError }}
      </p>
    </template>
  </NCard>
</template>

<style scoped>
.knowledge-settings-card {
  margin-bottom: 0;
}
.settings-alert {
  margin: 0;
}
.settings-status {
  margin: 0 0 8px;
  opacity: 0.7;
  font-size: 13px;
}
.settings-error {
  margin: 6px 0 0;
  color: var(--error-color, #d03050);
  font-size: 12px;
}
</style>