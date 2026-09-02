<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Omni-Realtime 粒子星环可视化（替代旧 CSS orb）。
 *
 * 三层结构（全部 canvas 绘制）：
 *  1. 中心核心 —— 径向渐变发光球，色相随 phase 切换（listening=青 /
 *     speaking=紫蓝 / error=红移），半径随综合能量呼吸；
 *  2. 粒子星环 —— 两圈轨道粒子，角速度 / 扩散半径 / 亮度由音频电平驱动：
 *     AI 说话（outputLevel）时粒子向外爆发扩散，用户说话（inputLevel）时
 *     向内收缩并加速闪烁，静默时缓慢旋转；
 *  3. 外圈光晕 —— 随能量呼吸的径向光雾。
 *
 * 音频电平在组件内做 EMA 平滑，父组件只需要把原始电平 refs 传进来。
 * RAF 循环挂载即启动（静默态绘制成本极低），卸载时清理。
 */
const props = defineProps<{
  phase: 'idle' | 'connecting' | 'ready' | 'listening' | 'speaking' | 'error' | 'closed'
  /** 麦克风输入电平（0-1，来自 useOmniRealtime 的 inputLevel）。 */
  inputLevel: number
  /** AI 播放输出电平（0-1，来自 useOmniRealtime 的 outputLevel）。 */
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

const RINGS = [{ radius: 0.62, tilt: 0.32, count: 66 }, { radius: 0.82, tilt: 0.2, count: 44 }]
const particles: Particle[] = []

function seedParticles(): void {
  particles.length = 0
  for (let ring = 0; ring < RINGS.length; ring += 1) {
    const ringDef = RINGS[ring]!
    for (let i = 0; i < ringDef.count; i += 1) {
      particles.push({
        baseAngle: (i / ringDef.count) * Math.PI * 2 + ring * 0.5,
        // 内圈转得更快，同一圈上速度略有抖动，避免机械感。
        angularSpeed: (0.10 - ring * 0.035) * (0.7 + Math.random() * 0.6),
        ringIndex: ring as 0 | 1,
        radiusJitter: 0.86 + Math.random() * 0.3,
        size: 0.8 + Math.random() * 2.2,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.6 + Math.random() * 1.8,
      })
    }
  }
}

/** 每 phase 的调色板（核心内色 / 核心外色 / 粒子色 / 光晕色）。 */
const PALETTES: Record<string, { coreIn: string; coreOut: string; particle: string; halo: string }> = {
  idle: { coreIn: 'rgba(129, 168, 255, 0.85)', coreOut: 'rgba(59, 91, 219, 0)', particle: '126, 156, 255', halo: 'rgba(80, 110, 220, 0.16)' },
  connecting: { coreIn: 'rgba(103, 232, 249, 0.8)', coreOut: 'rgba(34, 150, 220, 0)', particle: '103, 210, 249', halo: 'rgba(60, 160, 230, 0.2)' },
  ready: { coreIn: 'rgba(129, 168, 255, 0.85)', coreOut: 'rgba(59, 91, 219, 0)', particle: '126, 156, 255', halo: 'rgba(80, 110, 220, 0.16)' },
  listening: { coreIn: 'rgba(103, 232, 249, 0.95)', coreOut: 'rgba(14, 165, 210, 0)', particle: '94, 226, 244', halo: 'rgba(34, 211, 238, 0.26)' },
  speaking: { coreIn: 'rgba(192, 148, 252, 0.95)', coreOut: 'rgba(109, 84, 250, 0)', particle: '178, 148, 250', halo: 'rgba(139, 108, 250, 0.28)' },
  closed: { coreIn: 'rgba(129, 168, 255, 0.7)', coreOut: 'rgba(59, 91, 219, 0)', particle: '126, 156, 255', halo: 'rgba(80, 110, 220, 0.12)' },
  error: { coreIn: 'rgba(252, 128, 128, 0.9)', coreOut: 'rgba(220, 60, 60, 0)', particle: '250, 140, 130', halo: 'rgba(240, 80, 80, 0.22)' },
}

let smoothInput = 0
let smoothOutput = 0
// 调色板混色进度：0 → 上一帧 palette，1 → 当前 phase palette。
// 直接切换色板会硬跳，EMA 过渡让色相流动。
let paletteMix = 1
let prevPaletteKey = 'idle'
let time = 0

function lerpPalette(currentKey: string): { a: typeof PALETTES.idle, b: typeof PALETTES.idle, t: number } {
  const b = PALETTES[currentKey] ?? PALETTES.idle!
  const a = PALETTES[prevPaletteKey] ?? PALETTES.idle!
  return { a, b, t: paletteMix }
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 混合两个 'r, g, b' 三元组字符串。 */
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

  // 音频电平 EMA 平滑（不同方向不同系数：起音快、收音慢，更像呼吸）。
  smoothInput += (props.inputLevel - smoothInput) * (props.inputLevel > smoothInput ? 0.5 : 0.12)
  smoothOutput += (props.outputLevel - smoothOutput) * (props.outputLevel > smoothOutput ? 0.4 : 0.1)
  const energy = Math.min(1, smoothInput + smoothOutput)

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
  const coreIn = mixTriplet(rgbTripletOf(a.coreIn), rgbTripletOf(b.coreIn), mixT)
  const coreInAlphaBase = alphaOf(a.coreIn) + (alphaOf(b.coreIn) - alphaOf(a.coreIn)) * mixT

  const cx = cssWidth / 2
  const cy = cssHeight / 2
  const unit = Math.min(cssWidth, cssHeight) / 2

  // --- 外圈光晕 -------------------------------------------------------
  const haloRadius = unit * (0.72 + energy * 0.22)
  const halo = ctx.createRadialGradient(cx, cy, unit * 0.2, cx, cy, haloRadius)
  halo.addColorStop(0, withAlpha(b.halo, mix(alphaOf(a.halo), alphaOf(b.halo), mixT) * (0.7 + energy * 0.6)))
  halo.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2)
  ctx.fill()

  // --- 中心核心 -------------------------------------------------------
  const coreRadius = unit * (0.30 + energy * 0.08) * (1 + Math.sin(time * 1.8) * 0.02)
  const core = ctx.createRadialGradient(
    cx - coreRadius * 0.25, cy - coreRadius * 0.3, coreRadius * 0.05,
    cx, cy, coreRadius,
  )
  core.addColorStop(0, `rgba(${coreIn}, ${Math.min(1, coreInAlphaBase + energy * 0.05)})`)
  core.addColorStop(0.55, `rgba(${coreIn}, ${coreInAlphaBase * 0.45})`)
  core.addColorStop(1, `rgba(${coreIn}, 0)`)
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2)
  ctx.fill()

  // 核心高光点（左上小亮斑，增加体积感）。
  const highlight = ctx.createRadialGradient(
    cx - coreRadius * 0.32, cy - coreRadius * 0.38, 0,
    cx - coreRadius * 0.32, cy - coreRadius * 0.38, coreRadius * 0.42,
  )
  highlight.addColorStop(0, `rgba(255, 255, 255, ${0.32 + energy * 0.2})`)
  highlight.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = highlight
  ctx.beginPath()
  ctx.arc(cx - coreRadius * 0.32, cy - coreRadius * 0.38, coreRadius * 0.42, 0, Math.PI * 2)
  ctx.fill()

  // --- 粒子星环 -------------------------------------------------------
  // AI 说话：粒子沿径向向外爆发；用户说话：向内收缩、闪烁加速。
  const radialPush = smoothOutput * 0.42 - smoothInput * 0.14
  for (const p of particles) {
    const ringDef = RINGS[p.ringIndex]!
    const angle = p.baseAngle + time * p.angularSpeed * (1 + energy * 1.6)
    const orbit = unit * ringDef.radius * p.radiusJitter
    // 椭圆轨道（tilt 压扁 Y 轴，制造透视深度）。
    const px = cx + Math.cos(angle) * (orbit * (1 + radialPush))
    const py = cy + Math.sin(angle) * (orbit * (1 + radialPush) * ringDef.tilt)
    // 深度感：下半弧（sin>0）离观众更近 → 更大更亮。
    const depth = 0.55 + ((Math.sin(angle) + 1) / 2) * 0.65
    const twinkle = 0.55 + 0.45 * Math.sin(time * p.twinkleSpeed * (1 + smoothInput * 2.5) + p.twinklePhase)
    const alpha = Math.min(1, (0.16 + energy * 0.75) * depth * twinkle + 0.05)
    const size = p.size * depth * (1 + energy * 0.7)
    ctx.fillStyle = `rgba(${particleColor}, ${alpha.toFixed(3)})`
    ctx.beginPath()
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** 'rgba(r, g, b, a)' → 'r, g, b' */
function rgbTripletOf(rgba: string): string {
  const m = rgba.match(/rgba?\(([^)]+)\)/)
  if (!m) return '126, 156, 255'
  const parts = m[1]!.split(',').map(s => s.trim())
  return `${parts[0]}, ${parts[1]}, ${parts[2]}`
}

/** 'rgba(r, g, b, a)' → a（无 alpha 视为 1） */
function alphaOf(rgba: string): number {
  const m = rgba.match(/rgba?\(([^)]+)\)/)
  if (!m) return 1
  const parts = m[1]!.split(',').map(s => s.trim())
  return parts.length >= 4 ? parseFloat(parts[3]!) : 1
}

/** 'rgba(r, g, b, a)' → 'rgba(r, g, b, newA)' */
function withAlpha(rgba: string, alpha: number): string {
  return `rgba(${rgbTripletOf(rgba)}, ${alpha.toFixed(3)})`
}

onMounted(() => {
  seedParticles()
  rafId = requestAnimationFrame(draw)
  // draw() 每帧按 clientWidth/Height 自适应，ResizeObserver 只是显式
  // 通知兜底；jsdom 等测试环境没有该 API，缺席时跳过。
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { /* draw() 每帧自适应尺寸，无需处理 */ })
    if (canvasRef.value) resizeObserver.observe(canvasRef.value)
  }
})

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  resizeObserver?.disconnect()
  resizeObserver = null
})

// phase 变化时不需要重启 RAF（循环常驻），仅记录：防止未使用告警。
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
  width: min(560px, 62vw);
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
