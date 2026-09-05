<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NSelect, NSpin, NSwitch, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { fetchPlugins, setPluginEnabled, type HermesPluginInfo, type HermesPluginsMetadata } from '@/api/hermes/plugins'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useMessage } from '@/composables/useAppMessage'
import {
  BUILTIN_PLUGINS,
  isPluginEnabled,
  listBuiltinPlugins,
  readPluginEnabledMap,
  writePluginEnabledMap,
} from '@/plugins'

const { t, te } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const router = useRouter()

const plugins = ref<HermesPluginInfo[]>([])
const warnings = ref<string[]>([])
const metadata = ref<HermesPluginsMetadata | null>(null)
const loading = ref(false)
const error = ref('')
const actionLoading = ref<Record<string, boolean>>({})

// 客户端插件（built-in Vue 插件，与 Hermes Agent 插件解耦）。
interface ClientPluginRow {
  id: string
  name: string
  version: string
  description: string
  author?: string
  enabled: boolean
  hasOverride: boolean
}
const clientPlugins = ref<ClientPluginRow[]>([])
function loadClientPlugins() {
  const persisted = readPluginEnabledMap()
  clientPlugins.value = listBuiltinPlugins().map((m) => {
    const registration = BUILTIN_PLUGINS.find(r => r.plugin.id === m.id)
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      enabled: isPluginEnabled(m.id, registration?.enabledByDefault ?? true),
      hasOverride: Object.prototype.hasOwnProperty.call(persisted, m.id),
    }
  })
}
function persistClientPlugin(_row: ClientPluginRow) {
  const map: Record<string, boolean> = {}
  for (const r of clientPlugins.value) {
    if (r.hasOverride) map[r.id] = r.enabled
  }
  writePluginEnabledMap(map)
}
function toggleClientPlugin(row: ClientPluginRow, value: boolean) {
  row.enabled = value
  row.hasOverride = true
  persistClientPlugin(row)
}
function clientPluginLabel(row: ClientPluginRow) {
  const key = `pluginsClient.${row.id}.name`
  const translated = t(key)
  return (translated && translated !== key) ? translated : row.name
}
function clientPluginDescription(row: ClientPluginRow) {
  const key = `pluginsClient.${row.id}.description`
  const translated = t(key)
  return (translated && translated !== key) ? translated : row.description
}
function openClientPlugin(row: ClientPluginRow) {
  const routeName = row.id === 'scanner' ? 'plugin-scanner.scanner' : null
  if (routeName && router.hasRoute(routeName)) {
    void router.push({ name: routeName })
  }
}
onMounted(loadClientPlugins)

const searchQuery = ref('')
const sourceFilter = ref<string | null>(null)
const kindFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)

const statusValues = ['enabled', 'auto-active', 'inactive', 'disabled', 'provider-managed'] as const
const statusOptions = computed(() => statusValues.map(value => ({
  label: t(`plugins.status.${value}`),
  value,
})))

const sourceOptions = computed(() => toOptions(plugins.value.map(p => p.source)))
const kindOptions = computed(() => toOptions(plugins.value.map(p => p.kind)))

const summary = computed(() => ({
  total: plugins.value.length,
  active: plugins.value.filter(p => p.effectiveStatus === 'enabled' || p.effectiveStatus === 'auto-active').length,
  inactive: plugins.value.filter(p => p.effectiveStatus === 'inactive').length,
  disabled: plugins.value.filter(p => p.effectiveStatus === 'disabled').length,
  providerManaged: plugins.value.filter(p => p.effectiveStatus === 'provider-managed').length,
}))

const filteredPlugins = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return plugins.value.filter((plugin) => {
    if (sourceFilter.value && plugin.source !== sourceFilter.value) return false
    if (kindFilter.value && plugin.kind !== kindFilter.value) return false
    if (statusFilter.value && plugin.effectiveStatus !== statusFilter.value) return false
    if (!query) return true
    return [plugin.key, plugin.name, plugin.description, plugin.path, plugin.source, plugin.kind]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
})

function toOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b)).map(value => ({
    label: value,
    value,
  }))
}

