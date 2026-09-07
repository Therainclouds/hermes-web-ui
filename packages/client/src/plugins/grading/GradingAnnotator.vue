<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import Konva from 'konva'
import { drawAnnotation, imageElement } from './render'
import type { Annotation } from './api'
const props = defineProps<{ image: string; modelValue: Annotation[]; rough: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [Annotation[]] }>()
const { t } = useI18n()
const container = ref<HTMLDivElement>(); const tool = ref('select'); const color = ref('#dc2626'); const width = ref(3); const text = ref(''); const selected = ref('')
const history: Annotation[][] = []; const future: Annotation[][] = []
let stage: Konva.Stage | undefined; let scale = 1; let observer: ResizeObserver | undefined; let drawing: number[] | null = null
const copy = (value: Annotation[]) => JSON.parse(JSON.stringify(value)) as Annotation[]
function commit(value: Annotation[]) { history.push(copy(props.modelValue)); future.length = 0; emit('update:modelValue', value) }
function undo() { const value = history.pop(); if (value) { future.push(copy(props.modelValue)); emit('update:modelValue', value) } }
function redo() { const value = future.pop(); if (value) { history.push(copy(props.modelValue)); emit('update:modelValue', value) } }
function remove() { commit(props.modelValue.filter(a => a.id !== selected.value)); selected.value = '' }
function editText() { commit(props.modelValue.map(a => a.id === selected.value ? { ...a, content: text.value } : a)) }
let generation = 0
async function draw() {
  const current = ++generation
  if (!container.value || !props.image) return
  const img = await imageElement(props.image)
  if (current !== generation || !container.value) return
  stage?.destroy(); scale = Math.min(1, (container.value.clientWidth || 800) / img.naturalWidth)
  stage = new Konva.Stage({ container: container.value, width: img.naturalWidth * scale, height: img.naturalHeight * scale, scaleX: scale, scaleY: scale })
  const layer = new Konva.Layer(); stage.add(layer)
  layer.add(new Konva.Image({ image: img, width: img.naturalWidth, height: img.naturalHeight, listening: false }))
  for (const a of props.modelValue) {
    const shape = new Konva.Shape({ draggable: tool.value === 'select', sceneFunc(context) { drawAnnotation(context._context, a, props.rough) }, hitFunc(context, shape) { context.beginPath(); context.rect(...a.bbox); context.closePath(); context.fillStrokeShape(shape) } })
    shape.on('click tap', () => { selected.value = a.id; text.value = a.content })
    shape.on('dragend', () => {
      const dx = shape.x(); const dy = shape.y()
      const x = Math.max(0, Math.min(img.naturalWidth - a.bbox[2], a.bbox[0] + dx)); const y = Math.max(0, Math.min(img.naturalHeight - a.bbox[3], a.bbox[1] + dy))
      commit(props.modelValue.map(item => item.id === a.id ? { ...a, bbox: [x, y, a.bbox[2], a.bbox[3]], points: a.points?.map((n, i) => n + (i % 2 ? dy : dx)) } : item))
    })
    layer.add(shape)
  }
  stage.on('mousedown touchstart', () => {
    if (tool.value === 'select') return
    const p = stage!.getPointerPosition(); if (!p) return
    drawing = [p.x / scale, p.y / scale]
  })
  stage.on('mousemove touchmove', () => {
    if (!drawing || tool.value !== 'pen') return
    const p = stage!.getPointerPosition(); if (p) drawing.push(p.x / scale, p.y / scale)
  })
  stage.on('mouseup touchend', () => {
    if (!drawing) return
    const p = stage!.getPointerPosition(); const [x, y] = drawing as [number, number]
    const endX = p ? p.x / scale : x + 60; const endY = p ? p.y / scale : y + 40
    const a: Annotation = { id: crypto.randomUUID(), kind: tool.value, content: text.value, color: color.value, width: width.value, bbox: [Math.min(x, endX), Math.min(y, endY), Math.max(60, Math.abs(endX - x)), Math.max(30, Math.abs(endY - y))] }
    if (a.kind === 'pen') a.points = drawing
    if (a.kind === 'comment' || a.kind === 'badge') a.bbox = [x, y, 220, 40]
    drawing = null; commit([...props.modelValue, a])
  })
}
watch(() => [props.image, props.modelValue, props.rough, tool.value], () => void nextTick(draw), { deep: true })
watch(() => props.image, () => { history.length = 0; future.length = 0; selected.value = '' })
onMounted(() => { observer = new ResizeObserver(() => void draw()); if (container.value) observer.observe(container.value); void draw() })
onBeforeUnmount(() => { generation++; observer?.disconnect(); stage?.destroy() })
</script>
<template>
  <div class="annotator" tabindex="0" @keydown.delete.prevent="remove" @keydown.backspace.self.prevent="remove">
    <div class="toolbar">
      <NSelect v-model:value="tool" :options="['select','pen','circle','comment','badge'].map(value => ({ value, label: t(`grading.${value}`) }))" style="width:160px" />
      <input v-model="color" type="color" :aria-label="t('grading.color')"><input v-model.number="width" type="range" min="1" max="12" :aria-label="t('grading.width')">
      <NButton @click="undo">{{ t('grading.undo') }}</NButton><NButton @click="redo">{{ t('grading.redo') }}</NButton>
      <NButton :disabled="!selected" @click="remove">{{ t('grading.remove') }}</NButton>
      <NInput v-model:value="text" :placeholder="t('grading.text')" style="width:220px" />
      <NButton :disabled="!selected" @click="editText">{{ t('grading.save') }}</NButton>
    </div>
    <div ref="container" class="canvas" />
  </div>
</template>
<style scoped lang="scss">
.annotator { min-width: 0; } .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0; } .canvas { width: 100%; background: white; }
</style>
