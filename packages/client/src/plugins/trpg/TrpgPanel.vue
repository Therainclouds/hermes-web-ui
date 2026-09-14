<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { request, getBaseUrlValue, getStoredUserId, getActiveProfileName } from '@/api/client'
import { listNovelJobs } from '@/api/hermes/meetings'
import { campaignStorage, snapshotCampaign, emptyCampaign, normalizeCampaign, scopedTranscript, scopeStats, type CharacterCard, type Highlight } from './storage'
import { highlightWorkbenchUrl } from './bookUrl'
import { generatedImageBlob, isSupportedImage } from './image-io'
import { describeImageFailure, requestImage } from './imageRequest'
import { cleanSheet } from '../../../../shared/trpg'
import RecapSection from './RecapSection.vue'
import CharacterEditor from './CharacterEditor.vue'
import DiceControls from './DiceControls.vue'
import HighlightGallery from './HighlightGallery.vue'
import GenerationSettings from './GenerationSettings.vue'
import './trpg.css'
const props = defineProps<{ sessionId: string; sentences: { text: string; speaker?: string; timestamp?: number }[] }>()
const { t } = useI18n()
const meetingStore = useMeetingStore()
// Start from a fully normalized record so settings are never undefined during the
// first render (the settings dialog is mounted even while the campaign loads).
const campaign = ref(normalizeCampaign(emptyCampaign()))
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref(''), stage = ref('')
const previews = ref<Record<string, string>>({}), sceneImages = ref<Record<string, string>>({})
const settingsOpen = ref(false)
const key = JSON.stringify([getBaseUrlValue(), getStoredUserId(), getActiveProfileName(), props.sessionId])
const abort = new AbortController()
let disposed = false
let saveQueue = Promise.resolve()
const asr = computed(() => campaign.value.asrSettings!)
const transcript = computed(() => scopedTranscript(props.sentences, asr.value.highlight))
const highlightStats = computed(() => scopeStats(props.sentences, asr.value.highlight))
const settings = computed(() => campaign.value.imageSettings!)
/**
 * Highlight manager target. With a long-novel job it opens that workbench on the
 * highlights tab; without one it falls back to the standalone highlights page.
 */
const latestJobId = ref('')
const manageHref = computed(() => highlightWorkbenchUrl(props.sessionId, getActiveProfileName() || 'default', latestJobId.value || undefined))
async function loadLatestJob() {
  try {
    const result = await listNovelJobs(props.sessionId)
    if (!disposed) latestJobId.value = result.jobs[0]?.id || ''
  } catch { /* the link still opens the standalone highlights workspace */ }
}

/** Browser-bridge failures (not logged in, human verification, timeout) must reach the user verbatim. */
function imageFailure(e: unknown): string {
  return describeImageFailure(e, t)
}

/** Localize a bridge progress key; unknown keys fall back to a generic label. */
function webStageLabel(stage: string): string {
  const key = `trpg.webStage.${stage}`
  const text = t(key)
  return text === key ? t('trpg.webStage.working') : text
}

