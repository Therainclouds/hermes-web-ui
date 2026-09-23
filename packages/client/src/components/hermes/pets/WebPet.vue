<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { usePetsStore } from '@/stores/hermes/pets'

const petsStore = usePetsStore()

const SCALE_MIN = 0.18
const SCALE_MAX = 1.2
const SCALE_STEP = 0.06
const LOOP_MS_DEFAULT = 1100

const canvasRef = ref<HTMLCanvasElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const position = ref({ x: 0, y: 0 })
const scale = ref(0.33)
const dragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })
const canvasSize = ref({ width: 0, height: 0 })
const frameIndex = ref(0)

let animationTimer: number | null = null
let saveTimer: number | null = null

const activePet = computed(() => petsStore.activePet)
const frameW = computed(() => activePet.value?.frameW ?? 192)
const frameH = computed(() => activePet.value?.frameH ?? 208)
const framesPerState = computed(() => activePet.value?.framesPerState ?? 6)
const loopMs = computed(() => activePet.value?.loopMs ?? LOOP_MS_DEFAULT)
const stateRowCount = computed(() => activePet.value?.stateRows.length ?? 1)
const statesTotal = computed(() => stateRowCount.value * framesPerState.value)

function stopAnimation() {
  if (animationTimer !== null) {
    cancelAnimationFrame(animationTimer)
    animationTimer = null
  }
}

function drawPet() {
  const canvas = canvasRef.value
  const img = image.value
  if (!canvas || !img || !img.complete || img.naturalWidth === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const widthPx = Math.max(1, Math.round(frameW.value * scale.value))
  const heightPx = Math.max(1, Math.round(frameH.value * scale.value))
  canvas.width = Math.round(widthPx * dpr)
  canvas.height = Math.round(heightPx * dpr)
  canvas.style.width = `${widthPx}px`
  canvas.style.height = `${heightPx}px`
  canvasSize.value = { width: widthPx, height: heightPx }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, widthPx, heightPx)

  const colCount = framesPerState.value
  const totalCells = colCount * stateRowCount.value
  const idx = totalCells > 0 ? (frameIndex.value % totalCells) : 0
  const col = colCount > 0 ? idx % colCount : 0
  const row = colCount > 0 ? Math.floor(idx / colCount) : 0

  ctx.drawImage(
    img,
    col * frameW.value,
    row * frameH.value,
    frameW.value,
    frameH.value,
    0,
    0,
    widthPx,
    heightPx,
  )
}

let lastFrameAt = 0
function tick(now: number) {
  if (!image.value) return
  const interval = Math.max(60, loopMs.value / Math.max(1, framesPerState.value))
  if (!lastFrameAt || now - lastFrameAt >= interval) {
    lastFrameAt = now
    frameIndex.value = (frameIndex.value + 1) % Math.max(1, statesTotal.value)
    drawPet()
  }
  animationTimer = requestAnimationFrame(tick)
}

function startAnimation() {
  stopAnimation()
  if (!image.value) return
  animationTimer = requestAnimationFrame(tick)
}

function ensureImage(dataUrl: string, revision: number) {
  if (!dataUrl) {
    image.value = null
    return
  }
  const img = new Image()
  img.onload = () => {
    image.value = img
    drawPet()
    startAnimation()
  }
  img.onerror = () => {
    image.value = null
  }
  img.src = `${dataUrl}#${revision}`
}

function clampPosition(x: number, y: number) {
  const maxX = Math.max(0, window.innerWidth - canvasSize.value.width)
  const maxY = Math.max(0, window.innerHeight - canvasSize.value.height)
  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
  }
}

function placeInitial() {
  if (!activePet.value?.position) {
    const maxX = Math.max(0, window.innerWidth - canvasSize.value.width)
    const maxY = Math.max(0, window.innerHeight - canvasSize.value.height)
    position.value = { x: maxX - 24, y: maxY - 24 }
    return
  }
  position.value = clampPosition(activePet.value.position.x, activePet.value.position.y)
}

function queueSavePreferences(next: { scale?: number; position?: { x: number; y: number } }) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void petsStore.savePreferences(next)
  }, 350)
}

function startDrag(event: PointerEvent) {
  if (!canvasRef.value) return
  dragging.value = true
  const rect = canvasRef.value.getBoundingClientRect()
  dragOffset.value = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
}

function drag(event: PointerEvent) {
  if (!dragging.value) return
  const next = clampPosition(event.clientX - dragOffset.value.x, event.clientY - dragOffset.value.y)
  position.value = next
  queueSavePreferences({ position: next })
}

function endDrag(event: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
}

function adjustScale(delta: number) {
  const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round((scale.value + delta) * 100) / 100))
  scale.value = next
  queueSavePreferences({ scale: next })
  void nextTick(drawPet)
}

function hidePet() {
  void petsStore.hideActivePet()
}

watch(activePet, async pet => {
  if (!pet) {
    image.value = null
    stopAnimation()
    return
  }
  scale.value = pet.scale
  ensureImage(pet.spritesheetDataUrl, pet.spritesheetRevision)
  await nextTick()
  placeInitial()
}, { immediate: true })

watch(scale, () => {
  void nextTick(drawPet)
})

onMounted(() => {
  if (activePet.value) ensureImage(activePet.value.spritesheetDataUrl, activePet.value.spritesheetRevision)
  window.addEventListener('resize', placeInitial)
})

onUnmounted(() => {
  stopAnimation()
  if (saveTimer) clearTimeout(saveTimer)
  window.removeEventListener('resize', placeInitial)
})
</script>

<template>
  <div v-if="activePet" class="web-pet" :style="{ left: `${position.x}px`, top: `${position.y}px` }">
    <canvas
      ref="canvasRef"
      class="pet-canvas"
      role="img"
      :aria-label="activePet.displayName"
      @pointerdown="startDrag"
      @pointermove="drag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    />
    <div class="pet-controls" role="toolbar" :aria-label="activePet.displayName">
      <button type="button" class="control" :aria-label="'-'" @click="adjustScale(-SCALE_STEP)">−</button>
      <span class="scale-readout">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="control" :aria-label="'+'" @click="adjustScale(SCALE_STEP)">+</button>
      <button type="button" class="control hide" :aria-label="'hide'" @click="hidePet">×</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.web-pet {
  position: fixed;
  z-index: 9999;
  touch-action: none;
  user-select: none;
  pointer-events: auto;
}

.pet-canvas {
  display: block;
  cursor: grab;
}

.pet-canvas:active {
  cursor: grabbing;
}

.pet-controls {
  position: absolute;
  inset-inline-end: -8px;
  inset-block-start: -28px;
  display: flex;
  gap: 4px;
  align-items: center;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 4px 6px;
  border-radius: 14px;
  font-size: 12px;
  pointer-events: auto;
}

.control {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.16);
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.control:hover {
  background: rgba(255, 255, 255, 0.28);
}

.control.hide {
  margin-inline-start: 4px;
  background: rgba(220, 38, 38, 0.7);
}

.scale-readout {
  min-width: 36px;
  text-align: center;
}
</style>