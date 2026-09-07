<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NAlert, NButton, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { io, type Socket } from 'socket.io-client'
import { getApiKey } from '@/api/client'
import { useI18n } from 'vue-i18n'
import { useScannerCamera } from '../scanner/composables/useScannerCamera'
import { gradingApi, type Submission, type Annotation } from './api'
import { download, pdfPages, renderPage } from './render'
import GradingAnnotator from './GradingAnnotator.vue'
const { t } = useI18n(); const router = useRouter(); const route = useRoute()
const classes = ref<any[]>([]); const exams = ref<any[]>([]); const classId = ref<string | null>(null); const examId = ref<string | null>(null)
const className = ref(''); const examName = ref(''); const rubric = ref(''); const studentName = ref('')
const rows = ref<Omit<Submission, 'image'>[]>([]); const active = ref<Submission>(); const annotations = ref<Annotation[]>([])
const error = ref(''); const running = ref(false); const paused = ref(false); const busy = ref(false); const rough = ref(true); const settings = ref({ model: 'qwen3.8-plus', ocrModel: 'qwen3.5-ocr', threshold: .7 }); const summary = ref<any>()
const filesInput = ref<HTMLInputElement>(); const folderInput = ref<HTMLInputElement>(); const video = ref<HTMLVideoElement>()
const camera = useScannerCamera(); let disposed = false
let socket: Socket | undefined
const captureRequest = ref<string | null>(null)
const batch = computed(() => route.path.endsWith('grading-batch'))
const examOptions = computed(() => exams.value.filter(e => e.class_id === classId.value).map(e => ({ label: e.name, value: e.id })))
async function attempt(fn: () => Promise<unknown>) { error.value = ''; try { await fn() } catch (e) { error.value = (e as Error).message } }
async function catalog() { const data = await gradingApi('catalog'); classes.value = data.classes; exams.value = data.exams }
async function load() { if (!examId.value) return; rows.value = await gradingApi('list', { examId: examId.value }); await report() }
async function report() { summary.value = await gradingApi('summary', { scanIds: rows.value.filter(r => r.results.length).map(r => r.id) }) }
async function createClass() { const data = await gradingApi('create_class', { name: className.value }); classId.value = data.classId; className.value = ''; await catalog() }
async function createExam() { const data = await gradingApi('create_exam', { classId: classId.value, name: examName.value, date: new Date().toISOString().slice(0,10) }); examId.value = data.examId; examName.value = ''; await catalog(); await load() }
async function select(id: string) { if (active.value && active.value.id !== id) await save(); const s = await gradingApi<Submission>('get', { scanId: id }); active.value = s; annotations.value = structuredClone(s.annotations) }
async function add(image: string, name: string) {
  if (!examId.value) throw new Error(t('grading.empty'))
  const result = await gradingApi('capture_scan', { image, examId: examId.value, studentName: name }); await load(); if (!batch.value) await select(result.scanId)
  if (captureRequest.value) { await gradingApi('client_complete', { requestId: captureRequest.value, result }); captureRequest.value = null }
}
async function importFiles(files: File[]) {
  busy.value = true
  try {
    for (const file of files) {
      if (disposed) return
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) continue
      if (file.size > 4_500_000) throw new Error(`${file.name}: > 4.5 MB`)
      const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })
      await add(image, file.name.replace(/\.[^.]+$/, ''))
    }
  } finally { busy.value = false }
}
async function drop(event: DragEvent) {
  const entries = Array.from(event.dataTransfer?.items || []).map(item => item.webkitGetAsEntry?.()).filter(Boolean)
  const files: File[] = []
  async function walk(entry: any): Promise<void> {
    if (entry.isFile) { files.push(await new Promise<File>((resolve, reject) => entry.file(resolve, reject))); return }
    const reader = entry.createReader()
    for (;;) { const children = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject)); if (!children.length) break; for (const child of children) await walk(child) }
  }
  if (entries.length) for (const entry of entries) await walk(entry)
  else files.push(...Array.from(event.dataTransfer?.files || []))
  await importFiles(files)
}
async function openCamera() { await camera.start(); await nextTick(); if (video.value) camera.bindVideo(video.value) }
async function closeCamera() { camera.stop(); if (captureRequest.value) { await gradingApi('client_complete', { requestId: captureRequest.value, result: { cancelled: true } }); captureRequest.value = null } }
async function snap() { const result = await camera.snapshot(); if (result) await add(result.dataUrl, studentName.value || `Scan ${rows.value.length + 1}`) }
async function gradeRow(row: Omit<Submission, 'image'>) {
  try {
    for (const action of ['ocr', 'detect_questions', 'grade', 'apply_edits']) {
      if (disposed) return
      row.status = action === 'ocr' ? 'ocr' : 'grading'
      const result = await gradingApi(action, { scanId: row.id, rubric: rubric.value })
      Object.assign(row, result)
    }
  } catch (e) { row.status = 'error'; row.error = (e as Error).message }
}
async function start(only?: Omit<Submission, 'image'>) {
  if (!rubric.value.trim()) throw new Error(t('grading.rubricRequired'))
  if (running.value) return
  running.value = true; paused.value = false
  const queue = only ? [only] : rows.value.filter(r => ['pending','error','recognized','detected'].includes(r.status))
  if (!batch.value && !only) queue.splice(1)
  const worker = async () => { while (!paused.value && !disposed) { const row = queue.shift(); if (!row) return; await gradeRow(row) } }
  try { await Promise.all([worker(), worker()]); await report(); if (active.value) await select(active.value.id) } finally { running.value = false }
}
async function save() { if (!active.value) return; const result = await gradingApi('save_annotations', { scanId: active.value.id, revision: active.value.revision, annotations: annotations.value }); active.value.revision = result.revision; active.value.annotations = structuredClone(annotations.value) }
async function review() {
  if (!active.value) return
  await save()
  const result = await gradingApi('review', { scanId: active.value.id, revision: active.value.revision, results: active.value.results })
  active.value.revision = result.revision; active.value.status = 'done'; await load()
}
async function exportOne(format: 'png' | 'pdf') {
  if (!active.value) return
  await save(); const canvas = await renderPage(active.value.image, annotations.value, rough.value)
  if (format === 'pdf') download(await pdfPages([canvas]), `${active.value.studentName}.pdf`)
  else { const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve)); if (blob) download(blob, `${active.value.studentName}.png`) }
}
async function exportAll() {
  if (active.value) await save()
  const pages = []
  for (const row of rows.value.filter(r => r.results.length)) { const s = await gradingApi<Submission>('get', { scanId: row.id }); pages.push(await renderPage(s.image, s.annotations, rough.value)) }
  if (pages.length) download(await pdfPages(pages), 'grading.pdf')
}
function exportReport() { download(new Blob([JSON.stringify(summary.value, null, 2)], { type: 'application/json' }), 'grading-report.json') }
onMounted(() => void attempt(async () => { settings.value = await gradingApi('settings', { enabled: true }); await catalog();
  socket = io(`${localStorage.getItem('hermes_server_url') || ''}/grading`, { auth: { token: getApiKey() }, query: { profile: localStorage.getItem('hermes_active_profile_name') || 'default' } })
  socket.on('grading.request', (request: any) => void attempt(async () => {
    if (request.action === 'capture') {
      captureRequest.value = request.requestId
      if (request.examId) { const exam = exams.value.find(e => e.id === request.examId); if (exam) { classId.value = exam.class_id; examId.value = exam.id; await load() } }
      await openCamera()
    } else if (request.action === 'render') {
      await select(request.scanId); rough.value = request.style !== 'printed'; await exportOne('pdf'); await exportOne('png')
      await gradingApi('client_complete', { requestId: request.requestId, result: { scanId: request.scanId, downloaded: true } })
    }
  }))
}))
onBeforeUnmount(() => { disposed = true; paused.value = true; camera.stop(); socket?.disconnect() })
</script>
<template>
  <main class="grading-view">
    <header><h2>{{ t('grading.title') }}</h2><div class="actions"><NButton @click="router.push('/hermes')">{{ t('grading.chat') }}</NButton><NButton :type="!batch ? 'primary' : 'default'" @click="router.push('/hermes/grading')">{{ t('grading.single') }}</NButton><NButton :type="batch ? 'primary' : 'default'" @click="router.push('/hermes/grading-batch')">{{ t('grading.batch') }}</NButton></div></header>
    <NAlert v-if="error" type="error" closable @close="error = ''">{{ error }}</NAlert>
    <section class="selectors">
      <NSelect v-model:value="classId" :disabled="running || busy" :placeholder="t('grading.class')" :options="classes.map(c => ({ label: c.name, value: c.id }))" @update:value="examId = null; rows = []; active = undefined" />
      <NSelect v-model:value="examId" :disabled="running || busy" :placeholder="t('grading.exam')" :options="examOptions" @update:value="active = undefined; attempt(load)" />
      <NInput v-model:value="className" :placeholder="t('grading.newClass')" /><NButton :disabled="!className || running" @click="attempt(createClass)">{{ t('grading.create') }}</NButton>
      <NInput v-model:value="examName" :placeholder="t('grading.newExam')" /><NButton :disabled="!examName || !classId || running" @click="attempt(createExam)">{{ t('grading.create') }}</NButton>
    </section>
    <details><summary>{{ t('grading.settings') }}</summary><div class="selectors"><label>{{ t('grading.ocrModel') }}<NInput v-model:value="settings.ocrModel" /></label><label>{{ t('grading.model') }}<NInput v-model:value="settings.model" /></label><label>{{ t('grading.threshold') }}<NInputNumber v-model:value="settings.threshold" :min="0" :max="1" :step=".1" /></label><NButton :disabled="running" @click="attempt(() => gradingApi('settings', settings))">{{ t('grading.save') }}</NButton></div></details>
    <NInput v-model:value="rubric" type="textarea" :disabled="running" :placeholder="t('grading.rubric')" />
    <section class="drop" @dragover.prevent @drop.prevent="!running && !busy && attempt(() => drop($event))">
      <p>{{ t('grading.drop') }}</p><div class="actions">
        <input ref="filesInput" hidden type="file" accept="image/jpeg,image/png,image/webp" multiple @change="attempt(() => importFiles(Array.from(($event.target as HTMLInputElement).files || [])))">
        <input ref="folderInput" hidden type="file" webkitdirectory multiple @change="attempt(() => importFiles(Array.from(($event.target as HTMLInputElement).files || [])))">
        <NButton :disabled="!examId || busy || running" @click="filesInput?.click()">{{ t('grading.import') }}</NButton><NButton :disabled="!examId || busy || running" @click="folderInput?.click()">{{ t('grading.folder') }}</NButton><NButton :disabled="!examId" @click="attempt(openCamera)">{{ t('grading.camera') }}</NButton>
      </div>
      <div v-if="camera.isRunning.value"><video ref="video" autoplay muted playsinline /><NInput v-model:value="studentName" :placeholder="t('grading.student')" /><NButton @click="attempt(snap)">{{ t('grading.capture') }}</NButton><NButton @click="attempt(closeCamera)">{{ t('grading.close') }}</NButton></div>
      <p v-if="camera.error.value">{{ camera.error.value }}</p>
    </section>
    <div class="actions"><NButton type="primary" :disabled="running || busy || !rows.length" @click="attempt(() => start())">{{ t('grading.start') }}</NButton><NButton :disabled="!running" @click="paused = true">{{ t('grading.pause') }}</NButton><NButton :disabled="running || !rows.some(r => r.results.length)" @click="attempt(exportAll)">{{ t('grading.allPdf') }}</NButton><NButton :disabled="!summary?.total" @click="exportReport">{{ t('grading.report') }}</NButton></div>
    <section class="workspace">
      <div class="queue"><p v-if="!rows.length">{{ t('grading.empty') }}</p><article v-for="row in rows" :key="row.id" :class="{ selected: active?.id === row.id }"><NButton text @click="attempt(() => select(row.id))">{{ row.studentName }}</NButton><span>{{ t(`grading.${row.status}`) }}</span><strong v-if="row.results.length">{{ row.results.reduce((n,r) => n+r.score,0) }}</strong><p v-if="row.error">{{ row.error }}</p><NButton v-if="row.status === 'error'" :disabled="running" @click="attempt(() => start(row))">{{ t('grading.retry') }}</NButton></article></div>
      <div v-if="active" class="paper"><div class="actions"><NSwitch v-model:value="rough" />{{ t(rough ? 'grading.rough' : 'grading.printed') }}<NButton @click="attempt(save)">{{ t('grading.save') }}</NButton><NButton @click="attempt(() => exportOne('pdf'))">{{ t('grading.pdf') }}</NButton><NButton @click="attempt(() => exportOne('png'))">{{ t('grading.png') }}</NButton></div><NAlert v-if="active.status === 'review'" type="warning">{{ t('grading.review') }}</NAlert><GradingAnnotator v-model="annotations" :image="active.image" :rough="rough" /><div v-for="result in active.results" :key="result.qid" class="actions"><span>{{ result.qid }} / {{ result.fullMark }}</span><NInputNumber v-model:value="result.score" :min="0" :max="result.fullMark" /><NInput v-model:value="result.feedback" /></div><NButton v-if="active.results.length" @click="attempt(review)">{{ t('grading.confirmReview') }}</NButton></div>
    </section>
    <section v-if="summary?.total" class="report"><span v-for="key in ['average','max','min','passRate']" :key="key">{{ t(`grading.${key}`) }}: {{ Number(summary[key]).toFixed(2) }}</span><p>{{ t('grading.wrongRank') }}: {{ summary.wrongRank.map((q: any) => `${q.qid} (${q.wrongCount})`).join(', ') }}</p></section>
  </main>
</template>
<style scoped lang="scss">
.grading-view { padding: 24px; height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 18px; } header, .actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; } header { justify-content:space-between; } h2 { margin:0; } .selectors { display:flex; gap:10px; flex-wrap:wrap; > * { max-width:220px; } } .drop { border:2px dashed var(--border-color,#8885); padding:16px; border-radius:12px; } video { display:block; max-width:480px; width:100%; } .workspace { display:grid; grid-template-columns:260px minmax(0,1fr); gap:18px; } .queue article { padding:14px; border-bottom:1px solid #8884; display:flex; gap:10px; flex-wrap:wrap; } .selected { background:#8882; } .paper { min-width:0; } .report span { margin-inline-end:20px; } @media(max-width:800px) { .workspace { grid-template-columns:1fr; } }
</style>
