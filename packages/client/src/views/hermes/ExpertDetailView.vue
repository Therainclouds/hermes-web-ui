<script setup lang="ts">
/**
 * ExpertDetailView - 专家详情页
 * 结构：Hero + 右侧元数据侧栏 + 主体 Tab(概览/团队/Manifest)
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty, NPopconfirm, NSpin, NTabPane, NTabs, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useExpertsStore } from '@/stores/hermes/experts'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import * as expertsApi from '@/api/hermes/experts'
import type { ExpertDetail, ExpertManifest } from '@/api/hermes/experts'
import { ExpertCover, ExpertStarterPrompts } from '@/views/hermes/experts'
import { useMessage } from '@/composables/useAppMessage'

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
const activeTab = ref<'overview' | 'team' | 'manifest'>('overview')

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
  if (expertsStore.catalog.length === 0) expertsStore.fetchCatalog()
  if (expertsStore.installed.length === 0) expertsStore.fetchInstalled()
  loadAll()
})

watch(slug, () => {
  detail.value = null
  manifest.value = null
  activeTab.value = 'overview'
  loadAll()
})

async function handleInstall() {
  if (!detail.value?.latest_version) {
    message.warning(t('experts.noLatestVersion'))
    return
  }
  try {
    const r = await expertsStore.install(slug.value, detail.value.latest_version.version)
    message.success(t('experts.installedSuccess', { n: r.installed.length, failed: r.failed.length }))
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
  localStorage.setItem('hermes_active_profile_name', profileName)
  try {
    await expertsApi.activateExpertProfile(profileName)
  } catch {
    message.error(t('experts.detail.startChatFailed'))
    return
  }
  message.success(t('experts.detail.startChatSuccess'))
  await profilesStore.fetchProfiles()
  await appStore.reloadModels({ preserveSelection: true })

  const session = await chatStore.newChatWithRemoteCreate({
    profile: profileName,
    title: detail.value?.name || profileName,
  })

  const prompts = manifest.value?.profileTemplate?.starterPrompts
  if (prompts && prompts.length > 0) {
    const expertName = detail.value?.name || profileName
    const introText = `👋 你好！我是 **${expertName}**。\n\n我可以帮助你：\n${prompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n请告诉我你想做什么？`
    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    chatStore.addMessage(session.id, {
      id: msgId,
      role: 'assistant',
      content: introText,
      timestamp: Date.now(),
    })
  }

  router.push({ name: 'hermes.chat' })
}

const teamMembers = computed(() => detail.value?.team_members || [])
const starterPrompts = computed(() => manifest.value?.profileTemplate?.starterPrompts || [])
const defaultSkills = computed(() => manifest.value?.profileTemplate?.defaultSkills || [])

const hasUpgrade = computed(() =>
  !!installed.value &&
  !!detail.value?.latest_version &&
  installed.value.installed_version !== detail.value.latest_version.version,
)
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
      <div v-else class="layout">
        <main class="main">
          <section class="hero-card">
            <ExpertCover
              :name="detail.name"
              :slug="detail.slug"
              :icon-url="detail.icon_url"
              :cover-url="detail.cover_url"
              size="lg"
            />
            <div class="hero-info">
              <div class="hero-tags">
                <NTag size="small" :bordered="false">{{ detail.category }}</NTag>
                <NTag v-if="detail.kind === 'team'" size="small" :bordered="false" type="warning">
                  {{ t('experts.kind.team') }}
                </NTag>
                <NTag v-if="detail.is_featured" size="small" :bordered="false">
                  ★ {{ t('experts.featured') }}
                </NTag>
              </div>
              <h1 class="hero-name">{{ detail.name }}</h1>
              <p class="hero-summary">{{ detail.summary }}</p>
              <p class="hero-desc">{{ detail.description }}</p>

              <div class="hero-actions">
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
                  :disabled="!hasUpgrade"
                  @click="handleUpgrade"
                >
                  {{ t('experts.detail.upgrade') }}
                </NButton>
                <NPopconfirm v-if="installed" @positive-click="handleUninstall">
                  <template #trigger>
                    <NButton type="error" ghost :loading="expertsStore.uninstalling === slug">
                      {{ t('experts.detail.uninstall') }}
                    </NButton>
                  </template>
                  {{ t('experts.confirmUninstall') }}
                </NPopconfirm>
              </div>
            </div>
          </section>

          <NTabs v-model:value="activeTab" type="line" animated class="detail-tabs">
            <NTabPane name="overview" :tab="t('experts.detail.tabs.overview')">
              <section class="tab-section">
                <h3 class="section-title">{{ t('experts.detail.starterPrompts') }}</h3>
                <ExpertStarterPrompts :prompts="starterPrompts" />
              </section>

              <section v-if="defaultSkills.length > 0" class="tab-section">
                <h3 class="section-title">{{ t('experts.detail.defaultSkills') }}</h3>
                <div class="skill-list">
                  <NTag v-for="s in defaultSkills" :key="s" :bordered="false">{{ s }}</NTag>
                </div>
              </section>
            </NTabPane>

            <NTabPane v-if="teamMembers.length > 0" name="team" :tab="t('experts.detail.tabs.team')">
              <section class="tab-section">
                <ul class="member-list">
                  <li v-for="m in teamMembers" :key="m.slug" class="member-row">
                    <span class="member-name">{{ m.name }}</span>
                    <NTag v-if="m.is_captain" size="tiny" :bordered="false" type="warning">
                      {{ t('experts.role.captain') }}
                    </NTag>
                    <span class="member-role">{{ m.role_name }}</span>
                    <span class="member-version">{{ m.latest_version || '-' }}</span>
                  </li>
                </ul>
              </section>
            </NTabPane>

            <NTabPane v-if="manifest" name="manifest" :tab="t('experts.detail.tabs.manifest')">
              <NSpin :show="manifestLoading">
                <section class="tab-section kv-list">
                  <div class="kv"><span class="k">slug</span><span class="v">{{ manifest.expert.slug }}</span></div>
                  <div class="kv"><span class="k">version</span><span class="v">{{ manifest.version.name }}</span></div>
                  <div class="kv"><span class="k">displayName</span><span class="v">{{ manifest.profileTemplate.displayName }}</span></div>
                  <div class="kv"><span class="k">systemPromptPath</span><span class="v">{{ manifest.profileTemplate.systemPromptPath }}</span></div>
                  <div class="kv"><span class="k">defaultLaunchTarget</span><span class="v">{{ manifest.expert.defaultLaunchTarget }}</span></div>
                </section>
              </NSpin>
            </NTabPane>
          </NTabs>
        </main>

        <aside class="side">
          <div class="side-card">
            <h4 class="side-title">{{ t('experts.detail.metaTitle') }}</h4>
            <div class="side-row">
              <span class="side-k">{{ t('experts.detail.metaVersion') }}</span>
              <span class="side-v">{{ detail.latest_version?.version || t('experts.noVersion') }}</span>
            </div>
            <div class="side-row">
              <span class="side-k">{{ t('experts.detail.metaCategory') }}</span>
              <span class="side-v">{{ detail.category }}</span>
            </div>
            <div v-if="installed" class="side-row">
              <span class="side-k">{{ t('experts.detail.metaInstalled') }}</span>
              <span class="side-v">{{ installed.installed_version }}</span>
            </div>
            <div v-if="installed" class="side-row">
              <span class="side-k">{{ t('experts.detail.metaStatus') }}</span>
              <span class="side-v">{{ installed.status }}</span>
            </div>
            <div v-if="hasUpgrade" class="side-upgrade">
              ★ {{ t('experts.upgradeAvailable') }}
            </div>
          </div>
        </aside>
      </div>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.expert-detail-view {
  display: flex;
  flex-direction: column;
  padding: 0 20px 20px;
  overflow-y: auto;
}

.page-header {
  padding: 16px 0 8px;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 20px;
  align-items: start;
}

@media (max-width: $breakpoint-mobile) {
  .layout { grid-template-columns: 1fr; }
}

.main {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.side {
  position: sticky;
  top: 12px;
}

.hero-card {
  display: flex;
  gap: 20px;
  padding: 20px;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-lg;
}

.hero-info {
  flex: 1;
  min-width: 0;
}

.hero-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.hero-name {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: $text-primary;
  letter-spacing: -0.01em;
}

.hero-summary {
  margin: 6px 0 0;
  font-size: 14px;
  color: $text-secondary;
  line-height: 1.5;
}

.hero-desc {
  margin: 10px 0 0;
  font-size: 13px;
  color: $text-muted;
  line-height: 1.65;
  white-space: pre-wrap;
}

.hero-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.detail-tabs {
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-lg;
  padding: 4px 16px 16px;
}

.tab-section {
  padding: 8px 0;
}

.tab-section + .tab-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed $border-light;
}

.section-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
  letter-spacing: 0.02em;
}

.skill-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-secondary);
  border-radius: $radius-sm;
}

.member-name {
  font-weight: 600;
  color: $text-primary;
  min-width: 100px;
}

.member-role {
  color: $text-secondary;
  font-size: 12px;
}

.member-version {
  margin-left: auto;
  color: $text-muted;
  font-family: $font-code;
  font-size: 12px;
}

.kv-list .kv {
  display: flex;
  font-size: 12.5px;
  padding: 4px 0;
  gap: 12px;
}

.kv .k {
  color: $text-muted;
  width: 160px;
  flex-shrink: 0;
}

.kv .v {
  color: $text-primary;
  font-family: $font-code;
  word-break: break-all;
}

.side-card {
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: $radius-lg;
  padding: 16px;
}

.side-title {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: $text-muted;
}

.side-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px dashed $border-light;

  &:last-of-type { border-bottom: none; }
}

.side-k { color: $text-muted; }
.side-v { color: $text-primary; font-family: $font-code; max-width: 60%; word-break: break-all; text-align: right; }

.side-upgrade {
  margin-top: 10px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--warning);
  background: rgba(var(--warning-rgb), 0.08);
  border-radius: $radius-sm;
  text-align: center;
}
</style>
