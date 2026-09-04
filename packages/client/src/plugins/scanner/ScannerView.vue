<script setup lang="ts">
/**
 * ScannerView - UVC USB 摄像头扫描 + DashScope Qwen-VL-OCR 识别
 *
 * 布局：
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Header (摄像头开关 / 设备选择 / 拍摄)                    │
 *   ├──────────────────────────┬─────────────────────────────┤
 *   │ 摄像头预览 + 拍摄控制    │ 扫描结果（多页可切换 / 编辑）│
 *   │  · 动态捕捉（纸张检测 /  │  · 原图 + 增强控件 + 矫正裁剪 │
 *   │    选框微调 / 自动拍摄） │  · OCR 文本（可编辑）        │
 *   │  · 普通拍摄              │  · 整批操作（保存 / 导出 PDF）│
 *   └──────────────────────────┴─────────────────────────────┘
 *
 * 视觉引擎：插件自带的 OpenCV.js + jscanify（vendor/），运行时加载。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  NTooltip,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useScannerCamera } from './composables/useScannerCamera'
import { useSmartCapture } from './composables/useSmartCapture'
import ScannerQuadOverlay from './components/ScannerQuadOverlay.vue'
import ScannerEnhanceControls from './components/ScannerEnhanceControls.vue'
import {
  canvasFromImageSource,
  canvasToDataUrl,
  downscaleCanvas,
  enhanceCanvas,
  enhanceDataUrl,
} from './image-io'
import { createDetector, type Detector } from './vision/detector'
import { warpQuad } from './vision/perspective'
import {
  ENHANCE_DEFAULTS,
  type EnhanceParams,
  type EnhancePreset,
  type Quad,
  type WarpAspect,
} from './vision/types'
import {
  exportScannerPdf,
  runScannerOcr,
  saveScannerDocument,
  type ScannerOcrResponse,
  type ScannerSaveResponse,
} from './api'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { useMessage as useAppMessage } from '@/composables/useAppMessage'

interface ScannerPage {
  /** 唯一 id，用作 key */
  id: string
  /** 底图（矫正后的 raw / 原始拍摄），增强从此派生 */
  originalImage: string
  /** 当前显示的图（original + enhance） */
  image: string
  width: number
  height: number
  /** OCR 文本（用户可继续编辑） */
  text: string
  /** OCR 状态 */
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  /** 当前增强参数 */
  enhance: EnhanceParams
  /** image 实际已应用的增强参数（避免重复重算 / 二次编码） */
  applied: EnhanceParams
}

const { t } = useI18n()
const message = useAppMessage()
const realtimeModelStore = useRealtimeModelStore()

/**
 * 把 vue-i18n 的 `t()` 包一层，强制返回 string。
 */
const tt = ((key: string, ...args: unknown[]) => {
  const value = (t as unknown as (k: string, ...a: unknown[]) => unknown)(key, ...args)
  return typeof value === 'string' ? value : String(key)
}) as (key: string, ...args: unknown[]) => string

const cam = useScannerCamera()
const videoEl = ref<HTMLVideoElement | null>(null)

const devices = ref<MediaDeviceInfo[]>([])
const selectedDeviceId = ref<string | null>(null)

const language = ref<string>('auto')
const languageOptions = [
  { label: 'Auto', value: 'auto' },
  { label: '中文 (zh)', value: 'zh' },
  { label: 'English (en)', value: 'en' },
  { label: '日本語 (ja)', value: 'ja' },
  { label: '中英混合 (zh+en)', value: 'zh+en' },
]

const pages = ref<ScannerPage[]>([])
const activePageId = ref<string | null>(null)
const ocrAllLoading = ref(false)
const ocrOneLoading = ref(false)
const saveLoading = ref(false)
const pdfLoading = ref(false)
const correcting = ref(false)

/** Realtime 模型里配置的 DashScope key = Scanner 唯一入口。 */
const keyChecked = ref(false)
const dashscopeReady = computed(() => realtimeModelStore.hasApiKey)
const dashscopeMissing = computed(() => keyChecked.value && !dashscopeReady.value)

const cameraRunning = computed(() => cam.isRunning.value)
const cameraStarting = computed(() => cam.isStarting.value)
const cameraErrorCode = computed(() => cam.error.value)

