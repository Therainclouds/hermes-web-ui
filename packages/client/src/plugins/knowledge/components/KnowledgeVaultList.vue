<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSpace,
  NTag,
  type DataTableColumns,
} from 'naive-ui'
import type { KnowledgeVault } from '../api'

const { t } = useI18n()

const props = defineProps<{
  vaults: readonly KnowledgeVault[]
}>()

const emit = defineEmits<{
  (e: 'add', rootPath: string, name: string): void
  (e: 'delete', id: number, cascade: boolean): void
}>()

const showAddModal = ref(false)
const newPath = ref('')
const newName = ref('')

const canSubmit = computed(() => !!newPath.value.trim() && !!newName.value.trim())

function submit(): void {
  if (!canSubmit.value) return
  emit('add', newPath.value.trim(), newName.value.trim())
  newPath.value = ''
  newName.value = ''
  showAddModal.value = false
}

function cancel(): void {
  showAddModal.value = false
  newPath.value = ''
  newName.value = ''
}

const columns = computed<DataTableColumns<KnowledgeVault>>(() => [
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
        row.watch ? t('knowledge.vaults.watching') : t('knowledge.vaults.offline'),
      )
    },
  },
  {
    title: '',
    key: 'actions',
    width: 100,
    render(row) {
      return h(NPopconfirm, { onPositiveClick: () => emit('delete', row.id, false) }, {
        trigger: () => h(NButton, { size: 'small', type: 'error', quaternary: true }, () => t('knowledge.actions.delete')),
        default: () => t('knowledge.vaults.confirmDelete'),
      })
    },
  },
])
</script>

<template>
  <NCard :title="t('knowledge.vaults.title')" size="small" class="knowledge-vault-list">
    <template #header-extra>
      <NSpace>
        <NButton size="small" @click="showAddModal = true">
          {{ t('knowledge.vaults.add') }}
        </NButton>
      </NSpace>
    </template>
    <NDataTable
      :columns="columns"
      :data="[...props.vaults]"
      :bordered="false"
      size="small"
      :pagination="false"
    />

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
        <NButton @click="cancel">{{ t('knowledge.actions.cancel') }}</NButton>
        <NButton type="primary" :disabled="!canSubmit" @click="submit">
          {{ t('knowledge.actions.confirm') }}
        </NButton>
      </template>
    </NModal>
  </NCard>
</template>

<style scoped>
.knowledge-vault-list {
  margin-bottom: 0;
}
</style>