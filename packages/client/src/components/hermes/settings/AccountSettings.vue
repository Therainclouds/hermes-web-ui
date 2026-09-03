<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NButton, NInput, NModal, NForm, NFormItem, NPopconfirm } from "naive-ui";
import { useMessage } from "@/composables/useAppMessage";
import { useI18n } from "vue-i18n";
import { changePassword, changeUsername, setPassword, fetchCurrentUser, fetchLockedIps, unlockSpecificIp, unlockAllIps, fetchMyAvatar, updateMyAvatar, resetMyAvatar, bindPhone, unbindPhone } from "@/api/auth";
import type { LockedIp, UserAvatar } from "@/api/auth";
import { clearApiKey } from "@/api/client";
import { unbindHermesDevice } from "@/api/device-login";
import ProfileAvatar from "@/components/hermes/profiles/ProfileAvatar.vue";
import { looksLikeMojibake } from "@/utils/mojibake";
import multiavatar from "@multiavatar/multiavatar";

const { t } = useI18n();
const message = useMessage();
const router = useRouter();

const username = ref<string | null>(null);
const loading = ref(false);

// User avatar
const avatar = ref<UserAvatar | null>(null);
const avatarFileInput = ref<HTMLInputElement | null>(null);
const avatarSaving = ref(false);

function compressImage(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const tryCompress = (quality: number) => {
          const result = canvas.toDataURL('image/jpeg', quality)
          if (result.length <= maxBytes || quality <= 0.3) resolve(result)
          else tryCompress(quality - 0.1)
        }
        tryCompress(0.8)
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function handleAvatarUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    message.error(t('settings.userAvatar.invalidType'))
    target.value = ''
    return
  }
  if (file.size > 1024 * 1024) {
    message.error(t('settings.userAvatar.tooLarge'))
    target.value = ''
    return
  }
  avatarSaving.value = true
  try {
    let dataUrl: string
    if (file.size > 500 * 1024) {
      dataUrl = await compressImage(file, 500 * 1024)
    } else {
      dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.onerror = reject
        r.readAsDataURL(file)
      })
    }
    await updateMyAvatar({ type: 'image', dataUrl })
    avatar.value = { type: 'image', dataUrl }
    message.success(t('settings.userAvatar.saveSuccess'))
  } catch (err: any) {
    message.error(err.message || t('settings.userAvatar.saveFailed'))
  } finally {
    avatarSaving.value = false
    target.value = ''
  }
}

async function handleRandomAvatar() {
  avatarSaving.value = true
  try {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
    const seed = `${username.value || 'default'}-${Date.now()}-${randomPart}`
    const svg = multiavatar(seed)
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
    await updateMyAvatar({ type: 'image', dataUrl, seed })
    avatar.value = { type: 'image', dataUrl, seed }
    message.success(t('settings.userAvatar.saveSuccess'))
  } catch (err: any) {
    message.error(err.message || t('settings.userAvatar.saveFailed'))
  } finally {
    avatarSaving.value = false
  }
}

async function handleResetAvatar() {
  avatarSaving.value = true
  try {
    await resetMyAvatar()
    avatar.value = { type: 'default', seed: username.value || 'default' }
    message.success(t('settings.userAvatar.resetSuccess'))
  } catch (err: any) {
    message.error(err.message || t('settings.userAvatar.resetFailed'))
  } finally {
    avatarSaving.value = false
  }
}

// Change password form
const showChangePasswordModal = ref(false);
const currentPasswordForPwd = ref("");
const newPasswordVal = ref("");
const newPasswordConfirm = ref("");

// Set password form (WeChat device users: no current password required)
const showSetPasswordModal = ref(false);
const setNewPasswordVal = ref("");
const setNewPasswordConfirm = ref("");
const isWeChatDeviceUser = ref(false);
const unbindingWechat = ref(false);

// Change username form
const showChangeUsernameModal = ref(false);
const currentPasswordForName = ref("");
const newUsernameVal = ref("");

// Phone binding
const phoneNumber = ref<string | null>(null);
const wechatBound = ref(false);
const showBindPhoneModal = ref(false);
const phoneInputVal = ref("");
const bindingPhone = ref(false);

onMounted(async () => {
  try {
    const user = await fetchCurrentUser();
    username.value = user.username;
    isWeChatDeviceUser.value = user.username.startsWith("tp_");
    phoneNumber.value = user.phone_number || null;
    wechatBound.value = user.wechat_bound || false;
  } catch { /* ignore */ }
  try {
    const av = await fetchMyAvatar();
    avatar.value = av || { type: 'default', seed: username.value || 'default' };
  } catch { /* ignore */ }
});

