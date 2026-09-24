<script setup lang="ts">
/**
 * 高光管理器（小说工作流的「高光页」）。
 *
 * 同一份高光既来自跑团面板的 ASR 生成，也可以在小说页手动创建：这里可以新增
 * 高光、上传/替换插图、编辑文字与生图提示词，并把这些改动写回与面板共用的
 * 本地 IndexedDB。传入 `jobId` 时再读取长篇小说的章节/场景划分，用
 * `matchHighlight()` 判断每条高光与当前章节原文的关联度，帮助把插图对应到
 * 具体章节。
 *
 * 组件同时被独立页（`workspace=highlights`）和小说工作台内嵌使用，因此不 import
 * `@/api/client` / naive-ui，网络请求只用 `bookApi` 的 `writingRequest`。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NovelVisualAnalysis } from '../../../../shared/trpg-visual'
import type { VisualReference } from '../../../../shared/trpg-writing'
import type { NovelWorkbench } from '../../../../shared/trpg-novel'
import { HIGHLIGHT_RECENT_LIMIT, campaignStorage, snapshotCampaign, type Campaign, type Highlight } from './storage'
import { campaignStorageKey, writingRequest } from './bookApi'
import { blobToBase64, imageDataUri, imageMime, isSupportedImage } from './image-io'
import { matchHighlight, matchPercent, type SourceRow } from './highlight-match'

const props = defineProps<{ meetingId: string; profile: string; jobId?: string; focusId?: string; embedded?: boolean }>()
const emit = defineEmits<{ useForWriting: [value: { chapter: number; reference: VisualReference }] }>()
const { t } = useI18n()

interface ChapterAnalysis { score: number; percent: number; best?: { index: number; title: string; score: number }; matched: SourceRow[]; related: boolean }

const campaign = ref<Campaign | null>(null)
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('')
const previews = ref<Record<string, string>>({})
const expanded = ref(false)
const draft = ref({ title: '', transcript: '', prompt: '', image: null as Blob | null, imageName: '' })
const draftPreview = ref('')
const job = ref<NovelWorkbench | null>(null)
const chapterIndex = ref(0)
const analysis = ref<Record<string, ChapterAnalysis>>({})
const visualAnalysis = ref<Record<string, NovelVisualAnalysis>>({})
const chosenMatch = ref<Record<string, number>>({})
const visualInputs = new Map<string, { image: Blob; prompt: string; transcript: string }>()
const analyzing = ref(''), applying = ref(''), applied = ref('')
const recap = ref<{ id: string; chapters: { id: string; title: string }[] } | null>(null)
let disposed = false

const key = campaignStorageKey(props.meetingId)
const base = computed(() => `/api/meeting-storage/${encodeURIComponent(props.meetingId)}/novel-jobs/${encodeURIComponent(props.jobId || '')}`)
const highlights = computed(() => campaign.value?.highlights || [])
/** Newest 30 by default, exactly like the panel gallery. */
const shown = computed(() => expanded.value ? highlights.value : highlights.value.slice(0, HIGHLIGHT_RECENT_LIMIT))
const hasOlder = computed(() => highlights.value.length > HIGHLIGHT_RECENT_LIMIT)
const chapters = computed(() => job.value?.layout || [])
const activeChapter = computed(() => chapters.value.find(chapter => chapter.index === chapterIndex.value) || null)
const recapId = computed(() => job.value?.job.recapId || '')

