<script setup lang="ts">
/**
 * 生成设置弹窗（TRPG 面板右上角的「设置」按钮打开）。
 *
 * 一个入口集中三件事：
 *  1. 高光取的 ASR 范围（最近 N 句 / 指定段落）；
 *  2. 编年史取的 ASR 范围（默认全部）；
 *  3. 直接用当前生图设置生成编年史的封面或章节配图。
 *
 * 设置直接改 `campaign.asrSettings`（响应式对象），关闭时面板统一保存；
 * 配图上传到服务端编年史目录，阅读页据此在书本右侧显示。
 */
import { computed, ref, watch } from 'vue'
import { NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listRecaps, saveRecapImage } from '@/api/hermes/meetings'
import type { RecapEntry, RecapImageKind } from '../../../../shared/trpg-recap'
import { generatedImageBlob } from './image-io'
import { describeImageFailure, requestImage } from './imageRequest'
import { buildChronicleImagePrompt, chronicleCast, chronicleReferences } from './chronicle-image'
import type { AsrSettings, CharacterCard, ImageSettings } from './storage'
import AsrScopePicker from './AsrScopePicker.vue'

const props = defineProps<{
  show: boolean
  meetingId: string
  sentences: { text: string; speaker?: string; timestamp?: number }[]
  characters: CharacterCard[]
  asr: AsrSettings
  imageSettings: ImageSettings
  style: string
  busy: boolean
}>()
const emit = defineEmits<{ 'update:show': [value: boolean]; changed: []; generated: [payload: { recapId: string; kind: RecapImageKind }] }>()
const { t } = useI18n()

const visible = computed({ get: () => props.show, set: value => emit('update:show', value) })
const recaps = ref<RecapEntry[]>([]), loading = ref(false), loadError = ref('')
const selectedId = ref(''), kind = ref<RecapImageKind>('cover'), chapterId = ref('')
const generating = ref(false), imageError = ref(''), imageOk = ref(''), imageStage = ref('')

/** Localize a bridge progress key; unknown keys fall back to a generic label. */
function webStageLabel(stage: string): string {
  const key = `trpg.webStage.${stage}`
  const text = t(key)
  return text === key ? t('trpg.webStage.working') : text
}

const selected = computed(() => recaps.value.find(entry => entry.id === selectedId.value) || null)
const chapters = computed(() => selected.value?.chapters || [])
const currentImage = computed(() => {
  const entry = selected.value
  if (!entry) return null
  const wanted = kind.value === 'content' ? chapterId.value : ''
  return (entry.images || []).find(image => image.kind === kind.value && (image.chapterId || '') === wanted) || null
})

async function refresh() {
  loading.value = true; loadError.value = ''
  try {
    const result = await listRecaps(props.meetingId)
    recaps.value = result.recaps
    if (!recaps.value.some(entry => entry.id === selectedId.value)) selectedId.value = recaps.value[0]?.id || ''
  } catch {
    loadError.value = t('trpg.recap.failed')
  } finally { loading.value = false }
}
/** Keep the chapter selection valid whenever the chosen chronicle or slot changes. */
watch([selectedId, kind, chapters], () => {
  if (kind.value !== 'content') { chapterId.value = ''; return }
  if (!chapters.value.some(chapter => chapter.id === chapterId.value)) chapterId.value = chapters.value[0]?.id || ''
})
watch(() => props.show, value => { if (value) void refresh() })
// Any close path (footer button, built-in ×, mask click, Escape) must persist the
// mutated scope settings, so emit on the visible edge rather than on one button.
watch(visible, value => { if (!value) emit('changed') })

function close() { visible.value = false }

