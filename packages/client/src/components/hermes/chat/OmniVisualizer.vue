<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Omni-Realtime 视觉核心（黑白水墨 + 紫蓝高光版）。
 *
 * 三层叠加（全部 canvas 绘制）：
 *  1. 中心规整实心圆 —— 单色水墨白（暗主题）/ 黑（亮主题），径向高光
 *     用 accent-primary 紫蓝做单点高光。整体半径由能量缓慢呼吸，**不
 *     抖动**。这是"星体不再扭动"的根本：去掉顶点级起伏，整圆从单点
 *     径向伸缩。
 *  2. 圆周连续声纹 —— 32 段频谱映射到圆周 32 个等分角，每点的径向距
 *     离 = baseRadius * (1 + freq * gain)。相邻点用直线连成连续波形，
 *     顺时针闭合。波形线 1.4px，色调仍是 text-primary，仅透明度随
 *     能量浮动（安静时半透，AI 说话时饱满）。底部对中点小三角的垂线
 *     朝向不旋转——声纹以"音乐环形均衡器"的视觉读法呈现。
 *  3. 顶部柔光高光 —— 实心圆表面的一束斜光，固定在左上 ≈ 30° 方向。
 *     AI 说话时整体 alpha 提升。
 *
 * 颜色完全跟随 --text-primary（mono 黑白水墨） + --accent-primary（紫蓝
 * 高光）—— 老版本的"红/紫/青"独立调色板取消，全部并入主色族，light/dark
 * 主题下都一致。
 */
