<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, clearApiKey, hasApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword } from "@/api/auth";
import { clearLoginLocks, resetDefaultLogin } from "@/api/recovery";
import RecoveryConfirmModal, {
  type RecoveryAction,
} from "@/components/auth/RecoveryConfirmModal.vue";
import WeChatQrPanel from "@/components/auth/WeChatQrPanel.vue";
import {
  completeHermesDeviceLogin,
  bindSuperAdminDeviceLogin,
  createWeChatUser,
  bindExistingUserDeviceLogin,
  bindByCredentialsDeviceLogin,
  type TokenPlatformDeviceLoginStatus,
  type DeviceLoginChoice,
  type HermesDeviceLoginResult,
} from "@/api/device-login";
import { isDesktopShell } from "@/utils/desktop-bridge";
import { resolveLoginRedirect } from "@/utils/login-redirect";
import { useTheme } from "@/composables/useTheme";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const { activateUserTheme } = useTheme();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);
const desktopShell = isDesktopShell();

// WeChat scan login state
const wechatMode = ref(false);
const wechatSyncing = ref(false);
const wechatError = ref("");

// WeChat choice modal state
const showChoiceModal = ref(false);
const choiceModalStep = ref<"options" | "super_admin" | "create_user" | "pick_existing" | "credentials">("options");
const choiceData = ref<DeviceLoginChoice | null>(null);
const choiceResult = ref<{ api_base: string; api_key: string; device_id: number | string; models: string[] } | null>(null)
const choiceSubmitting = ref(false)
const choiceError = ref("")
// Form fields for sub-steps
const saUsername = ref("")
const saPassword = ref("")
const saPhone = ref("")
const newUsername = ref("")
const newPassword = ref("")
const newPhone = ref("")
const credIdentifier = ref("")
const credPassword = ref("")
const pickedCandidateId = ref<number | null>(null)

// Recovery modal state
type RecoveryModalState = { open: false } | { open: true; action: RecoveryAction };
const recoveryModal = ref<RecoveryModalState>({ open: false });
const recoveryModalRef = ref<InstanceType<typeof RecoveryConfirmModal> | null>(null);

// If already has a key, try to go to main page
if (desktopShell) {
  // Desktop login is a recovery path. Drop stale JWTs before any background
  // request can reuse them and show an unrelated expiry notice.
  clearApiKey();
} else if (hasApiKey()) {
  router.replace(resolveLoginRedirect(route.query.redirect));
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
    router.replace(resolveLoginRedirect(route.query.redirect));
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
    const response = await completeHermesDeviceLogin({
      api_base: result.api.api_base,
      api_key: result.api.api_key,
      device_id: result.device.device_id,
      device_name: "Hermes",
      models: result.api.models,
    });

    // If server returns a token directly (already bound), log in immediately.
    if ("token" in response && response.token) {
      const hermesResult = response as HermesDeviceLoginResult;
      setApiKey(hermesResult.token);
      router.replace("/hermes/chat");
      return;
    }

    // Otherwise server returns needs_choice: show the choice modal.
    const choice = response as DeviceLoginChoice;
    if (choice.status === "needs_choice") {
      choiceData.value = choice;
      choiceResult.value = {
        api_base: result.api.api_base,
        api_key: result.api.api_key,
        device_id: result.device.device_id,
        models: result.api.models,
      };
      choiceModalStep.value = "options";
      choiceError.value = "";
      showChoiceModal.value = true;
    }
  } catch (err: any) {
    wechatError.value = err?.message || t("login.deviceLoginFailed");
  } finally {
    wechatSyncing.value = false;
  }
}

// ── Choice modal handlers ──

function closeChoiceModal() {
  showChoiceModal.value = false;
  choiceData.value = null;
  choiceResult.value = null;
  choiceError.value = "";
  saUsername.value = "";
  saPassword.value = "";
  saPhone.value = "";
  newUsername.value = "";
  newPassword.value = "";
  newPhone.value = "";
  credIdentifier.value = "";
  credPassword.value = "";
  pickedCandidateId.value = null;
}

async function pickOption(option: string) {
  choiceModalStep.value = option as "super_admin" | "create_user" | "pick_existing" | "credentials";
  choiceError.value = "";
}

