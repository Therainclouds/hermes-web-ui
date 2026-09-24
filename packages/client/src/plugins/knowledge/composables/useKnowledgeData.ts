/**
 * Knowledge plugin — data loading composable.
 *
 * Centralizes vaults / documents / health fetching with a generation counter
 * to cancel stale async loads (mirrors JourneyView.vue's pattern).
 */
import { onBeforeUnmount, shallowRef, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import * as api from '../api'
import type { KnowledgeVault, KnowledgeDocument, KnowledgeHealth } from '../api'
import { useMessage } from '@/composables/useAppMessage'

export type DocumentStatusFilter = '' | 'pending' | 'indexing' | 'indexed' | 'failed' | 'metadata_only'

export function useKnowledgeData() {
  const { t } = useI18n()
  const message = useMessage()

  const loading = ref(false)
  const vaults = shallowRef<KnowledgeVault[]>([])
  const documents = shallowRef<KnowledgeDocument[]>([])
  const health = shallowRef<KnowledgeHealth | null>(null)
  const statusFilter = ref<DocumentStatusFilter>('')
  const selectedVaultId = ref<number | null>(null)

  let generation = 0
  let disposed = false

  const vaultById = computed(() => new Map(vaults.value.map(v => [v.id, v])))
  const documentsByVault = computed(() => {
    const map = new Map<number, KnowledgeDocument[]>()
    for (const doc of documents.value) {
      const list = map.get(doc.vault_id) || []
      list.push(doc)
      map.set(doc.vault_id, list)
    }
    return map
  })

  async function loadAll(): Promise<void> {
    const gen = ++generation
    loading.value = true
    try {
      const [vaultRes, docRes, healthRes] = await Promise.all([
        api.listVaults(),
        api.listDocuments({
          vaultId: selectedVaultId.value ?? undefined,
          status: statusFilter.value || undefined,
        }),
        api.getHealth().catch(() => null),
      ])
      if (disposed || gen !== generation) return
      vaults.value = vaultRes.vaults
      documents.value = docRes.documents
      health.value = healthRes
    } catch {
      if (!disposed && gen === generation) {
        message.error(t('knowledge.errors.fetchFailed'))
      }
    } finally {
      if (!disposed && gen === generation) {
        loading.value = false
      }
    }
  }

  async function reloadDocuments(): Promise<void> {
    const gen = ++generation
    try {
      const docRes = await api.listDocuments({
        vaultId: selectedVaultId.value ?? undefined,
        status: statusFilter.value || undefined,
      })
      if (disposed || gen !== generation) return
      documents.value = docRes.documents
    } catch {
      if (!disposed && gen === generation) {
        message.error(t('knowledge.errors.fetchFailed'))
      }
    }
  }

  async function addVault(rootPath: string, name: string): Promise<boolean> {
    try {
      await api.createVault(rootPath, name)
      await loadAll()
      message.success(t('knowledge.messages.vaultCreated'))
      return true
    } catch {
      message.error(t('knowledge.errors.createFailed'))
      return false
    }
  }

  async function removeVault(id: number, cascade: boolean): Promise<void> {
    try {
      await api.deleteVault(id, cascade)
      if (selectedVaultId.value === id) selectedVaultId.value = null
      await loadAll()
    } catch {
      message.error(t('knowledge.errors.deleteFailed'))
    }
  }

  async function removeDocument(id: number): Promise<void> {
    try {
      await api.deleteDocument(id)
      await reloadDocuments()
    } catch {
      message.error(t('knowledge.errors.deleteFailed'))
    }
  }

  function selectVault(vaultId: number | null): void {
    selectedVaultId.value = vaultId
    void reloadDocuments()
  }

  function setStatusFilter(filter: DocumentStatusFilter): void {
    statusFilter.value = filter
    void reloadDocuments()
  }

  onBeforeUnmount(() => {
    disposed = true
  })

  return {
    loading,
    vaults,
    documents,
    health,
    statusFilter,
    selectedVaultId,
    vaultById,
    documentsByVault,
    loadAll,
    reloadDocuments,
    addVault,
    removeVault,
    removeDocument,
    selectVault,
    setStatusFilter,
  }
}