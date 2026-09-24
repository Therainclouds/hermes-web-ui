<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { writingStages, type WritingSettings, type WritingModel, type WritingStage } from '../../../../shared/trpg-writing'
const props = defineProps<{ modelValue: WritingSettings; advanced?: boolean; catalog?: WritingModel[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: WritingSettings]; loadModels: [] }>()
const { t } = useI18n()
const rows = computed(() => props.advanced ? ['default', ...writingStages] : ['default'])
function selected(row: string) { return row === 'default' ? props.modelValue.defaultModel : props.modelValue.stages?.[row as WritingStage] }
function choices(row: string) {
  const value = selected(row), all = [...(props.catalog ?? [])]
  if (value && !all.some(m => m.model === value.model && m.provider === value.provider)) all.unshift(value)
  return all
}
function encode(value: WritingModel) { return JSON.stringify([value.provider, value.model]) }
function change(row: string, raw: string) {
  const pair = raw ? JSON.parse(raw) as [string, string] : undefined
  const value: WritingModel | undefined = pair ? { provider: pair[0], model: pair[1] } : undefined
  const settings = { ...props.modelValue, stages: { ...props.modelValue.stages } }
  if (row === 'default') settings.defaultModel = value
  else settings.stages[row as WritingStage] = value
  emit('update:modelValue', settings)
}
function toggle(key: 'pauseAfterOutline' | 'pauseAfterChapter' | 'economy', value: boolean) { emit('update:modelValue', { ...props.modelValue, [key]: value }) }
</script>
<template>
  <fieldset class="writing-settings" :disabled="disabled">
    <legend>{{ t('trpg.harness.models') }}</legend>
    <label class="check"><input type="checkbox" :checked="modelValue.economy" @change="toggle('economy', ($event.target as HTMLInputElement).checked)" />{{ t('trpg.harness.economy') }}</label><p>{{ t('trpg.harness.economyHint') }}</p>
    <label class="check"><input type="checkbox" :checked="modelValue.consistency === 'block'" @change="emit('update:modelValue', { ...modelValue, consistency: ($event.target as HTMLInputElement).checked ? 'block' : 'warn' })" />{{ t('trpg.harness.strictConsistency') }}</label><p>{{ t('trpg.harness.strictConsistencyHint') }}</p>
    <p>{{ t('trpg.harness.modelHint') }}</p>
    <button type="button" @click="emit('loadModels')">{{ t('trpg.harness.loadModels') }}</button>
    <label v-for="row in rows" :key="row">
      <span>{{ t(`trpg.harness.modelStage.${row}`) }}</span>
      <select :value="selected(row) ? encode(selected(row)!) : ''" @change="change(row, ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t(row === 'default' ? 'trpg.harness.profileDefault' : 'trpg.harness.inheritModel') }}</option>
        <option v-for="m in choices(row)" :key="`${m.provider}/${m.model}`" :value="encode(m)">{{ m.provider }} / {{ m.model }}</option>
      </select>
    </label>
    <template v-if="advanced">
      <label>{{ t('trpg.harness.totalTarget') }}<input type="number" min="5000" max="60000" step="1000" :value="modelValue.targetChars ?? ''" @input="emit('update:modelValue', { ...modelValue, targetChars: ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : undefined })" /></label><p>{{ t('trpg.harness.totalTargetHint') }}</p>
      <label>{{ t('trpg.harness.concurrency') }}<select :value="modelValue.concurrency ?? 2" @change="emit('update:modelValue', { ...modelValue, concurrency: Number(($event.target as HTMLSelectElement).value) })"><option v-for="n in [1,2,3,4]" :key="n" :value="n">{{ n }}</option></select></label><p>{{ t('trpg.harness.concurrencyHint') }}</p>
      <label class="check"><input type="checkbox" :checked="modelValue.pauseAfterOutline" @change="toggle('pauseAfterOutline', ($event.target as HTMLInputElement).checked)" />{{ t('trpg.harness.pauseOutline') }}</label>
      <label class="check"><input type="checkbox" :checked="modelValue.pauseAfterChapter" @change="toggle('pauseAfterChapter', ($event.target as HTMLInputElement).checked)" />{{ t('trpg.harness.pauseChapter') }}</label>
    </template>
  </fieldset>
</template>
<style scoped>
.writing-settings { border: 1px solid #ad895755; border-radius: 10px; margin: 14px 0; padding: 14px; min-width: 0; }
legend { padding: 0 6px; }
p { font-size: 12px; line-height: 1.6; opacity: .8; }
label { display: grid; gap: 5px; margin: 12px 0; font-size: 13px; }
.check { display: flex; align-items: center; }
input[type=number],select { width: 100%; min-width: 0; padding: 8px; background: #251e16; color: #eedbc0; border: 1px solid #ad895755; border-radius: 5px; }
button { padding: 7px 10px; border: 1px solid #ad895755; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; }
</style>
