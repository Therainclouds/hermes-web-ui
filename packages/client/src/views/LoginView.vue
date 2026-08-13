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
import BindSuperAdminModal from "@/components/auth/BindSuperAdminModal.vue";
import WeChatQrPanel from "@/components/auth/WeChatQrPanel.vue";
import {
  completeHermesDeviceLogin,
  type TokenPlatformDeviceLoginStatus,
} from "@/api/device-login";
import { addCustomProvider } from "@/api/hermes/system";
import { useDeviceBinding } from "@/composables/useDeviceBinding";
import { useTheme } from "@/composables/useTheme";

const { t } = useI18n();
const router = useRouter();
const { activateUserTheme } = useTheme();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);

// Token Platform WeChat binding restore (previously scanned device)
const {
  checking: bindingChecking,
  hasBinding,
  restoring: bindingRestoring,
  restoreError: bindingRestoreError,
  binding,
  restore,
} = useDeviceBinding();

// WeChat scan login state
const wechatMode = ref(false);
const wechatSyncing = ref(false);
const wechatError = ref("");

// Bind super admin prompt (only for non-super-admin WeChat device users)
const showBindSuperAdmin = ref(false);
const pendingLoginToken = ref("");

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
    const session = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(session.token);
    activateUserTheme(session.userId, session.theme);
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

async function handleWeChatApproved(
  result: Extract<TokenPlatformDeviceLoginStatus, { status: "approved" }>,
) {
  wechatSyncing.value = true;
  wechatError.value = "";
  try {
    const hermesResult = await completeHermesDeviceLogin({
      api_base: result.api.api_base,
      api_key: result.api.api_key,
      device_id: result.device.device_id,
      device_name: "Hermes",
      models: result.api.models,
    });
    pendingLoginToken.value = hermesResult.token;

    // Set the Hermes session token FIRST so the addCustomProvider call below
    // (which requires a Bearer JWT) carries the Authorization header. Without
    // this the provider onboarding request is rejected with 401 and the
    // account logs in with no usable model (falls back to whatever the default
    // profile already had).
    setApiKey(hermesResult.token);

    // Sync the user's model capabilities into Hermes as the default provider.
    // The Token Platform reports an OpenAI-compatible api_base (e.g.
    // https://api.quantclaw.vip). Its /v1/chat/completions, /v1/models and
    // /v1/completions endpoints are served from that origin, so the base URL
    // must NOT have "/v1" appended (the gateway/tooling appends "/v1" itself).
    const models = hermesResult.user.bound_models?.length
      ? hermesResult.user.bound_models
      : result.api.models;
    const defaultModel = models[0];
    if (!defaultModel) {
      wechatError.value = t("login.tokenPlatformNoModel");
      return;
    }
    try {
      await addCustomProvider({
        name: "token_platform",
        base_url: result.api.api_base.replace(/\/+$/, ""),
        api_key: result.api.api_key,
        model: defaultModel,
        api_mode: "chat_completions",
      });
    } catch (providerErr: any) {
      // Auto-onboarding the user into the default provider is the whole point
      // of WeChat login. If it fails the account is unusable, so surface the
      // error instead of silently logging in without any model.
      console.error("Failed to configure Token Platform provider:", providerErr);
      wechatError.value = providerErr?.message || t("login.tokenPlatformConfigureFailed");
      return;
    }

    // WeChat device users are regular admins. Offer to bind the account to the
    // super administrator by verifying its credentials. The session token is
    // already set above, so the bind request carries the Authorization header.
    if (hermesResult.user.role !== "super_admin") {
      showBindSuperAdmin.value = true;
      return;
    }

    setApiKey(hermesResult.token);
    router.replace("/hermes/chat");
  } catch (err: any) {
    wechatError.value = err?.message || t("login.deviceLoginFailed");
  } finally {
    wechatSyncing.value = false;
  }
}

function handleBindSuperAdminSkip() {
  showBindSuperAdmin.value = false;
  if (pendingLoginToken.value) {
    setApiKey(pendingLoginToken.value);
    router.replace("/hermes/chat");
  }
}