async function loadPlugins() {
  loading.value = true
  error.value = ''
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    const data = await fetchPlugins()
    plugins.value = data.plugins ?? []
    warnings.value = data.warnings ?? []
    metadata.value = data.metadata ?? null
  } catch (err: any) {
    error.value = err?.message || t('plugins.loadFailed')
  } finally {
    loading.value = false
  }
}

function statusLabel(plugin: HermesPluginInfo) {
  const key = `plugins.statusLabel.${plugin.effectiveStatus}`
  return te(key) ? t(key) : plugin.effectiveStatus
}

function configStatusLabel(plugin: HermesPluginInfo) {
  const key = `plugins.configStatuses.${plugin.configStatus}`
  return te(key) ? t(key) : plugin.configStatus
}

function statusTagType(plugin: HermesPluginInfo): 'success' | 'warning' | 'error' | 'info' | 'default' {
  switch (plugin.effectiveStatus) {
    case 'enabled':
    case 'auto-active':
      return 'success'
    case 'disabled':
      return 'error'
    case 'provider-managed':
      return 'info'
    default:
      return 'warning'
  }
}

function canManagePlugin(plugin: HermesPluginInfo) {
  return plugin.kind === 'standalone' && plugin.source !== 'bundled'
}

function pluginIsEnabled(plugin: HermesPluginInfo) {
  return plugin.effectiveStatus === 'enabled'
}

async function updatePlugin(plugin: HermesPluginInfo, enabled: boolean) {
  actionLoading.value = { ...actionLoading.value, [plugin.key]: true }
  try {
    await setPluginEnabled(plugin.key, enabled)
    message.success(t(enabled ? 'plugins.enableSuccess' : 'plugins.disableSuccess', { name: plugin.key }))
    await loadPlugins()
  } catch (err: any) {
    message.error(err?.message || t('plugins.updateFailed'))
  } finally {
    const next = { ...actionLoading.value }
    delete next[plugin.key]
    actionLoading.value = next
  }
}

watch(() => profilesStore.activeProfileName || 'default', () => {
  plugins.value = []
  warnings.value = []
  metadata.value = null
  void loadPlugins()
}, { immediate: true })
</script>