async function submitBindSuperAdmin() {
  if (!saUsername.value.trim() || !saPassword.value) {
    choiceError.value = t("login.choiceFieldsRequired");
    return;
  }
  if (!choiceResult.value || !choiceData.value) return;
  choiceSubmitting.value = true;
  choiceError.value = "";
  try {
    const result = await bindSuperAdminDeviceLogin({
      ...choiceResult.value,
      username: saUsername.value.trim(),
      password: saPassword.value,
      phone: saPhone.value.trim() || undefined,
    });
    setApiKey(result.token);
    router.replace("/hermes/chat");
  } catch (err: any) {
    choiceError.value = err.message || t("login.bindSuperAdminFailed");
  } finally {
    choiceSubmitting.value = false;
  }
}

async function submitCreateUser() {
  if (!newUsername.value.trim() || !newPassword.value) {
    choiceError.value = t("login.choiceFieldsRequired");
    return;
  }
  if (!choiceResult.value) return;
  choiceSubmitting.value = true;
  choiceError.value = "";
  try {
    const result = await createWeChatUser({
      ...choiceResult.value,
      username: newUsername.value.trim(),
      password: newPassword.value,
      phone: newPhone.value.trim() || undefined,
    });
    setApiKey(result.token);
    router.replace("/hermes/chat");
  } catch (err: any) {
    choiceError.value = err.message || t("login.createUserFailed");
  } finally {
    choiceSubmitting.value = false;
  }
}

async function submitBindByCredentials() {
  if (!credIdentifier.value.trim() || !credPassword.value) {
    choiceError.value = t("login.choiceFieldsRequired");
    return;
  }
  if (!choiceResult.value) return;
  choiceSubmitting.value = true;
  choiceError.value = "";
  try {
    const result = await bindByCredentialsDeviceLogin({
      ...choiceResult.value,
      identifier: credIdentifier.value.trim(),
      password: credPassword.value,
    });
    setApiKey(result.token);
    router.replace("/hermes/chat");
  } catch (err: any) {
    choiceError.value = err.message || t("login.bindByCredentialsFailed");
  } finally {
    choiceSubmitting.value = false;
  }
}