async function generateImage() {
  const entry = selected.value
  if (!entry || generating.value || props.busy) return
  generating.value = true; imageError.value = ''; imageOk.value = ''; imageStage.value = ''
  try {
    const chapter = kind.value === 'content' ? (chapterId.value || undefined) : undefined
    const cast = chronicleCast(entry, kind.value, chapter, props.characters)
    const prompt = buildChronicleImagePrompt(entry, kind.value, chapter, cast, props.style)
    const base64 = await requestImage(prompt, chronicleReferences(cast), props.imageSettings, undefined, progress => { imageStage.value = webStageLabel(progress.stage) })
    imageStage.value = ''
    const blob = generatedImageBlob(base64)
    const model = props.imageSettings.useChatGptWeb ? t('trpg.chatGptWebBadge') : (props.imageSettings.model || t('trpg.profileDefault'))
    const { image } = await saveRecapImage(props.meetingId, entry.id, { kind: kind.value, chapterId: chapter, mime: blob.type as 'image/png' | 'image/jpeg' | 'image/webp', dataBase64: base64, model, prompt })
    entry.images = [...(entry.images || []).filter(existing => !(existing.kind === image.kind && (existing.chapterId || '') === (image.chapterId || ''))), image]
    imageOk.value = t('trpg.chronicleImage.done')
    emit('generated', { recapId: entry.id, kind: image.kind })
  } catch (error) {
    imageError.value = describeImageFailure(error, t)
  } finally { generating.value = false; imageStage.value = '' }
}

defineExpose<{ refresh: () => Promise<void> }>({ refresh })
</script>

<template>
  <NModal v-model:show="visible" preset="card" class="trpg-workspace generation-settings" :title="t('trpg.settings.title')" :style="{ width: 'min(720px, 94vw)' }" @close="close">
    <p class="muted">{{ t('trpg.settings.hint') }}</p>
    <div class="settings-scroll">
      <AsrScopePicker :sentences="sentences" :scope="asr.highlight" :legend="t('trpg.settings.highlightScope')" />
      <AsrScopePicker :sentences="sentences" :scope="asr.recap" :legend="t('trpg.settings.recapScope')" />

      <fieldset class="chronicle-image" :disabled="busy || generating">
        <legend>{{ t('trpg.chronicleImage.title') }}</legend>
        <p class="muted">{{ t('trpg.chronicleImage.hint') }}</p>
        <p v-if="loading" class="muted">{{ t('trpg.loading') }}</p>
        <p v-else-if="loadError" class="feedback error" role="alert">{{ loadError }}</p>
        <p v-else-if="!recaps.length" class="muted">{{ t('trpg.recap.empty') }}</p>
        <template v-else>
          <div class="field-grid">
            <label>{{ t('trpg.chronicleImage.recap') }}<select v-model="selectedId" :aria-label="t('trpg.chronicleImage.recap')"><option v-for="entry in recaps" :key="entry.id" :value="entry.id">{{ entry.title }}</option></select></label>
            <label>{{ t('trpg.chronicleImage.kind') }}<select v-model="kind" :aria-label="t('trpg.chronicleImage.kind')"><option value="cover">{{ t('trpg.chronicleImage.cover') }}</option><option value="content">{{ t('trpg.chronicleImage.content') }}</option></select></label>
            <label v-if="kind === 'content'">{{ t('trpg.chronicleImage.chapter') }}<select v-model="chapterId" :aria-label="t('trpg.chronicleImage.chapter')"><option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.title }}</option></select></label>
          </div>
          <p v-if="currentImage" class="muted">{{ t('trpg.chronicleImage.exists', { model: currentImage.model || t('trpg.profileDefault') }) }}</p>
          <p v-else class="muted">{{ t('trpg.chronicleImage.missing') }}</p>
          <div class="section-heading">
            <button type="button" class="primary" :disabled="generating || !selected" @click="generateImage">{{ t(generating ? 'trpg.chronicleImage.generating' : 'trpg.chronicleImage.generate') }}</button>
            <small class="muted">{{ t(imageSettings.useChatGptWeb ? 'trpg.chronicleImage.viaWeb' : 'trpg.chronicleImage.viaApi') }}</small>
          </div>
          <p v-if="generating && imageStage" class="muted" role="status" data-testid="chronicle-image-stage">{{ imageStage }}</p>
          <p v-if="imageError" class="feedback error" role="alert">{{ imageError }}</p>
          <p v-if="imageOk" class="feedback" role="status">{{ imageOk }}</p>
        </template>
      </fieldset>
    </div>
    <template #footer><div class="settings-footer"><button type="button" @click="close">{{ t('trpg.settings.close') }}</button></div></template>
  </NModal>
</template>

<style scoped>
.settings-scroll { max-height: min(62vh, 620px); overflow-y: auto; padding-inline-end: 4px; }
.chronicle-image { border: 1px solid #ad89573b; border-radius: 10px; padding: 10px 12px; margin: 0; }
legend { padding: 0 6px; color: #e7cb91; letter-spacing: .08em; }
.settings-footer { display: flex; justify-content: flex-end; }
</style>