/* ------------------------------------------------------------------ *
 * 智能捕捉（动态捕捉）
 * ------------------------------------------------------------------ */
const capturePreset = ref<EnhancePreset>('auto')
const capturePresetOptions = [
  { label: tt('scanner.enhance.presetNone'), value: 'none' },
  { label: tt('scanner.enhance.presetAuto'), value: 'auto' },
  { label: tt('scanner.enhance.presetGray'), value: 'gray' },
  { label: tt('scanner.enhance.presetBw'), value: 'bw' },
]
const aspect = ref<WarpAspect>('auto')
const aspectOptions = [
  { label: tt('scanner.smart.aspectAuto'), value: 'auto' },
  { label: tt('scanner.smart.aspectA4'), value: 'a4' },
  { label: tt('scanner.smart.aspectA4Landscape'), value: 'a4-landscape' },
]

const smart = useSmartCapture({
  video: () => videoEl.value,
  cameraRunning: () => cameraRunning.value,
  onAutoCapture: onSmartAutoCapture,
  aspectRatio: null,
})

const smartEnabled = computed(() => smart.enabled.value)
const smartQuad = computed(() => smart.quad.value)
const smartManual = computed(() => smart.manual.value)
const smartStatus = computed(() => smart.status.value)
const autoCaptureOn = computed({
  get: () => smart.autoCapture.value,
  set: (v: boolean) => smart.setAutoCapture(v),
})
/** AI 识别开关（默认关闭，仅用经典识别；点开才启用 AI 兜底）。 */
const aiEnabled = computed({
  get: () => smart.aiEnabled.value,
  set: (v: boolean) => { smart.aiEnabled.value = v },
})

watch(aspect, (v) => {
  smart.setAspectRatio(v === 'auto' ? null : aspectRatioValue(v))
})

function aspectRatioValue(v: Exclude<WarpAspect, 'auto'>): number {
  if (v === 'a4') return 1 / Math.sqrt(2)
  return Math.sqrt(2)
}

const smartStatusText = computed(() => {
  switch (smartStatus.value) {
    case 'off': return tt('scanner.smart.off')
    case 'loading': return tt('scanner.smart.loading')
    case 'unavailable': return tt('scanner.smart.unavailable')
    case 'searching': return tt('scanner.smart.searching')
    case 'detected': return tt('scanner.smart.detected')
    case 'capturing': return tt('scanner.smart.capturing')
    case 'cooling': return tt('scanner.smart.cooling')
    default: return tt('scanner.smart.off')
  }
})
const smartStatusTone = computed<'default' | 'info' | 'success' | 'error'>(() => {
  switch (smartStatus.value) {
    case 'unavailable': return 'error'
    case 'detected':
    case 'capturing': return 'success'
    case 'loading':
    case 'searching': return 'info'
    default: return 'default'
  }
})

const smartEngineError = computed(() => smart.engineError.value)

watch(smartStatus, (next) => {
  if (next === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn('[scanner] 检测器不可用：', smartEngineError.value || '(无详细原因)')
  }
})

async function toggleSmart() {
  if (smartEnabled.value) {
    await smart.setEnabled(false)
  } else {
    await smart.setEnabled(true)
  }
}

