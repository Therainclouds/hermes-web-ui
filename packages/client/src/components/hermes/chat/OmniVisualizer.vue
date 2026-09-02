<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Omni-Realtime 视觉核心（月亮 + 高密度径向柱状声纹版）。
 *
 * 三层叠加（全部 canvas 绘制）：
 *  1. 月亮本体 —— 实心圆用"左上受光"的亮度渐变：受光面接近纯 ink，
 *     暗侧边缘渐弱（terminator），加几块固定位置的 onInk 色月海斑
 *     （低 alpha 椭圆），整体读作一轮水墨月亮。**没有任何深色中心
 *     阴影**——旧版把 accent 高光画在圆心，暗主题下读成一团黑斑，
 *     用户反馈"不像月亮"。accent 紫蓝只留作球体外的柔光环。
 *  2. 径向柱状声纹 —— 64 根柱子均匀分布在圆周，每根柱子从内圈半径
 *     沿径向向外伸出，长度 = 该段频谱能量。频谱做了左右镜像（低频
 *     在正下方、高频在正上方，两侧对称），读起来像环形均衡器。
 *  3. 柔光环 —— 月亮外一圈 accent 低 alpha 光晕，AI 说话时微微增亮。
 *
 * 颜色完全跟随 --text-primary（mono 水墨） + --accent-primary（紫蓝
 * 高光），light/dark 主题下都一致。
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

let smoothInput = 0
let smoothOutput = 0
// 综合能量"呼吸"——驱动月亮半径 / 柱状透明度 / 光环。attack 与 release
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

/** 固定伪随机（确定性），用于月海斑的位置——不能每帧抖动。 */
function craterSpec(i: number): { dx: number; dy: number; r: number; a: number } {
  const specs = [
    { dx: -0.32, dy: -0.18, r: 0.30, a: 0.16 },
    { dx: 0.22, dy: 0.10, r: 0.22, a: 0.13 },
    { dx: -0.05, dy: 0.38, r: 0.17, a: 0.11 },
    { dx: 0.38, dy: -0.30, r: 0.13, a: 0.10 },
    { dx: -0.42, dy: 0.22, r: 0.11, a: 0.09 },
  ]
  return specs[i % specs.length]!
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

  // 颜色 token：mono 主色 + 紫蓝高光。完全跟随主题。
  const inkRGB = readCSSVar('--text-primary-rgb', '26, 26, 26')         // 月亮 / 声纹柱
  const accentRGB = readCSSVar('--accent-primary-rgb', '74, 144, 217')  // 柔光环
  const onInkRGB = readCSSVar('--bg-primary-rgb', '250, 250, 250')      // 月海斑 / 高光

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
      // 平滑每根柱，避免单帧跳变。attack 快、release 慢。
      const target = peak / 255
      const prev = freqBuckets[i]!
      freqBuckets[i] = prev + (target - prev) * (target > prev ? 0.6 : 0.15)
    }
  } else {
    // 没有 analyser 时让声纹自然衰减到 0——不假动。
    for (let i = 0; i < BAR_COUNT; i += 1) {
      freqBuckets[i]! *= 0.9
    }
  }

  // ---- 1) 月亮本体 ------------------------------------------------
  // 整体半径由单点能量驱动，做一次"呼吸"——圆本身无任何顶点级起伏。
  const coreR = unit * (0.20 + energy * 0.04)
  // 受光面在左上：受光处接近纯 ink，向右下边缘（terminator）渐弱。
  // 全程都是 ink 色系——**圆心不再画 accent 高光**，暗主题下不会再
  // 出现"中间一团黑影"。accent 只留到最外圈柔光。
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

  // 月海斑：固定位置的低 alpha onInk 椭圆。暗主题下是白月亮上的暗斑，
  // 亮主题下是黑月亮上的亮斑——两种主题都符合"月面纹理"的读法。
  for (let i = 0; i < 5; i += 1) {
    const c = craterSpec(i)
    ctx.save()
    ctx.translate(cx + c.dx * coreR, cy + c.dy * coreR)
    ctx.scale(1, 0.78)
    ctx.beginPath()
    ctx.arc(0, 0, c.r * coreR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${onInkRGB}, ${c.a})`
    ctx.fill()
    ctx.restore()
  }

  // 边缘描边：极细 ink 边，把月亮从背景里衬出来。
  ctx.strokeStyle = `rgba(${inkRGB}, 0.28)`
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.stroke()

  // ---- 2) 径向柱状声纹 -------------------------------------------
  // 64 根柱子均匀分布在圆周。每根从内圈半径沿径向向外伸，长度随该段
  // 频谱能量。内圈留出"呼吸空腔"，柱子不与月面粘连。
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

  // 柱顶柔光层：能量高的柱子补一道 accent 短光，读作"发热"的均衡器。
  // 只画 v > 0.35 的柱，安静时完全不出现。
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
    ctx.strokeStyle = `rgba(${accentRGB}, ${((v - 0.35) * 0.85).toFixed(3)})`
    ctx.lineWidth = barWidth + 0.6
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  // ---- 3) 柔光环 --------------------------------------------------
  // 月亮外一圈 accent 低 alpha 光晕 + 一层 ink 淡晕，AI 说话时整体
  // 增亮。安静时几乎不可见。
  const haloR = innerRadius * 1.02
  const halo = ctx.createRadialGradient(cx, cy, coreR * 1.05, cx, cy, haloR * 1.28)
  halo.addColorStop(0, `rgba(${accentRGB}, ${(0.05 + energy * 0.10).toFixed(3)})`)
  halo.addColorStop(0.55, `rgba(${accentRGB}, ${(0.02 + energy * 0.05).toFixed(3)})`)
  halo.addColorStop(1, `rgba(${accentRGB}, 0)`)
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, haloR * 1.28, 0, Math.PI * 2)
  ctx.fill()
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
