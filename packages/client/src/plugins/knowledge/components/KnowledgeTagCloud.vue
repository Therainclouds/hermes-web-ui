<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { KnowledgeDocument } from '../api'
import { mimeTypeTag } from '../utils/status'

const { t } = useI18n()

const props = defineProps<{
  documents: readonly KnowledgeDocument[]
}>()

const emit = defineEmits<{
  (e: 'filter', mimePrefix: string | null): void
}>()

interface TagEntry {
  tag: string
  count: number
}

const tags = computed<TagEntry[]>(() => {
  const counts = new Map<string, number>()
  for (const doc of props.documents) {
    const tag = mimeTypeTag(doc.mime_type)
    counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
})

const maxCount = computed(() => Math.max(1, ...tags.value.map(t => t.count)))

function fontSize(count: number): string {
  const ratio = count / maxCount.value
  return `${12 + ratio * 6}px`
}
</script>

<template>
  <div class="knowledge-tag-cloud">
    <h4 class="cloud-title">{{ t('knowledge.sidebar.tags') }}</h4>
    <div v-if="tags.length" class="cloud-items">
      <span
        v-for="entry in tags"
        :key="entry.tag"
        class="cloud-tag"
        :style="{ fontSize: fontSize(entry.count) }"
        @click="emit('filter', entry.tag)"
      >
        {{ entry.tag }}
        <span class="cloud-tag-count">{{ entry.count }}</span>
      </span>
    </div>
    <p v-else class="cloud-empty">{{ t('knowledge.sidebar.noTags') }}</p>
  </div>
</template>

<style scoped>
.knowledge-tag-cloud {
  padding: 12px 0;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
}
.cloud-title {
  margin: 0 0 8px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
.cloud-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 0 12px;
}
.cloud-tag {
  cursor: pointer;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
  transition: color 0.15s ease;
  padding: 2px 4px;
  border-radius: 4px;
}
.cloud-tag:hover {
  color: var(--primary-color, #2080f0);
  background: var(--hover-color, rgba(255, 255, 255, 0.04));
}
.cloud-tag-count {
  font-size: 0.7em;
  opacity: 0.6;
  margin-left: 4px;
}
.cloud-empty {
  margin: 0 12px;
  font-size: 12px;
  opacity: 0.5;
}
</style>