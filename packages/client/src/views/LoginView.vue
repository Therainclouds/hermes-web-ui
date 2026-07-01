<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, hasApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword } from "@/api/auth";
import { clearLoginLocks, resetDefaultLogin } from "@/api/recovery";
import RecoveryConfirmModal, {
  type RecoveryAction,
} from "@/components/auth/RecoveryConfirmModal.vue";

const { t } = useI18n();
const router = useRouter();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);

// Recovery modal state
type RecoveryModalState = { open: false } | { open: true; action: RecoveryAction };
const recoveryModal = ref<RecoveryModalState>({ open: false });
const recoveryModalRef = ref<InstanceType<typeof RecoveryConfirmModal> | null>(null);

// If already has a key, try to go to main page
if (hasApiKey()) {
  router.replace("/hermes/chat");
}

onMounted(async () => {
  try {
    await fetchAuthStatus();
  } catch {
    // Login remains available; the submit request will surface connection errors.
  }
});

async function handleLogin() {
  await handlePasswordLogin();
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";
  showLockResetHint.value = false;

  try {
    const sessionToken = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(sessionToken);
    router.replace("/hermes/chat");
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
      showLockResetHint.value = true;
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}

function openRecoveryModal(action: RecoveryAction) {
  recoveryModal.value = { open: true, action };
}

function closeRecoveryModal() {
  recoveryModal.value = { open: false };
}

async function handleRecoverySubmit(recoveryPassword: string) {
  if (!recoveryModal.value.open) return;
  const action = recoveryModal.value.action;
  try {
    if (action === "clear-locks") {
      await clearLoginLocks(recoveryPassword);
    } else {
      await resetDefaultLogin(recoveryPassword);
    }
    const successMessage = recoveryModalRef.value?.getSuccessMessage?.() || t("login.recoveryFailed");
    recoveryModalRef.value?.showSuccess();
    // Per product decision: clear the lock hint and surface a transient success
    // banner above the form, then close the modal.
    showLockResetHint.value = false;
    errorMsg.value = successMessage;
    setTimeout(() => {
      closeRecoveryModal();
      if (errorMsg.value === successMessage) errorMsg.value = "";
    }, 1800);
  } catch (err: any) {
    recoveryModalRef.value?.setError(err?.message || t("login.recoveryFailed"));
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="Quanta Hermes" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>
      <p class="login-default-hint">{{ t("login.defaultCredentialsHint") }}</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <input
          v-model="username"
          type="text"
          class="login-input"
          :placeholder="t('login.usernamePlaceholder')"
          autofocus
        />
        <input
          v-model="password"
          type="password"
          class="login-input"
          :placeholder="t('login.passwordPlaceholder')"
          @keyup.enter="handleLogin"
        />

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <div v-if="showLockResetHint" class="login-lock-hint">
          <span>{{ t("login.lockResetHint") }}</span>
          <div class="login-lock-hint__actions">
            <button
              type="button"
              class="login-lock-hint__btn"
              @click="openRecoveryModal('clear-locks')"
            >
              {{ t("login.recoveryClearLocksButton") }}
            </button>
            <button
              type="button"
              class="login-lock-hint__btn"
              @click="openRecoveryModal('reset-password')"
            >
              {{ t("login.recoveryResetPasswordButton") }}
            </button>
          </div>
          <span class="login-lock-hint__secondary">
            {{ t("login.defaultLoginResetHint") }}
          </span>
        </div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
    </div>

    <RecoveryConfirmModal
      v-if="recoveryModal.open"
      ref="recoveryModalRef"
      :open="recoveryModal.open"
      :action="recoveryModal.action"
      @close="closeRecoveryModal"
      @submit="handleRecoverySubmit"
    />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.login-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
  }
}

.login-logo {
  margin-bottom: 24px;
}

.login-title {
  font-size: 26px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.login-desc {
  font-size: 14px;
  color: $text-muted;
  margin: 0 0 12px;
  line-height: 1.6;
}

.login-default-hint {
  margin: 0 0 28px;
  font-family: $font-code;
  font-size: 13px;
  color: $text-secondary;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 15px;
  color: $text-primary;
  background: $bg-input;
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.login-error {
  font-size: 13px;
  color: $error;
  text-align: left;
}

.login-lock-hint {
  padding: 10px 12px;
  border: 1px solid rgba(var(--warning-rgb), 0.35);
  border-radius: $radius-sm;
  background: rgba(var(--warning-rgb), 0.08);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 8px;

  code {
    display: block;
    margin-top: 4px;
    color: $text-primary;
  }
}

.login-lock-hint__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}

.login-lock-hint__btn {
  padding: 6px 12px;
  border: 1px solid rgba(var(--warning-rgb), 0.55);
  border-radius: $radius-sm;
  background: transparent;
  color: $text-primary;
  font-size: 12px;
  cursor: pointer;
  transition: background $transition-fast, border-color $transition-fast;

  &:hover:not(:disabled) {
    background: rgba(var(--warning-rgb), 0.15);
    border-color: rgba(var(--warning-rgb), 0.8);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.login-lock-hint__secondary {
  font-size: 11px;
  opacity: 0.85;
  margin-top: 2px;
}

.login-btn {
  width: 100%;
  padding: 14px 16px;
  border: none;
  border-radius: $radius-sm;
  background: $accent-primary;
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;
  font-family: $font-code;

  &:hover:not(:disabled) {
    opacity: 0.92;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}
</style>