function revoke(map: Record<string, string>, id: string) { if (map[id]) URL.revokeObjectURL(map[id]); delete map[id] }
function back() {
  if (window.history.length > 1) window.history.back()
  else window.location.href = '/'
}
async function persist() {
  if (!campaign.value) return
  await campaignStorage(key, snapshotCampaign(campaign.value))
}
async function load() {
  try {
    const value = await campaignStorage(key)
    if (disposed) return
    value.highlights = value.highlights || []
    campaign.value = value
    for (const h of value.highlights) {
      const saved = h.novelAssociation
      if (saved && saved.jobId === props.jobId && saved.prompt === h.prompt && saved.transcript === h.transcript && saved.image && h.image && saved.image.size === h.image.size) {
        const [a, b] = await Promise.all([saved.image.arrayBuffer(), h.image.arrayBuffer()])
        const other = new Uint8Array(b)
        if (!disposed && new Uint8Array(a).every((byte, i) => byte === other[i])) visualAnalysis.value[h.id] = saved.analysis
      }
    }
    for (const highlight of value.highlights) if (highlight.image) previews.value[highlight.id] = URL.createObjectURL(highlight.image)
    if (props.focusId) {
      const index = value.highlights.findIndex(highlight => highlight.id === props.focusId)
      if (index >= HIGHLIGHT_RECENT_LIMIT) expanded.value = true
    }
  } catch { if (!disposed) error.value = t('trpg.storageError') }
  finally { if (!disposed) loading.value = false }
}

/** The text the matcher reads: the ASR evidence first, then the user's own notes. */
function matchTextFor(highlight: Highlight): string {
  const transcript = (highlight.transcript || '').trim()
  if (transcript) return transcript
  return [highlight.title, highlight.prompt].filter(Boolean).join('\n')
}

function resetDraft() {
  if (draftPreview.value) URL.revokeObjectURL(draftPreview.value)
  draftPreview.value = ''
  draft.value = { title: '', transcript: '', prompt: '', image: null, imageName: '' }
}

async function addHighlight() {
  if (!campaign.value || busy.value) return
  const title = draft.value.title.trim(), transcript = draft.value.transcript.trim(), prompt = draft.value.prompt.trim()
  if (!title && !transcript && !prompt && !draft.value.image) { error.value = t('trpg.highlights.emptyDraft'); return }
  const highlight: Highlight = { id: crypto.randomUUID(), createdAt: Date.now(), title: title || undefined, prompt, transcript, source: 'manual', actions: [] }
  if (draft.value.image) {
    highlight.image = draft.value.image
    highlight.imageName = draft.value.imageName
    highlight.imageModel = t('trpg.manualUpload')
    previews.value[highlight.id] = URL.createObjectURL(draft.value.image)
  }
  campaign.value.highlights.unshift(highlight)
  busy.value = true; error.value = ''
  try { await persist(); notice.value = t('trpg.highlights.saved'); resetDraft() }
  catch { error.value = t('trpg.storageError') }
  finally { busy.value = false }
}

function readImage(event: Event): File | null {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset so picking the same file again still fires a change event.
  input.value = ''
  if (!file) return null
  if (!isSupportedImage(file)) { error.value = t('trpg.imageInvalid'); return null }
  return file
}
function pickDraftImage(event: Event) {
  const file = readImage(event)
  if (!file) return
  if (draftPreview.value) URL.revokeObjectURL(draftPreview.value)
  draft.value.image = file; draft.value.imageName = file.name; draftPreview.value = URL.createObjectURL(file)
}
function invalidateVisual(id: string) {
  const h = campaign.value?.highlights.find(h => h.id === id); if (h) delete h.novelAssociation
  visualInputs.delete(id); delete visualAnalysis.value[id]; delete chosenMatch.value[id]; delete analysis.value[id]
}
async function pickCardImage(event: Event, highlight: Highlight) {
  const file = readImage(event)
  if (!file) return
  revoke(previews.value, highlight.id)
  invalidateVisual(highlight.id)
  highlight.image = file
  highlight.imageName = file.name
  highlight.imageModel = t('trpg.manualUpload')
  delete highlight.referenceNames
  previews.value[highlight.id] = URL.createObjectURL(file)
  await saveCard()
}
async function saveCard() {
  busy.value = true; error.value = ''
  try { await persist(); notice.value = t('trpg.highlights.saved') }
  catch { error.value = t('trpg.storageError') }
  finally { busy.value = false }
}
async function removeHighlight(highlight: Highlight) {
  revoke(previews.value, highlight.id)
  invalidateVisual(highlight.id)
  if (campaign.value) campaign.value.highlights = campaign.value.highlights.filter(item => item.id !== highlight.id)
  try { await persist() }
  catch { error.value = t('trpg.storageError') }
}