const props = defineProps<{
  phase: 'idle' | 'connecting' | 'ready' | 'listening' | 'speaking' | 'error' | 'closed'
  /** 麦克风输入电平（0-1），已经过 EMA + RMS blend 平滑。 */
  inputLevel: number
  /** AI 播放输出电平（0-1），已经过 EMA 平滑。 */
  outputLevel: number
  /** 播放分析器（playback AnalyserNode 的 shallowRef），由父组件
   *  注入。visualizer 监听它的变化并 attach 到内部 analyser slot，
   *  让圆周连续声纹读到真实频谱而不是仅仅平滑电平。 */
  analyser?: AnalyserNode | null
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let analyser: AnalyserNode | null = null
let freqBuf: Uint8Array<ArrayBuffer> | null = null

/** Number of waveform segments around the ring — must match the analyser
 *  fftSize (fftSize/2 buckets). 32 is the sweet spot for a perimeter waveform
 *  that reads as a circle from a few meters away while still resolving
 *  vowel/consonant energy differences. */
const WAVEFORM_SEGMENTS = 32
const freqBuckets = new Float32Array(WAVEFORM_SEGMENTS)

let smoothInput = 0
let smoothOutput = 0
// 综合能量"呼吸"——驱动实心圆半径 / 声纹透明度 / 高光。attack 与 release
// 都慢到听不出逐音节跳变：TTS 每个音节的 RMS 起伏由此被滤成一次平滑的
// "呼吸"。这是**唯一**驱动核心形状/位置的信号。
let energySmooth = 0

function smoothLevel(current: number, target: number): number {
  return current + (target - current) * (target > current ? 0.3 : 0.08)
}

function readCSSVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name)
  return v && v.trim() ? v.trim() : fallback
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

  // 60Hz 时间累计——只用于 sin 抖动相位（高光 8% 范围内的极小游走）。
  // 不参与核心形状或声纹驱动。
  const time = (performance.now() ?? Date.now()) / 1000

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

  // 颜色 token：mono 主色 + 紫蓝高光。完全跟随主题。
  const inkRGB = readCSSVar('--text-primary-rgb', '26, 26, 26')         // 实心圆 / 声纹线
  const accentRGB = readCSSVar('--accent-primary-rgb', '74, 144, 217')   // 高光 / 声纹柔光
  const onInkRGB = readCSSVar('--bg-primary-rgb', '250, 250, 250')       // 实心圆内部空腔

  // 读取 analyser 频谱（如果上游尚未 attach，则全 0，声纹自然静止）。
  if (analyser && freqBuf) {
    analyser.getByteFrequencyData(freqBuf)
    // 把 0..fftSize/2 的桶按对数感知重新分布到 WAVEFORM_SEGMENTS 段，
    // 每段取一段桶的最大值——细节感更强。
    const total = freqBuf.length
    for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) {
      // 对数起点 ~ 200Hz，止点 ~ Nyquist；这样元音能量集中在低段，
      // 谐波向高段衰减，符合音乐可视化器的读法。
      const start = Math.floor((i / WAVEFORM_SEGMENTS) * (total * 0.6))
      const end = Math.floor(((i + 1) / WAVEFORM_SEGMENTS) * (total * 0.6))
      let peak = 0
      for (let k = start; k < end && k < total; k += 1) {
        if (freqBuf[k]! > peak) peak = freqBuf[k]!
      }
      // 平滑每段，避免单帧跳变。attack 快、release 慢。
      const target = peak / 255
      const prev = freqBuckets[i]!
      freqBuckets[i] = prev + (target - prev) * (target > prev ? 0.6 : 0.15)
    }
  } else {
    // 没有 analyser 时让声纹自然衰减到 0——不假动。
    for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) {
      freqBuckets[i]! *= 0.9
    }
  }

  // ---- 1) 中心实心圆 ---------------------------------------------
  // 整体半径由单点能量驱动，做一次"呼吸"——圆本身无任何顶点级起伏。
  const coreR = unit * (0.22 + energy * 0.045)
  // 主体 fill：径向渐变（左上微亮，右下进入 onInk 色，让暗主题里有
  // 一束斜光的体积感；亮主题里同样有体积感，只是亮的在 onInk 端）。
  const coreGrad = ctx.createRadialGradient(
    cx - coreR * 0.35, cy - coreR * 0.42, coreR * 0.05,
    cx + coreR * 0.15, cy + coreR * 0.25, coreR * 1.05,
  )
  coreGrad.addColorStop(0, `rgba(${accentRGB}, ${(0.55 + energy * 0.25).toFixed(3)})`)
  coreGrad.addColorStop(0.45, `rgba(${inkRGB}, ${(0.78 + energy * 0.10).toFixed(3)})`)
  coreGrad.addColorStop(1, `rgba(${inkRGB}, ${(0.55 + energy * 0.10).toFixed(3)})`)
  ctx.fillStyle = coreGrad
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.fill()

  // 圆描边：极淡的 1px mono 边，给"剪影"感。
  ctx.strokeStyle = `rgba(${inkRGB}, 0.35)`
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.stroke()

  // 顶部柔光高光：固定在左上方 ≈ 30° 方向的小椭圆白点，给圆加
  // 一束斜光"湿润感"。AI 说话时 alpha 提升。
  const hlR = coreR * 0.45
  const hlOx = cx - Math.cos(Math.PI * 0.6 + Math.sin(time * 0.4) * 0.05) * coreR * 0.42
  const hlOy = cy - Math.sin(Math.PI * 0.6 + Math.sin(time * 0.27) * 0.05) * coreR * 0.42
  const highlight = ctx.createRadialGradient(hlOx, hlOy, 0, hlOx, hlOy, hlR)
  highlight.addColorStop(0, `rgba(${onInkRGB}, ${(0.30 + energy * 0.20).toFixed(3)})`)
  highlight.addColorStop(0.5, `rgba(${onInkRGB}, ${(0.10 + energy * 0.08).toFixed(3)})`)
  highlight.addColorStop(1, `rgba(${onInkRGB}, 0)`)
  ctx.fillStyle = highlight
  ctx.beginPath()
  ctx.arc(hlOx, hlOy, hlR, 0, Math.PI * 2)
  ctx.fill()

  // ---- 2) 圆周连续声纹 -------------------------------------------
  // 32 段频谱映射到圆周 32 个等分角的径向距离。baseRadius 是核心圆外
  // 留出的一圈"呼吸空腔"，让声纹线不和实心圆粘连。
  const baseRadius = unit * (0.32 + energy * 0.05)
  const gain = unit * 0.13
  // 起角：让 0 度指向屏幕正上方（12 点钟），从 12 点顺时针展开 32 段。
  // 这样声纹读起来是"上方 = 第 0 段"，与人声的中频泛音峰值位置
  // （元音共振峰）落在上半圆，符合直觉。
  const startAngle = -Math.PI / 2
  const step = (Math.PI * 2) / WAVEFORM_SEGMENTS

  // 取这一帧的"声纹能量"——给线条整体 alpha 用。安静时线条半透，
  // 说话时饱满。
  let freqMean = 0
  for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) freqMean += freqBuckets[i]!
  freqMean /= WAVEFORM_SEGMENTS
  const lineAlpha = 0.32 + energy * 0.45 + freqMean * 0.18

  // 声纹主线条：先画"环"，再画波形径向偏移。
  ctx.beginPath()
  for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) {
    const angle = startAngle + i * step
    const r = baseRadius + freqBuckets[i]! * gain
    const x = cx + Math.cos(angle) * r
    const y = cy + Math.sin(angle) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = `rgba(${inkRGB}, ${Math.min(0.95, lineAlpha).toFixed(3)})`
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()

  // 声纹柔光层：同一形状，accent 色 0.35 alpha 叠在主线上方，
  // 给线条一层紫蓝高光（安静时几乎不可见，AI 说话时发光）。
  ctx.beginPath()
  for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) {
    const angle = startAngle + i * step
    const r = baseRadius + freqBuckets[i]! * gain
    const x = cx + Math.cos(angle) * r
    const y = cy + Math.sin(angle) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = `rgba(${accentRGB}, ${(0.10 + energy * 0.22 + freqMean * 0.10).toFixed(3)})`
  ctx.lineWidth = 1.4
  ctx.stroke()

  // ---- 3) 声纹端点（32 个小圆点）--------------------------------
  // 给连续波形加颗粒感——每个端点画一个 1.2px 圆点，alpha 跟该段
  // 频谱能量正相关。整体看仍是"环形均衡器"，但连续线条 + 端点颗粒
  // 双重读法。
  ctx.fillStyle = `rgba(${inkRGB}, ${(0.55 + freqMean * 0.25).toFixed(3)})`
  for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) {
    const angle = startAngle + i * step
    const r = baseRadius + freqBuckets[i]! * gain
    const x = cx + Math.cos(angle) * r
    const y = cy + Math.sin(angle) * r
    ctx.beginPath()
    ctx.arc(x, y, 1.2 + freqBuckets[i]! * 0.6, 0, Math.PI * 2)
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
    for (let i = 0; i < WAVEFORM_SEGMENTS; i += 1) freqBuckets[i] = 0
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
})

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  resizeObserver?.disconnect()
  resizeObserver = null
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
