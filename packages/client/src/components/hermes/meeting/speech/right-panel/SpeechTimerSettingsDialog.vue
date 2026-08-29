<script setup lang="ts">
// 演讲评分 · 计时设置弹窗：Toastmasters 环节预设 + 时长/黄牌/红牌设置。
// 设置状态经 speechTimerContext 注入（面板创建的唯一实例）。
import { useI18n } from 'vue-i18n'
import { NButton, NInputNumber, NModal } from 'naive-ui'
import { injectSpeechTimer } from '../speechTimerContext'

const { t } = useI18n()
const timer = injectSpeechTimer()

// Toastmasters 常见环节预设（一键套用时长/黄牌/红牌）
const SEGMENT_PRESETS = [
  { key: 'tableTopics', durationSec: 120, yellowAtSec: 30, redAtSec: 10 },   // 即兴演讲 2 分钟
  { key: 'prepared', durationSec: 420, yellowAtSec: 60, redAtSec: 15 },      // 备稿演讲 5-7 分钟（按 6 分钟黄牌）
  { key: 'evaluation', durationSec: 180, yellowAtSec: 30, redAtSec: 10 },    // 评估 2-3 分钟
  { key: 'iceBreaker', durationSec: 300, yellowAtSec: 45, redAtSec: 10 },    // 破冰演讲 4-6 分钟
  { key: 'custom', durationSec: 180, yellowAtSec: 30, redAtSec: 10 },        // 自定义
] as const

function applyPreset(presetKey: string) {
  const preset = SEGMENT_PRESETS.find(p => p.key === presetKey)
  if (!preset) return
  timer.settingsDuration = preset.durationSec
  timer.settingsYellow = preset.yellowAtSec
  timer.settingsRed = preset.redAtSec
}
</script>

<template>
  <NModal
    v-model:show="timer.showSettings"
    preset="card"
    :title="t('meeting.speechEval.settingsTitle')"
    :style="{ width: '380px' }"
    :bordered="false"
  >
    <div class="settings-form">
      <div class="setting-field">
        <label>{{ t('meeting.speechEval.presetsLabel') }}</label>
        <div class="preset-grid">
          <NButton
            v-for="p in SEGMENT_PRESETS"
            :key="p.key"
            size="small"
            quaternary
            @click="applyPreset(p.key)"
          >
            {{ t(`meeting.speechEval.preset_${p.key}`) }}
          </NButton>
        </div>
      </div>
      <div class="setting-field">
        <label>{{ t('meeting.speechEval.durationLabel') }}</label>
        <NInputNumber v-model:value="timer.settingsDuration" :min="10" :max="3600" size="small" style="width: 100%" />
      </div>
      <div class="setting-field">
        <label>{{ t('meeting.speechEval.yellowLabel') }}</label>
        <NInputNumber v-model:value="timer.settingsYellow" :min="0" :max="300" size="small" style="width: 100%" />
      </div>
      <div class="setting-field">
        <label>{{ t('meeting.speechEval.redLabel') }}</label>
        <NInputNumber v-model:value="timer.settingsRed" :min="0" :max="300" size="small" style="width: 100%" />
      </div>
      <div class="settings-actions">
        <NButton size="small" @click="timer.showSettings = false">{{ t('common.cancel') }}</NButton>
        <NButton size="small" type="primary" @click="timer.saveSettings">{{ t('common.confirm') }}</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
// --- 计时设置弹窗（自 SpeechEvaluationPanel 原样搬出） ---
.settings-form { display: flex; flex-direction: column; gap: 12px; }

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label { font-size: 12px; font-weight: 500; color: var(--n-text-color, #ccc); }
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
