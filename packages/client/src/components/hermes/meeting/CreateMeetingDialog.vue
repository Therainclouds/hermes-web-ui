<script setup lang="ts">
// 创建会议对话框外壳：
//   - NModal preset="card" + 标题 + 底部 action 按钮（取消/创建）
//   - 表单主体交给父级通过 default slot 注入（wizard 逻辑、ASR/LLM 配置
//     与 store/options 强耦合，由 MeetingView 主页面维护更合适）
//
// props 契约：
//   visible       控制显示（v-model）
//   createDisabled 父级计算的"创建"按钮禁用条件
// emits:
//   update:visible 关闭/取消
//   create         点击"创建会议"按钮

import { useI18n } from 'vue-i18n'
import { NModal, NButton } from 'naive-ui'

const props = defineProps<{
  visible: boolean
  createDisabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'create'): void
}>()

const { t } = useI18n()

function close() {
  emit('update:visible', false)
}

function onCreate() {
  emit('create')
}
</script>

<template>
  <NModal
    :show="props.visible"
    preset="card"
    :title="t('meeting.createMeeting')"
    :style="{ width: '640px' }"
    :bordered="false"
    :mask-closable="false"
    @update:show="(v: boolean) => emit('update:visible', v)"
  >
    <slot />
    <template #action>
      <NButton @click="close">{{ t('common.cancel') }}</NButton>
      <NButton
        type="primary"
        :disabled="props.createDisabled"
        @click="onCreate"
      >
        {{ t('meeting.create') }}
      </NButton>
    </template>
  </NModal>
</template>