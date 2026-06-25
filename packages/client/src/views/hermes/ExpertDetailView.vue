<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NButton,
  NCard,
  NEmpty,
  NPopconfirm,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useExpertsStore } from '@/stores/hermes/experts'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import * as expertsApi from '@/api/hermes/experts'
import type { ExpertDetail, ExpertManifest } from '@/api/hermes/experts'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const expertsStore = useExpertsStore()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()
const appStore = useAppStore()

const slug = computed(() => String(route.params.slug || ''))
const detail = ref<ExpertDetail | null>(null)
const manifest = ref<ExpertManifest | null>(null)
const installed = computed(() => expertsStore.findInstalled(slug.value))
const detailLoading = ref(false)
const manifestLoading = ref(false)

async function loadAll() {
  if (!slug.value) return
  detailLoading.value = true
  manifestLoading.value = true
  try {
    const d = await expertsStore.fetchDetail(slug.value)
    detail.value = d
    if (d?.latest_version) {
      const m = await expertsStore.fetchManifest(slug.value, d.latest_version.version)
      manifest.value = m
    }
  } finally {
    detailLoading.value = false
    manifestLoading.value = false
  }
}

onMounted(() => {
  if (expertsStore.catalog.length === 0) {
    expertsStore.fetchCatalog()
  }
  if (expertsStore.installed.length === 0) {
    expertsStore.fetchInstalled()
  }
  loadAll()
})

watch(slug, () => {
  detail.value = null
  manifest.value = null
  loadAll()
})

async function handleInstall() {
  if (!detail.value?.latest_version) {
    message.warning(t('experts.noLatestVersion'))
    return
  }
  try {
    const r = await expertsStore.install(slug.value, detail.value.latest_version.version)
    message.success(t('experts.installedSuccess', {
      n: r.installed.length,
      failed: r.failed.length,
    }))
    await profilesStore.fetchProfiles()
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('experts.installFailed'))
  }
}

async function handleUpgrade() {
  try {
    const r = await expertsStore.upgrade(slug.value)
    message.success(t('experts.upgradedSuccess', { n: r.installed.length }))
    await profilesStore.fetchProfiles()
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('experts.upgradeFailed'))
  }
}

async function handleUninstall() {
  try {
    await expertsStore.uninstall(slug.value)
    message.success(t('experts.uninstalledSuccess'))
    await profilesStore.fetchProfiles()
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('experts.uninstallFailed'))
  }
}

function findChatProfileName(): string | null {
  const expertBindings = expertsStore.bindings.filter((b) => b.expert_slug === slug.value)
  if (expertBindings.length === 0) return null
  // 优先团长，其次单专家，最后兜底
  const captain = expertBindings.find((b) => b.role === 'captain')
  if (captain) return captain.profile_name
  const expert = expertBindings.find((b) => b.role === 'expert')
  if (expert) return expert.profile_name
  return expertBindings[0].profile_name
}

async function handleStartChat() {
  const profileName = findChatProfileName()
  if (!profileName) {
    message.warning(t('experts.detail.noBinding'))
    return
  }
  // 先设 localStorage 确保 reload 后拿到正确的 active profile
  localStorage.setItem('hermes_active_profile_name', profileName)
  // 调用专家系统的激活端点（无需 super admin 权限）
  try {
    await expertsApi.activateExpertProfile(profileName)
  } catch (err) {
    message.error(t('experts.detail.startChatFailed'))
    return
  }
  message.success(t('experts.detail.startChatSuccess'))
  await profilesStore.fetchProfiles()
  // 强制刷新 app store 中的 model 列表（避免 30s 缓存 + expert profile 新写入 model 不同步）
  await appStore.reloadModels({ preserveSelection: true })

  // Q3: 创建新会话（先在 server 端落库，避免 ChatView.loadSessions 覆盖本地新 session）
  const session = await chatStore.newChatWithRemoteCreate({
    profile: profileName,
    title: detail.value?.name || profileName,
  })

  // 从 manifest 构建自我介绍消息（通过 store API 写入，避免响应式 proxy 直接 push 触发告警）
  const prompts = manifest.value?.profileTemplate?.starterPrompts
  if (prompts && prompts.length > 0) {
    const expertName = detail.value?.name || profileName
    const introText = `👋 你好！我是 **${expertName}**。\n\n我可以帮助你：\n${prompts.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}\n\n请告诉我你想做什么？`
    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    chatStore.addMessage(session.id, {
      id: msgId,
      role: 'assistant',
      content: introText,
      timestamp: Date.now(),
    })
  }

  // 跳转到聊天页（不带 sessionId，避免 ChatView.loadRouteSession 触发 loadSessions 覆盖新会话）
  router.push({ name: 'hermes.chat' })
}

const teamMembers = computed(() => detail.value?.team_members || [])
</script>