const namedCharacters = computed(() => campaign.value.characters.filter(c => c.name.replace(/[【】\r\n]/g, '').trim()))
function add() {
  if (campaign.value.characters.length < 20) campaign.value.characters.push({ id: crypto.randomUUID(), name: '', player: '', appearance: '', card: '', sheet: {} })
}
function revoke(map: Record<string, string>, id: string) { if (map[id]) URL.revokeObjectURL(map[id]); delete map[id] }
function remove(id: string) { revoke(previews.value, id); campaign.value.characters = campaign.value.characters.filter(c => c.id !== id) }
function portrait(c: CharacterCard, file: File) { revoke(previews.value, c.id); c.image = file; c.imageName = file.name; previews.value[c.id] = URL.createObjectURL(file) }
function clearPortrait(c: CharacterCard) { revoke(previews.value, c.id); delete c.image; delete c.imageName }
function valid() {
  const names = namedCharacters.value.map(c => c.name.replace(/[【】\r\n]/g, '').trim())
  return campaign.value.characters.length <= 20 && names.every(n => n.length > 0 && n.length <= 80) && new Set(names).size === names.length
}
async function save() {
  error.value = ''; notice.value = ''
  if (!valid()) { error.value = t('trpg.invalid'); return false }
  const snapshot = snapshotCampaign(campaign.value)
  const pending = saveQueue.then(() => campaignStorage(key, snapshot))
  saveQueue = pending.then(() => undefined, () => undefined)
  try { await pending; if (!disposed) notice.value = t('trpg.saved'); return true }
  catch { if (!disposed) error.value = t('trpg.storageError'); return false }
}
async function renderImage(h: Highlight) {
  stage.value = t('trpg.painting')
  const options = { ...settings.value }
  const ids = new Set(h.actions.map(a => a.characterId))
  const references = options.useReferences
    ? campaign.value.characters.filter(c => ids.has(c.id) && c.image).map(c => ({ name: c.name.replace(/[【】\r\n]/g, '').trim(), blob: c.image as Blob }))
    : []
  const base64 = await requestImage(h.prompt, references, options, abort.signal, progress => { stage.value = webStageLabel(progress.stage) })
  if (disposed) return
  h.image = generatedImageBlob(base64)
  h.referenceNames = references.map(reference => `【${reference.name}】`)
  h.imageModel = options.useChatGptWeb ? t('trpg.chatGptWebBadge') : (options.model || t('trpg.profileDefault'))
  revoke(sceneImages.value, h.id); sceneImages.value[h.id] = URL.createObjectURL(h.image)
}
async function renderExisting(h: Highlight) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await renderImage(h); if (!disposed) await save() }
  catch (e) { if (!disposed) error.value = imageFailure(e) }
  finally { busy.value = false; stage.value = '' }
}
async function generate() {
  if (busy.value || !transcript.value.trim() || !namedCharacters.value.length) return
  error.value = ''; notice.value = ''
  const source = transcript.value
  busy.value = true; stage.value = t('trpg.generating')
  try {
    if (!await save() || disposed) return
    // 只有客户端三件套（key/base/model）齐全时才覆盖服务端配置；否则交给服务端
    // config.json 解析。避免把 MiniMax 的 key 配上 DashScope 的默认地址这种
    // "半套配置"发出去，导致上游 401/404 却只报"生成失败"。
    const llm = meetingStore.asrConfig
    const llmConfig = llm.llmApiKey.trim() && llm.llmBaseUrl.trim() && llm.llmModel.trim()
      ? { apiKey: llm.llmApiKey.trim(), baseUrl: llm.llmBaseUrl.trim(), model: llm.llmModel.trim() }
      : undefined
    const result = await request<{ prompt: string; actions: Highlight['actions'] }>('/api/plugins/trpg/highlight', {
      method: 'POST', signal: abort.signal,
      body: JSON.stringify({ transcript: source, llmConfig, setting: campaign.value.setting, style: campaign.value.style,
        characters: namedCharacters.value.map(({ id, name, player, appearance, card }) => ({ id, name, player, appearance, card })) }),
    })
    if (disposed) return
    const h: Highlight = { ...result, id: crypto.randomUUID(), createdAt: Date.now(), transcript: source, source: 'auto' }
    // Highlights are never trimmed: the gallery shows the newest 30 and expands
    // the rest, so an old scene image stays editable in the novel workbench.
    campaign.value.highlights.unshift(h)
    if (!await save()) return
    if (settings.value.enabled) {
      try { await renderImage(h); if (!disposed) await save() }
      catch (e) { if (!disposed) error.value = imageFailure(e) }
    }
  } catch (e) {
    if (!disposed) {
      const code = (e as { code?: string }).code ?? ''
      const detail = (e as { detail?: string }).detail ?? ''
      if (code === 'invalid_output' && detail) {
        const hintKey = `trpg.highlightInvalidDetail.${detail}`
        const hint = t(hintKey)
        error.value = hint === hintKey ? t('trpg.highlightInvalid') : `${t('trpg.highlightInvalid')}（${hint}）`
      } else {
        const key = code === 'llm_not_configured' ? 'meetingLlmMissing'
          : code === 'llm_config_invalid' ? 'llmConfigInvalid'
          : code === 'llm_unreachable' ? 'llmUnreachable'
          : code === 'invalid_output' ? 'highlightInvalid'
          : code === 'no_highlight' ? 'no_highlight'
          : 'generation_failed'
        error.value = t(`trpg.${key}`)
      }
    }
  } finally { busy.value = false; stage.value = '' }
}
async function removeHighlight(id: string) { revoke(sceneImages.value, id); campaign.value.highlights = campaign.value.highlights.filter(h => h.id !== id); await save() }
/**
 * Attach a locally produced image to a highlight.
 *
 * This is the fallback that keeps the panel usable when the bridge times out or
 * the model refuses: the user can generate or find the picture elsewhere and
 * drop it in. It replaces any generated image for the same highlight.
 */
