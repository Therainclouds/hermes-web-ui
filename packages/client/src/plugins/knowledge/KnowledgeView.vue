<script setup lang="ts">
import { h, onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NDataTable,
  NInput,
  NModal,
  NSpace,
  NTag,
  NForm,
  NFormItem,
  NAlert,
  NSpin,
  NPopconfirm,
  NGrid,
  NGi,
  NCard,
  NStatistic,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import * as api from './api'
import type { KnowledgeVault, KnowledgeDocument, KnowledgeHealth } from './api'

const { t } = useI18n()
const message = useMessage()

// --- State ----------------------------------------------------------------

const loading = ref(false)
const vaults = ref<KnowledgeVault[]>([])
const documents = ref<KnowledgeDocument[]>([])
const health = ref<KnowledgeHealth | null>(null)
const statusFilter = ref<string>('')
const selectedVaultId = ref<number | null>(null)

// Add vault modal
const showAddModal = ref(false)
const newPath = ref('')
const newName = ref('')
const cascadeDelete = ref(false)

// --- Data loading ---------------------------------------------------------

async function loadData() {
  loading.value = true
  try {
    const [vaultRes, docRes, healthRes] = await Promise.all([
      api.listVaults(),
      api.listDocuments(selectedVaultId.value ? { vaultId: selectedVaultId.value, status: statusFilter.value || undefined } : { status: statusFilter.value || undefined }),
      api.getHealth().catch(() => null),
    ])
    vaults.value = vaultRes.vaults
    documents.value = docRes.documents
    health.value = healthRes
  } catch (err) {
    message.error(t('knowledge.errors.fetchFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(() => { loadData() })

// --- Vault actions --------------------------------------------------------

async function addVault() {
  if (!newPath.value.trim() || !newName.value.trim()) return
  try {
    await api.createVault(newPath.value.trim(), newName.value.trim())
    showAddModal.value = false
    newPath.value = ''
    newName.value = ''
    await loadData()
    message.success(t('knowledge.messages.vaultCreated'))
  } catch (err) {
    message.error(t('knowledge.errors.createFailed'))
  }
}

async function removeVault(id: number) {
  try {
    await api.deleteVault(id, cascadeDelete.value)
    cascadeDelete.value = false
    await loadData()
  } catch (err) {
    message.error(t('knowledge.errors.deleteFailed'))
  }
}

// --- Document table columns -----------------------------------------------

const docColumns = computed<DataTableColumns<KnowledgeDocument>>(() => [
  {
    title: t('knowledge.documents.path'),
    key: 'source_path',
    ellipsis: { tooltip: true },
  },
  {
    title: t('knowledge.documents.status'),
    key: 'status',
    width: 120,
    render(row) {
      const typeMap: Record<string, 'success' | 'warning' | 'error' | 'info' | 'default'> = {
        indexed: 'success',
        indexing: 'info',
        pending: 'warning',
        failed: 'error',
      }
      const labelKey = `knowledge.documents.${row.status}`
      return h(NTag, { type: typeMap[row.status] || 'default', size: 'small' }, () => t(labelKey))
    },
  },
  {
    title: t('knowledge.documents.size'),
    key: 'size_bytes',
    width: 100,
    render(row) {
      if (row.size_bytes < 1024) return `${row.size_bytes} B`
      if (row.size_bytes < 1024 * 1024) return `${(row.size_bytes / 1024).toFixed(1)} KB`
      return `${(row.size_bytes / (1024 * 1024)).toFixed(1)} MB`
    },
  },
  {
    title: t('knowledge.documents.indexedAt'),
    key: 'indexed_at',
    width: 180,
    render(row) {
      if (row.status !== 'indexed' || !row.indexed_at) return '—'
      return new Date(row.indexed_at).toLocaleString()
    },
  },
  {
    title: t('knowledge.documents.error'),
    key: 'error',
    ellipsis: { tooltip: true },
    render(row) {
      return row.error || '—'
    },
  },
])

const vaultColumns = computed<DataTableColumns<KnowledgeVault>>(() => [
  {
    title: t('knowledge.vaults.name'),
    key: 'name',
  },
  {
    title: t('knowledge.vaults.path'),
    key: 'root_path',
    ellipsis: { tooltip: true },
  },
  {
    title: t('knowledge.vaults.status'),
    key: 'watch',
    width: 120,
    render(row) {
      return h(NTag, { type: row.watch ? 'success' : 'warning', size: 'small' }, () =>
        row.watch ? t('knowledge.vaults.watching') : t('knowledge.vaults.offline')
      )
    },
  },
  {
    title: '',
    key: 'actions',
    width: 100,
    render(row) {
      return h(NPopconfirm, { onPositiveClick: () => removeVault(row.id) }, {
        trigger: () => h(NButton, { size: 'small', type: 'error', quaternary: true }, () => t('knowledge.actions.delete')),
        default: () => t('knowledge.vaults.confirmDelete'),
      })
    },
  },
])



</script>

<template>
  <div class="knowledge-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('knowledge.title') }}</h2>
      <p class="header-subtitle">{{ t('knowledge.description') }}</p>
    </header>

    <NSpin :show="loading">
      <div class="knowledge-content">
        <!-- Health summary -->
        <NCard v-if="health" size="small" class="health-card">
          <NGrid :cols="4" :x-gap="12">
            <NGi>
              <NStatistic :label="t('knowledge.health.vaults')" :value="health.vaults.total" />
            </NGi>
            <NGi>
              <NStatistic :label="t('knowledge.health.documents')" :value="health.documents.total" />
            </NGi>
            <NGi>
              <NStatistic :label="t('knowledge.health.chunks')" :value="health.chunks.total" />
            </NGi>
            <NGi>
              <NStatistic :label="t('knowledge.health.vectors')" :value="health.vecIndex.vectorCount" />
            </NGi>
          </NGrid>
        </NCard>

        <!-- Vault list -->
        <NCard :title="t('knowledge.vaults.title')" size="small" class="section-card">
          <template #header-extra>
            <NSpace>
              <NButton size="small" @click="loadData">{{ t('knowledge.actions.refresh') }}</NButton>
              <NButton size="small" type="primary" @click="showAddModal = true">
                {{ t('knowledge.vaults.add') }}
              </NButton>
            </NSpace>
          </template>
          <NDataTable
            :columns="vaultColumns"
            :data="vaults"
            :bordered="false"
            size="small"
            :pagination="false"
          />
        </NCard>

        <!-- Document list -->
        <NCard :title="t('knowledge.documents.title')" size="small" class="section-card">
          <template #header-extra>
            <NSpace>
              <NButton
                v-for="s in ['', 'indexed', 'indexing', 'pending', 'failed']"
                :key="s"
                size="small"
                :type="statusFilter === s ? 'primary' : 'default'"
                @click="statusFilter = s; loadData()"
              >
                {{ s ? t(`knowledge.documents.${s}`) : t('knowledge.documents.all') }}
              </NButton>
            </NSpace>
          </template>

          <NAlert v-if="documents.length === 0 && !loading" type="info" class="empty-alert">
            {{ t('knowledge.documents.noDocuments') }}
          </NAlert>

          <NDataTable
            v-else
            :columns="docColumns"
            :data="documents"
            :bordered="false"
            size="small"
            :pagination="{ pageSize: 20 }"
          />
        </NCard>
      </div>
    </NSpin>

    <!-- Add vault modal -->
    <NModal v-model:show="showAddModal" preset="dialog" :title="t('knowledge.vaults.add')">
      <NForm>
        <NFormItem :label="t('knowledge.vaults.name')">
          <NInput v-model:value="newName" :placeholder="t('knowledge.vaults.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('knowledge.vaults.path')">
          <NInput v-model:value="newPath" :placeholder="t('knowledge.vaults.pathPlaceholder')" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showAddModal = false">{{ t('knowledge.actions.cancel') }}</NButton>
        <NButton type="primary" @click="addVault" :disabled="!newPath.trim() || !newName.trim()">
          {{ t('knowledge.actions.confirm') }}
        </NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.knowledge-view {
  padding: 16px 24px;
  max-width: 1200px;
  margin: 0 auto;
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
.knowledge-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.health-card {
  margin-bottom: 4px;
}
.section-card {
  /* empty */
}
.empty-alert {
  margin: 8px 0;
}
</style>
