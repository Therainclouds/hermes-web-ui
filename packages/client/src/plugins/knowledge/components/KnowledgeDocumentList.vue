<script setup lang="ts">
import { computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NAlert,
  NButton,
  NDataTable,
  NSpace,
  NTag,
  type DataTableColumns,
} from 'naive-ui'
import type { KnowledgeDocument } from '../api'
import type { DocumentStatusFilter } from '../composables/useKnowledgeData'
import { statusTagType } from '../utils/status'
import { formatBytes, formatTimestamp, basename } from '../utils/format'

const { t } = useI18n()

const props = defineProps<{
  documents: readonly KnowledgeDocument[]
  loading: boolean
  statusFilter: DocumentStatusFilter
}>()

const emit = defineEmits<{
  (e: 'update:statusFilter', value: DocumentStatusFilter): void
  (e: 'select', doc: KnowledgeDocument): void
  (e: 'delete', id: number): void
}>()

const FILTER_OPTIONS: DocumentStatusFilter[] = ['', 'indexed', 'indexing', 'pending', 'failed', 'metadata_only']

const columns = computed<DataTableColumns<KnowledgeDocument>>(() => [
  {
    title: t('knowledge.documents.name'),
    key: 'name',
    render(row) {
      return h(
        'a',
        {
          href: '#',
          class: 'document-link',
          onClick: (e: MouseEvent) => {
            e.preventDefault()
            emit('select', row)
          },
        },
        basename(row.source_path),
      )
    },
  },
  {
    title: t('knowledge.documents.status'),
    key: 'status',
    width: 120,
    render(row) {
      return h(NTag, { type: statusTagType(row.status), size: 'small' }, () =>
        t(`knowledge.documents.${row.status}`),
      )
    },
  },
  {
    title: t('knowledge.documents.size'),
    key: 'size_bytes',
    width: 100,
    render(row) {
      return formatBytes(row.size_bytes)
    },
  },
  {
    title: t('knowledge.documents.indexedAt'),
    key: 'indexed_at',
    width: 180,
    render(row) {
      if (row.status !== 'indexed' || !row.indexed_at) return '—'
      return formatTimestamp(row.indexed_at)
    },
  },
  {
    title: '',
    key: 'actions',
    width: 80,
    render(row) {
      return h(
        NButton,
        {
          size: 'tiny',
          type: 'error',
          quaternary: true,
          onClick: () => emit('delete', row.id),
        },
        () => t('knowledge.actions.delete'),
      )
    },
  },
])
</script>

<template>
  <NCard :title="t('knowledge.documents.title')" size="small" class="knowledge-document-list">
    <template #header-extra>
      <NSpace>
        <NButton
          v-for="s in FILTER_OPTIONS"
          :key="s"
          size="small"
          :type="props.statusFilter === s ? 'primary' : 'default'"
          @click="emit('update:statusFilter', s)"
        >
          {{ s ? t(`knowledge.documents.${s}`) : t('knowledge.documents.all') }}
        </NButton>
      </NSpace>
    </template>

    <NAlert v-if="props.documents.length === 0 && !props.loading" type="info" class="empty-alert">
      {{ t('knowledge.documents.noDocuments') }}
    </NAlert>

    <NDataTable
      v-else
      :columns="columns"
      :data="[...props.documents]"
      :bordered="false"
      size="small"
      :pagination="{ pageSize: 20 }"
      :row-key="(row: KnowledgeDocument) => row.id"
    />
  </NCard>
</template>

<style scoped>
.knowledge-document-list {
  margin-bottom: 0;
}
.document-link {
  color: var(--primary-color, #2080f0);
  text-decoration: none;
}
.document-link:hover {
  text-decoration: underline;
}
.empty-alert {
  margin: 8px 0;
}
</style>