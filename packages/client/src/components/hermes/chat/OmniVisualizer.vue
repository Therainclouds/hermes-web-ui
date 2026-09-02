<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Omni-Realtime 视觉核心。
 *
 * 三层叠加（全部 canvas 绘制）：
 *  1. 外圈粒子环 —— 仅做缓慢公转 + 闪烁，**完全不接音频电平**。
 *     早期实现里粒子速度/径向位置/闪烁频率都耦合了 inputLevel，导致
 *     AI 说话时麦克风 AEC 残音会拉偏整片星云（"鬼畜"）。本版把音频
 *     影响限制在中心液体核心——星环是恒星，不再随声音颤动。
 *  2. 中心液体星体 —— 由 N=10 个顶点的 catmull-rom 圆周组成，每个顶点
 *     半径由基波 + 音频能量驱动，闭合为 bezier 路径，形成"液珠呼吸"
 *     效果。AI 说话时整体缓推外扩并缓慢旋转；用户说话时核心瞬间
 *     微鼓（inputLevel 只走一条单独的低权重通道）。
 *  3. 光晕层 —— 跟随能量做径向呼吸；色相随 phase 切换（listening=
 *     蓝青、speaking=紫、error=暖红）。
 */
const props = defineProps<{
  phase: 'idle' | 'connecting' | 'ready' | 'listening' | 'speaking' | 'error' | 'closed'
  /** 麦克风输入电平（0-1），已经过 EMA + RMS blend 平滑。 */
  inputLevel: number
  /** AI 播放输出电平（0-1），已经过 EMA 平滑。 */
  outputLevel: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null

interface Particle {
  baseAngle: number
  angularSpeed: number
  ringIndex: 0 | 1
  radiusJitter: number
  size: number
  twinklePhase: number
  twinkleSpeed: number
}

const RINGS = [{ radius: 0.62, tilt: 0.32, count: 56 }, { radius: 0.82, tilt: 0.2, count: 36 }]
const particles: Particle[] = []

function seedParticles(): void {
  particles.length = 0
  for (let ring = 0; ring < RINGS.length; ring += 1) {
    const ringDef = RINGS[ring]!
    for (let i = 0; i < ringDef.count; i += 1) {
      particles.push({
        baseAngle: (i / ringDef.count) * Math.PI * 2 + ring * 0.5,
        // 星环速度只跟 time 走，不再被能量调制。
        angularSpeed: (0.045 - ring * 0.015) * (0.85 + Math.random() * 0.3),
        ringIndex: ring as 0 | 1,
        radiusJitter: 0.86 + Math.random() * 0.3,
        size: 0.8 + Math.random() * 2.2,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.4 + Math.random() * 1.2,
      })
    }
  }
}

const PALETTES: Record<string, { coreIn: string; coreOut: string; particle: string; halo: string }> = {
  idle:       { coreIn: 'rgba(126, 156, 255, 0.85)', coreOut: 'rgba(59, 91, 219, 0)',   particle: '126, 156, 255', halo: 'rgba(80, 110, 220, 0.14)' },
  connecting: { coreIn: 'rgba(103, 232, 249, 0.80)', coreOut: 'rgba(34, 150, 220, 0)',   particle: '103, 210, 249', halo: 'rgba(60, 160, 230, 0.20)' },
  ready:      { coreIn: 'rgba(126, 156, 255, 0.85)', coreOut: 'rgba(59, 91, 219, 0)',   particle: '126, 156, 255', halo: 'rgba(80, 110, 220, 0.14)' },
  listening:  { coreIn: 'rgba(94, 226, 244, 0.95)',  coreOut: 'rgba(14, 165, 210, 0)',  particle: '94, 226, 244',  halo: 'rgba(34, 211, 238, 0.22)' },
  speaking:   { coreIn: 'rgba(178, 148, 250, 0.95)', coreOut: 'rgba(109, 84, 250, 0)',  particle: '178, 148, 250', halo: 'rgba(139, 108, 250, 0.24)' },
  closed:     { coreIn: 'rgba(126, 156, 255, 0.70)', coreOut: 'rgba(59, 91, 219, 0)',   particle: '126, 156, 255', halo: 'rgba(80, 110, 220, 0.10)' },
  error:      { coreIn: 'rgba(252, 148, 128, 0.90)', coreOut: 'rgba(220, 60, 60, 0)',    particle: '250, 156, 132', halo: 'rgba(240, 90, 80, 0.22)' },
}

let smoothInput = 0
let smoothOutput = 0
// 综合能量"呼吸"——驱动液体核心半径 / 整体外推 / 光晕。attack 与 release
// 都慢到听不出逐音节跳变：TTS 每个音节的 RMS 起伏由此被滤成一次平滑的
// "呼吸"。这是**唯一**驱动核心形状/位置的信号。
let energySmooth = 0
let paletteMix = 1
let prevPaletteKey = 'idle'
let time = 0
let blobRotation = 0

function smoothLevel(current: number, target: number): number {
  return current + (target - current) * (target > current ? 0.3 : 0.08)
}

function lerpPalette(currentKey: string): { a: typeof PALETTES.idle, b: typeof PALETTES.idle, t: number } {
  const b = PALETTES[currentKey] ?? PALETTES.idle!
  const a = PALETTES[prevPaletteKey] ?? PALETTES.idle!
  return { a, b, t: paletteMix }
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function mixTriplet(a: string, b: string, t: number): string {
  const pa = a.split(',').map(s => parseFloat(s.trim()))
  const pb = b.split(',').map(s => parseFloat(s.trim()))
  return `${Math.round(mix(pa[0] ?? 0, pb[0] ?? 0, t))}, ${Math.round(mix(pa[1] ?? 0, pb[1] ?? 0, t))}, ${Math.round(mix(pa[2] ?? 0, pb[2] ?? 0, t))}`
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

  time += 1 / 60

  // 输入端平滑（继承 useOmniRealtime 已做 EMA + RMS blend，这里再做一道
  // 防御性平滑，把残余抖动进一步压扁）。粒子/核心两者都基于同一个
  // 平滑过的能量驱动——不会再出现"麦克风噪声拉偏星云"的现象。
  smoothInput = smoothLevel(smoothInput, props.inputLevel)
  smoothOutput = smoothLevel(smoothOutput, props.outputLevel)
  // 用户权重 0.55 + AI 权重 0.75 —— 二者都被同一慢速 EMA 滤过。
  const rawEnergy = Math.min(1, smoothInput * 0.55 + smoothOutput * 0.75)
  energySmooth += (rawEnergy - energySmooth) * (rawEnergy > energySmooth ? 0.12 : 0.045)
  const energy = Math.pow(energySmooth, 0.8)

  // 调色板过渡。
  if (props.phase !== prevPaletteKey) {
    if (paletteMix >= 1) {
      prevPaletteKey = props.phase
      paletteMix = 0
    }
  }
  paletteMix = Math.min(1, paletteMix + 0.05)
  const { a, b, t: mixT } = lerpPalette(props.phase)
  const particleColor = mixTriplet(a.particle, b.particle, mixT)
  const coreInTriplet = mixTriplet(rgbTripletOf(a.coreIn), rgbTripletOf(b.coreIn), mixT)
  const coreInAlpha = alphaOf(a.coreIn) + (alphaOf(b.coreIn) - alphaOf(a.coreIn)) * mixT
  const haloAlpha = alphaOf(a.halo) + (alphaOf(b.halo) - alphaOf(a.halo)) * mixT

  const cx = cssWidth / 2
  const cy = cssHeight / 2
  const unit = Math.min(cssWidth, cssHeight) / 2

  // --- 1) 外圈光晕（径向呼吸） -----------------------------------
  const haloRadius = unit * (0.74 + energy * 0.14)
  const halo = ctx.createRadialGradient(cx, cy, unit * 0.2, cx, cy, haloRadius)
  halo.addColorStop(0, withAlpha(b.halo, haloAlpha * (0.65 + energy * 0.4)))
  halo.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2)
  ctx.fill()

  // --- 2) 粒子星环（与音频解耦） -------------------------------
  // 关键改动：粒子位置/亮度/大小只由 time + 自身 phase + 缓慢公转决定，
  // 完全不接 smoothInput/smoothOutput。energy 仅通过一个**极低权重**的
  // 通道影响整体 alpha（让星环在活跃时微微变亮，但仍是无声的）。
  // AI 说话时整个星环**绝对不**抖——只有中心液体核心在动。
  for (const p of particles) {
    const ringDef = RINGS[p.ringIndex]!
    const angle = p.baseAngle + time * p.angularSpeed
    const orbit = unit * ringDef.radius * p.radiusJitter
    // 不再有任何 radialPush，粒子在固定轨道上公转。
    const px = cx + Math.cos(angle) * orbit
    const py = cy + Math.sin(angle) * orbit * ringDef.tilt
    const depth = 0.55 + ((Math.sin(angle) + 1) / 2) * 0.65
    // twinkle 也只接 time 与自身 phase，闪烁节奏固定、无音频耦合。
    const twinkle = 0.55 + 0.45 * Math.sin(time * p.twinkleSpeed + p.twinklePhase)
    const baseAlpha = (0.18 + energy * 0.18) * depth * twinkle + 0.04
    const size = p.size * depth
    ctx.fillStyle = `rgba(${particleColor}, ${Math.min(1, baseAlpha).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fill()
  }

  // --- 3) 中心液体星体（canvas blob） ---------------------------
  drawBlob(ctx, cx, cy, unit, energy, coreInTriplet, coreInAlpha)

  // 顶部高光：跟随 blob 上半弧最高点的位置，给液珠打一束斜光。
  drawHighlight(ctx, cx, cy, unit, energy)
}

/**
 * 在 N=10 顶点的 catmull-rom 圆周上叠加多频正弦波，bezier 闭合为液珠。
 *
 * 每顶点半径：
 *   r_i = baseRadius * (1 + baseWave_i * 0.18 + audioWave_i * 0.28)
 *
 * baseWave_i = 基线起伏（始终存在，让液珠"活着"）
 * audioWave_i = 由能量驱动，AI 说话时主呼吸方向固定向"上"（垂直方向）
 *
 * 用户说话时 inputSmooth 单独把整体基础半径上推 5%，让液珠"鼓一下"。
 */
function drawBlob(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, unit: number,
  energy: number, colorTriplet: string, alpha: number,
): void {
  const N = 10
  // 用户说话时液珠微鼓：基线半径 +5% 峰值，由独立平滑通道驱动。
  const userPulse = smoothInput * 0.06
  const baseRadius = unit * (0.30 + energy * 0.06 + userPulse)

  // 液珠慢速自旋（≤ 0.3 rad/s），跟随能量微调但不抽搐。
  blobRotation += 0.0035 + energy * 0.004

  // 收集每帧顶点位置（N+1 个首尾相接）。
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i < N; i += 1) {
    const theta = (i / N) * Math.PI * 2 + blobRotation
    // 基波：低频多谐波叠加，呼吸感来自多个不同时长的正弦。
    const baseWave =
      0.6 * Math.sin(time * 0.55 + i * 0.7) +
      0.4 * Math.sin(time * 0.31 + i * 1.3 + 1.2)
    // 音频驱动波：方向固定向上，让 AI 说话时液珠向"上"凸起，模拟发声方向。
    // i=7 附近对应 top (sin(theta) ≈ 1)。
    const audioWave =
      0.7 * Math.sin(time * 1.7 + i * 0.9) +
      0.3 * Math.sin(time * 2.4 + i * 1.7 + 0.6)
    const radial = baseRadius * (1 + baseWave * 0.18 + audioWave * energy * 0.28)
    points.push({
      x: cx + Math.cos(theta) * radial,
      y: cy + Math.sin(theta) * radial,
    })
  }

  // Catmull-Rom → Bezier 闭合：每段用一个控制点前后加权绘制。
  ctx.beginPath()
  ctx.moveTo(points[0]!.x, points[0]!.y)
  for (let i = 0; i < N; i += 1) {
    const p0 = points[(i - 1 + N) % N]!
    const p1 = points[i]!
    const p2 = points[(i + 1) % N]!
    const p3 = points[(i + 2) % N]!
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
  }
  ctx.closePath()

  // 内部径向渐变填色：左上是亮区，右下是暗区，模拟立体打光。
  const grad = ctx.createRadialGradient(
    cx - baseRadius * 0.4, cy - baseRadius * 0.5, baseRadius * 0.05,
    cx + baseRadius * 0.2, cy + baseRadius * 0.3, baseRadius * 1.1,
  )
  grad.addColorStop(0, `rgba(${colorTriplet}, ${Math.min(1, alpha + energy * 0.1)})`)
  grad.addColorStop(0.55, `rgba(${colorTriplet}, ${alpha * 0.55})`)
  grad.addColorStop(1, `rgba(${colorTriplet}, 0)`)
  ctx.fillStyle = grad
  ctx.fill()
}

/**
 * 顶部柔光高光——液珠最凸点附近打一个椭圆白点，给液珠加体积感。
 * 偏移随能量轻微游走，但量极小（≤ 8% 半径），不会出现跳变。
 */
function drawHighlight(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, unit: number, energy: number,
): void {
  const r = unit * (0.18 + energy * 0.03)
  const ox = cx - r * (0.5 + Math.sin(time * 0.4) * 0.06)
  const oy = cy - r * (0.55 + Math.sin(time * 0.27) * 0.06)
  const highlight = ctx.createRadialGradient(ox, oy, 0, ox, oy, r * 1.3)
  highlight.addColorStop(0, `rgba(255, 255, 255, ${0.22 + energy * 0.12})`)
  highlight.addColorStop(0.45, `rgba(255, 255, 255, ${0.05 + energy * 0.04})`)
  highlight.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = highlight
  ctx.beginPath()
  ctx.arc(ox, oy, r * 1.3, 0, Math.PI * 2)
  ctx.fill()
}

function rgbTripletOf(rgba: string): string {
  const m = rgba.match(/rgba?\(([^)]+)\)/)
  if (!m) return '126, 156, 255'
  const parts = m[1]!.split(',').map(s => s.trim())
  return `${parts[0]}, ${parts[1]}, ${parts[2]}`
}

function alphaOf(rgba: string): number {
  const m = rgba.match(/rgba?\(([^)]+)\)/)
  if (!m) return 1
  const parts = m[1]!.split(',').map(s => s.trim())
  return parts.length >= 4 ? parseFloat(parts[3]!) : 1
}

function withAlpha(rgba: string, alpha: number): string {
  return `rgba(${rgbTripletOf(rgba)}, ${alpha.toFixed(3)})`
}

onMounted(() => {
  seedParticles()
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
})

watch(() => props.phase, () => { /* palette 过渡在 draw 内处理 */ })
</script>

<template>
  <div class="omni-visualizer" data-testid="omni-visualizer">
    <canvas ref="canvasRef" class="omni-visualizer__canvas" aria-hidden="true" />
  </div>
</template>

<style scoped>
.omni-visualizer {
  position: relative;
  width: min(560px, 62vw, 52vh);
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