async function handleChangePassword() {
  if (newPasswordVal.value !== newPasswordConfirm.value) {
    message.error(t("login.passwordMismatch"));
    return;
  }
  if (newPasswordVal.value.length < 6) {
    message.error(t("login.passwordTooShort"));
    return;
  }
  loading.value = true;
  try {
    await changePassword(currentPasswordForPwd.value, newPasswordVal.value);
    showChangePasswordModal.value = false;
    currentPasswordForPwd.value = "";
    newPasswordVal.value = "";
    newPasswordConfirm.value = "";
    message.success(t("login.passwordChanged"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

async function handleChangeUsername() {
  if (newUsernameVal.value.trim().length < 2) {
    message.error(t("login.usernameTooShort"));
    return;
  }
  // WeChat device users (tp_*) don't need current password — their JWT is
  // authenticated via WeChat device binding scan.
  const password = isWeChatDeviceUser.value ? null : currentPasswordForName.value;
  loading.value = true;
  try {
    await changeUsername(password, newUsernameVal.value.trim());
    username.value = newUsernameVal.value.trim();
    showChangeUsernameModal.value = false;
    currentPasswordForName.value = "";
    newUsernameVal.value = "";
    message.success(t("login.usernameChanged"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

function openChangePasswordModal() {
  currentPasswordForPwd.value = "";
  newPasswordVal.value = "";
  newPasswordConfirm.value = "";
  showChangePasswordModal.value = true;
}

function openSetPasswordModal() {
  setNewPasswordVal.value = "";
  setNewPasswordConfirm.value = "";
  showSetPasswordModal.value = true;
}

async function handleSetPassword() {
  if (setNewPasswordVal.value !== setNewPasswordConfirm.value) {
    message.error(t("login.passwordMismatch"));
    return;
  }
  if (setNewPasswordVal.value.length < 6) {
    message.error(t("login.passwordTooShort"));
    return;
  }
  loading.value = true;
  try {
    await setPassword(setNewPasswordVal.value);
    showSetPasswordModal.value = false;
    setNewPasswordVal.value = "";
    setNewPasswordConfirm.value = "";
    message.success(t("settings.passwordSet"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

function openChangeUsernameModal() {
  currentPasswordForName.value = "";
  newUsernameVal.value = "";
  showChangeUsernameModal.value = true;
}

// Phone binding handlers
function openBindPhoneModal() {
  phoneInputVal.value = phoneNumber.value || "";
  showBindPhoneModal.value = true;
}

async function handleBindPhone() {
  const phone = phoneInputVal.value.trim();
  if (!phone) {
    message.error(t("settings.phone.required"));
    return;
  }
  bindingPhone.value = true;
  try {
    const result = await bindPhone(phone);
    phoneNumber.value = result.phone_number;
    showBindPhoneModal.value = false;
    message.success(t("settings.phone.bindSuccess"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    bindingPhone.value = false;
  }
}

async function handleUnbindPhone() {
  bindingPhone.value = true;
  try {
    await unbindPhone();
    phoneNumber.value = null;
    message.success(t("settings.phone.unbindSuccess"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    bindingPhone.value = false;
  }
}

// Unbind WeChat (WeChat device users only): clears the device binding,
// deletes the provisioned local account, and returns to the login page.
async function handleUnbindWechat() {
  unbindingWechat.value = true;
  try {
    await unbindHermesDevice();
    message.success(t("settings.unbindWechatSuccess"));
    clearApiKey();
    setTimeout(() => router.replace("/login"), 600);
  } catch (err: any) {
    message.error(err.message || t("settings.unbindWechatFailed"));
  } finally {
    unbindingWechat.value = false;
  }
}

// Locked IPs management
const lockedIps = ref<LockedIp[]>([]);
const loadingLocks = ref(false);

async function loadLockedIps() {
  loadingLocks.value = true;
  try {
    lockedIps.value = await fetchLockedIps();
  } catch { /* ignore */ }
  finally {
    loadingLocks.value = false;
  }
}

async function handleUnlockIp(ip: string) {
  try {
    await unlockSpecificIp(ip);
    message.success(t("settings.lockedIps.unlocked"));
    await loadLockedIps();
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  }
}

async function handleUnlockAll() {
  try {
    const count = await unlockAllIps();
    message.success(t("settings.lockedIps.allUnlocked", { count }));
    await loadLockedIps();
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  }
}

function formatTime(ts: number): string {
  const remaining = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return remaining > 0 ? `${remaining} min` : t("common.expired");
}

function lockedIpTypeLabel(type: LockedIp["type"]): string {
  return t(`settings.lockedIps.type.${type}`);
}

const nicknameLooksCorrupt = computed(() => looksLikeMojibake(username.value));

onMounted(() => { loadLockedIps(); });
</script>

<template>
  <div class="account-settings">
    <p class="section-desc">{{ t("login.setupDescription") }}</p>

    <!-- User Avatar -->
    <div class="avatar-section">
      <h3 class="section-title">{{ t('settings.userAvatar.title') }}</h3>
      <div class="avatar-row">
        <div class="avatar-display">
          <ProfileAvatar
            :name="username || 'default'"
            :avatar="avatar?.type === 'image' && avatar.dataUrl ? { type: 'image', dataUrl: avatar.dataUrl } : null"
            :size="80"
          />
        </div>
        <div class="avatar-actions">
          <p class="avatar-hint">{{ t('settings.userAvatar.hint') }}</p>
          <div class="action-buttons">
            <NButton @click="avatarFileInput?.click()">{{ t('settings.userAvatar.upload') }}</NButton>
            <NButton @click="handleRandomAvatar" :loading="avatarSaving">{{ t('settings.userAvatar.random') }}</NButton>
            <NButton @click="handleResetAvatar" :loading="avatarSaving">{{ t('settings.userAvatar.reset') }}</NButton>
          </div>
          <input
            ref="avatarFileInput"
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            style="display: none"
            @change="handleAvatarUpload"
          />
        </div>
      </div>
    </div>

    <div class="configured-section">
      <div class="action-row">
        <span class="action-label">{{ t("login.passwordLoginConfigured", { username }) }}</span>
        <div class="action-buttons">
          <NButton v-if="isWeChatDeviceUser" type="primary" @click="openSetPasswordModal">{{ t("settings.setAccountPassword") }}</NButton>
          <NButton @click="openChangePasswordModal">{{ t("login.changePassword") }}</NButton>
          <NButton @click="openChangeUsernameModal">{{ t("login.changeUsername") }}</NButton>
          <NPopconfirm v-if="isWeChatDeviceUser" @positive-click="handleUnbindWechat">
            <template #trigger>
              <NButton type="error" ghost :loading="unbindingWechat">{{ t("settings.unbindWechat") }}</NButton>
            </template>
            {{ t("settings.unbindWechatConfirm", { account: username || "" }) }}
          </NPopconfirm>
        </div>
      </div>
      <p v-if="isWeChatDeviceUser" class="set-password-hint">{{ t("settings.setAccountPasswordHint") }}</p>
      <p v-if="isWeChatDeviceUser && nicknameLooksCorrupt" class="nickname-mojibake-hint">
        ⚠️ {{ t("settings.nicknameMojibakeHint") }}
      </p>
    </div>

    <!-- Phone Binding -->
    <div class="phone-section">
      <h3 class="section-title">{{ t('settings.phone.title') }}</h3>
      <div class="action-row">
        <span class="action-label">
          <template v-if="phoneNumber">{{ t('settings.phone.bound', { phone: phoneNumber }) }}</template>
          <template v-else>{{ t('settings.phone.notBound') }}</template>
        </span>
        <div class="action-buttons">
          <NButton v-if="!phoneNumber" size="small" type="primary" @click="openBindPhoneModal">{{ t('settings.phone.bind') }}</NButton>
          <template v-else>
            <NButton size="small" @click="openBindPhoneModal">{{ t('settings.phone.change') }}</NButton>
            <NPopconfirm v-if="!wechatBound" @positive-click="handleUnbindPhone">
              <template #trigger>
                <NButton size="small" type="warning" ghost :loading="bindingPhone">{{ t('settings.phone.unbind') }}</NButton>
              </template>
              {{ t('settings.phone.unbindConfirm') }}
            </NPopconfirm>
          </template>
        </div>
      </div>
      <p class="phone-hint">{{ t('settings.phone.hint') }}</p>
    </div>

    <!-- Locked IPs management -->
    <div class="locked-ips-section">
      <h3 class="section-title">{{ t("settings.lockedIps.title") }}</h3>
      <div class="action-row" style="margin-bottom: 12px;">
        <span class="action-label">{{ t("settings.lockedIps.count", { count: lockedIps.length }) }}</span>
        <div class="action-buttons">
          <NButton size="small" :loading="loadingLocks" @click="loadLockedIps">{{ t("common.retry") }}</NButton>
          <NPopconfirm v-if="lockedIps.length > 0" @positive-click="handleUnlockAll">
            <template #trigger>
              <NButton size="small" type="warning">{{ t("settings.lockedIps.unlockAll") }}</NButton>
            </template>
            {{ t("settings.lockedIps.unlockAllConfirm") }}
          </NPopconfirm>
        </div>
      </div>
      <div v-if="lockedIps.length > 0" class="locked-list">
        <div v-for="lock in lockedIps" :key="lock.ip + lock.type" class="locked-item">
          <div class="locked-info">
            <span class="locked-ip">{{ lock.ip }}</span>
            <span class="locked-badge">{{ lockedIpTypeLabel(lock.type) }}</span>
            <span class="locked-ttl">{{ formatTime(lock.lockedUntil) }}</span>
          </div>
          <NButton size="tiny" type="error" ghost @click="handleUnlockIp(lock.ip)">{{ t("settings.lockedIps.unlock") }}</NButton>
        </div>
      </div>
      <p v-else class="empty-hint">{{ t("settings.lockedIps.empty") }}</p>
    </div>

    <!-- Change password modal -->
    <NModal v-model:show="showChangePasswordModal" preset="dialog" :title="t('login.changePassword')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForPwd" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newPassword')">
          <NInput v-model:value="newPasswordVal" type="password" show-password-on="click" :placeholder="t('login.newPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.confirmPassword')">
          <NInput v-model:value="newPasswordConfirm" type="password" show-password-on="click" :placeholder="t('login.confirmPassword')" @keyup.enter="handleChangePassword" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangePasswordModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangePassword">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Set password modal (WeChat device user, no current password) -->
    <NModal v-model:show="showSetPasswordModal" preset="dialog" :title="t('settings.setAccountPassword')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.newPassword')">
          <NInput v-model:value="setNewPasswordVal" type="password" show-password-on="click" :placeholder="t('login.newPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.confirmPassword')">
          <NInput v-model:value="setNewPasswordConfirm" type="password" show-password-on="click" :placeholder="t('login.confirmPassword')" @keyup.enter="handleSetPassword" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showSetPasswordModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSetPassword">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Change username modal -->
    <NModal v-model:show="showChangeUsernameModal" preset="dialog" :title="t('login.changeUsername')">
      <NForm label-placement="top">
        <NFormItem v-if="!isWeChatDeviceUser" :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForName" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newUsername')">
          <NInput v-model:value="newUsernameVal" :placeholder="t('login.usernamePlaceholder')" @keyup.enter="handleChangeUsername" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangeUsernameModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangeUsername">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Bind phone modal -->
    <NModal v-model:show="showBindPhoneModal" preset="dialog" :title="t('settings.phone.title')">
      <NForm label-placement="top">
        <NFormItem :label="t('settings.phone.inputLabel')">
          <NInput v-model:value="phoneInputVal" :placeholder="t('settings.phone.placeholder')" @keyup.enter="handleBindPhone" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showBindPhoneModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="bindingPhone" @click="handleBindPhone">{{ t("common.save") }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.account-settings {
  padding: 8px 0;
}

.section-desc {
  font-size: 13px;
  color: $text-muted;
  margin: 0 0 20px;
  line-height: 1.6;
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.action-label {
  font-size: 14px;
  color: $text-secondary;
}

.action-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.set-password-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: $text-muted;
}

.nickname-mojibake-hint {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-left: 3px solid $warning;
  background: rgba($warning, 0.08);
  border-radius: $radius-sm;
  font-size: 12px;
  color: $warning;
  line-height: 1.5;
}

.phone-section {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid $border-color;
}

.phone-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: $text-muted;
  line-height: 1.5;
}

.locked-ips-section {
  margin-top: 32px;
  padding-top: 20px;
  border-top: 1px solid $border-color;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 16px;
}

.locked-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.locked-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
}

.locked-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.locked-ip {
  font-family: $font-code;
  font-size: 13px;
  color: $text-primary;
}

.locked-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba($error, 0.1);
  color: $error;
}

.locked-ttl {
  font-size: 12px;
  color: $text-muted;
}

.empty-hint {
  font-size: 13px;
  color: $text-muted;
  margin: 0;
}

.avatar-section {
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid $border-color;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 24px;
}

.avatar-display {
  flex-shrink: 0;
}

.avatar-actions {
  flex: 1;
}

.avatar-hint {
  font-size: 12px;
  color: $text-muted;
  margin: 0 0 12px;
}
</style>
