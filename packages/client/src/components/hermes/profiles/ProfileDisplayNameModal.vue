<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NText } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'
import { useMessage } from '@/composables/useAppMessage'

const props = defineProps<{ profileName: string; currentDisplayName?: string }>()
const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const displayName = ref('')

onMounted(() => {
  displayName.value = props.currentDisplayName || ''
})

async function handleSave() {
  loading.value = true
  try {
    await profilesStore.updateDisplayName(props.profileName, displayName.value.trim())
    message.success(t('profiles.displayNameSaveSuccess'))
    emit('saved')
  } catch (err: any) {
    message.error(err?.message || t('profiles.displayNameSaveFailed'))
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('profiles.editDisplayName')"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('profiles.displayName')">
        <NInput
          v-model:value="displayName"
          :placeholder="t('profiles.displayNamePlaceholder')"
          maxlength="40"
        />
        <NText depth="3" style="font-size: 12px; margin-top: 4px;">
          {{ t('profiles.displayNameHint') }}
        </NText>
        <NText v-if="!displayName" depth="3" type="warning" style="font-size: 12px; margin-top: 4px;">
          {{ t('profiles.displayNameClearHint') }}
        </NText>
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="loading" @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ t('common.confirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