async function uploadHighlight({ highlight, file }: { highlight: Highlight; file: File }) {
  error.value = ''; notice.value = ''
  if (!isSupportedImage(file)) { error.value = t('trpg.imageInvalid'); return }
  revoke(sceneImages.value, highlight.id)
  highlight.image = file
  highlight.imageName = file.name
  delete highlight.referenceNames
  highlight.imageModel = t('trpg.manualUpload')
  sceneImages.value[highlight.id] = URL.createObjectURL(file)
  await save()
}
onMounted(async () => {
  void loadLatestJob()
  try {
    const value = normalizeCampaign(await campaignStorage(key))
    if (disposed) return
    for (const c of value.characters) c.sheet = cleanSheet(c.sheet)
    campaign.value = value
    for (const c of value.characters) if (c.image) previews.value[c.id] = URL.createObjectURL(c.image)
    for (const h of value.highlights) if (h.image) sceneImages.value[h.id] = URL.createObjectURL(h.image)
    loading.value = false
  } catch { error.value = t('trpg.storageError') }
})
onBeforeUnmount(() => { disposed = true; abort.abort(); Object.keys(previews.value).forEach(id => revoke(previews.value, id)); Object.keys(sceneImages.value).forEach(id => revoke(sceneImages.value, id)) })
</script>
<template>
  <section class="trpg-workspace" data-testid="trpg-panel" :aria-busy="busy">
    <header class="campaign-banner"><span class="rune" aria-hidden="true">✧</span><div><small>{{ t('trpg.eyebrow') }}</small><h2>{{ t('trpg.workspaceTitle') }}</h2><p>{{ t('trpg.intro') }}</p></div></header>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="notice" class="feedback" role="status">{{ notice }}</p>
    <p v-if="loading">{{ t('trpg.loading') }}</p>
    <template v-else>
      <div class="scene-command"><div><span class="live-dot" />{{ t('trpg.asrContext') }} <b>{{ highlightStats.count }}</b> <small class="muted">/ {{ sentences.length }}</small></div><div class="scene-actions"><button class="settings-open" type="button" data-testid="trpg-settings-open" :aria-label="t('trpg.settings.open')" @click="settingsOpen = true">⚙ {{ t('trpg.settings.open') }}</button><button class="primary" type="button" :disabled="busy || !transcript.trim() || !namedCharacters.length" @click="generate">✧ {{ busy ? stage : t(settings.enabled ? 'trpg.generateImage' : 'trpg.generate') }}</button></div></div>
      <p v-if="!transcript.trim() || !namedCharacters.length" class="muted">{{ t(!namedCharacters.length ? 'trpg.needNamedCharacter' : 'trpg.empty') }}</p>
      <HighlightGallery :highlights="campaign.highlights" :images="sceneImages" :busy="busy" :direct="settings.enabled" :manage-href="manageHref" @remove="removeHighlight" @save="save" @render="renderExisting" @upload="uploadHighlight" />
      <RecapSection :meeting-id="sessionId" :sentences="sentences" :characters="campaign.characters" :setting="campaign.setting" :style="campaign.style" :asr-scope="asr.recap" :writing-settings="campaign.writingSettings" @update:writing-settings="value => { campaign.writingSettings = value; save() }" />
      <details class="utility-section"><summary>{{ t('trpg.sceneSettings') }}</summary><fieldset :disabled="busy"><label>{{ t('trpg.setting') }}<textarea v-model="campaign.setting" :aria-label="t('trpg.setting')" maxlength="3000" rows="3" /></label><label>{{ t('trpg.style') }}<input v-model="campaign.style" :aria-label="t('trpg.style')" maxlength="500" :placeholder="t('trpg.styleHint')" /></label></fieldset></details>
      <details class="utility-section"><summary>{{ t('trpg.imageSettings') }}<small>{{ t(settings.enabled ? 'trpg.on' : 'trpg.off') }}</small></summary>
        <fieldset :disabled="busy"><label class="check"><input v-model="settings.enabled" type="checkbox" />{{ t('trpg.directGeneration') }}</label><p class="muted">{{ t('trpg.imageSettingsHint') }}</p>
          <label class="check"><input v-model="settings.useChatGptWeb" data-testid="trpg-chatgpt-web" type="checkbox" />{{ t('trpg.chatGptWebToggle') }}</label>
          <p v-if="settings.useChatGptWeb" class="muted">{{ t('trpg.chatGptWebHint') }}</p>
          <label v-if="settings.useChatGptWeb">{{ t('trpg.chatGptWebProject') }}<input v-model="settings.chatGptWebProjectUrl" :aria-label="t('trpg.chatGptWebProject')" :placeholder="t('trpg.chatGptWebProjectPlaceholder')" maxlength="300" /></label>
          <div v-if="!settings.useChatGptWeb" class="field-grid"><label>{{ t('trpg.provider') }}<input v-model="settings.provider" :aria-label="t('trpg.provider')" :placeholder="t('trpg.profileDefault')" maxlength="150" /></label><label>{{ t('trpg.model') }}<input v-model="settings.model" :aria-label="t('trpg.model')" :placeholder="t('trpg.profileDefault')" maxlength="150" /></label>
            <label>{{ t('trpg.size') }}<select v-model="settings.size" :aria-label="t('trpg.size')"><option value="1536x1024">{{ t('trpg.landscape') }}</option><option value="1024x1024">{{ t('trpg.square') }}</option><option value="1024x1536">{{ t('trpg.portraitSize') }}</option></select></label><label>{{ t('trpg.quality') }}<select v-model="settings.quality" :aria-label="t('trpg.quality')"><option v-for="v in ['auto','low','medium','high']" :key="v" :value="v">{{ t(`trpg.quality_${v}`) }}</option></select></label></div>
          <label class="check"><input v-model="settings.useReferences" type="checkbox" />{{ t('trpg.useReferences') }}</label>
        </fieldset>
      </details>
      <section class="party-section"><header class="section-heading"><div><small>{{ t('trpg.partyEyebrow') }}</small><h3>{{ t('trpg.characters') }}</h3></div><button type="button" :disabled="busy || campaign.characters.length >= 20" @click="add">+ {{ t('trpg.add') }}</button></header>
        <CharacterEditor v-for="c in campaign.characters" :key="c.id" :card="c" :portrait="previews[c.id]" :disabled="busy" @remove="remove(c.id)" @portrait="portrait(c, $event)" @clear-portrait="clearPortrait(c)" />
      </section>
      <DiceControls v-model="campaign.cameraId" />
      <footer class="workspace-footer"><small>{{ t('trpg.localData') }}</small><button type="button" :disabled="busy" @click="save">{{ t('trpg.save') }}</button></footer>
    </template>
    <GenerationSettings
      v-model:show="settingsOpen"
      :meeting-id="sessionId"
      :sentences="sentences"
      :characters="campaign.characters"
      :asr="asr"
      :image-settings="settings"
      :style="campaign.style"
      :busy="busy"
      @changed="save"
      @generated="notice = t('trpg.chronicleImage.done')"
    />
  </section>
</template>
