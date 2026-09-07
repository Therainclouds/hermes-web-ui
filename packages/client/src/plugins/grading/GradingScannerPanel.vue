<script setup lang="ts">
/**
 * GradingScannerPanel — 批改模式右侧的「摄像头 + OCR」实时面板。
 *
 * 完全复用扫描插件的能力，不重复造轮子：
 *   - useScannerCamera：UVC/USB / 移动端摄像头 + 分辨率预设；
 *   - useSmartCapture：动态捕捉（纸张检测 / 选框微调 / 自动拍摄 / AI 兜底）；
 *   - ScannerQuadOverlay：选框覆盖层（角点拖动）。
 *
 * 拍摄后把图存到服务端（grading/capture_scan）并用配置的视觉模型（默认
 * qwen3.7-flash）跑 OCR，把识别出的文本流到下面展示。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NEmpty, NSpin, NSwitch, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { SCANNER_RESOLUTION_PRESETS, useScannerCamera } from '../scanner/composables/useScannerCamera'
import { useSmartCapture } from '../scanner/composables/useSmartCapture'
import ScannerQuadOverlay from '../scanner/components/ScannerQuadOverlay.vue'
import { canvasToDataUrl } from '../scanner/image-io'
import type { Quad } from '../scanner/vision/types'
import { gradingApi, type Submission } from './api'

const { t } = useI18n()
const cam = useScannerCamera()
const video = ref<HTMLVideoElement | null>(null)

const resolutionId = ref('2k')
const resolutionOptions = computed(() =>
  SCANNER_RESOLUTION_PRESETS.map(p => ({ label: p.labelKey, value: p.id })),
)

const pages = ref<any[]>([])
const active = ref<Submission | null>(null)
const busy = ref(false)
const error = ref('')
const showOcr = ref(false)

const smart = useSmartCapture({
  video: () => video.value,
  cameraRunning: () => cam.isRunning.value,
  onAutoCapture: async payload => {
    await handleCapture(canvasToDataUrl(payload.canvas, 0.92))
  },
  aspectRatio: null,
})
const smartEnabled = computed(() => smart.enabled.value)
const smartQuad = computed(() => smart.quad.value)
const autoCaptureOn = computed({ get: () => smart.autoCapture.value, set: v => smart.setAutoCapture(v) })
const smartStatusText = computed(() => {
  switch (smart.status.value) {
    case 'off': return t('scanner.smart.off')
    case 'loading': return t('scanner.smart.loading')
    case 'unavailable': return t('scanner.smart.unavailable')
    case 'searching': return t('scanner.smart.searching')
    case 'detected': return t('scanner.smart.detected')
    case 'held': return t('scanner.smart.held')
    case 'capturing': return t('scanner.smart.capturing')
    case 'cooling': return t('scanner.smart.cooling')
    default: return t('scanner.smart.off')
  }
})

function onQuadEdit(next: Quad) { smart.setQuadManually(next) }

async function startCamera() {
  await cam.start({ resolutionId: resolutionId.value })
  if (cam.error.value) error.value = String(cam.error.value)
}
function stopCamera() { cam.stop() }
async function onResolutionChange(next: string) {
  resolutionId.value = next
  if (cam.isRunning.value) await cam.start({ resolutionId: next })
}

async function handleCapture(dataUrl: string) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const captured: any = await gradingApi('capture_scan', { image: dataUrl, studentName: `Scan ${pages.value.length + 1}` })
    const ocr: any = await gradingApi('ocr', { scanId: captured.scanId })
    const row = { id: captured.scanId, studentName: ocr.studentName, status: ocr.status || 'recognized', results: ocr.results || [], error: ocr.error || '', wordCount: (ocr.words?.length || 0) }
    pages.value.unshift(row)
    const full = await gradingApi<Submission>('get', { scanId: captured.scanId })
    active.value = full
    showOcr.value = true
  } catch (e) { error.value = (e as Error).message } finally { busy.value = false }
}

async function snap() {
  const shot = await smart.captureNow()
  if (shot) await handleCapture(shot.dataUrl)
}

onMounted(() => { void nextTick(); if (video.value) cam.bindVideo(video.value) })
onBeforeUnmount(() => { cam.stop() })
watch(video, el => { if (el) cam.bindVideo(el) })
</script>

<template>
  <aside class="grading-scanner" role="region" :aria-label="t('grading.title')">
    <div class="gs-toolbar">
      <NSelect :value="resolutionId" :options="resolutionOptions" size="small" style="width:130px" @update:value="onResolutionChange" />
      <NButton size="small" :type="cam.isRunning.value ? 'default' : 'primary'" @click="cam.isRunning.value ? stopCamera() : startCamera()">
        {{ cam.isRunning.value ? t('scanner.camera.stop') : t('scanner.camera.start') }}
      </NButton>
    </div>

    <div class="gs-camera">
      <video ref="video" autoplay playsinline muted class="gs-video" />
      <ScannerQuadOverlay v-if="cam.isRunning.value && smartEnabled && smartQuad" :quad="smartQuad" :manual="smart.manual.value" @update:quad="onQuadEdit" @drag-start="smart.lockSelection()" />
      <div v-if="!cam.isRunning.value" class="gs-empty">
        <NEmpty :description="t('scanner.camera.idleHint')">
          <template #extra><NButton size="small" type="primary" :loading="busy" @click="startCamera">{{ t('scanner.camera.start') }}</NButton></template>
        </NEmpty>
      </div>
    </div>

    <!-- 动态捕捉：复用扫描插件的智能捕捉 -->
    <div v-if="cam.isRunning.value" class="gs-smart">
      <NButton size="small" :type="smartEnabled ? 'warning' : 'default'" @click="smart.setEnabled(!smartEnabled)">{{ t('scanner.smart.mode') }}</NButton>
      <template v-if="smartEnabled">
        <label class="gs-option"><NSwitch v-model:value="autoCaptureOn" size="small" /><span>{{ t('scanner.smart.auto') }}</span></label>
        <NButton size="small" type="primary" :disabled="!smartQuad" @click="snap">{{ t('scanner.smart.shoot') }}</NButton>
        <NButton v-if="smartQuad" size="small" quaternary type="error" @click="smart.rescan()">{{ t('scanner.smart.resetBox') }}</NButton>
      </template>
      <span v-if="smartEnabled" class="gs-status">{{ smartStatusText }}</span>
    </div>

    <NSpin :show="busy">
      <div v-if="error" class="gs-error">{{ error }}</div>

      <div v-if="active" class="gs-ocr">
        <div class="gs-ocr-head">
          <span>{{ t('grading.ocrResult') }}</span>
          <NTag v-if="active.status" size="tiny" :type="active.status === 'error' ? 'error' : 'info'">{{ t(`grading.${active.status}`) }}</NTag>
        </div>
        <div class="gs-ocr-image"><img :src="active.image" :alt="active.studentName" /></div>
        <textarea class="gs-ocr-text" :value="active.words?.map((w: any) => w.text).join('\n') || ''" readonly :placeholder="t('grading.empty')" />
      </div>

      <div v-if="pages.length === 0 && !active" class="gs-no-scan">{{ t('grading.empty') }}</div>
      <div v-else class="gs-queue" role="list">
        <article v-for="row in pages" :key="row.id" :class="{ selected: active?.id === row.id }">
          <span>{{ row.studentName }}</span>
          <NTag size="tiny">{{ t(`grading.${row.status}`) }}</NTag>
        </article>
      </div>
    </NSpin>
  </aside>
</template>

<style scoped lang="scss">
.grading-scanner { width: 100%; height: 100%; display: flex; flex-direction: column; gap: 10px; overflow: auto; padding: 12px; }
.gs-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gs-camera { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #0d0d10; border-radius: 8px; overflow: hidden; }
.gs-video { width: 100%; height: 100%; object-fit: contain; display: block; }
.gs-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.gs-smart { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gs-option { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-color-2); }
.gs-status { font-size: 12px; color: var(--text-color-2); }
.gs-error { color: #e88080; font-size: 12px; }
.gs-ocr { display: flex; flex-direction: column; gap: 8px; }
.gs-ocr-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.gs-ocr-image { max-height: 240px; overflow: hidden; border-radius: 8px; border: 1px solid #5555; }
.gs-ocr-image img { width: 100%; display: block; }
.gs-ocr-text { width: 100%; min-height: 120px; resize: vertical; border-radius: 8px; border: 1px solid #5555; background: transparent; color: inherit; padding: 10px; font: inherit; }
.gs-no-scan { font-size: 12.5px; color: var(--text-color-2); padding: 12px; border: 1px dashed #5555; border-radius: 8px; text-align: center; }
.gs-queue { display: flex; flex-direction: column; gap: 6px; }
.gs-queue article { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #4444; }
.gs-queue .selected { background: #8882; }
</style>