/** ML pipeline 加载状态（worker 镜像回主线程）。 */
const mlStatus = smart.mlStatus
const mlStatusText = computed(() => {
  switch (mlStatus.value.state) {
    case 'off': return ''
    case 'loading': return tt('scanner.smart.mlLoading')
    case 'ready': return tt('scanner.smart.mlReady')
    case 'failed': return tt('scanner.smart.mlFailed')
    default: return ''
  }
})
const mlStatusTone = computed<'default' | 'info' | 'success' | 'error'>(() => {
  switch (mlStatus.value.state) {
    case 'loading': return 'info'
    case 'ready': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
})

function onQuadEdit(next: Quad) {
  smart.setQuadManually(next)
}

function pushCorrectedPage(canvas: HTMLCanvasElement) {
  const original = canvasToDataUrl(canvas, 0.92)
  const enhance = ENHANCE_DEFAULTS[capturePreset.value]
  const image = enhance.preset === 'none'
    ? original
    : canvasToDataUrl(enhanceCanvas(canvas, enhance), 0.92)
  pushPage(original, image, canvas.width, canvas.height, enhance)
}

async function onSmartAutoCapture(payload: { canvas: HTMLCanvasElement; quad: Quad; ms: number }) {
  try {
    pushCorrectedPage(payload.canvas)
    smart.markCaptured(payload.quad)
    message.success(tt('scanner.smart.captured', { n: smart.autoCount.value }))
  } catch {
    smart.markCaptured(payload.quad)
    message.error(tt('scanner.smart.shootFailed'))
  }
}

async function smartShoot() {
  const shot = await smart.captureNow()
  if (!shot) {
    message.warning(tt('scanner.smart.noDoc'))
    return
  }
  try {
    const enhance = ENHANCE_DEFAULTS[capturePreset.value]
    const image = enhance.preset === 'none'
      ? shot.dataUrl
      : (await enhanceDataUrl(shot.dataUrl, enhance)) || shot.dataUrl
    pushPage(shot.dataUrl, image, shot.width, shot.height, enhance)
  } catch {
    message.error(tt('scanner.smart.shootFailed'))
  }
}

/** 清除当前选框/手动锁定并重新搜索（「重置选框」按钮）。 */
function smartRescan() {
  smart.rescan()
}

/* ------------------------------------------------------------------ *
 * 摄像头基础操作
 * ------------------------------------------------------------------ */
function pushPage(original: string, image: string, width: number, height: number, enhance: EnhanceParams) {
  const page: ScannerPage = {
    id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    originalImage: original,
    image,
    width,
    height,
    text: '',
    status: 'pending',
    enhance,
    applied: { ...enhance },
  }
  pages.value.push(page)
  activePageId.value = page.id
}
async function refreshVideoInputs() {
  devices.value = await cam.listVideoInputs()
  if (devices.value.length === 0) return
  if (!selectedDeviceId.value) {
    selectedDeviceId.value = devices.value[0]?.deviceId ?? null
  }
}

async function startCamera() {
  await cam.start({ deviceId: selectedDeviceId.value || undefined })
  if (cam.error.value) {
    message.error(tt(`scanner.camera.${cameraErrorCode.value}` as any))
  } else {
    await refreshVideoInputs()
  }
}

function stopCamera() {
  cam.stop()
}

async function switchCamera(deviceId: string | null) {
  selectedDeviceId.value = deviceId
  if (cam.isRunning.value) {
    await cam.start({ deviceId: deviceId || undefined })
  }
}

async function capture() {
  const shot = await cam.snapshot()
  if (!shot) {
    message.warning(tt('scanner.capture.empty'))
    return
  }
  pushPage(
    shot.dataUrl,
    shot.dataUrl,
    shot.width,
    shot.height,
    { ...ENHANCE_DEFAULTS.none },
  )
}

async function deletePage(id: string) {
  pages.value = pages.value.filter(p => p.id !== id)
  if (activePageId.value === id) activePageId.value = pages.value[0]?.id ?? null
}

function clearAll() {
  pages.value = []
  activePageId.value = null
}

const activePage = computed(() => pages.value.find(p => p.id === activePageId.value) || null)

/* ------------------------------------------------------------------ *
 * 页面增强 / 矫正
 * ------------------------------------------------------------------ */
let enhanceDebounce = 0

function sameEnhance(a: EnhanceParams, b: EnhanceParams): boolean {
  return a.preset === b.preset
    && a.contrast === b.contrast
    && a.brightness === b.brightness
    && a.sharpen === b.sharpen
}

async function recomputePageImage(page: ScannerPage) {
  const params = { ...page.enhance }
  const url = await enhanceDataUrl(page.originalImage, params)
  if (!url || !pages.value.some(p => p.id === page.id)) return
  if (!sameEnhance(page.enhance, params)) {
    // 计算期间参数又被改过：按最新参数再算一次
    scheduleEnhance()
    return
  }
  page.image = url
  page.applied = params
}

function scheduleEnhance() {
  const page = activePage.value
  if (!page || sameEnhance(page.applied, page.enhance)) return
  window.clearTimeout(enhanceDebounce)
  enhanceDebounce = window.setTimeout(() => {
    void recomputePageImage(page)
  }, 220)
}

watch(
  () => activePage.value?.enhance,
  () => {
    scheduleEnhance()
  },
  { deep: true },
)

function onEnhanceParams(params: EnhanceParams) {
  const page = activePage.value
  if (!page) return
  page.enhance = { ...params }
}

function resetEnhance() {
  const page = activePage.value
  if (!page) return
  page.enhance = { ...ENHANCE_DEFAULTS.none }
}

/** 对当前页原图做「自动矫正裁剪」（重新检测纸张边缘 + 透视拉伸）。 */
async function correctActivePage() {
  const page = activePage.value
  if (!page) {
    message.warning(tt('scanner.enhance.none'))
    return
  }
  if (correcting.value) return
  correcting.value = true
  let detectorHandle: Detector | null = null
  try {
    const fullCanvas = await canvasFromImageSource(page.originalImage, 2600)
    if (!fullCanvas) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    const detectCanvas = downscaleCanvas(fullCanvas, 900)
    const ctx = detectCanvas.getContext('2d')
    if (!ctx) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    const img = ctx.getImageData(0, 0, detectCanvas.width, detectCanvas.height)
    const rgba = new Uint8ClampedArray(img.data)
    detectorHandle = createDetector()
    const detect = await detectorHandle.detect(
      { width: detectCanvas.width, height: detectCanvas.height, data: rgba },
      { minAreaRatio: 0.05 },
    )
    if (!detect) {
      message.warning(tt('scanner.enhance.correctFail'))
      return
    }
    const cornersPx: [import('./vision/types').Pt, import('./vision/types').Pt, import('./vision/types').Pt, import('./vision/types').Pt] = [
      { x: detect.quad[0].x * fullCanvas.width, y: detect.quad[0].y * fullCanvas.height },
      { x: detect.quad[1].x * fullCanvas.width, y: detect.quad[1].y * fullCanvas.height },
      { x: detect.quad[2].x * fullCanvas.width, y: detect.quad[2].y * fullCanvas.height },
      { x: detect.quad[3].x * fullCanvas.width, y: detect.quad[3].y * fullCanvas.height },
    ]
    const fullCtx = fullCanvas.getContext('2d')
    if (!fullCtx) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    const fullImg = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height)
    const warped = warpQuad(
      { width: fullCanvas.width, height: fullCanvas.height, data: new Uint8ClampedArray(fullImg.data) },
      cornersPx,
      { maxEdge: 2200 },
    )
    const out = document.createElement('canvas')
    out.width = warped.width
    out.height = warped.height
    const outCtx = out.getContext('2d')
    if (!outCtx) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    outCtx.putImageData(new ImageData(new Uint8ClampedArray(warped.data), warped.width, warped.height), 0, 0)
    page.originalImage = canvasToDataUrl(out, 0.92)
    page.width = out.width
    page.height = out.height
    await recomputePageImage(page)
  } catch {
    message.error(tt('scanner.enhance.correctFail'))
  } finally {
    detectorHandle?.terminate()
    correcting.value = false
  }
}