async function loadJob() {
  if (!props.jobId) return
  try {
    const value = await writingRequest<NovelWorkbench>(`${base.value}/workbench`, props.profile)
    if (disposed) return
    job.value = value
    chapterIndex.value = value.layout[0]?.index ?? 0
    await loadRecap()
  } catch { if (!disposed) error.value = t('trpg.highlights.jobFailed') }
}
async function loadRecap() {
  if (!recapId.value) return
  try {
    const data = await writingRequest<{ recaps: { id: string; chapters: { id: string; title: string }[] }[] }>(`/api/meeting-storage/${encodeURIComponent(props.meetingId)}/recaps`, props.profile)
    const found = data.recaps.find(entry => entry.id === recapId.value)
    recap.value = found ? { id: found.id, chapters: found.chapters } : null
  } catch { recap.value = null }
}

/** Score one highlight against every scene of the selected chapter. */
async function analyze(highlight: Highlight) {
  const chapter = activeChapter.value
  if (!props.jobId || !chapter) { error.value = t('trpg.highlights.needJob'); return }
  analyzing.value = highlight.id; error.value = ''; notice.value = ''; delete analysis.value[highlight.id]
  try {
    if (highlight.image) {
      delete visualAnalysis.value[highlight.id]; visualInputs.delete(highlight.id)
      const original = { image: highlight.image, prompt: highlight.prompt, transcript: highlight.transcript }
      const result = await writingRequest<NovelVisualAnalysis>(`${base.value}/visual-match`, props.profile, 'POST', { image: await imageDataUri(original.image), prompt: original.prompt, transcript: original.transcript })
      if (disposed) return
      if (highlight.image !== original.image || highlight.prompt !== original.prompt || highlight.transcript !== original.transcript) { error.value = t('trpg.harness.visualChanged'); return }
      visualInputs.set(highlight.id, original); visualAnalysis.value[highlight.id] = result; chosenMatch.value[highlight.id] = 0
      highlight.novelAssociation = { image: original.image, jobId: props.jobId || '', prompt: original.prompt, transcript: original.transcript, analysis: result }
      await persist()
      const best = result.matches[0]
      analysis.value[highlight.id] = { score: best?.score ?? 0, percent: matchPercent(best?.score ?? 0), best: best ? { index: best.scene, title: best.title, score: best.score } : undefined, matched: best?.evidence.map(e => ({ index: e.index, text: e.quote })) ?? [], related: !!best }
      return
    }
    const rows: SourceRow[] = []
    let best: ChapterAnalysis['best']
    for (const scene of chapter.scenes) {
      const result = await writingRequest<{ rows: SourceRow[] }>(`${base.value}/evidence?from=${scene.from}&to=${scene.to}`, props.profile)
      rows.push(...result.rows)
      const sceneMatch = matchHighlight(matchTextFor(highlight), result.rows)
      if (sceneMatch.score > 0 && (!best || sceneMatch.score > best.score)) best = { index: scene.index, title: scene.title, score: sceneMatch.score }
    }
    const overall = matchHighlight(matchTextFor(highlight), rows)
    analysis.value[highlight.id] = { score: overall.score, percent: matchPercent(overall.score), best, matched: overall.matched, related: overall.related }
  } catch { error.value = t(highlight.image ? 'trpg.harness.visionFailed' : 'trpg.harness.failed') }
  finally { analyzing.value = '' }
}

