<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NModal, NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'

export type RecoveryAction = 'clear-locks' | 'reset-password'

const props = defineProps<{
  open: boolean
  action: RecoveryAction
}>()

const emit = defineEmits<{
  close: []
  submit: [recoveryPassword: string]
}>()

const { t } = useI18n()

const recoveryPassword = ref('')
const submitting = ref(false)
const localError = ref('')

const title = computed(() => {
  return props.action === 'clear-locks'
    ? t('login.recoveryClearLocksTitle')
    : t('login.recoveryResetPasswordTitle')
})

const description = computed(() => {
  return props.action === 'clear-locks'
    ? t('login.recoveryClearLocksDescription')
    : t('login.recoveryResetPasswordDescription')
})

const successMessage = computed(() => {
  return props.action === 'clear-locks'
    ? t('login.recoveryClearLocksSuccess')
    : t('login.recoveryResetPasswordSuccess')
})

watch(
  () => props.open,
  (next) => {
    if (next) {
      recoveryPassword.value = ''
      localError.value = ''
      submitting.value = false
    }
  },
)

async function handleSubmit() {
  if (!recoveryPassword.value.trim() || submitting.value) return
  submitting.value = true
  localError.value = ''
  try {
    emit('submit', recoveryPassword.value)
  } catch (err: any) {
    submitting.value = false
    localError.value = err?.message || String(err)
  }
}

function handleCancel() {
  if (submitting.value) return
  emit('close')
}

defineExpose({
  setSubmitting(value: boolean) {
    submitting.value = value
  },
  setError(message: string) {
    localError.value = message
    submitting.value = false
  },
  showSuccess() {
    submitting.value = false
  },
  getSuccessMessage() {
    return successMessage.value
  },
})
</script>

<template>
  <NModal
    :show="open"
    preset="card"
    :title="title"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!submitting"
    @after-leave="emit('close')"
  >
    <div class="recovery-modal">
      <p class="recovery-modal__desc">{{ description }}</p>
      <NInput
        v-model:value="recoveryPassword"
        type="password"
        :placeholder="t('login.recoveryPasswordPlaceholder')"
        :disabled="submitting"
        @keyup.enter="handleSubmit"
      />
      <p v-if="localError" class="recovery-modal__error">{{ localError }}</p>
    </div>

    <template #footer>
      <div class="recovery-modal__footer">
        <NButton :disabled="submitting" @click="handleCancel">
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          type="primary"
          :loading="submitting"
          :disabled="!recoveryPassword.trim()"
          @click="handleSubmit"
        >
          {{ t('common.confirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.recovery-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.recovery-modal__desc {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  opacity: 0.85;
}

.recovery-modal__error {
  color: #d03050;
  font-size: 12px;
  margin: 0;
}

.recovery-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>