async function submitBindExisting() {
  if (!pickedCandidateId.value || !choiceResult.value) return;
  choiceSubmitting.value = true;
  choiceError.value = "";
  try {
    const result = await bindExistingUserDeviceLogin({
      ...choiceResult.value,
      user_id: pickedCandidateId.value,
    });
    setApiKey(result.token);
    router.replace("/hermes/chat");
  } catch (err: any) {
    choiceError.value = err.message || t("login.bindExistingFailed");
  } finally {
    choiceSubmitting.value = false;
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

    <!-- WeChat bind choice modal -->
    <div v-if="showChoiceModal" class="choice-overlay" @click.self="closeChoiceModal">
      <div class="choice-card">
        <h2 class="choice-title">{{ t("login.choiceTitle") }}</h2>
        <p class="choice-desc">{{ t("login.choiceDesc") }}</p>

        <!-- Option selection -->
        <template v-if="choiceModalStep === 'options'">
          <button
            v-if="choiceData?.options?.includes('bind_super_admin')"
            type="button"
            class="choice-option-btn"
            @click="pickOption('super_admin')"
          >
            {{ t("login.choiceBindSuperAdmin") }}
          </button>
          <button
            type="button"
            class="choice-option-btn"
            @click="pickOption('create_user')"
          >
            {{ t("login.choiceCreateUser") }}
          </button>
          <button
            type="button"
            class="choice-option-btn"
            @click="pickOption('credentials')"
          >
            {{ t("login.choiceBindByCredentials") }}
          </button>
          <button
            v-if="choiceData?.candidates?.length && choiceData.options?.includes('login_existing')"
            type="button"
            class="choice-option-btn"
            @click="pickOption('pick_existing')"
          >
            {{ t("login.choicePickExisting") }}
          </button>
          <div v-if="choiceData?.candidates?.length === 0" class="choice-hint">
            {{ t("login.choiceNoCandidates") }}
          </div>
        </template>

        <!-- Bind super admin form -->
        <template v-else-if="choiceModalStep === 'super_admin'">
          <button type="button" class="choice-back-btn" @click="choiceModalStep = 'options'">
            ← {{ t("login.back") }}
          </button>
          <input
            v-model="saUsername"
            type="text"
            class="login-input"
            :placeholder="t('login.superAdminUsername')"
          />
          <input
            v-model="saPassword"
            type="password"
            class="login-input"
            :placeholder="t('login.passwordPlaceholder')"
          />
          <input
            v-model="saPhone"
            type="text"
            class="login-input"
            :placeholder="t('login.superAdminPhone')"
          />
          <div v-if="choiceError" class="login-error">{{ choiceError }}</div>
          <button
            type="button"
            class="login-btn"
            :disabled="choiceSubmitting"
            @click="submitBindSuperAdmin"
          >
            {{ choiceSubmitting ? "..." : t("login.choiceBindSuperAdmin") }}
          </button>
        </template>

        <!-- Create new user form -->
        <template v-else-if="choiceModalStep === 'create_user'">
          <button type="button" class="choice-back-btn" @click="choiceModalStep = 'options'">
            ← {{ t("login.back") }}
          </button>
          <input
            v-model="newUsername"
            type="text"
            class="login-input"
            :placeholder="t('login.usernamePlaceholder')"
          />
          <input
            v-model="newPassword"
            type="password"
            class="login-input"
            :placeholder="t('login.newPassword')"
          />
          <input
            v-model="newPhone"
            type="text"
            class="login-input"
            :placeholder="t('login.newPhone')"
          />
          <div v-if="choiceError" class="login-error">{{ choiceError }}</div>
          <button
            type="button"
            class="login-btn"
            :disabled="choiceSubmitting"
            @click="submitCreateUser"
          >
            {{ choiceSubmitting ? "..." : t("login.choiceCreateUser") }}
          </button>
        </template>

        <!-- Bind by credentials (username or phone + password) -->
        <template v-else-if="choiceModalStep === 'credentials'">
          <button type="button" class="choice-back-btn" @click="choiceModalStep = 'options'">
            ← {{ t("login.back") }}
          </button>
          <input
            v-model="credIdentifier"
            type="text"
            class="login-input"
            :placeholder="t('login.credentialIdentifier')"
          />
          <input
            v-model="credPassword"
            type="password"
            class="login-input"
            :placeholder="t('login.passwordPlaceholder')"
          />
          <div v-if="choiceError" class="login-error">{{ choiceError }}</div>
          <button
            type="button"
            class="login-btn"
            :disabled="choiceSubmitting"
            @click="submitBindByCredentials"
          >
            {{ choiceSubmitting ? "..." : t("login.choiceBindByCredentials") }}
          </button>
        </template>

        <!-- Pick existing user -->
        <template v-else-if="choiceModalStep === 'pick_existing'">
          <button type="button" class="choice-back-btn" @click="choiceModalStep = 'options'">
            ← {{ t("login.back") }}
          </button>
          <div
            v-for="c in choiceData?.candidates"
            :key="c.id"
            class="choice-candidate"
            :class="{ 'choice-candidate--selected': pickedCandidateId === c.id }"
            @click="pickedCandidateId = c.id"
          >
            <span class="choice-candidate__name">{{ c.username }}</span>
            <span class="choice-candidate__phone">{{ c.phone_number || t("login.noPhone") }}</span>
          </div>
          <div v-if="choiceError" class="login-error">{{ choiceError }}</div>
          <button
            type="button"
            class="login-btn"
            :disabled="choiceSubmitting || !pickedCandidateId"
            @click="submitBindExisting"
          >
            {{ choiceSubmitting ? "..." : t("login.choiceConfirmBind") }}
          </button>
        </template>
      </div>
    </div>
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

/* ── WeChat choice modal ── */
.choice-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.choice-card {
  width: 420px;
  max-width: calc(100vw - 32px);
  padding: 40px 32px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 14px;

  @media (max-width: $breakpoint-mobile) {
    padding: 24px 16px;
  }
}

.choice-title {
  font-size: 20px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 4px;
}

.choice-desc {
  font-size: 13px;
  color: $text-muted;
  margin: 0 0 8px;
  line-height: 1.5;
}

.choice-option-btn {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-primary;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background $transition-fast, border-color $transition-fast;
  font-family: $font-code;

  &:hover {
    background: rgba(var(--accent-rgb, 79, 158, 139), 0.08);
    border-color: $accent-primary;
  }
}

.choice-back-btn {
  align-self: flex-start;
  background: none;
  border: none;
  color: $text-muted;
  font-size: 13px;
  cursor: pointer;
  padding: 4px 0;

  &:hover {
    color: $text-primary;
  }
}

.choice-hint {
  font-size: 12px;
  color: $text-muted;
  padding: 8px 0;
}

.choice-candidate {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: border-color $transition-fast, background $transition-fast;

  &:hover,
  &--selected {
    border-color: $accent-primary;
    background: rgba(var(--accent-rgb, 79, 158, 139), 0.06);
  }

  &__name {
    font-size: 14px;
    color: $text-primary;
    font-family: $font-code;
  }

  &__phone {
    font-size: 12px;
    color: $text-muted;
  }
}
</style>