<template>
  <div class="expert-detail-view">
    <header class="page-header">
      <NButton size="tiny" quaternary @click="router.push({ name: 'hermes.experts' })">
        ← {{ t('common.back') }}
      </NButton>
    </header>

    <NSpin :show="detailLoading">
      <NEmpty v-if="!detail" :description="t('experts.empty')" />
      <div v-else class="content">
        <NCard class="basic">
          <div class="title-row">
            <h2 class="name">{{ detail.name }}</h2>
            <NTag size="small" :bordered="false">{{ detail.category }}</NTag>
            <NTag size="small" :bordered="false" type="warning" v-if="detail.kind === 'team'">
              {{ t('experts.kind.team') }}
            </NTag>
          </div>
          <p class="summary">{{ detail.summary }}</p>
          <p class="desc">{{ detail.description }}</p>
          <div class="meta-row">
            <NTag size="small" type="success" :bordered="false">
              {{ detail.latest_version?.version || t('experts.noVersion') }}
            </NTag>
            <NTag
              v-if="installed"
              size="small"
              type="info"
              :bordered="false"
            >
              {{ t('experts.status.installed') }} · {{ installed.installed_version }}
            </NTag>
          </div>
          <div class="actions">
            <NButton
              v-if="!installed"
              type="primary"
              :loading="expertsStore.installing"
              :disabled="!detail.latest_version"
              @click="handleInstall"
            >
              {{ t('experts.detail.install') }}
            </NButton>
            <NButton
              v-if="installed"
              type="primary"
              @click="handleStartChat"
            >
              {{ t('experts.detail.startChat') }}
            </NButton>
            <NButton
              v-if="installed"
              :loading="expertsStore.upgrading === slug"
              :disabled="!detail.latest_version || installed.installed_version === detail.latest_version.version"
              @click="handleUpgrade"
            >
              {{ t('experts.detail.upgrade') }}
            </NButton>
            <NPopconfirm
              v-if="installed"
              @positive-click="handleUninstall"
            >
              <template #trigger>
                <NButton
                  type="error"
                  ghost
                  :loading="expertsStore.uninstalling === slug"
                >
                  {{ t('experts.detail.uninstall') }}
                </NButton>
              </template>
              {{ t('experts.confirmUninstall') }}
            </NPopconfirm>
          </div>
        </NCard>

        <NCard v-if="teamMembers.length > 0" class="members">
          <template #header>{{ t('experts.teamMembers') }}</template>
          <ul class="member-list">
            <li v-for="m in teamMembers" :key="m.slug">
              <span class="member-name">{{ m.name }}</span>
              <NTag size="tiny" :bordered="false" v-if="m.is_captain">{{ t('experts.role.captain') }}</NTag>
              <span class="role">{{ m.role_name }}</span>
              <span class="version">{{ m.latest_version || '-' }}</span>
            </li>
          </ul>
        </NCard>

        <NCard v-if="manifest" class="manifest">
          <template #header>{{ t('experts.manifest') }}</template>
          <NSpin :show="manifestLoading">
            <div class="kv">
              <span class="k">slug</span>
              <span class="v">{{ manifest.expert.slug }}</span>
            </div>
            <div class="kv">
              <span class="k">version</span>
              <span class="v">{{ manifest.version.name }}</span>
            </div>
            <div class="kv">
              <span class="k">displayName</span>
              <span class="v">{{ manifest.profileTemplate.displayName }}</span>
            </div>
            <div class="kv">
              <span class="k">systemPromptPath</span>
              <span class="v">{{ manifest.profileTemplate.systemPromptPath }}</span>
            </div>
            <div class="kv">
              <span class="k">defaultLaunchTarget</span>
              <span class="v">{{ manifest.expert.defaultLaunchTarget }}</span>
            </div>
            <div class="starter">
              <h4>{{ t('experts.detail.starterPrompts') }}</h4>
              <ul>
                <li v-for="(s, i) in manifest.profileTemplate.starterPrompts" :key="i">{{ s }}</li>
              </ul>
            </div>
            <div class="starter">
              <h4>{{ t('experts.detail.defaultSkills') }}</h4>
              <div class="skill-list">
                <NTag v-for="s in manifest.profileTemplate.defaultSkills" :key="s" size="tiny" :bordered="false">{{ s }}</NTag>
              </div>
            </div>
          </NSpin>
        </NCard>
      </div>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.expert-detail-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
  padding: 0 20px 20px;
  overflow-y: auto;
}

.page-header {
  padding: 16px 0 8px;
}

.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.name {
  margin: 0;
  font-size: 18px;
  color: $text-primary;
}

.summary {
  margin: 4px 0;
  color: $text-secondary;
  font-size: 14px;
}

.desc {
  color: $text-muted;
  font-size: 13px;
  margin: 0 0 12px;
}

.meta-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.actions {
  display: flex;
  gap: 8px;
}

.member-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px dashed $border-color;
  }
}

.member-name {
  font-weight: 600;
  color: $text-primary;
  min-width: 100px;
}

.role {
  color: $text-secondary;
  font-size: 12px;
}

.version {
  margin-left: auto;
  color: $text-muted;
  font-family: $font-code;
  font-size: 12px;
}

.kv {
  display: flex;
  font-size: 12px;
  padding: 4px 0;
  gap: 12px;
}

.k {
  color: $text-muted;
  width: 140px;
  flex-shrink: 0;
}

.v {
  color: $text-primary;
  word-break: break-all;
}

.starter {
  margin-top: 10px;

  h4 {
    margin: 0 0 4px;
    font-size: 12px;
    color: $text-muted;
  }
}

.skill-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