function handleBindSuperAdminBound(
  token: string,
  _user: { id: number; username: string; role: string },
) {
  showBindSuperAdmin.value = false;
  pendingLoginToken.value = token;
  setApiKey(token);
  router.replace("/hermes/chat");
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

      <div v-if="!wechatMode">
        <!-- WeChat scan is the primary login for token-platform-bound devices. -->
        <div class="login-primary-wechat">
          <p class="login-wechat-mode__title">{{ t("login.wechatLoginTitle") }}</p>
          <WeChatQrPanel @approved="handleWeChatApproved" />
          <div v-if="wechatSyncing" class="login-wechat-syncing">
            {{ t("login.deviceLoginSyncing") }}
          </div>
          <div v-if="wechatError" class="login-error">{{ wechatError }}</div>
        </div>

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

        <div class="login-divider">
          <span class="login-divider__line" />
          <span class="login-divider__text">{{ t("login.passwordOption") }}</span>
          <span class="login-divider__line" />
        </div>
        <p class="login-default-hint">{{ t("login.defaultCredentialsHint") }}</p>

        <button
          type="button"
          class="login-password-btn"
          @click="wechatMode = false"
        >
          {{ t("login.passwordLogin") }}
        </button>

        <button
          v-if="hasBinding && !bindingChecking"
          type="button"
          class="login-restore-btn"
          :disabled="bindingRestoring"
          @click="restore"
        >
          {{ bindingRestoring ? "..." : t("login.wechatRestore", { account: binding?.display_name || "" }) }}
        </button>
        <div v-if="bindingRestoreError" class="login-error">
          {{ bindingRestoreError }}
        </div>
      </div>

      <div v-else class="login-wechat-mode">
        <p class="login-wechat-mode__title">{{ t("login.wechatLoginTitle") }}</p>
        <WeChatQrPanel @approved="handleWeChatApproved" />
        <div v-if="wechatSyncing" class="login-wechat-syncing">
          {{ t("login.deviceLoginSyncing") }}
        </div>
        <div v-if="wechatError" class="login-error">{{ wechatError }}</div>
        <button
          type="button"
          class="login-back-btn"
          @click="wechatMode = false"
        >
          {{ t("login.back") }}
        </button>
      </div>
    </div>

    <RecoveryConfirmModal
      v-if="recoveryModal.open"
      ref="recoveryModalRef"
      :open="recoveryModal.open"
      :action="recoveryModal.action"
      @close="closeRecoveryModal"
      @submit="handleRecoverySubmit"
    />

    <BindSuperAdminModal
      :open="showBindSuperAdmin"
      @close="handleBindSuperAdminSkip"
      @bound="handleBindSuperAdminBound"
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

.login-primary-wechat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid $border-color;
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
  text-align: start;
}

.login-lock-hint {
  padding: 10px 12px;
  border: 1px solid rgba(var(--warning-rgb), 0.35);
  border-radius: $radius-sm;
  background: rgba(var(--warning-rgb), 0.08);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
  text-align: start;
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
.login-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 12px;
}

.login-divider__line {
  flex: 1;
  height: 1px;
  background: $border-color;
}

.login-divider__text {
  font-size: 12px;
  color: $text-muted;
}

.login-password-btn {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-primary;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: background $transition-fast, border-color $transition-fast;
  font-family: $font-code;

  &:hover:not(:disabled) {
    background: rgba(var(--accent-rgb, 79, 158, 139), 0.08);
    border-color: $accent-primary;
  }
}

.login-restore-btn {
  width: 100%;
  margin-top: 8px;
  padding: 10px 16px;
  border: 1px dashed $border-color;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  font-size: 13px;
  cursor: pointer;
  transition: color $transition-fast, border-color $transition-fast;
  font-family: $font-code;

  &:hover:not(:disabled) {
    color: $accent-primary;
    border-color: $accent-primary;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.login-wechat-mode {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.login-wechat-mode__title {
  font-size: 14px;
  color: $text-secondary;
  margin: 0 0 4px;
}

.login-wechat-syncing {
  font-size: 13px;
  color: $text-muted;
}

.login-back-btn {
  margin-top: 4px;
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: $text-muted;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }
}
</style>