/* ------------------------------------------------------------------ *
 * OCR / 保存 / PDF
 * ------------------------------------------------------------------ */
async function recognizeActivePage() {
  const page = activePage.value
  if (!page) return
  ocrOneLoading.value = true
  page.status = 'running'
  page.error = ''
  try {
    const response: ScannerOcrResponse = await runScannerOcr({
      pages: [{ image: page.image }],
      language: language.value,
    })
    const first = response.pages[0]
    page.text = first?.text || ''
    page.status = 'done'
    if (!first?.hasContent) {
      message.warning(tt('scanner.ocr.empty'))
    }
  } catch (err: any) {
    page.status = 'error'
    page.error = err?.message || tt('scanner.ocr.failed')
    message.error(page.error || tt('scanner.ocr.failed'))
  } finally {
    ocrOneLoading.value = false
  }
}

async function recognizeAll() {
  if (pages.value.length === 0) {
    message.warning(tt('scanner.pages.empty'))
    return
  }
  ocrAllLoading.value = true
  try {
    const pending = pages.value.filter(p => p.status !== 'done')
    if (pending.length === 0) {
      message.info(tt('scanner.ocr.allDone'))
      return
    }
    const response = await runScannerOcr({
      pages: pending.map(p => ({ image: p.image })),
      language: language.value,
    })
    for (const [index, page] of pending.entries()) {
      const result = response.pages[index]
      page.text = result?.text || ''
      page.status = 'done'
    }
    message.success(tt('scanner.ocr.batchDone', { count: pending.length }))
  } catch (err: any) {
    const msg = err?.message || tt('scanner.ocr.failed')
    for (const page of pages.value) {
      if (page.status === 'running') {
        page.status = 'error'
        page.error = msg
      }
    }
    message.error(msg)
  } finally {
    ocrAllLoading.value = false
  }
}