async function useForWriting(highlight: Highlight) {
  const cached = visualInputs.get(highlight.id)
  if (!cached || cached.image !== highlight.image || cached.prompt !== highlight.prompt || cached.transcript !== highlight.transcript) await analyze(highlight)
  const visual = visualAnalysis.value[highlight.id], match = visual?.matches[chosenMatch.value[highlight.id] ?? 0]
  if (!match) return
  emit('useForWriting', { chapter: match.chapter, reference: { id: highlight.id, description: visual.description, evidence: match.evidence } })
}

function positionUrl(highlightId: string, kind: 'position' | 'asr' | 'canon' | 'material' = 'position'): string {
  const match = visualAnalysis.value[highlightId]?.matches[chosenMatch.value[highlightId] ?? 0]
  const saved = kind === 'canon' || kind === 'material' ? match?.artifacts?.[kind] : undefined
  const prose = kind === 'position' ? match?.prose : undefined
  return `/recap-book.html?${new URLSearchParams({ workspace: 'novel', meetingId: props.meetingId, jobId: props.jobId || '', profile: props.profile, chapter: String(match?.chapter ?? 0), scene: String(match?.scene ?? 0), artifact: saved?.name ?? (prose ? `review-${match!.scene}` : ''), ...(prose ? { paragraph: String(prose.paragraph) } : {}), ...((saved?.version || prose?.version) ? { version: saved?.version || prose!.version! } : {}), panel: saved || prose ? 'prose' : 'evidence' })}`
}

/** Upload the highlight picture as the chronicle illustration of the selected chapter. */
async function applyToChapter(highlight: Highlight) {
  const chapter = activeChapter.value
  const target = chapter ? recap.value?.chapters[chapter.index] : undefined
  const mime = highlight.image ? imageMime(highlight.image) : null
  if (!recapId.value || !target || !highlight.image || !mime) { error.value = t('trpg.highlights.applyUnavailable'); return }
  applying.value = highlight.id; error.value = ''; notice.value = ''
  try {
    const dataBase64 = await blobToBase64(highlight.image)
    await writingRequest(`/api/meeting-storage/${encodeURIComponent(props.meetingId)}/recaps/${encodeURIComponent(recapId.value)}/images/content`, props.profile, 'PUT', {
      kind: 'content', chapterId: target.id, mime, dataBase64, model: highlight.imageModel || t('trpg.manualUpload'), prompt: (highlight.prompt || '').slice(0, 8000) || undefined,
    })
    applied.value = highlight.id
    notice.value = t('trpg.highlights.applied')
  } catch { error.value = t('trpg.harness.failed') }
  finally { applying.value = '' }
}

