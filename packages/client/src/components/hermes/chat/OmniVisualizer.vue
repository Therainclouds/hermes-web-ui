<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Omni-Realtime 视觉核心（月亮/太阳双主题 + 径向柱状声纹版）。
 *
 * 天体本身用预渲染 SVG 素材（public/realtime/celestial-moon.svg /
 * celestial-sun.svg，圆盘半径 150 @ 480 画布），每帧按能量缩放
 * drawImage 进 canvas——矢量素材的月海/环形山/日冕细节远比 canvas
 * 手绘圆细腻。暗主题画月亮、亮主题画太阳，主题跟随 html.dark class
 * （MutationObserver 监听，不引 useTheme 以免测试环境拉起它的模块
 * 副作用）。素材加载失败时回退到 canvas 矢量球。
 *
 * canvas 叠层：
 *  1. 天体（SVG drawImage，单一能量驱动呼吸缩放）
 *  2. 径向柱状声纹 —— 64 根柱均匀分布圆周，低频正下、高频正上镜像
 *     对称；柱身 ink 色，能量柱顶叠一道主题色短光（月亮=紫蓝 accent，
 *     太阳=暖琥珀）。
 *  3. 主题色柔光环（月亮明显、太阳由 SVG 日冕承担只补内圈）。
 */
const props = defineProps<{
  phase: 'idle' | 'connecting' | 'ready' | 'listening' | 'speaking' | 'error' | 'closed'
  /** 麦克风输入电平（0-1），已经过 EMA + RMS blend 平滑。 */
  inputLevel: number
  /** AI 播放输出电平（0-1），已经过 EMA 平滑。 */
  outputLevel: number
  /** 播放分析器（playback AnalyserNode 的 shallowRef），由父组件
   *  注入。visualizer 监听它的变化并 attach 到内部 analyser slot，
   *  让柱状声纹读到真实频谱而不是仅仅平滑电平。 */
  analyser?: AnalyserNode | null
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let analyser: AnalyserNode | null = null
let freqBuf: Uint8Array<ArrayBuffer> | null = null

/** 圆周柱状声纹的柱数——64 根在 360° 里切割密度足够细（每 5.6° 一根，
 *  相邻柱心距在 r≈120px 处约 12px，柱宽 2.4px 时视觉上是连续的密集
 *  均衡器）。fftSize=256 → 128 个 bin，取 75% 频段 max-pool 到 64 柱。 */
const BAR_COUNT = 64
const freqBuckets = new Float32Array(BAR_COUNT)

/** SVG 素材里天体圆盘的半径（画布 480）。drawImage 缩放比 = discR / 此值。 */
const SVG_DISC_RADIUS = 150
const SVG_CANVAS_SIZE = 480

/** 太阳的暖琥珀高光（light 主题专属）——紫蓝 accent 在白底上读不出
 *  "热"，太阳的柱顶光用琥珀色。 */
const SUN_ACCENT_RGB = '232, 152, 34'

let smoothInput = 0
let smoothOutput = 0
// 综合能量"呼吸"——驱动天体缩放 / 柱状透明度。attack 与 release 都慢
// 到听不出逐音节跳变：TTS 每个音节的 RMS 起伏由此被滤成一次平滑呼吸。
let energySmooth = 0

// --- 天体素材（moon/sun 预加载，跨主题切换即时可用） ------------------
const moonImg = new Image()
const sunImg = new Image()
let moonReady = false
let sunReady = false
let moonFailed = false
let sunFailed = false

// --- 主题（html.dark class） -----------------------------------------
const isDarkTheme = ref(
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
)
let themeObserver: MutationObserver | null = null

function smoothLevel(current: number, target: number): number {
  return current + (target - current) * (target > current ? 0.3 : 0.08)
}

function readCSSVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name)
  return v && v.trim() ? v.trim() : fallback
}

function loadCelestial(img: HTMLImageElement, src: string, onReady: () => void, onFail: () => void): void {
  img.onload = onReady
  img.onerror = onFail
  img.src = src
}