<template>
  <div class="plugins-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('plugins.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadPlugins">
        {{ t('plugins.refresh') }}
      </NButton>
    </header>

    <div class="plugins-content" :class="{ 'is-loading': loading && plugins.length === 0 }">
      <div v-if="loading && plugins.length === 0" class="plugins-loading-state">
        <NSpin />
      </div>
      <template v-else>
        <NAlert type="info" :bordered="false" class="plugins-notice">
          {{ t('plugins.notice') }}
        </NAlert>

        <NAlert v-if="error" type="error" class="plugins-notice">
          {{ error }}
        </NAlert>

        <NAlert v-for="warning in warnings" :key="warning" type="warning" class="plugins-notice">
          {{ warning }}
        </NAlert>

        <!-- 客户端插件（浏览器侧 Vue 插件，与下面表格里的 Hermes Agent 插件是两套体系） -->
        <section v-if="clientPlugins.length > 0" class="client-plugins">
          <div class="client-plugins-header">
            <h3 class="section-title">{{ t('plugins.clientSectionTitle') }}</h3>
            <span class="section-hint">{{ t('plugins.clientSectionHint') }}</span>
          </div>
          <div class="client-plugins-grid">
            <NCard
              v-for="row in clientPlugins"
              :key="row.id"
              class="client-plugin-card"
              :class="{ 'is-disabled': !row.enabled }"
              hoverable
              @click="openClientPlugin(row)"
            >
              <div class="client-plugin-card-head">
                <div class="client-plugin-card-title-block">
                  <div class="client-plugin-card-title">
                    <span>{{ clientPluginLabel(row) }}</span>
                    <NTag size="small" round>v{{ row.version }}</NTag>
                  </div>
                  <div class="client-plugin-card-id">{{ row.id }}</div>
                </div>
                <NSwitch
                  :value="row.enabled"
                  size="small"
                  @click.stop="(e: MouseEvent) => e.stopPropagation()"
                  @update:value="(value: boolean) => toggleClientPlugin(row, value)"
                />
              </div>
              <p class="client-plugin-card-desc">{{ clientPluginDescription(row) }}</p>
              <div class="client-plugin-card-meta">
                <span v-if="row.author">{{ t('clientPlugins.author', { author: row.author }) }}</span>
                <NTag v-if="row.hasOverride" size="tiny" type="warning">
                  {{ t('clientPlugins.overridden') }}
                </NTag>
                <NTag v-else-if="row.enabled" size="tiny" type="success">
                  {{ t('clientPlugins.enabledTag') }}
                </NTag>
                <NTag v-else size="tiny" type="default">
                  {{ t('clientPlugins.disabledTag') }}
                </NTag>
              </div>
            </NCard>
          </div>
          <NAlert type="info" :bordered="false" size="small" class="client-plugins-refresh-hint">
            {{ t('plugins.clientSectionRefreshHint') }}
          </NAlert>
        </section>

        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">{{ t('plugins.summary.total') }}</span>
            <strong>{{ summary.total }}</strong>
          </div>
          <div class="summary-card success">
            <span class="summary-label">{{ t('plugins.summary.active') }}</span>
            <strong>{{ summary.active }}</strong>
          </div>
          <div class="summary-card warning">
            <span class="summary-label">{{ t('plugins.summary.inactive') }}</span>
            <strong>{{ summary.inactive }}</strong>
          </div>
          <div class="summary-card error">
            <span class="summary-label">{{ t('plugins.summary.disabled') }}</span>
            <strong>{{ summary.disabled }}</strong>
          </div>
          <div class="summary-card info">
            <span class="summary-label">{{ t('plugins.summary.providerManaged') }}</span>
            <strong>{{ summary.providerManaged }}</strong>
          </div>
        </div>

        <div class="filter-row">
          <NInput v-model:value="searchQuery" :placeholder="t('plugins.searchPlaceholder')" clearable />
          <NSelect v-model:value="sourceFilter" :options="sourceOptions" :placeholder="t('plugins.source')" clearable />
          <NSelect v-model:value="kindFilter" :options="kindOptions" :placeholder="t('plugins.kind')" clearable />
          <NSelect v-model:value="statusFilter" :options="statusOptions" :placeholder="t('plugins.statusTitle')" clearable />
        </div>

        <div v-if="filteredPlugins.length" class="plugins-table-wrap">
          <table class="plugins-table">
            <thead>
              <tr>
                <th>{{ t('plugins.table.plugin') }}</th>
                <th>{{ t('plugins.table.status') }}</th>
                <th>{{ t('plugins.table.source') }}</th>
                <th>{{ t('plugins.table.kind') }}</th>
                <th>{{ t('plugins.table.capabilities') }}</th>
                <th>{{ t('plugins.table.path') }}</th>
                <th>{{ t('plugins.table.manage') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plugin in filteredPlugins" :key="plugin.key">
                <td>
                  <div class="plugin-name">
                    <strong>{{ plugin.key }}</strong>
                    <span v-if="plugin.name !== plugin.key">{{ plugin.name }}</span>
                  </div>
                  <div v-if="plugin.description" class="description">{{ plugin.description }}</div>
                  <div v-if="plugin.version || plugin.author" class="meta-line">
                    <span v-if="plugin.version">v{{ plugin.version }}</span>
                    <span v-if="plugin.author">{{ plugin.author }}</span>
                  </div>
                </td>
                <td>
                  <NTag size="small" :type="statusTagType(plugin)">{{ statusLabel(plugin) }}</NTag>
                  <div class="config-status">{{ t('plugins.configStatus', { status: configStatusLabel(plugin) }) }}</div>
                </td>
                <td><NTag size="small" round>{{ plugin.source }}</NTag></td>
                <td><NTag size="small" round>{{ plugin.kind }}</NTag></td>
                <td>
                  <div class="capability-list">
                    <span>{{ t('plugins.capabilities.tools', { count: plugin.providesTools.length }) }}</span>
                    <span>{{ t('plugins.capabilities.hooks', { count: plugin.providesHooks.length }) }}</span>
                    <span>{{ t('plugins.capabilities.env', { count: plugin.requiresEnv.length }) }}</span>
                  </div>
                </td>
                <td><code class="path-cell">{{ plugin.path || t('plugins.notAvailable') }}</code></td>
                <td>
                  <NButton
                    v-if="canManagePlugin(plugin)"
                    size="tiny"
                    secondary
                    :type="pluginIsEnabled(plugin) ? 'warning' : 'primary'"
                    :loading="!!actionLoading[plugin.key]"
                    @click="updatePlugin(plugin, !pluginIsEnabled(plugin))"
                  >
                    {{ pluginIsEnabled(plugin) ? t('common.disable') : t('common.enable') }}
                  </NButton>
                  <span v-else class="muted">{{ t('plugins.managedElsewhere') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <NEmpty v-else :description="t('plugins.noMatch')" />

        <div v-if="metadata" class="metadata-panel">
          <span>{{ t('plugins.metadata.agentRoot') }}: <code>{{ metadata.hermesAgentRoot }}</code></span>
          <span>{{ t('plugins.metadata.python') }}: <code>{{ metadata.pythonExecutable }}</code></span>
          <span>{{ t('plugins.metadata.scanCwd') }}: <code>{{ metadata.cwd }}</code></span>
          <span>{{ t('plugins.metadata.projectPlugins') }}: <code>{{ metadata.projectPluginsEnabled ? t('plugins.enabled') : t('plugins.disabled') }}</code></span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.plugins-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.plugins-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;

  &.is-loading {
    display: grid;
    place-items: center;
  }
}

.plugins-loading-state {
  display: grid;
  place-items: center;
}

.plugins-notice {
  margin-bottom: 14px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

// ── 客户端插件 section ──────────────────────────────────────────────
.client-plugins {
  margin-bottom: 18px;
  padding-bottom: 16px;
  border-bottom: 1px dashed $border-color;
}

.client-plugins-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.section-hint {
  font-size: 12px;
  color: $text-muted;
}

.client-plugins-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.client-plugin-card {
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease;

  &.is-disabled {
    opacity: 0.65;
  }
}

.client-plugin-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.client-plugin-card-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.client-plugin-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.client-plugin-card-id {
  font-size: 11px;
  color: $text-muted;
  font-family: var(--font-mono, monospace);
}

.client-plugin-card-desc {
  font-size: 12.5px;
  color: $text-secondary;
  margin: 8px 0 4px;
  line-height: 1.45;
}

.client-plugin-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: $text-muted;
  flex-wrap: wrap;
}

.client-plugins-refresh-hint {
  margin-top: 10px;
  font-size: 11.5px;
}

.summary-card {
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  display: flex;
  flex-direction: column;
  gap: 6px;

  strong {
    font-size: 24px;
    line-height: 1;
  }

  &.success strong { color: $success; }
  &.warning strong { color: $warning; }
  &.error strong { color: $error; }
  &.info strong { color: $accent-primary; }
}

.summary-label {
  font-size: 11px;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.filter-row {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) repeat(3, minmax(140px, 180px));
  gap: 10px;
  margin-bottom: 16px;
}

.plugins-table-wrap {
  overflow-x: auto;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
}

.plugins-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 980px;

  th,
  td {
    padding: 12px;
    border-bottom: 1px solid $border-color;
    text-align: start;
    vertical-align: top;
    font-size: 13px;
  }

  th {
    color: $text-muted;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: rgba(var(--accent-primary-rgb), 0.04);
  }

  tr:last-child td {
    border-bottom: none;
  }
}

.plugin-name {
  display: flex;
  flex-direction: column;
  gap: 2px;

  span {
    color: $text-muted;
    font-size: 12px;
  }
}

.description {
  margin-top: 6px;
  color: $text-secondary;
  max-width: 420px;
}

.meta-line,
.config-status,
.muted {
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
}

.meta-line {
  display: flex;
  gap: 8px;
}

.capability-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: $text-secondary;
}

.path-cell {
  display: inline-block;
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: $text-muted;
  background: rgba(var(--accent-primary-rgb), 0.06);
  padding: 2px 6px;
  border-radius: 6px;
}

.metadata-panel {
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  color: $text-muted;
  font-size: 11px;

  code {
    color: $text-secondary;
  }
}

@media (max-width: 900px) {
  .summary-grid,
  .filter-row {
    grid-template-columns: 1fr;
  }
}
</style>