async function saveToWorkspace() {
  if (pages.value.length === 0) {
    message.warning(tt('scanner.pages.empty'))
    return
  }
  saveLoading.value = true
  try {
    const response: ScannerSaveResponse = await saveScannerDocument({
      pages: pages.value.map(p => ({ image: p.image, text: p.text })),
      title: tt('scanner.save.defaultTitle'),
    })
    message.success(tt('scanner.save.success', { dir: response.directory }))
  } catch (err: any) {
    message.error(err?.message || tt('scanner.save.failed'))
  } finally {
    saveLoading.value = false
  }
}

async function exportPdf() {
  if (pages.value.length === 0) {
    message.warning(tt('scanner.pages.empty'))
    return
  }
  pdfLoading.value = true
  let url: string | null = null
  try {
    const result = await exportScannerPdf(pages.value.map(p => ({ image: p.image })))
    url = result.url
    const link = document.createElement('a')
    link.href = result.url
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    message.success(tt('scanner.pdf.success', { filename: result.filename }))
  } catch (err: any) {
    message.error(err?.message || tt('scanner.pdf.failed'))
  } finally {
    pdfLoading.value = false
    if (url) {
      setTimeout(() => URL.revokeObjectURL(url!), 5000)
    }
  }
}

async function ensureKeyLoaded() {
  await realtimeModelStore.loadFromServer().catch(() => undefined)
  keyChecked.value = true
}

onMounted(async () => {
  await nextTick()
  if (videoEl.value) cam.bindVideo(videoEl.value)
  await refreshVideoInputs()
  void ensureKeyLoaded()
})

onBeforeUnmount(() => {
  stopCamera()
})

watch(videoEl, (el) => {
  cam.bindVideo(el)
})

/** 摄像头开启后把预览框比例切换为视频比例，保证选框与画面一一对应。 */
const videoMetaTick = ref(0)

const frameStyle = computed(() => {
  const v = videoEl.value
  const vw = cameraRunning.value ? v?.videoWidth || 0 : 0
  const vh = cameraRunning.value ? v?.videoHeight || 0 : 0
  if (vw > 0 && vh > 0) {
    // 依赖 videoMetaTick：元数据/流变化后重新计算比例
    void videoMetaTick.value
    return { aspectRatio: `${vw} / ${vh}` }
  }
  return undefined
})

// videoWidth/Height 是非响应式属性：元数据就绪/流切换时用 tick 触发重算
function onVideoMetadata() {
  videoMetaTick.value += 1
}

const deviceOptions = computed(() => devices.value.map((d, idx) => ({
  label: d.label || `${tt('scanner.camera.deviceFallback')} ${idx + 1}`,
  value: d.deviceId,
})))

const cameraHint = computed(() => {
  if (cameraErrorCode.value) return tt(`scanner.camera.${cameraErrorCode.value}` as any)
  if (cameraRunning.value) return tt('scanner.camera.live')
  return tt('scanner.camera.idle')
})

const cameraHintTone = computed(() => {
  if (cameraErrorCode.value) return 'error'
  if (cameraRunning.value) return 'success'
  return 'info'
})
</script>

