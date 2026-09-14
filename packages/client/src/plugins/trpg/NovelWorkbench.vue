<script setup lang="ts">
import NovelTokenUsage from './NovelTokenUsage.vue'
import { computed, onBeforeUnmount, onMounted, ref, toRaw, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NovelArtifact, NovelWorkbench } from '../../../../shared/trpg-novel'
import type { ChapterDirection, WritingSettings, WritingModel, VisualReference } from '../../../../shared/trpg-writing'
import { writingRequest } from './bookApi'
import { writingCatalog } from './writing-catalog'
import WritingSettingsEditor from './WritingSettingsEditor.vue'
import HighlightWorkbench from './HighlightWorkbench.vue'
import { recapBookUrl } from './bookUrl'

const { t } = useI18n()
const query = new URLSearchParams(location.search)
const meetingId = query.get('meetingId') || '', jobId = query.get('jobId') || ''
const profile = query.get('profile') || localStorage.getItem('hermes_active_profile_name') || 'default'
const base = `/api/meeting-storage/${encodeURIComponent(meetingId)}/novel-jobs/${encodeURIComponent(jobId)}`
const state = ref<NovelWorkbench | null>(null), error = ref(''), busy = ref(false)
const chapter = ref(Math.max(0, Number(query.get('chapter')) || 0)), artifactName = ref(query.get('artifact') || ''), artifact = ref<NovelArtifact | null>(null)
const versions = ref<{ inputHash: string; createdAt: number }[]>([]), version = ref(query.get('version') || '')
const compare = ref<NovelArtifact | null>(null), evidence = ref<{ index: number; text: string; speaker?: string }[]>([])
// The gallery's highlight link lands here with `panel=highlights` (+ the card to focus).
const tab = ref(query.get('panel') === 'highlights' ? 'highlights' : query.get('panel') === 'evidence' ? 'evidence' : 'prose')
const focusHighlight = query.get('highlight') || undefined
const catalog = ref<WritingModel[]>([]), settings = ref<WritingSettings>({})
const direction = ref<ChapterDirection | null>(null), directionDirty = ref(false), settingsDirty = ref(false)
const directionRevision = ref(0), settingsRevision = ref(0)
let located = false
const targetParagraph = query.has('paragraph') ? Number(query.get('paragraph')) : -1
let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, selection = 0
const theme = ref(localStorage.getItem('trpg.novel.theme') === 'light' ? 'light' : 'dark')
const followLatest = ref(!query.has('artifact') && !query.has('panel'))
function setTheme(value: string) { theme.value = value; localStorage.setItem('trpg.novel.theme', value) }
const running = computed(() => state.value?.job.status === 'running')
const chapterLayout = computed(() => state.value?.layout.find(c => c.index === chapter.value))
const sceneIndex = computed(() => Number(/^(?:write|review|revision|canon|check)-(\d+)(?:-\d+|-gap-[a-f0-9]+)?$/.exec(artifactName.value)?.[1] ?? query.get('scene') ?? -1))
const content = computed(() => artifact.value?.value as any)
const comparisonBody = computed(() => (compare.value?.value as any)?.body || '')
const chapterArtifacts = computed(() => state.value?.artifacts.filter(a => a.name === `plan-${chapter.value}` || a.name.startsWith(`planpart-${chapter.value}-`) || a.name === `chapter-${chapter.value}` || chapterLayout.value?.scenes.some(s => a.name === `canon-${s.index}` || a.name.startsWith(`canon-${s.index}-gap-`) || a.name === `check-${s.index}` || a.name === `write-${s.index}` || a.name === `review-${s.index}` || a.name.startsWith(`revision-${s.index}-`))) ?? [])
const artifactGroups = computed(() => {
  const available = [...chapterArtifacts.value, ...(state.value?.artifacts.filter(a => /^(book|bookpart|extract|read|memory|material|state)(-|$)/.test(a.name)) ?? [])]
  const categories = { source: ['extract', 'read', 'memory', 'material', 'state', 'canon'], outline: ['book', 'bookpart', 'plan', 'planpart'], prose: ['write', 'review', 'revision', 'chapter'], checks: ['check'] }
  return Object.entries(categories).map(([id, kinds]) => ({ id, items: available.filter(a => kinds.includes(a.name.split('-')[0])) })).filter(group => group.items.length)
})
async function followArtifact(next: NovelWorkbench) {
  if (!followLatest.value || directionDirty.value || settingsDirty.value || tab.value !== 'prose') return
  const latest = [...next.artifacts].sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!latest || (latest.name === artifactName.value && latest.createdAt === artifact.value?.createdAt)) return
  const [kind, number] = latest.name.split('-')
  const owner = ['book', 'bookpart', 'extract', 'read', 'memory'].includes(kind) ? undefined : ['plan', 'planpart', 'chapter'].includes(kind) ? next.layout.find(c => c.index === Number(number)) : next.layout.find(c => c.scenes.some(scene => scene.index === Number(number)))
  if (owner && !['extract', 'read', 'memory'].includes(kind)) { chapter.value = owner.index; direction.value = null; await loadDirection() }
  await selectArtifact(latest.name)
}
function setFollow(value: boolean) { followLatest.value = value; if (value) { tab.value = 'prose'; void refresh() } }
function label(name: string) {
  const [kind, index, ...parts] = name.split('-')
  const suffix = parts[0] === 'gap' ? ` · ${t('trpg.harness.coverageRecovery')}` : parts.length ? ` · ${parts.join('.')}` : ''
  return `${t(`trpg.harness.artifactKind.${kind}`)}${index == null ? '' : ` ${Number(index) + 1}`}${suffix}`
}
async function useVisual(value: { chapter: number; reference: VisualReference }) {
  if (running.value || directionDirty.value || settingsDirty.value) { error.value = t('trpg.harness.visualPause'); return }
  await chooseChapter(value.chapter)
  if (!direction.value) return
  direction.value.visualReferences = [...(direction.value.visualReferences ?? []).filter(r => r.id !== value.reference.id), value.reference].slice(-6)
  directionDirty.value = true; tab.value = 'prose'
}
function beforeUnload(event: BeforeUnloadEvent) { if (directionDirty.value || settingsDirty.value) { event.preventDefault(); event.returnValue = '' } }
async function getArtifact(name: string, hash = '') {
  return writingRequest<{ artifact: NovelArtifact; versions: typeof versions.value }>(`${base}/artifacts/${encodeURIComponent(name)}${hash ? `?version=${hash}` : ''}`, profile)
}
async function loadDirection() {
  if (directionDirty.value || !state.value) return
  const saved = state.value.controls.chapters[String(chapter.value)]
  if (saved) direction.value = structuredClone(toRaw(saved))
  else if (state.value.artifacts.some(a => a.name === `plan-${chapter.value}`)) {
    const selected = chapter.value
    const plan = (await getArtifact(`plan-${selected}`)).artifact.value as { title: string; guide: string }
    if (selected !== chapter.value || directionDirty.value || disposed) return
    direction.value = { ...plan, pov: '', pacing: 'balanced', focus: '', avoid: '' }
  } else direction.value = null
  directionRevision.value = state.value.controls.revision
}
async function selectArtifact(name: string, hash = '') {
  const request = ++selection
  artifactName.value = name; version.value = hash; evidence.value = []; compare.value = null
  const result = await getArtifact(name, hash)
  if (disposed || request !== selection) return
  artifact.value = result.artifact; versions.value = result.versions
  if (!located && Number.isInteger(targetParagraph) && targetParagraph >= 0) { await nextTick(); document.getElementById(`novel-p-${targetParagraph}`)?.scrollIntoView?.({ block: 'center' }); located = true }
  if (tab.value === 'evidence') await showEvidence()
  if (name.startsWith('review-') && state.value?.artifacts.some(a => a.name === name.replace('review-', 'write-'))) {
    const draft = await getArtifact(name.replace('review-', 'write-'))
    if (request === selection && !disposed) compare.value = draft.artifact
  }
}
async function chooseChapter(index: number) {
  if (directionDirty.value) { error.value = t('trpg.harness.unsaved'); return }
  followLatest.value = false
  chapter.value = index; direction.value = null
  try {
    await loadDirection()
    const available = chapterArtifacts.value
    const preferred = available.find(a => a.name === `chapter-${index}`) ?? available.filter(a => a.name.startsWith('review-')).sort((a, b) => Number(b.name.split('-')[1]) - Number(a.name.split('-')[1]))[0] ?? available[0]
    if (preferred) await selectArtifact(preferred.name)
  } catch { error.value = t('trpg.harness.failed') }
}
async function refresh() {
  try {
    const next = await writingRequest<NovelWorkbench>(`${base}/workbench`, profile)
    if (disposed) return
    state.value = next
    if (!settingsDirty.value) { settings.value = { ...structuredClone(next.controls.settings), targetChars: next.controls.settings.targetChars ?? next.job.targetChars }; settingsRevision.value = next.controls.revision }
    await loadDirection()
    await followArtifact(next)
    if (tab.value === 'evidence' && !evidence.value.length && sceneIndex.value >= 0) await showEvidence()
    if (artifactName.value && !artifact.value) {
      await selectArtifact(artifactName.value, version.value)
    } else if (artifactName.value && !version.value) {
      const meta = next.artifacts.find(a => a.name === artifactName.value)
      if (meta && meta.createdAt !== artifact.value?.createdAt) await selectArtifact(meta.name)
    } else if (!artifactName.value && next.artifacts.length) {
      const first = next.artifacts.find(a => a.name === `plan-${chapter.value}`) ?? next.artifacts[0]
      await selectArtifact(first.name)
    }
  } catch { if (!disposed) error.value = t('trpg.harness.failed') }
}
async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, 2500) }
async function control(action: 'pause' | 'resume' | 'cancel') {
  if (directionDirty.value || settingsDirty.value) { error.value = t('trpg.harness.unsaved'); return }
  busy.value = true; error.value = ''
  try { await writingRequest(`${base}/${action}`, profile, 'POST'); await refresh() }
  catch { error.value = t('trpg.harness.failed') }
  finally { busy.value = false }
}
async function edit(action: string, data: Record<string, unknown> = {}, revision = state.value?.controls.revision) {
  busy.value = true; error.value = ''
  try {
    const result = await writingRequest<{ controls: NovelWorkbench['controls'] }>(`${base}/controls`, profile, 'PATCH', { action, revision, ...data })
    // Our own successful edit advances both forms; another tab still produces a 409.
    if (directionRevision.value === revision) directionRevision.value = result.controls.revision
    if (settingsRevision.value === revision) settingsRevision.value = result.controls.revision
    if (action === 'chapter') directionDirty.value = false
    if (action === 'settings') settingsDirty.value = false
    await refresh()
  } catch (e) { error.value = t((e as { status?: number }).status === 409 ? 'trpg.harness.conflict' : 'trpg.harness.failed') }
  finally { busy.value = false }
}
async function loadModels() {
  try { catalog.value = writingCatalog(await writingRequest(`/api/hermes/available-models?${new URLSearchParams({ profile })}`, profile)) }
  catch { error.value = t('trpg.harness.modelLoadFailed') }
}
async function showEvidence() {
  tab.value = 'evidence'
  const scene = chapterLayout.value?.scenes.find(s => s.index === sceneIndex.value)
  if (!scene) return
  try { evidence.value = (await writingRequest<{ rows: typeof evidence.value }>(`${base}/evidence?from=${scene.from}&to=${scene.to}`, profile)).rows }
  catch { error.value = t('trpg.harness.failed') }
}
function safeSelect(name: string, hash = '') { followLatest.value = false; tab.value = 'prose'; void selectArtifact(name, hash).catch(() => { error.value = t('trpg.harness.failed') }) }
function discard() { directionDirty.value = false; settingsDirty.value = false; void refresh() }
onMounted(() => { document.title = t('trpg.harness.title'); window.addEventListener('beforeunload', beforeUnload); void poll() })
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); selection++; window.removeEventListener('beforeunload', beforeUnload) })
</script>
<template>
  <main class="novel-workbench" data-testid="novel-workbench" :data-theme="theme">
    <header class="workbench-header">
      <div><small>TRPG · {{ profile }}</small><h1>{{ t('trpg.harness.title') }}</h1><p>{{ t('trpg.harness.intro') }}</p></div>
      <div class="actions"><div class="theme-switch" :aria-label="t('trpg.harness.appearance')"><button v-for="mode in ['light', 'dark']" :key="mode" :aria-pressed="theme === mode" @click="setTheme(mode)">{{ t(`trpg.harness.${mode}`) }}</button></div><template v-if="state">
        <button v-if="running" :disabled="busy || state.job.pauseRequested" @click="control('pause')">{{ t(state.job.pauseRequested ? 'trpg.harness.pausing' : 'trpg.harness.pause') }}</button>
        <button v-if="!running && state.job.status !== 'completed'" :disabled="busy" @click="control('resume')">{{ t('trpg.recap.resumeJob') }}</button>
        <button v-if="running" :disabled="busy" @click="control('cancel')">{{ t('trpg.recap.cancelJob') }}</button>
        <a v-if="state.job.recapId" :href="recapBookUrl(meetingId, state.job.recapId, profile)" target="_blank" rel="noopener noreferrer">{{ t('trpg.recap.read') }}</a>
      </template></div>
    </header>
    <p v-if="error" class="feedback" role="alert">{{ error }}</p>
    <section v-if="state" class="status-band" aria-live="polite">
      <strong>{{ t(`trpg.recap.jobStatus.${state.job.status}`) }} · {{ t(`trpg.recap.jobStage.${state.job.stage}`) }}</strong>
      <NovelTokenUsage :usage="state.job.tokenUsage" />
      <span>{{ t('trpg.recap.jobProgress', { processed: state.job.processedSentences, total: state.job.totalSentences, reviewed: state.job.reviewed, scenes: state.job.scenes, chars: state.job.outputChars }) }}</span>
      <span v-if="state.job.currentStep">{{ label(state.job.currentStep.name) }} · {{ state.job.currentStep.model ? `${state.job.currentStep.model.provider} / ${state.job.currentStep.model.model}` : t('trpg.harness.profileDefault') }}</span>
      <span v-if="state.job.preparedChunks || state.job.preparedScenes">{{ t('trpg.harness.preparedProgress', { chunks: state.job.preparedChunks ?? 0, scenes: state.job.preparedScenes ?? 0 }) }}</span>
      <span v-if="state.job.scenes">{{ t('trpg.harness.canonProgress', { done: state.job.canonized ?? 0, total: state.job.scenes }) }}</span>
      <span v-for="step in state.job.activeSteps" :key="step.name" class="step-chip">{{ label(step.name) }} · {{ t('trpg.harness.attempt', { n: step.attempt }) }}</span>
      <span v-if="state.job.failure" class="failure-detail">{{ label(state.job.failure.step) }} · {{ state.job.failure.detail }} · {{ t('trpg.harness.attempt', { n: state.job.failure.attempt }) }}</span>
      <span v-if="state.job.error">{{ t('trpg.recap.jobError') }} ({{ state.job.error }})</span>
      <button v-if="!running && state.job.pauseReason === 'outline'" :disabled="busy || directionDirty || settingsDirty" @click="edit('approve-outline')">{{ t('trpg.harness.approveOutline') }}</button>
      <button v-if="!running && state.job.pauseReason === 'chapter'" :disabled="busy || directionDirty || settingsDirty" @click="edit('approve-chapter', { chapter: state.job.waitingChapter })">{{ t('trpg.harness.approveChapter') }}</button>
    </section>
    <div v-if="state" class="workbench-grid">
      <nav class="chapter-nav" :aria-label="t('trpg.harness.chapters')">
        <h2>{{ t('trpg.harness.chapters') }}</h2>
        <p v-if="!state.layout.length">{{ t('trpg.harness.waitOutline') }}</p>
        <button v-for="c in state.layout" :key="c.index" :class="{ selected: chapter === c.index }" @click="chooseChapter(c.index)">{{ t('trpg.harness.chapterNumber', { n: c.index + 1 }) }} <small>{{ c.scenes.length }} {{ t('trpg.harness.scenes') }}</small></button>
        <h2>{{ t('trpg.harness.materials') }}</h2>
        <details><summary>{{ t('trpg.harness.extractions') }}</summary><button v-for="a in state.artifacts.filter(a => (a.name.startsWith('extract-') || (!state?.layout.length && a.name.startsWith('canon-'))))" :key="a.name" @click="safeSelect(a.name)">{{ label(a.name) }}</button></details>
        <h2>{{ t('trpg.harness.activity') }}</h2>
        <ol class="events"><li v-for="(event, i) in [...state.events].reverse().slice(0, 25)" :key="i"><time>{{ new Date(event.at).toLocaleTimeString() }}</time> {{ t(`trpg.harness.eventType.${event.type}`) }}<small v-if="event.step">{{ label(event.step) }}</small></li></ol>
      </nav>
      <section class="manuscript">
        <section v-if="state.liveOutputs?.length" class="live-output" aria-live="off">
          <div class="live-heading"><h2>{{ t('trpg.harness.liveOutput') }}</h2><span class="live-dot" :class="{ streaming: running }"></span></div>
          <p class="hint">{{ t('trpg.harness.liveOutputHint') }}</p>
          <details v-for="output in state.liveOutputs" :key="output.step" open><summary>{{ label(output.step) }}</summary><pre>{{ output.text }}</pre></details>
        </section>
        <div class="artifact-heading"><h2>{{ t('trpg.harness.artifact') }}</h2><label class="follow-toggle"><input type="checkbox" :checked="followLatest" @change="setFollow(($event.target as HTMLInputElement).checked)" />{{ t('trpg.harness.followLatest') }}</label></div>
        <p class="hint">{{ t(followLatest ? 'trpg.harness.followHint' : 'trpg.harness.inspectHint') }}</p>
        <div class="artifact-groups" :aria-label="t('trpg.harness.artifact')">
          <section v-for="group in artifactGroups" :key="group.id" class="artifact-group">
            <h3>{{ t(`trpg.harness.artifactGroup.${group.id}`) }} <small>{{ group.items.length }}</small></h3>
            <div class="artifact-options"><button v-for="a in group.items" :key="a.name" :aria-pressed="artifactName === a.name" :class="{ selected: artifactName === a.name }" @click="safeSelect(a.name)">{{ label(a.name) }}</button></div>
          </section>
        </div>
        <div class="artifact-toolbar"><label>{{ t('trpg.harness.version') }}<select :value="version" @change="safeSelect(artifactName, ($event.target as HTMLSelectElement).value)"><option value="">{{ t('trpg.harness.currentVersion') }}</option><option v-for="v in versions" :key="v.inputHash" :value="v.inputHash">{{ new Date(v.createdAt).toLocaleString() }}</option></select></label></div>
        <div class="tabs"><button @click="tab = 'prose'">{{ t('trpg.harness.manuscript') }}</button><button :disabled="sceneIndex < 0" @click="followLatest = false; showEvidence()">{{ t('trpg.recap.evidence') }}</button><button @click="followLatest = false; tab = 'highlights'">{{ t('trpg.highlights.title') }}</button></div>
        <p v-if="artifact?.model" class="byline">{{ artifact.model.provider }} / {{ artifact.model.model }}</p>
        <HighlightWorkbench v-if="tab === 'highlights'" :meeting-id="meetingId" :profile="profile" :job-id="jobId || undefined" :focus-id="focusHighlight" embedded @use-for-writing="useVisual" />
        <template v-else>
        <p v-if="!artifact && tab === 'prose'">{{ t('trpg.harness.waitArtifact') }}</p>
        <template v-else-if="tab === 'prose'">
          <div :class="{ comparison: !!comparisonBody }">
            <article v-if="comparisonBody"><h3>{{ t('trpg.harness.draft') }}</h3><div class="prose">{{ comparisonBody }}</div></article>
            <article><h3>{{ label(artifactName) }}</h3><div v-if="content?.body" class="prose"><p v-for="(paragraph, i) in content.body.split(/\n\s*\n/)" :id="`novel-p-${i}`" :key="i" :class="{ 'matched-paragraph': i === targetParagraph && artifactName === query.get('artifact') }">{{ paragraph }}</p></div><div v-else-if="content?.events" class="ledger">
              <h4>{{ t('trpg.harness.events') }}</h4>
              <section v-for="event in content.events" :key="event.id"><strong>{{ event.id }} · {{ event.kind }}</strong><p>{{ event.fact }}</p><blockquote v-for="(cite, i) in event.evidence" :key="i">#{{ cite.index }} {{ cite.quote }}</blockquote></section>
              <h4>{{ t('trpg.harness.state') }}</h4><p v-for="(fact, i) in content.updates" :key="i">{{ fact.entity }} · {{ fact.attribute }}：{{ fact.value }}</p>
              <details><summary>{{ t('trpg.harness.omitted') }} ({{ content.omitted.length }})</summary><p v-for="row in content.omitted" :key="row.index">#{{ row.index }} {{ row.reason }}</p></details>
            </div>
            <div v-else-if="typeof content?.passed === 'boolean'" class="ledger">
              <strong :class="{ feedback: !content.passed }">{{ t(content.passed ? 'trpg.harness.passed' : 'trpg.harness.blocked') }}</strong>
              <p class="hint">{{ t('trpg.harness.consistencyHint') }}</p>
              <ul><li v-for="(issue, i) in content.issues" :key="i">{{ issue.detail }}</li></ul>
              <h4>{{ t('trpg.harness.coverage') }}</h4><blockquote v-for="item in content.coverage" :key="item.eventId">{{ item.eventId }} · {{ item.quote }}</blockquote>
            </div>
            <div v-else-if="content?.guide"><h3>{{ content.title }}</h3><p class="prose">{{ content.guide }}</p></div>
            <pre v-else>{{ JSON.stringify(content, null, 2) }}</pre></article>
          </div>
          <details v-if="content?.continuity"><summary>{{ t('trpg.harness.continuity') }}</summary><p class="prose">{{ content.continuity }}</p></details>
          <ul v-if="content?.warnings?.length"><li v-for="(note, i) in content.warnings" :key="i">{{ note }}</li></ul>
        </template>
        <ol v-else class="source"><li v-for="row in evidence" :key="row.index"><small>#{{ row.index }} · {{ row.speaker }}</small><p>{{ row.text }}</p></li></ol>
        </template>
      </section>
      <aside class="direction-panel">
        <h2>{{ t('trpg.harness.direction') }}</h2><p class="hint">{{ t('trpg.harness.editHint') }}</p>
        <fieldset v-if="direction" :disabled="running || busy" @input="directionDirty = true" @change="directionDirty = true">
          <label>{{ t('trpg.harness.chapterTitle') }}<input v-model="direction.title" maxlength="160" /></label>
          <label>{{ t('trpg.harness.guide') }}<textarea v-model="direction.guide" rows="6" maxlength="2500" /></label>
          <label>{{ t('trpg.harness.pov') }}<input v-model="direction.pov" maxlength="200" /></label>
          <label>{{ t('trpg.harness.pacing') }}<select v-model="direction.pacing"><option v-for="p in ['balanced', 'slow', 'fast']" :key="p" :value="p">{{ t(`trpg.harness.pace.${p}`) }}</option></select></label>
          <label>{{ t('trpg.harness.focus') }}<textarea v-model="direction.focus" rows="3" maxlength="1500" /></label>
          <label>{{ t('trpg.harness.avoid') }}<textarea v-model="direction.avoid" rows="3" maxlength="1500" /></label>
          <section v-if="direction.visualReferences?.length" class="visual-notes"><h3>{{ t('trpg.harness.visualNotes') }}</h3><p class="hint">{{ t('trpg.harness.visualHint') }}</p><label v-for="(reference, i) in direction.visualReferences" :key="reference.id"><textarea v-model="reference.description" rows="4" maxlength="1500" /><button type="button" @click="direction.visualReferences.splice(i, 1); directionDirty = true">{{ t('trpg.remove') }}</button></label></section>
          <label>{{ t('trpg.harness.chapterLength') }}<input type="number" min="500" max="60000" :value="direction.targetChars ?? ''" @input="direction.targetChars = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : undefined" /></label>
          <button :disabled="!directionDirty" @click="edit('chapter', { chapter, direction }, directionRevision)">{{ t('trpg.harness.saveDirection') }}</button>
          <button :disabled="directionDirty || settingsDirty" @click="edit('regenerate', { chapter })">{{ t('trpg.harness.regenerate') }}</button>
        </fieldset>
        <WritingSettingsEditor :model-value="settings" advanced :catalog="catalog" :disabled="running || busy" @load-models="loadModels" @update:model-value="value => { settings = value; settingsDirty = true }" />
        <button :disabled="running || busy || !settingsDirty" @click="edit('settings', { settings }, settingsRevision)">{{ t('trpg.harness.saveModels') }}</button>
        <button v-if="directionDirty || settingsDirty" :disabled="busy" @click="discard">{{ t('trpg.harness.discard') }}</button>
      </aside>
    </div>
  </main>
