<script setup lang="ts">
/**
 * Explorer mode — the power-user surface. Hosts everything the classic
 * UI had (dashboard / graph / library tabs), keeps the settings card
 * fully expanded, and is the only mode that will expose vec0 index
 * internals (round 2).
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NTabPane, NTabs } from 'naive-ui'
import type {
  KnowledgeDocument,
  KnowledgeHealth,
  KnowledgeSettings,
  KnowledgeVault,
} from '../../api'
import type { DocumentStatusFilter } from '../../composables/useKnowledgeData'
import KnowledgeSettingsCard from '../KnowledgeSettingsCard.vue'
import KnowledgeHealthCard from '../KnowledgeHealthCard.vue'
import KnowledgeVaultList from '../KnowledgeVaultList.vue'
import KnowledgeDocumentList from '../KnowledgeDocumentList.vue'
import KnowledgeDashboard from '../KnowledgeDashboard.vue'
import KnowledgeGraphView from '../KnowledgeGraphView.vue'

const props = defineProps<{
  vaults: readonly KnowledgeVault[]
  documents: readonly KnowledgeDocument[]
  health: KnowledgeHealth | null
  loading: boolean
  statusFilter: DocumentStatusFilter
  settings: KnowledgeSettings | null
  apiKeyInput: string
  savingKey: boolean
  canSave: boolean
  validationError: string | null
}>()

const emit = defineEmits<{
  (e: 'add-vault', rootPath: string, name: string): void
  (e: 'delete-vault', id: number, cascade: boolean): void
  (e: 'delete-document', id: number): void
  (e: 'select-document', doc: KnowledgeDocument): void
  (e: 'update:statusFilter', value: DocumentStatusFilter): void
  (e: 'update:apiKeyInput', value: string): void
  (e: 'save-key'): void
}>()

const { t } = useI18n()

type ViewTab = 'dashboard' | 'graph' | 'list'
const activeTab = ref<ViewTab>('dashboard')

const statusFilterModel = computed<DocumentStatusFilter>({
  get: () => props.statusFilter,
  set: (v: DocumentStatusFilter) => emit('update:statusFilter', v),
})
</script>

<template>
  <div class="explorer-mode">
    <KnowledgeSettingsCard
      :settings="settings"
      :api-key-input="apiKeyInput"
      :saving-key="savingKey"
      :can-save="canSave"
      :validation-error="validationError"
      @update:api-key-input="(v: string) => emit('update:apiKeyInput', v)"
      @save="emit('save-key')"
    />

    <NTabs v-model:value="activeTab" type="line" animated class="explorer-tabs">
      <NTabPane name="dashboard" :tab="t('knowledge.tabs.dashboard')">
        <KnowledgeDashboard
          :vaults="vaults"
          :documents="documents"
          :health="health"
          @open-graph="activeTab = 'graph'"
          @open-list="activeTab = 'list'"
          @select-document="(doc: KnowledgeDocument) => emit('select-document', doc)"
        />
      </NTabPane>

      <NTabPane name="graph" :tab="t('knowledge.tabs.graph')">
        <KnowledgeGraphView
          :vaults="vaults"
          :documents="documents"
          @select-document="(doc: KnowledgeDocument) => emit('select-document', doc)"
        />
      </NTabPane>

      <NTabPane name="list" :tab="t('knowledge.tabs.list')">
        <KnowledgeHealthCard :health="health" />
        <KnowledgeVaultList
          :vaults="vaults"
          @add="(p: string, n: string) => emit('add-vault', p, n)"
          @delete="(id: number, cascade: boolean) => emit('delete-vault', id, cascade)"
        />
        <KnowledgeDocumentList
          :documents="documents"
          :loading="loading"
          v-model:status-filter="statusFilterModel"
          @select="(doc: KnowledgeDocument) => emit('select-document', doc)"
          @delete="(id: number) => emit('delete-document', id)"
        />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.explorer-mode {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.explorer-tabs :deep(.n-tab-pane) {
  padding-top: 16px;
}
</style>