<template>
  <div class="scanner-view">
    <header class="page-header">
      <div class="header-title-block">
        <div class="title-row">
          <h2 class="header-title">{{ tt('scanner.page.title') }}</h2>
          <NTag round size="small" :type="cameraHintTone">
            {{ cameraHint }}
          </NTag>
          <NTag v-if="smartEnabled" round size="small" :type="smartStatusTone">
            {{ smartStatusText }}
          </NTag>
        </div>
        <span class="header-subtitle">{{ tt('scanner.page.subtitle') }}</span>
      </div>
      <div class="header-actions">
        <NSelect
          v-if="deviceOptions.length > 0"
          v-model:value="selectedDeviceId"
          :options="deviceOptions"
          size="small"
          :disabled="cameraStarting"
          :placeholder="tt('scanner.camera.selectDevice')"
          style="width: 200px;"
          @update:value="switchCamera"
        />
        <NButton
          size="small"
          :type="cameraRunning ? 'default' : 'primary'"
          :loading="cameraStarting"
          @click="cameraRunning ? stopCamera() : startCamera()"
        >
          {{ cameraRunning ? tt('scanner.camera.stop') : tt('scanner.camera.start') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!cameraRunning"
          @click="capture"
        >
          {{ tt('scanner.capture.snapshot') }}
        </NButton>
      </div>
    </header>

    <div class="scanner-content">
      <div class="scanner-left">
        <section class="camera-stage">
          <div class="camera-frame" :style="frameStyle">
            <video
              ref="videoEl"
              autoplay
              playsinline
              muted
              class="camera-video"
              @loadedmetadata="onVideoMetadata"
            />
            <ScannerQuadOverlay
              v-if="cameraRunning && smartEnabled && smartQuad"
              :quad="smartQuad"
              :manual="smartManual"
              @update:quad="onQuadEdit"
            />
            <div v-if="!cameraRunning" class="camera-empty">
              <NEmpty :description="tt('scanner.camera.idleHint')">
                <template #extra>
                  <NButton size="small" type="primary" :loading="cameraStarting" @click="startCamera">
                    {{ tt('scanner.camera.start') }}
                  </NButton>
                </template>
              </NEmpty>
            </div>
          </div>

          <div class="camera-toolbar">
            <span class="camera-toolbar-label">{{ tt('scanner.camera.languageLabel') }}</span>
            <NSelect
              v-model:value="language"
              :options="languageOptions"
              size="small"
              style="width: 160px;"
            />
            <NTooltip>
              <template #trigger>
                <NButton
                  size="small"
                  type="primary"
                  :loading="ocrAllLoading"
                  :disabled="pages.length === 0"
                  @click="recognizeAll"
                >
                  {{ tt('scanner.ocr.recognizeAll') }}
                </NButton>
              </template>
              {{ tt('scanner.ocr.recognizeAllHint') }}
            </NTooltip>
          </div>

          <!-- 动态捕捉控制条 -->
          <div v-if="cameraRunning" class="smart-toolbar">
            <NTooltip>
              <template #trigger>
                <NButton
                  size="small"
                  :type="smartEnabled ? 'warning' : 'default'"
                  @click="toggleSmart"
                >
                  {{ tt('scanner.smart.mode') }}
                </NButton>
              </template>
              {{ tt('scanner.smart.modeHint') }}
            </NTooltip>

            <span
              v-if="aiEnabled && smartEnabled && mlStatus.state !== 'off' && mlStatus.state !== 'ready'"
              class="smart-live"
              :class="`tone-${mlStatusTone}`"
              :title="mlStatus.error ?? ''"
            >
              {{ mlStatusText }}
            </span>

            <template v-if="smartEnabled">
              <label class="smart-option smart-ai" :title="tt('scanner.smart.aiHint')">
                <NSwitch v-model:value="aiEnabled" size="small" />
                <span>{{ tt('scanner.smart.aiLabel') }}</span>
              </label>
              <label class="smart-option smart-auto">
                <NSwitch v-model:value="autoCaptureOn" size="small" />
                <span>{{ tt('scanner.smart.auto') }}</span>
              </label>
              <span class="smart-option smart-preset">
                <span class="smart-option-label">{{ tt('scanner.smart.preset') }}</span>
                <NSelect
                  v-model:value="capturePreset"
                  :options="capturePresetOptions"
                  size="small"
                  style="width: 108px;"
                />
              </span>
              <span class="smart-option smart-aspect">
                <span class="smart-option-label">{{ tt('scanner.smart.aspect') }}</span>
                <NSelect
                  v-model:value="aspect"
                  :options="aspectOptions"
                  size="small"
                  style="width: 116px;"
                />
              </span>
              <NTooltip>
                <template #trigger>
                  <NButton
                    size="small"
                    type="primary"
                    :disabled="!smartQuad"
                    @click="smartShoot"
                  >
                    {{ tt('scanner.smart.shoot') }}
                  </NButton>
                </template>
                {{ tt('scanner.smart.shootHint') }}
              </NTooltip>
              <NButton
                v-if="smartQuad"
                size="small"
                quaternary
                type="error"
                @click="smartRescan"
              >
                {{ tt('scanner.smart.resetBox') }}
              </NButton>
              <span
                v-if="smartStatus === 'searching' || smartStatus === 'detected'"
                class="smart-live"
                :class="`tone-${smartStatusTone}`"
              >
                {{ smartStatusText }}
              </span>
            </template>

            <NAlert
              v-if="smartStatus === 'unavailable'"
              type="error"
              size="small"
              :show-icon="false"
              class="smart-unavailable"
            >
              {{ tt('scanner.smart.unavailable') }}
            </NAlert>
          </div>
        </section>

        <section class="page-strip">
          <div class="page-strip-header">
            <span class="page-strip-title">{{ tt('scanner.pages.title') }}</span>
            <span class="page-strip-count">{{ pages.length }}</span>
            <NButton
              v-if="pages.length > 0"
              size="tiny"
              quaternary
              type="error"
              @click="clearAll"
            >
              {{ tt('scanner.pages.clearAll') }}
            </NButton>
          </div>
          <div v-if="pages.length === 0" class="page-strip-empty">
            {{ tt('scanner.pages.emptyHint') }}
          </div>
          <div v-else class="page-strip-list">
            <button
              v-for="(page, idx) in pages"
              :key="page.id"
              type="button"
              class="page-thumb"
              :class="{ 'is-active': page.id === activePageId }"
              @click="activePageId = page.id"
            >
              <img :src="page.image" :alt="`page-${idx + 1}`" />
              <span class="page-thumb-index">{{ idx + 1 }}</span>
              <NTag
                v-if="page.status === 'done'"
                size="tiny"
                type="success"
                class="page-thumb-tag"
                round
              >
                {{ tt('scanner.pages.statusDone') }}
              </NTag>
              <NTag
                v-else-if="page.status === 'running'"
                size="tiny"
                type="info"
                class="page-thumb-tag"
                round
              >
                {{ tt('scanner.pages.statusRunning') }}
              </NTag>
              <NTag
                v-else-if="page.status === 'error'"
                size="tiny"
                type="error"
                class="page-thumb-tag"
                round
              >
                {{ tt('scanner.pages.statusError') }}
              </NTag>
              <span
                class="page-thumb-delete"
                role="button"
                tabindex="0"
                :title="tt('scanner.pages.delete')"
                @click.stop="deletePage(page.id)"
                @keydown.enter.stop.prevent="deletePage(page.id)"
              >
                ×
              </span>
            </button>
          </div>
        </section>
      </div>

      <div class="scanner-right">
        <NSpin :show="ocrOneLoading || correcting">
          <div v-if="!activePage" class="scanner-right-empty">
            <NEmpty :description="tt('scanner.detail.emptyHint')" />
          </div>
          <div v-else class="scanner-detail">
            <div class="scanner-detail-image">
              <img :src="activePage.image" :alt="activePage.id" />
            </div>
            <ScannerEnhanceControls
              :params="activePage.enhance"
              :correcting="correcting"
              @update:params="onEnhanceParams"
              @correct="correctActivePage"
              @reset="resetEnhance"
            />
            <div class="scanner-detail-text">
              <div class="scanner-detail-toolbar">
                <span class="scanner-detail-title">{{ tt('scanner.detail.textTitle') }}</span>
                <NButton
                  size="tiny"
                  type="primary"
                  :loading="ocrOneLoading"
                  @click="recognizeActivePage"
                >
                  {{ activePage.text ? tt('scanner.detail.recognizeAgain') : tt('scanner.detail.recognize') }}
                </NButton>
              </div>
              <NAlert
                v-if="activePage.status === 'error' && activePage.error"
                type="error"
                size="small"
                :show-icon="false"
                class="scanner-detail-error"
              >
                {{ activePage.error }}
              </NAlert>
              <NInput
                v-model:value="activePage.text"
                type="textarea"
                :autosize="{ minRows: 8, maxRows: 20 }"
                :placeholder="tt('scanner.detail.placeholder')"
              />
              <div class="scanner-detail-meta">
                {{ tt('scanner.detail.size', {
                  width: activePage.width,
                  height: activePage.height,
                  chars: activePage.text.length,
                }) }}
              </div>
            </div>
          </div>
        </NSpin>

        <footer v-if="pages.length > 0" class="scanner-actions">
          <NButton :loading="saveLoading" @click="saveToWorkspace">
            {{ tt('scanner.save.action') }}
          </NButton>
          <NButton :loading="pdfLoading" type="primary" @click="exportPdf">
            {{ tt('scanner.pdf.action') }}
          </NButton>
        </footer>

        <NAlert
          v-if="dashscopeMissing"
          type="warning"
          size="small"
          :show-icon="false"
          class="scanner-warn"
        >
          {{ tt('scanner.apiKey.warn') }}
        </NAlert>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.scanner-view {
  display: flex;
  flex-direction: column;
  height: calc(100 * var(--vh));
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid $border-light;
}

.header-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.header-subtitle {
  font-size: 12px;
  color: $text-muted;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.scanner-content {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 16px;
  padding: 16px 20px 20px;
  overflow: hidden;
}

.scanner-left,
.scanner-right {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.camera-stage {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--bg-secondary);
  padding: 12px;
}

.camera-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #0d0d10;
  border-radius: $radius-sm;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: aspect-ratio 160ms ease;
}

.camera-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #0d0d10;
  display: block;
}

.camera-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.camera-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.camera-toolbar-label {
  font-size: 12.5px;
  color: $text-muted;
}

/* 动态捕捉控制条 */
.smart-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed $border-light;
  border-radius: $radius-sm;
  background: var(--bg-elevated);
}

