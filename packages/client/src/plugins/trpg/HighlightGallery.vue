<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { HIGHLIGHT_RECENT_LIMIT, type Highlight } from './storage'
const props = defineProps<{ highlights: Highlight[]; images: Record<string, string>; busy: boolean; direct: boolean; manageHref?: string }>()
const emit = defineEmits<{ remove: [id: string]; save: []; render: [highlight: Highlight]; upload: [payload: { highlight: Highlight; file: File }] }>()
const { t } = useI18n()
const selected = ref<string | null>(null), copyError = ref(''), expanded = ref(false)
/** Newest 30 by default; earlier cards stay reachable behind one toggle. */
const shown = computed(() => expanded.value ? props.highlights : props.highlights.slice(0, HIGHLIGHT_RECENT_LIMIT))
const hasOlder = computed(() => props.highlights.length > HIGHLIGHT_RECENT_LIMIT)
const current = computed(() => props.highlights.find(h => h.id === selected.value))
const show = computed({ get: () => !!current.value, set: value => { if (!value) selected.value = null } })
/** Deep link into the highlight manager, focused on one card when possible. */
function manageHrefFor(highlight?: Highlight) {
  if (!props.manageHref) return ''
  return highlight ? `${props.manageHref}&highlight=${encodeURIComponent(highlight.id)}` : props.manageHref
}
async function copy() { try { await navigator.clipboard.writeText(current.value?.prompt || ''); copyError.value = t('trpg.copied') } catch { copyError.value = t('trpg.copyError') } }
/** Hand the picked file to the panel, which validates, stores and persists it. */
function pick(event: Event, highlight: Highlight) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset so picking the same file again still fires a change event.
  input.value = ''
  if (file) emit('upload', { highlight, file })
}
</script>
<template>
  <section class="gallery-section">
    <header class="section-heading">
      <h3>{{ t('trpg.history') }}</h3>
      <div class="gallery-head-actions">
        <span class="count">{{ shown.length }} / {{ highlights.length }}</span>
        <a v-if="manageHref" class="quiet gallery-manage" :href="manageHrefFor()" target="_blank" rel="noopener noreferrer">{{ t('trpg.highlights.manage') }}</a>
      </div>
    </header>
    <div v-if="!highlights.length" class="gallery-empty"><span aria-hidden="true">✧</span><h4>{{ t('trpg.waitingScene') }}</h4><p>{{ t('trpg.galleryHint') }}</p></div>
    <div v-else class="highlight-grid">
      <article v-for="(h, i) in shown" :key="h.id" class="highlight-card" :class="{ latest: i === 0, older: i >= HIGHLIGHT_RECENT_LIMIT }">
        <button type="button" class="scene-image" :aria-label="t('trpg.enlarge')" @click="selected = h.id; copyError = ''">
          <img v-if="images[h.id]" :src="images[h.id]" :alt="h.title || `${t('trpg.scene')} ${highlights.length - i}`" />
          <span v-else class="prompt-tile"><span aria-hidden="true">◇</span>{{ t('trpg.promptReady') }}</span>
          <span class="image-caption">{{ h.title || (i === 0 ? t('trpg.currentScene') : t('trpg.scene')) }} · {{ new Date(h.createdAt).toLocaleTimeString() }} <span>↗</span></span>
          <span v-if="i >= HIGHLIGHT_RECENT_LIMIT" class="older-badge">{{ t('trpg.highlights.older') }}</span>
        </button>
        <div class="scene-footer">
          <small>{{ h.imageName || h.referenceNames?.join(' · ') || t('trpg.noReferences') }}</small>
          <div class="scene-footer-actions">
            <a v-if="manageHref && i >= HIGHLIGHT_RECENT_LIMIT" class="quiet scene-manage" :href="manageHrefFor(h)" target="_blank" rel="noopener noreferrer">{{ t('trpg.highlights.illustrate') }}</a>
            <label class="quiet scene-upload">
              {{ t(h.image ? 'trpg.replaceImage' : 'trpg.uploadImage') }}
              <input type="file" accept="image/png,image/jpeg,image/webp" :aria-label="t('trpg.uploadImage')" :disabled="busy" @change="pick($event, h)" />
            </label>
            <button type="button" class="quiet" :disabled="busy" @click="emit('remove', h.id)">{{ t('trpg.remove') }}</button>
          </div>
        </div>
      </article>
    </div>
    <button v-if="hasOlder" type="button" class="quiet gallery-more" @click="expanded = !expanded">
      {{ t(expanded ? 'trpg.highlights.showRecent' : 'trpg.highlights.showOlder', { count: highlights.length - HIGHLIGHT_RECENT_LIMIT }) }}
    </button>
    <NModal v-model:show="show" preset="card" :title="t('trpg.sceneDetails')" class="trpg-workspace trpg-lightbox" :style="{ width: 'min(1080px, 94vw)' }">
      <div v-if="current" class="lightbox-content">
        <img v-if="images[current.id]" class="full-image" :src="images[current.id]" :alt="t('trpg.scene')" />
        <div class="actions">
          <a v-if="images[current.id]" :href="images[current.id]" :download="`trpg-${current.id}.${current.image?.type === 'image/jpeg' ? 'jpg' : current.image?.type === 'image/webp' ? 'webp' : 'png'}`">{{ t('trpg.downloadImage') }}</a>
          <button v-if="direct && !current.image" type="button" :disabled="busy" @click="emit('render', current)">{{ t('trpg.generateImage') }}</button>
          <label class="quiet scene-upload" :class="{ primary: !current.image }">
            {{ t(current.image ? 'trpg.replaceImage' : 'trpg.uploadImage') }}
            <input type="file" accept="image/png,image/jpeg,image/webp" :aria-label="t('trpg.uploadImage')" :disabled="busy" @change="pick($event, current)" />
          </label>
        </div>
        <label>{{ t('trpg.highlights.note') }}<input v-model="current.title" :disabled="busy" :aria-label="t('trpg.highlights.note')" maxlength="120" /></label>
        <label>{{ t('trpg.imagePrompt') }}<textarea v-model="current.prompt" :disabled="busy" :aria-label="t('trpg.imagePrompt')" rows="6" maxlength="20000" /></label>
        <div class="actions"><button type="button" @click="copy">{{ t('trpg.copy') }}</button><button type="button" :disabled="busy" @click="emit('save')">{{ t('trpg.save') }}</button></div>
        <p v-if="copyError" role="status">{{ copyError }}</p>
        <details class="sheet-group"><summary>{{ t('trpg.evidence') }}</summary><p v-for="(a, i) in current.actions" :key="i">{{ a.name }}：{{ a.evidence }}</p></details>
        <p class="muted">{{ current.imageModel }} · {{ current.imageName || current.referenceNames?.join(' · ') }}</p>
      </div>
    </NModal>
  </section>
</template>
<style scoped>
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.gallery-head-actions { display: flex; align-items: center; gap: 10px; }
.gallery-manage, .scene-manage { color: inherit; text-decoration: none; }
.gallery-manage:hover, .scene-manage:hover { text-decoration: underline; }
.gallery-more { display: block; width: 100%; margin-top: 10px; }
.highlight-card.older { opacity: 0.88; }
.older-badge { position: absolute; top: 6px; left: 6px; padding: 1px 7px; font-size: 10px; letter-spacing: 0.08em; border-radius: 999px; background: rgba(0, 0, 0, 0.55); color: #f0dcae; }
.scene-footer-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.scene-upload { display: inline-flex; align-items: center; cursor: pointer; }
.scene-upload input[type='file'] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
