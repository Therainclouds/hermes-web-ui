<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCard,
  NEmpty,
  NList,
  NListItem,
  NSpace,
  NStatistic,
  NTag,
  NThing,
} from 'naive-ui'
import type { KnowledgeHealth, KnowledgeVault, KnowledgeDocument } from '../api'
import { formatRelativeTime, basename } from '../utils/format'
import { statusTagType } from '../utils/status'

const { t } = useI18n()

const props = defineProps<{
  vaults: readonly KnowledgeVault[]
  documents: readonly KnowledgeDocument[]
  health: KnowledgeHealth | null
}>()

defineEmits<{
  (e: 'open-graph'): void
  (e: 'open-list'): void
  (e: 'select-document', doc: KnowledgeDocument): void
}>()

const recentDocuments = computed(() => {
  return [...props.documents]
    .filter(d => d.status === 'indexed' && d.indexed_at)
    .sort((a, b) => b.indexed_at - a.indexed_at)
    .slice(0, 5)
})

const statusBreakdown = computed(() => {
  const counts = {
    indexed: 0,
    indexing: 0,
    pending: 0,
    failed: 0,
    metadata_only: 0,
  }
  for (const doc of props.documents) {
    if (doc.status in counts) {
      counts[doc.status as keyof typeof counts]++
    }
  }
  return counts
})
</script>

<template>
  <div class="knowledge-dashboard">
    <div class="dashboard-stats">
      <NCard size="small" class="stat-card">
        <NStatistic :label="t('knowledge.health.vaults')" :value="props.vaults.length" />
      </NCard>
      <NCard size="small" class="stat-card">
        <NStatistic :label="t('knowledge.health.documents')" :value="props.documents.length" />
      </NCard>
      <NCard size="small" class="stat-card">
        <NStatistic
          :label="t('knowledge.health.chunks')"
          :value="props.health?.chunks.total ?? 0"
        />
      </NCard>
      <NCard size="small" class="stat-card">
        <NStatistic
          :label="t('knowledge.health.vectors')"
          :value="props.health?.vecIndex.vectorCount ?? 0"
        />
      </NCard>
    </div>

    <div class="dashboard-grid">
      <NCard :title="t('knowledge.dashboard.statusBreakdown')" size="small">
        <NSpace vertical :size="8">
          <div class="status-row">
            <NTag :type="statusTagType('indexed')" size="small">
              {{ t('knowledge.documents.indexed') }}
            </NTag>
            <span class="status-count">{{ statusBreakdown.indexed }}</span>
          </div>
          <div class="status-row">
            <NTag :type="statusTagType('indexing')" size="small">
              {{ t('knowledge.documents.indexing') }}
            </NTag>
            <span class="status-count">{{ statusBreakdown.indexing }}</span>
          </div>
          <div class="status-row">
            <NTag :type="statusTagType('pending')" size="small">
              {{ t('knowledge.documents.pending') }}
            </NTag>
            <span class="status-count">{{ statusBreakdown.pending }}</span>
          </div>
          <div class="status-row">
            <NTag :type="statusTagType('failed')" size="small">
              {{ t('knowledge.documents.failed') }}
            </NTag>
            <span class="status-count">{{ statusBreakdown.failed }}</span>
          </div>
          <div class="status-row">
            <NTag :type="statusTagType('metadata_only')" size="small">
              {{ t('knowledge.documents.metadata_only') }}
            </NTag>
            <span class="status-count">{{ statusBreakdown.metadata_only }}</span>
          </div>
        </NSpace>
      </NCard>

      <NCard :title="t('knowledge.dashboard.recentActivity')" size="small">
        <NList v-if="recentDocuments.length" hoverable>
          <NListItem
            v-for="doc in recentDocuments"
            :key="doc.id"
            @click="$emit('select-document', doc)"
          >
            <NThing>
              <template #header>
                <span class="recent-doc-title">{{ basename(doc.source_path) }}</span>
              </template>
              <template #description>
                <NTag size="tiny" :type="statusTagType(doc.status)">
                  {{ t(`knowledge.documents.${doc.status}`) }}
                </NTag>
                <span class="recent-doc-time">{{ formatRelativeTime(doc.indexed_at) }}</span>
              </template>
            </NThing>
          </NListItem>
        </NList>
        <NEmpty v-else size="small" :description="t('knowledge.dashboard.noRecentActivity')" />
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.knowledge-dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dashboard-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.stat-card {
  margin: 0;
}
.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 16px;
}
@media (max-width: 768px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
.status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.status-count {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.recent-doc-title {
  font-weight: 500;
}
.recent-doc-time {
  margin-left: 8px;
  font-size: 12px;
  opacity: 0.6;
}
</style>