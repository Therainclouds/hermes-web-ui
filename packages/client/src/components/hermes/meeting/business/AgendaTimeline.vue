<script setup lang="ts">
// 议程时间线（Business 场景专属）
//
// 数据形状：本轮先就地维护在组件内部；后续 PR 把议程存到 store.session.agenda
// 当前可点击议程项切换状态（pending → active → done），便于预览交互。

import { ref } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'

interface AgendaItem {
  id: string
  title: string
  durationMin: number
  status: 'pending' | 'active' | 'done'
}

const props = withDefaults(defineProps<{
  items?: AgendaItem[]
}>(), {
  items: () => [
    { id: 'a1', title: '开场 · 上季度回顾', durationMin: 5, status: 'done' },
    { id: 'a2', title: 'Q3 营收与增长', durationMin: 10, status: 'done' },
    { id: 'a3', title: '新产品线发布', durationMin: 15, status: 'active' },
    { id: 'a4', title: '渠道 ROI 分析', durationMin: 10, status: 'pending' },
    { id: 'a5', title: '行动项与责任人', durationMin: 5, status: 'pending' },
  ],
})

const { t } = useI18n()
const localItems = ref<AgendaItem[]>([...props.items])

function nextStatus(s: AgendaItem['status']): AgendaItem['status'] {
  if (s === 'pending') return 'active'
  if (s === 'active') return 'done'
  return 'pending'
}

function advance(item: AgendaItem) {
  item.status = nextStatus(item.status)
}

const doneCount = () => localItems.value.filter(i => i.status === 'done').length
</script>

<template>
  <section class="agenda-timeline">
    <header class="agenda-timeline__header">
      <h3>{{ t('meeting.sceneBusiness.agenda.title') }}</h3>
      <NTag size="small" round>
        {{ doneCount() }} / {{ localItems.length }}
      </NTag>
    </header>
    <ol class="agenda-timeline__list">
      <li
        v-for="item in localItems"
        :key="item.id"
        class="agenda-timeline__item"
        :class="`agenda-timeline__item--${item.status}`"
        @click="advance(item)"
      >
        <span class="agenda-timeline__dot" aria-hidden="true" />
        <span class="agenda-timeline__title">{{ item.title }}</span>
        <span class="agenda-timeline__duration">{{ item.durationMin }}m</span>
      </li>
    </ol>
    <NButton size="small" block secondary class="agenda-timeline__add">
      + {{ t('meeting.sceneBusiness.agenda.add') }}
    </NButton>
  </section>
</template>

<style scoped>
.agenda-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
.agenda-timeline__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.agenda-timeline__header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.agenda-timeline__list {
  flex: 1 1 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}
.agenda-timeline__item {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms;
}
.agenda-timeline__item:hover {
  background: var(--bg-card-hover);
}
.agenda-timeline__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--border-color);
  background: transparent;
}
.agenda-timeline__item--done .agenda-timeline__dot {
  background: var(--success);
  border-color: var(--success);
}
.agenda-timeline__item--done .agenda-timeline__title {
  color: var(--text-muted);
  text-decoration: line-through;
}
.agenda-timeline__item--active .agenda-timeline__dot {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(var(--accent-primary-rgb), 0.18);
}
.agenda-timeline__item--active .agenda-timeline__title {
  font-weight: 600;
}
.agenda-timeline__title {
  font-size: 13px;
  line-height: 1.4;
}
.agenda-timeline__duration {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.agenda-timeline__add {
  margin-top: 4px;
}
</style>