/** 素材未加载/加载失败时的兜底矢量球（保留旧版月亮画法，够用即可）。 */
function drawFallbackCore(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, coreR: number,
  inkRGB: string, onInkRGB: string,
): void {
  const bodyGrad = ctx.createRadialGradient(
    cx - coreR * 0.38, cy - coreR * 0.42, coreR * 0.08,
    cx + coreR * 0.10, cy + coreR * 0.14, coreR * 1.04,
  )
  bodyGrad.addColorStop(0, `rgba(${inkRGB}, 0.96)`)
  bodyGrad.addColorStop(0.55, `rgba(${inkRGB}, 0.86)`)
  bodyGrad.addColorStop(1, `rgba(${inkRGB}, 0.52)`)
  ctx.fillStyle = bodyGrad
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = `rgba(${inkRGB}, 0.28)`
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.stroke()
  // 左上柔光
  const hl = ctx.createRadialGradient(
    cx - coreR * 0.35, cy - coreR * 0.4, 0,
    cx - coreR * 0.35, cy - coreR * 0.4, coreR * 0.7,
  )
  hl.addColorStop(0, `rgba(${onInkRGB}, 0.30)`)
  hl.addColorStop(1, `rgba(${onInkRGB}, 0)`)
  ctx.fillStyle = hl
  ctx.beginPath()
  ctx.arc(cx - coreR * 0.35, cy - coreR * 0.4, coreR * 0.7, 0, Math.PI * 2)
  ctx.fill()
}

