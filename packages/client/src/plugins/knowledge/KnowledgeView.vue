<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin, NTabPane, NTabs } from 'naive-ui'
import type { KnowledgeDocument } from './api'
import { useKnowledgeData, type DocumentStatusFilter } from './composables/useKnowledgeData'
import { useKnowledgeSettings } from './composables/useKnowledgeSettings'
import KnowledgeSidebar from './components/KnowledgeSidebar.vue'
import KnowledgeSettingsCard from './components/KnowledgeSettingsCard.vue'
import KnowledgeHealthCard from './components/KnowledgeHealthCard.vue'
import KnowledgeVaultList from './components/KnowledgeVaultList.vue'
import KnowledgeDocumentList from './components/KnowledgeDocumentList.vue'

const { t } = useI18n()

// Lazy-load heavy panels (mirrors ChatPanel.vue's pattern).
const KnowledgeDashboard = defineAsyncComponent(() =>
  import('./components/KnowledgeDashboard.vue').then(m => m.default),
)
const KnowledgeGraphView = defineAsyncComponent(() =>
  import('./components/KnowledgeGraphView.vue').then(m => m.default),
)
const KnowledgeDocumentDetail = defineAsyncComponent(() =>
  import('./components/KnowledgeDocumentDetail.vue').then(m => m.default),
)

// --- Composable state ----------------------------------------------------
const data = useKnowledgeData()
const settings = useKnowledgeSettings()

// --- Local UI state ------------------------------------------------------
type ViewTab = 'dashboard' | 'graph' | 'list'
const activeTab = ref<ViewTab>('dashboard')
const selectedDocument = shallowRef<KnowledgeDocument | null>(null)
const detailOpen = ref(false)

const statusFilterModel = computed<DocumentStatusFilter>({
  get: () => data.statusFilter.value,
  set: (v: DocumentStatusFilter) => data.setStatusFilter(v),
})

function onSelectVault(vaultId: number | null): void {
  data.selectVault(vaultId)
}

function onAddVault(rootPath: string, name: string): void {
  void data.addVault(rootPath, name)
}

function onDeleteVault(id: number, _cascade: boolean): void {
  void data.removeVault(id, false)
}

function onDeleteDocument(id: number): void {
  void data.removeDocument(id)
  detailOpen.value = false
  selectedDocument.value = null
}

function onSelectDocument(doc: KnowledgeDocument): void {
  selectedDocument.value = doc
  detailOpen.value = true
}

function openTab(tab: ViewTab): void {
  activeTab.value = tab
}

onMounted(() => {
  void settings.load()
  void data.loadAll()
})
</script>

<template>
  <div class="knowledge-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('knowledge.title') }}</h2>
      <p class="header-subtitle">{{ t('knowledge.description') }}</p>
    </header>

    <NSpin :show="data.loading.value">
      <div class="knowledge-workspace">
        <KnowledgeSidebar
          :vaults="data.vaults.value"
          :documents="data.documents.value"
          :selected-vault-id="data.selectedVaultId.value"
          @select-vault="onSelectVault"
        />

        <main class="knowledge-main">
          <KnowledgeSettingsCard
            :settings="settings.settings.value"
            :api-key-input="settings.apiKeyInput.value"
            :saving-key="settings.savingKey.value"
            :can-save="settings.canSave.value"
            :validation-error="settings.validationError.value"
            @update:api-key-input="(v: string) => (settings.apiKeyInput.value = v)"
            @save="settings.save"
          />

          <NTabs
            v-model:value="activeTab"
            type="line"
            animated
            class="knowledge-tabs"
          >
            <NTabPane name="dashboard" :tab="t('knowledge.tabs.dashboard')">
              <KnowledgeDashboard
                :vaults="data.vaults.value"
                :documents="data.documents.value"
                :health="data.health.value"
                @open-graph="openTab('graph')"
                @open-list="openTab('list')"
                @select-document="onSelectDocument"
              />
            </NTabPane>

            <NTabPane name="graph" :tab="t('knowledge.tabs.graph')">
              <KnowledgeGraphView
                :vaults="data.vaults.value"
                :documents="data.documents.value"
                @select-document="onSelectDocument"
              />
            </NTabPane>

            <NTabPane name="list" :tab="t('knowledge.tabs.list')">
              <KnowledgeHealthCard :health="data.health.value" />
              <KnowledgeVaultList
                :vaults="data.vaults.value"
                @add="onAddVault"
                @delete="onDeleteVault"
              />
              <KnowledgeDocumentList
                :documents="data.documents.value"
                :loading="data.loading.value"
                v-model:status-filter="statusFilterModel"
                @select="onSelectDocument"
                @delete="onDeleteDocument"
              />
            </NTabPane>
          </NTabs>
        </main>
      </div>

      <KnowledgeDocumentDetail
        v-model:show="detailOpen"
        :document="selectedDocument"
        @delete="onDeleteDocument"
      />
    </NSpin>
  </div>
</template>

<style scoped>
.knowledge-view {
  padding: 16px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.page-header {
  margin-bottom: 16px;
}
.header-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}
.header-subtitle {
  margin: 0;
  opacity: 0.6;
  font-size: 13px;
}
.knowledge-workspace {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  border-radius: 8px;
  overflow: hidden;
  background: var(--card-color, rgba(255, 255, 255, 0.02));
}
.knowledge-main {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.knowledge-tabs {
  margin-top: 4px;
}
.knowledge-tabs :deep(.n-tab-pane) {
  padding-top: 16px;
}
</style>