onMounted(async () => {
  await load()
  if (props.jobId) void loadJob()
  if (props.focusId) requestAnimationFrame(() => document.getElementById(`highlight-${props.focusId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }))
})
onBeforeUnmount(() => { disposed = true; visualInputs.clear(); Object.keys(previews.value).forEach(id => revoke(previews.value, id)); if (draftPreview.value) URL.revokeObjectURL(draftPreview.value) })
</script>

<template>
  <div class="highlight-workbench" :class="{ embedded }" data-testid="highlight-workbench">
    <header v-if="!embedded" class="hw-header">
      <div>
        <small>{{ t('trpg.highlights.eyebrow') }} · {{ profile }}</small>
        <h1>{{ t('trpg.highlights.title') }}</h1>
        <p>{{ t('trpg.highlights.intro') }}</p>
      </div>
      <button type="button" class="quiet" @click="back">{{ t('trpg.highlights.back') }}</button>
    </header>

    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="feedback" role="status">{{ notice }}</p>
    <p v-if="loading" class="muted">{{ t('trpg.loading') }}</p>

    <template v-else>
      <section class="hw-create">
        <h2>{{ t('trpg.highlights.create') }}</h2>
        <p class="muted">{{ t('trpg.highlights.createHint') }}</p>
        <div class="hw-create-grid">
          <label>{{ t('trpg.highlights.note') }}<input v-model="draft.title" maxlength="120" :placeholder="t('trpg.highlights.notePlaceholder')" /></label>
          <label class="hw-file">{{ t('trpg.highlights.image') }}
            <input type="file" accept="image/png,image/jpeg,image/webp" @change="pickDraftImage" />
            <span v-if="draft.imageName" class="muted">{{ draft.imageName }}</span>
          </label>
        </div>
        <label>{{ t('trpg.highlights.transcript') }}<textarea v-model="draft.transcript" rows="3" maxlength="12000" :placeholder="t('trpg.highlights.transcriptPlaceholder')" /></label>
        <label>{{ t('trpg.highlights.prompt') }}<textarea v-model="draft.prompt" rows="3" maxlength="20000" :placeholder="t('trpg.highlights.promptPlaceholder')" /></label>
        <div class="hw-create-actions">
          <img v-if="draftPreview" class="hw-draft-preview" :src="draftPreview" :alt="t('trpg.highlights.image')" />
          <button type="button" class="primary" :disabled="busy" @click="addHighlight">{{ t('trpg.highlights.add') }}</button>
          <button type="button" :disabled="busy || (!draft.title && !draft.transcript && !draft.prompt && !draft.image)" @click="resetDraft">{{ t('trpg.highlights.clear') }}</button>
        </div>
      </section>

      <section class="hw-analysis" v-if="jobId">
        <h2>{{ t('trpg.highlights.analysisTitle') }}</h2>
        <p class="muted">{{ t('trpg.harness.visionHint') }}</p>
        <label v-if="chapters.length">{{ t('trpg.highlights.chapter') }}
          <select v-model.number="chapterIndex"><option v-for="chapter in chapters" :key="chapter.index" :value="chapter.index">{{ t('trpg.harness.chapterNumber', { n: chapter.index + 1 }) }}</option></select>
        </label>
        <p v-else class="muted">{{ t('trpg.harness.waitOutline') }}</p>
      </section>
      <p v-else class="muted hw-standalone-hint">{{ t('trpg.highlights.standaloneHint') }}</p>

      <section class="hw-list">
        <header class="hw-list-head"><h2>{{ t('trpg.highlights.list') }}</h2><span class="muted">{{ shown.length }} / {{ highlights.length }}</span></header>
        <p v-if="!highlights.length" class="muted">{{ t('trpg.highlights.empty') }}</p>
        <article v-for="(highlight, i) in shown" :id="`highlight-${highlight.id}`" :key="highlight.id" class="hw-card" :class="{ older: i >= HIGHLIGHT_RECENT_LIMIT, focused: focusId === highlight.id }">
          <div class="hw-card-image">
            <img v-if="previews[highlight.id]" :src="previews[highlight.id]" :alt="highlight.title || t('trpg.scene')" />
            <span v-else class="hw-card-placeholder" aria-hidden="true">◇</span>
          </div>
          <div class="hw-card-body">
            <div class="hw-card-title">
              <input v-model="highlight.title" maxlength="120" :aria-label="t('trpg.highlights.note')" :placeholder="t('trpg.highlights.notePlaceholder')" />
              <small>{{ highlight.source === 'manual' ? t('trpg.highlights.manual') : t('trpg.highlights.auto') }} · {{ new Date(highlight.createdAt).toLocaleString() }}</small>
            </div>
            <label>{{ t('trpg.highlights.transcript') }}<textarea v-model="highlight.transcript" @input="invalidateVisual(highlight.id)" rows="2" maxlength="12000" /></label>
            <label>{{ t('trpg.highlights.prompt') }}<textarea v-model="highlight.prompt" @input="invalidateVisual(highlight.id)" rows="2" maxlength="20000" /></label>
            <div class="hw-card-actions">
              <label class="quiet hw-upload">{{ t(highlight.image ? 'trpg.replaceImage' : 'trpg.uploadImage') }}<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="busy" @change="pickCardImage($event, highlight)" /></label>
              <button type="button" class="quiet" :disabled="busy" @click="saveCard()">{{ t('trpg.highlights.save') }}</button>
              <button type="button" class="quiet" :disabled="busy || !!analyzing" @click="analyze(highlight)">{{ t(analyzing === highlight.id ? 'trpg.highlights.analyzing' : 'trpg.highlights.analyze') }}</button>
              <button v-if="embedded && jobId" type="button" :disabled="busy || !!analyzing || !highlight.image" @click="useForWriting(highlight)">{{ t('trpg.harness.useVisual') }}</button>
              <button v-if="recapId" type="button" class="quiet" :disabled="busy || applying === highlight.id || !highlight.image" @click="applyToChapter(highlight)">{{ t(applying === highlight.id ? 'trpg.highlights.applying' : 'trpg.highlights.applyToChapter') }}</button>
              <button type="button" class="quiet danger" :disabled="busy" @click="removeHighlight(highlight)">{{ t('trpg.remove') }}</button>
            </div>
            <section v-if="visualAnalysis[highlight.id]" class="hw-vision">
              <h3>{{ t('trpg.harness.visionDescription') }}</h3><p>{{ visualAnalysis[highlight.id]!.description }}</p>
              <p class="muted">{{ t('trpg.harness.visionCandidates', { count: visualAnalysis[highlight.id]!.candidateCount, total: visualAnalysis[highlight.id]!.sceneCount }) }}</p>
              <ul><li v-for="(note, n) in visualAnalysis[highlight.id]!.uncertainties" :key="n">{{ note }}</li></ul>
              <label v-if="visualAnalysis[highlight.id]!.matches.length">{{ t('trpg.harness.visionPosition') }}<select v-model.number="chosenMatch[highlight.id]"><option v-for="(match, n) in visualAnalysis[highlight.id]!.matches" :key="match.scene" :value="n">{{ t('trpg.harness.chapterNumber', { n: match.chapter + 1 }) }} · {{ match.title }} · {{ Math.round(match.score * 100) }}%</option></select></label>
              <template v-for="(match, n) in visualAnalysis[highlight.id]!.matches" :key="match.scene"><div v-if="n === (chosenMatch[highlight.id] ?? 0)"><p>{{ match.reason }}</p><blockquote v-for="cite in match.evidence" :key="cite.index">#{{ cite.index }} {{ cite.quote }}</blockquote><blockquote v-if="match.prose">¶{{ match.prose.paragraph + 1 }} {{ match.prose.quote }}</blockquote></div></template>
              <a v-if="visualAnalysis[highlight.id]!.matches.length" :href="positionUrl(highlight.id)" target="_blank" rel="noopener noreferrer">{{ t('trpg.harness.openPosition') }}</a>
              <template v-if="visualAnalysis[highlight.id]!.matches.length">
                <a :href="positionUrl(highlight.id, 'asr')" target="_blank" rel="noopener noreferrer">{{ t('trpg.harness.linkAsr') }}</a>
                <a v-if="visualAnalysis[highlight.id]!.matches[chosenMatch[highlight.id] ?? 0]?.artifacts?.canon" :href="positionUrl(highlight.id, 'canon')" target="_blank" rel="noopener noreferrer">{{ t('trpg.harness.linkCanon') }}</a>
                <a v-if="visualAnalysis[highlight.id]!.matches[chosenMatch[highlight.id] ?? 0]?.artifacts?.material" :href="positionUrl(highlight.id, 'material')" target="_blank" rel="noopener noreferrer">{{ t('trpg.harness.linkMaterial') }}</a>
              </template>
              <p v-else>{{ t('trpg.highlights.noMatch') }}</p>
            </section>
            <div v-else-if="analysis[highlight.id]" class="hw-match">
              <strong :class="{ related: analysis[highlight.id].related }">{{ t('trpg.highlights.matchScore', { percent: analysis[highlight.id].percent }) }}</strong>
              <span v-if="analysis[highlight.id].best"> · {{ t('trpg.highlights.bestScene', { n: (analysis[highlight.id].best?.index ?? 0) + 1, title: analysis[highlight.id].best?.title || '' }) }}</span>
              <span v-else class="muted"> · {{ t('trpg.highlights.noMatch') }}</span>
              <details v-if="analysis[highlight.id].matched.length"><summary>{{ t('trpg.highlights.matchedRows', { count: analysis[highlight.id].matched.length }) }}</summary>
                <blockquote v-for="row in analysis[highlight.id].matched" :key="row.index"><small>#{{ row.index }} · {{ row.speaker || t('trpg.unnamed') }}</small><p>{{ row.text }}</p></blockquote>
              </details>
            </div>
            <p v-if="applied === highlight.id" class="muted">{{ t('trpg.highlights.applied') }}</p>
          </div>
        </article>
        <button v-if="hasOlder" type="button" class="quiet hw-more" @click="expanded = !expanded">
          {{ t(expanded ? 'trpg.highlights.showRecent' : 'trpg.highlights.showOlder', { count: highlights.length - HIGHLIGHT_RECENT_LIMIT }) }}
        </button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.highlight-workbench { min-height: 100%; padding: 22px 30px 60px; background: #181a1c; color: #e2e5e7; font: 14px/1.65 system-ui, sans-serif; }
.highlight-workbench.embedded { padding: 0; background: transparent; }
.hw-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
h1 { font-size: 24px; margin: 2px 0; } h2 { font-size: 15px; margin: 0 0 8px; }
small, .muted { color: #aeb7bd; } .feedback { margin: 0 0 14px; padding: 10px 14px; background: #28362f; border-radius: 6px; } .feedback.error { background: #632e28; }
section { margin-bottom: 22px; padding: 14px 16px; border: 1px solid #394047; border-radius: 10px; }
label { display: grid; gap: 5px; margin-bottom: 10px; font-size: 12px; }
input, textarea, select { box-sizing: border-box; width: 100%; color: inherit; background: #22272b; border: 1px solid #4b545b; border-radius: 5px; padding: 8px; font: inherit; }
button, a { display: inline-flex; align-items: center; padding: 7px 11px; border: 1px solid #53675e; border-radius: 5px; background: #28362f; color: #e2eee6; cursor: pointer; text-decoration: none; font: inherit; }
button:disabled { opacity: .5; cursor: default; } button.primary { background: #37543f; } button.danger { border-color: #7a423a; color: #f0c0b6; }
.hw-create-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.hw-create-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hw-draft-preview { max-height: 90px; border-radius: 6px; }
.hw-file input { padding: 6px; }
.hw-list-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.hw-card { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 14px; padding: 12px 0; border-top: 1px solid #2c3338; }
.hw-card.focused { background: #26332c; border-radius: 8px; padding: 12px; }
.hw-card-image { display: grid; place-items: center; overflow: hidden; border-radius: 8px; background: #22272b; border: 1px solid #394047; aspect-ratio: 3 / 2; }
.hw-card-image img { width: 100%; height: 100%; object-fit: cover; }
.hw-card-placeholder { color: #6d7a82; font-size: 30px; }
.hw-card-title { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.hw-card-title input { flex: 1; }
.hw-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hw-upload input[type='file'] { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.hw-match { margin-top: 8px; font-size: 12px; } .hw-match strong.related { color: #9fd3ac; }
blockquote { margin: 6px 0; padding-left: 12px; border-left: 2px solid #688b78; color: #bdc8c1; }
.hw-more { width: 100%; margin-top: 10px; justify-content: center; }
@media (max-width: 700px) { .hw-card { grid-template-columns: 1fr; } .hw-create-grid { grid-template-columns: 1fr; } }
.hw-vision { margin-top: 18px; border: 1px solid #62725a; border-radius: 8px; padding: 16px; background: #232e25; } .hw-vision blockquote { margin: 10px 0; padding: 8px 12px; border-left: 2px solid #b0bd92; overflow-wrap: anywhere; }
</style>
