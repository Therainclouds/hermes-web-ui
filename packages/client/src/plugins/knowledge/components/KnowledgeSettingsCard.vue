<script setup lang="ts">
import { NAlert, NButton, NInput, NSpace } from 'naive-ui'
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
  <div class="knowledge-settings-form">
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
      <NSpace align="center" :wrap="false" class="settings-row">
        <NInput
          :value="props.apiKeyInput"
          type="password"
          show-password-on="click"
          :placeholder="t('knowledge.settings.apiKeyPlaceholder')"
          style="flex: 1; min-width: 0"
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
  </div>
</template>

<style scoped>
.knowledge-settings-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
  max-width: 100%;
}
.settings-alert {
  margin: 0;
}
.settings-status {
  margin: 0;
  opacity: 0.7;
  font-size: 13px;
  line-height: 1.5;
}
.settings-row {
  width: 100%;
}
.settings-error {
  margin: 4px 0 0;
  color: var(--error-color, #d03050);
  font-size: 12px;
}
</style>