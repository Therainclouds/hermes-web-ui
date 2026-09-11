<script setup lang="ts">
import type { KnowledgeVault, KnowledgeDocument } from '../api'
import KnowledgeVaultTree from './KnowledgeVaultTree.vue'
import KnowledgeTagCloud from './KnowledgeTagCloud.vue'

defineProps<{
  vaults: readonly KnowledgeVault[]
  documents: readonly KnowledgeDocument[]
  selectedVaultId: number | null
}>()

const emit = defineEmits<{
  (e: 'select-vault', vaultId: number | null): void
  (e: 'filter-tag', mimePrefix: string | null): void
}>()
</script>

<template>
  <aside class="knowledge-sidebar">
    <KnowledgeVaultTree
      :vaults="vaults"
      :documents="documents"
      :selected-vault-id="selectedVaultId"
      @select="(id: number | null) => emit('select-vault', id)"
    />
    <KnowledgeTagCloud
      :documents="documents"
      @filter="(tag: string | null) => emit('filter-tag', tag)"
    />
  </aside>
</template>

<style scoped>
.knowledge-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  height: 100%;
  overflow-y: auto;
}
</style>