</template>
<style scoped>
.novel-workbench { min-height: 100vh; background: #181a1c; color: #e2e5e7; font: 14px/1.65 system-ui, sans-serif; }
.workbench-header { padding: 22px 30px; border-bottom: 1px solid #394047; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
h1 { font-size: 25px; margin: 2px 0; letter-spacing: .02em; } h2 { font-size: 15px; margin: 20px 0 10px; } h3 { font-size: 14px; opacity: .7; }
p { margin: 8px 0; } small,.hint,.byline { color: #aeb7bd; } .hint { font-size: 12px; }
.actions,.status-band,.tabs { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.status-band { padding: 14px 30px; background: #22292c; border-bottom: 1px solid #3b494b; font-size: 12px; }
.workbench-grid { display: grid; grid-template-columns: 200px minmax(300px, 1fr) 330px; min-height: calc(100vh - 175px); }
.chapter-nav,.direction-panel { padding: 12px 20px; } .chapter-nav { border-right: 1px solid #394047; } .direction-panel { border-left: 1px solid #394047; }
.chapter-nav button { display: block; width: 100%; margin: 8px 0; text-align: left; } .chapter-nav small { display: block; }
.selected { border-color: #a1c7b3; background: #34433c; }.events { padding-left: 0; list-style: none; font-size: 11px; } .events li { margin-bottom: 10px; } time { color: #93a3ac; }
.manuscript { padding: 22px 30px; min-width: 0; } .artifact-toolbar { display: flex; gap: 14px; flex-wrap: wrap; } .artifact-toolbar label { flex: 1; min-width: 160px; }
.ledger section { border-bottom: 1px solid #394047; padding: 10px 0; } blockquote { margin: 8px 0; padding-left: 14px; border-left: 2px solid #688b78; color: #bdc8c1; overflow-wrap: anywhere; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; font: 17px/2 Georgia, 'Noto Serif SC', serif; }
.comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; } .comparison article:first-child { opacity: .75; border-right: 1px solid #394047; padding-right: 20px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.7 monospace; }
label { display: grid; gap: 5px; margin-bottom: 13px; font-size: 12px; } fieldset { min-width: 0; padding: 0; border: 0; }
input,textarea,select { box-sizing: border-box; min-width: 0; width: 100%; color: inherit; background: #22272b; border: 1px solid #4b545b; border-radius: 5px; padding: 8px; font: inherit; }
button,a { display: inline-block; padding: 7px 11px; border: 1px solid #53675e; border-radius: 5px; background: #28362f; color: #e2eee6; cursor: pointer; text-decoration: none; font: inherit; }
button:disabled,fieldset:disabled { opacity: .5; cursor: default; } .feedback { margin: 0; padding: 12px 30px; background: #632e28; } .source { padding: 0; list-style: none; }
@media(max-width: 1100px) { .workbench-grid { grid-template-columns: 150px minmax(0,1fr); } .direction-panel { grid-column: 1 / -1; border-top: 1px solid #394047; } }
@media(max-width: 650px) { .workbench-grid,.comparison { display: block; } .chapter-nav { border-bottom: 1px solid #394047; }.workbench-header { display: block; }.manuscript { padding: 18px; } }
.workbench-header { background: radial-gradient(ellipse at 12% 0%, #42504566, transparent 65%), #171e1b; padding: 32px 36px; }
.workbench-header h1 { font-family: Georgia, 'Noto Serif SC', serif; font-size: 30px; color: #f1e5ce; }
.workbench-header small { letter-spacing: .16em; color: #bfa67b; }
.manuscript { background: #f2ecdf; color: #302d27; margin: 20px; border-radius: 12px; box-shadow: 0 12px 40px #0003; }
.manuscript .prose { max-width: 78ch; margin: 16px auto; line-height: 2.15; }
.manuscript .hint,.manuscript .byline { color: #6f7065; }
.manuscript select { background: #e8e1d2; color: #393c32; border-color: #b8b9a7; }
.manuscript button { background: #e2e5d7; color: #334338; border-color: #a6b59f; }
.manuscript blockquote { color: #5b6655; border-color: #78906a; background: #e5e8da; padding: 10px 16px; border-radius: 4px; }
.manuscript .tabs { border-bottom: 1px solid #ccc7b8; margin: 18px 0; padding-bottom: 14px; }
.chapter-nav { background: #1d2520; } .direction-panel { background: #202722; }
.chapter-nav button.selected { border-left: 3px solid #d0b784; }
.status-band { gap: 10px 20px; } .step-chip { border: 1px solid #6b8069; padding: 3px 10px; border-radius: 20px; }
.failure-detail { width: 100%; color: #f0c895; overflow-wrap: anywhere; }
.visual-notes { border-left: 2px solid #bfa67b; padding-left: 12px; }
button:focus-visible,a:focus-visible { outline: 2px solid #bcad77; outline-offset: 3px; }
@media(min-width: 1200px) { .chapter-nav,.direction-panel { max-height: calc(100vh - 150px); overflow-y: auto; position: sticky; top: 0; } }
@media(max-width: 650px) { .manuscript { margin: 12px; } .workbench-header { padding: 24px; } }
.manuscript .feedback { display: block; color: #fff2dd; border-radius: 6px; padding: 12px 16px; line-height: 1.5; }
fieldset:disabled { opacity: .75; }
.matched-paragraph { background: #e2ddaf; outline: 2px solid #9e9858; border-radius: 5px; padding: 8px 14px; scroll-margin-top: 40px; }

.novel-workbench { --canvas: #151c1b; --panel: #1e2925; --paper: #202a27; --text: #e5e9df; --muted: #a6b5a9; --line: #405149; --button: #2c3d33; --accent: #d4be8d; --quote: #2b3830; color-scheme: dark; background: var(--canvas); color: var(--text); }
.novel-workbench[data-theme="light"] { --canvas: #e9ede6; --panel: #f1f3eb; --paper: #fffdf6; --text: #2d382f; --muted: #62705e; --line: #c6d0c0; --button: #e1e8d9; --accent: #756039; --quote: #edf0e4; color-scheme: light; }
.workbench-header,.chapter-nav,.direction-panel,.status-band { background: var(--panel); border-color: var(--line); }
.workbench-header h1,.workbench-header small { color: var(--accent); }
small,.hint,.byline,time,.manuscript .hint,.manuscript .byline { color: var(--muted); }
.manuscript { background: var(--paper); color: var(--text); border: 1px solid var(--line); box-shadow: 0 12px 35px #00000012; }
.novel-workbench :deep(input),.novel-workbench :deep(textarea),.novel-workbench :deep(select) { color: var(--text); background: var(--canvas); border-color: var(--line); }
.novel-workbench :deep(button),.novel-workbench a { background: var(--button); color: var(--text); border-color: var(--line); }
.novel-workbench button[aria-pressed="true"],.novel-workbench .selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.manuscript blockquote { background: var(--quote); color: var(--muted); }
.manuscript .tabs,.ledger section,.comparison article:first-child { border-color: var(--line); }
.artifact-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }.artifact-heading h2 { margin: 0; }
.follow-toggle { display: flex; align-items: center; gap: 8px; margin: 0; cursor: pointer; }.follow-toggle input { width: auto; accent-color: var(--accent); }
.artifact-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 16px 0; max-height: 320px; overflow-y: auto; padding: 2px; }
.artifact-group { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }.artifact-group h3 { margin: 0 0 8px; opacity: 1; font-size: 12px; }.artifact-group h3 small { margin-left: 6px; }
.artifact-options { display: flex; gap: 6px; flex-wrap: wrap; }.artifact-options button { font-size: 12px; border-radius: 6px; padding: 5px 9px; }
.artifact-toolbar { justify-content: flex-end; }.artifact-toolbar label { flex: 0 1 240px; }
.theme-switch { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 9px; }.theme-switch button { border: 0; padding: 5px 10px; }
.novel-workbench[data-theme="light"] .failure-detail { color: #8c482b; }.novel-workbench[data-theme="dark"] .matched-paragraph { background: #4b4731; color: #fff1c9; }

.live-output { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px; padding: 14px 16px; margin-bottom: 22px; background: var(--quote); }.live-heading { display: flex; align-items: center; gap: 10px; }.live-heading h2 { margin: 0; }.live-output pre { max-height: 280px; overflow: auto; font-size: 12px; }.live-output summary { cursor: pointer; font-size: 12px; }.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }.streaming { animation: live-pulse 1.6s ease-in-out infinite; }@keyframes live-pulse { 50% { opacity: .3; } }@media(prefers-reduced-motion: reduce) { .streaming { animation: none; } }
@media(max-width: 650px) { .artifact-groups { grid-template-columns: 1fr; } }
</style>
