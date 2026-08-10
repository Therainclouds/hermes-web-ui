<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal, NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { bindSuperAdmin } from '@/api/auth'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  bound: [token: string, user: { id: number; username: string; role: string }]
}>()

const { t } = useI18n()

const step = ref<'confirm' | 'credentials'>('confirm')
const username = ref('')
const password = ref('')
const submitting = ref(false)
const localError = ref('')

watch(
  () => props.open,
  (next) => {
    if (next) {
      step.value = 'confirm'
      username.value = ''
      password.value = ''
      localError.value = ''
      submitting.value = false
    }
  },
)

function proceedToCredentials() {
  step.value = 'credentials'
  localError.value = ''
}

async function handleBind() {
  if (!username.value.trim() || !password.value || submitting.value) return
  submitting.value = true
  localError.value = ''
  try {
    const result = await bindSuperAdmin(username.value.trim(), password.value)
    emit('bound', result.token, result.user)
  } catch (err: any) {
    localError.value = err?.message || t('login.bindSuperAdminFailed')
  } finally {
    submitting.value = false
  }
}

function handleClose() {
  if (submitting.value) return
  emit('close')
}
</script>

<template>
  <NModal
    :show="open"
    preset="card"
    :title="t('login.bindSuperAdminTitle')"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    :mask-closable="!submitting"
    :closable="!submitting"
    @update:show="show => { if (!show && !submitting) handleClose() }"
  >
    <!-- Step 1: ask whether to bind this WeChat account to super admin -->
    <div v-if="step === 'confirm'" class="bind-modal">
      <p class="bind-modal__desc">{{ t('login.bindSuperAdminPrompt') }}</p>
      <p class="bind-modal__hint">{{ t('login.bindSuperAdminSkipHint') }}</p>
    </div>

    <!-- Step 2: enter super admin credentials -->
    <div v-else class="bind-modal">
      <p class="bind-modal__desc">{{ t('login.bindSuperAdminCredentialsPrompt') }}</p>
      <NInput
        v-model:value="username"
        :placeholder="t('login.bindSuperAdminUsernamePlaceholder')"
        :disabled="submitting"
      />
      <NInput
        v-model:value="password"
        type="password"
        :placeholder="t('login.bindSuperAdminPasswordPlaceholder')"
        :disabled="submitting"
        @keyup.enter="handleBind"
      />
      <p v-if="localError" class="bind-modal__error">{{ localError }}</p>
    </div>

    <template #footer>
      <div class="bind-modal__footer">
        <template v-if="step === 'confirm'">
          <NButton :disabled="submitting" @click="handleClose">
            {{ t('login.bindSuperAdminNo') }}
          </NButton>
          <NButton type="primary" @click="proceedToCredentials">
            {{ t('login.bindSuperAdminYes') }}
          </NButton>
        </template>
        <template v-else>
          <NButton :disabled="submitting" @click="handleClose">
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            type="primary"
            :loading="submitting"
            :disabled="!username.trim() || !password"
            @click="handleBind"
          >
            {{ t('common.confirm') }}
          </NButton>
        </template>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.bind-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bind-modal__desc {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  opacity: 0.9;
}

.bind-modal__hint {
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
  opacity: 0.65;
}

.bind-modal__error {
  color: #d03050;
  font-size: 12px;
  margin: 0;
}

.bind-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