.smart-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-muted;
}

.smart-option-label {
  white-space: nowrap;
}

.smart-live {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-secondary);

  &.tone-success { color: var(--color-success, #18a058); }
  &.tone-info { color: var(--color-info, #2080f0); }
  &.tone-error { color: var(--color-error, #d03050); }
}

.smart-unavailable {
  width: 100%;
  font-size: 12px;
}

.page-strip {
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--bg-secondary);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.page-strip-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-strip-title {
  font-size: 13px;
  font-weight: 600;
}

.page-strip-count {
  font-size: 12px;
  color: $text-muted;
  padding: 0 6px;
  background: var(--bg-elevated);
  border-radius: 999px;
}

.page-strip-empty {
  font-size: 12.5px;
  color: $text-muted;
  padding: 12px;
  border: 1px dashed $border-light;
  border-radius: $radius-sm;
  text-align: center;
}

.page-strip-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
  overflow-y: auto;
}

.page-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--bg-elevated);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 120ms ease, transform 120ms ease;

  &:hover {
    border-color: var(--accent-info);
  }

  &.is-active {
    border-color: var(--accent-info);
    box-shadow: 0 0 0 2px rgba(var(--accent-info-rgb), 0.25);
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
}

.page-thumb-index {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
}

.page-thumb-tag {
  position: absolute;
  right: 4px;
  top: 4px;
}

.page-thumb-delete {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border: 0;
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  display: none;
  text-align: center;
  user-select: none;
}

.page-thumb:hover .page-thumb-delete {
  display: block;
}

.scanner-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--bg-secondary);
  padding: 12px;
  min-height: 0;
  overflow-y: auto;
}

.scanner-detail-image {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
  border-radius: $radius-sm;
  overflow: hidden;
  min-height: 180px;
  max-height: 46vh;

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
}

.scanner-detail-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.scanner-detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.scanner-detail-title {
  font-size: 13px;
  font-weight: 600;
}

.scanner-detail-error {
  font-size: 12px;
}

.scanner-detail-meta {
  font-size: 11.5px;
  color: $text-muted;
}

.scanner-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  flex-shrink: 0;
}

.scanner-warn {
  font-size: 12px;
  flex-shrink: 0;
}

.scanner-right-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed $border-light;
  border-radius: $radius-md;
}

@media (max-width: $breakpoint-mobile) {
  .scanner-content {
    grid-template-columns: 1fr;
  }
}
</style>