function draw(): void {
  rafId = requestAnimationFrame(draw)
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const cssWidth = canvas.clientWidth || 560
  const cssHeight = canvas.clientHeight || 560
  const width = Math.round(cssWidth * dpr)
  const height = Math.round(cssHeight * dpr)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // 防御性再平滑——useOmniRealtime 已经做 EMA + RMS blend，这里再
  // 压一下 0.3/0.08 attack/release，保证 raw input 不再进入声纹。
  smoothInput = smoothLevel(smoothInput, props.inputLevel)
  smoothOutput = smoothLevel(smoothOutput, props.outputLevel)
  const rawEnergy = Math.min(1, smoothInput * 0.55 + smoothOutput * 0.75)
  energySmooth += (rawEnergy - energySmooth) * (rawEnergy > energySmooth ? 0.12 : 0.045)
  const energy = Math.pow(energySmooth, 0.8)

  const cx = cssWidth / 2
  const cy = cssHeight / 2
  const unit = Math.min(cssWidth, cssHeight) / 2

  const dark = isDarkTheme.value
  const inkRGB = readCSSVar('--text-primary-rgb', '26, 26, 26')
  const accentRGB = dark
    ? readCSSVar('--accent-primary-rgb', '74, 144, 217')
    : SUN_ACCENT_RGB

  // 读取 analyser 频谱（如果上游尚未 attach，则全 0，声纹自然静止）。
  if (analyser && freqBuf) {
    analyser.getByteFrequencyData(freqBuf)
    const total = freqBuf.length
    const usable = Math.floor(total * 0.75)
    for (let i = 0; i < BAR_COUNT; i += 1) {
      // 镜像映射：柱 0 在正上方，向两侧展开到正下方。低频（人声基频
      // 能量最大）落在正下方两侧，高频在正上方——两侧对称的环形均衡
      // 器读法。|i - BAR_COUNT/2| = 距正下方的柱距。
      const mirrored = i <= BAR_COUNT / 2 ? BAR_COUNT / 2 - i : i - BAR_COUNT / 2
      const t0 = mirrored / (BAR_COUNT / 2)
      const t1 = (mirrored + 1) / (BAR_COUNT / 2)
      const start = Math.floor(t0 * usable)
      const end = Math.max(start + 1, Math.floor(t1 * usable))
      let peak = 0
      for (let k = start; k < end && k < total; k += 1) {
        if (freqBuf[k]! > peak) peak = freqBuf[k]!
      }
      const target = peak / 255
      const prev = freqBuckets[i]!
      freqBuckets[i] = prev + (target - prev) * (target > prev ? 0.6 : 0.15)
    }
  } else {
    for (let i = 0; i < BAR_COUNT; i += 1) {
      freqBuckets[i]! *= 0.9
    }
  }

  // ---- 1) 天体（SVG 素材 / 矢量兜底） ----------------------------
  const discR = unit * (0.20 + energy * 0.045)
  const img = dark ? moonImg : sunImg
  const ready = dark ? moonReady : sunReady
  const failed = dark ? moonFailed : sunFailed
  if (ready && !failed) {
    // SVG 里圆盘半径 150，柔光外溢到画布边缘；按 discR 等比缩放整图，
    // 呼吸时光晕随之缩放。
    const scale = discR / SVG_DISC_RADIUS
    const size = SVG_CANVAS_SIZE * scale
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size)
  } else if (failed) {
    drawFallbackCore(ctx, cx, cy, discR, inkRGB, readCSSVar('--bg-primary-rgb', '250, 250, 250'))
  } // 都不是：素材还在加载，本帧留空，下一帧即有

  // ---- 2) 径向柱状声纹 -------------------------------------------
  const innerRadius = unit * (0.30 + energy * 0.04)
  const gain = unit * 0.15
  const step = (Math.PI * 2) / BAR_COUNT
  const barWidth = 2.4

  for (let i = 0; i < BAR_COUNT; i += 1) {
    const v = freqBuckets[i]!
    if (v < 0.015) continue   // 静音段不画柱——避免一整圈均匀细点的假象
    const angle = -Math.PI / 2 + i * step
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const r0 = innerRadius
    const r1 = innerRadius + Math.max(barWidth, v * gain)
    ctx.beginPath()
    ctx.moveTo(cx + cos * r0, cy + sin * r0)
    ctx.lineTo(cx + cos * r1, cy + sin * r1)
    ctx.strokeStyle = `rgba(${inkRGB}, ${(0.30 + v * 0.65).toFixed(3)})`
    ctx.lineWidth = barWidth
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  // 柱顶柔光层：能量高的柱子补一道主题色短光，读作"发热"的均衡器。
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const v = freqBuckets[i]!
    if (v <= 0.35) continue
    const angle = -Math.PI / 2 + i * step
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const r0 = innerRadius + v * gain * 0.55
    const r1 = innerRadius + v * gain
    ctx.beginPath()
    ctx.moveTo(cx + cos * r0, cy + sin * r0)
    ctx.lineTo(cx + cos * r1, cy + sin * r1)
    ctx.strokeStyle = `rgba(${accentRGB}, ${((v - 0.35) * (dark ? 0.85 : 0.7)).toFixed(3)})`
    ctx.lineWidth = barWidth + 0.6
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  // ---- 3) 内圈柔光环 ----------------------------------------------
  // 月亮：accent 紫蓝外晕（SVG 自带柔光之上再补一层能量光）；
  // 太阳：SVG 日冕已足够，只在能量高时补内圈暖光。
  const haloInner = discR * 1.05
  const haloOuter = innerRadius * 1.02
  if (dark || energy > 0.05) {
    const haloAlpha = (dark ? 0.05 : 0.03) + energy * (dark ? 0.10 : 0.07)
    const halo = ctx.createRadialGradient(cx, cy, haloInner, cx, cy, haloOuter * 1.26)
    halo.addColorStop(0, `rgba(${accentRGB}, ${haloAlpha.toFixed(3)})`)
    halo.addColorStop(0.55, `rgba(${accentRGB}, 0.03)`)
    halo.addColorStop(1, `rgba(${accentRGB}, 0)`)
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(cx, cy, haloOuter * 1.26, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Wire a (possibly-null) AnalyserNode into the visualizer. The parent
 *  passes `analyser` as a prop; the watcher below re-runs this on any
 *  change. Re-allocation of freqBuf is needed only when the underlying
 *  frequencyBinCount changes (which only happens if the parent re-creates
 *  the node — e.g. on a fresh session). */
function attachAnalyser(node: AnalyserNode | null): void {
  analyser = node
  if (node) {
    node.smoothingTimeConstant = 0.6
    if (!freqBuf || freqBuf.length !== node.frequencyBinCount) {
      freqBuf = new Uint8Array(node.frequencyBinCount)
    }
  } else {
    freqBuf = null
    for (let i = 0; i < BAR_COUNT; i += 1) freqBuckets[i] = 0
  }
}

watch(
  () => props.analyser,
  (next) => attachAnalyser(next ?? null),
  { immediate: true },
)

onMounted(() => {
  rafId = requestAnimationFrame(draw)
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { /* draw() 自适应尺寸 */ })
    if (canvasRef.value) resizeObserver.observe(canvasRef.value)
  }
  // 预载两套天体素材：主题切换时无需等待网络/磁盘。
  loadCelestial(moonImg, '/realtime/celestial-moon.svg',
    () => { moonReady = true },
    () => { moonFailed = true })
  loadCelestial(sunImg, '/realtime/celestial-sun.svg',
    () => { sunReady = true },
    () => { sunFailed = true })
  // 主题跟随 html.dark class——useTheme 用 classList.toggle('dark')，
  // MutationObserver 与其天然同步，也不把 useTheme 的模块副作用拉进
  // 测试环境。
  if (typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(() => {
      isDarkTheme.value = document.documentElement.classList.contains('dark')
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
  analyser = null
  freqBuf = null
})
</script>

<template>
  <div class="omni-visualizer" data-testid="omni-visualizer">
    <canvas ref="canvasRef" class="omni-visualizer__canvas" aria-hidden="true" />
  </div>
</template>

<style scoped>
.omni-visualizer {
  position: relative;
  width: min(520px, 58vw, 50vh);
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.omni-visualizer__canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
