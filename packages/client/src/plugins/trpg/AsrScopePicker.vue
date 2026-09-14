<script setup lang="ts">
/**
 * ASR scope picker: decides which transcript slice a generation reads.
 *
 * The transcript arrives as a flat finalized-sentence list, which is unreadable
 * as a wall of text, so `buildParagraphs` groups it the way a listener would
 * (speaker change / pause / length) and the user ticks the paragraphs that
 * matter. The chosen paragraphs are stored as sentence ranges rather than
 * paragraph ids, so editing the transcript does not silently deselect them.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ASR_MAX_RECENT, ASR_RECENT_PRESETS, buildParagraphs, mergeSegments, scopeStats, type AsrScope, type Paragraph } from './storage'

const props = defineProps<{ sentences: { text: string; speaker?: string; timestamp?: number }[]; scope: AsrScope; legend: string }>()
const { t } = useI18n()
const expanded = ref(false)

const paragraphs = computed(() => buildParagraphs(props.sentences))
const stats = computed(() => scopeStats(props.sentences, props.scope))
const preview = computed(() => props.sentences.length ? '' : t('trpg.scope.empty'))

function selected(paragraph: Paragraph): boolean {
  return (props.scope.segments || []).some(segment => segment.from <= paragraph.from && segment.to >= paragraph.from)
}
function toggle(paragraph: Paragraph) {
  const segments = props.scope.segments || []
  if (selected(paragraph)) {
    const next: { from: number; to: number }[] = []
    for (const segment of segments) {
      if (segment.to < paragraph.from || segment.from > paragraph.to) next.push({ ...segment })
      else {
        if (segment.from < paragraph.from) next.push({ from: segment.from, to: paragraph.from - 1 })
        if (segment.to > paragraph.to) next.push({ from: paragraph.to + 1, to: segment.to })
      }
    }
    props.scope.segments = next
    return
  }
  props.scope.segments = mergeSegments([...segments, { from: paragraph.from, to: paragraph.to }], props.sentences.length)
}
function selectAll() { props.scope.segments = mergeSegments(paragraphs.value.map(p => ({ from: p.from, to: p.to })), props.sentences.length) }
function clearAll() { props.scope.segments = [] }
function setRecent(value: unknown) {
  const count = Math.trunc(Number(value))
  if (!Number.isFinite(count)) return
  props.scope.recentCount = Math.max(1, Math.min(count, ASR_MAX_RECENT))
}
</script>

<template>
  <fieldset class="scope-picker">
    <legend>{{ legend }}</legend>
    <p class="scope-stats">{{ t('trpg.scope.stats', { sentences: stats.count, chars: stats.chars }) }}<span v-if="preview"> · {{ preview }}</span></p>
    <div class="scope-modes">
      <label class="check"><input v-model="scope.mode" type="radio" value="all" />{{ t('trpg.scope.modeAll') }}</label>
      <label class="check"><input v-model="scope.mode" type="radio" value="recent" />{{ t('trpg.scope.modeRecent') }}</label>
      <label class="check"><input v-model="scope.mode" type="radio" value="segments" />{{ t('trpg.scope.modeSegments') }}</label>
    </div>

    <div v-if="scope.mode === 'recent'" class="scope-recent">
      <label>{{ t('trpg.scope.recentCount') }}<input :value="scope.recentCount" type="number" min="1" :max="ASR_MAX_RECENT" :aria-label="t('trpg.scope.recentCount')" @change="setRecent(($event.target as HTMLInputElement).value)" /></label>
      <button v-for="preset in ASR_RECENT_PRESETS" :key="preset" type="button" class="scope-preset" :class="{ 'is-active': scope.recentCount === preset }" @click="scope.recentCount = preset">{{ preset }}</button>
    </div>

    <template v-if="scope.mode === 'segments'">
      <div class="scope-segments-head"><button type="button" @click="selectAll">{{ t('trpg.scope.selectAll') }}</button><button type="button" @click="clearAll">{{ t('trpg.scope.clear') }}</button><small>{{ t('trpg.scope.selected', { count: (scope.segments || []).length }) }}</small></div>
      <p v-if="!paragraphs.length" class="muted">{{ t('trpg.scope.empty') }}</p>
      <div v-else class="scope-paragraphs" :class="{ 'is-expanded': expanded }">
        <label v-for="paragraph in paragraphs" :key="paragraph.id" class="scope-paragraph">
          <input type="checkbox" :checked="selected(paragraph)" @change="toggle(paragraph)" />
          <span class="scope-paragraph__body"><small>{{ paragraph.speaker || t('trpg.scope.noSpeaker') }} · {{ t('trpg.scope.range', { from: paragraph.from + 1, to: paragraph.to + 1 }) }}</small><span class="scope-paragraph__text">{{ paragraph.preview }}</span></span>
        </label>
      </div>
      <button v-if="paragraphs.length" type="button" class="scope-toggle" @click="expanded = !expanded">{{ t(expanded ? 'trpg.scope.collapse' : 'trpg.scope.expand', { count: paragraphs.length }) }}</button>
    </template>
  </fieldset>
</template>

<style scoped>
.scope-picker { border: 1px solid #ad89573b; border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; }
legend { padding: 0 6px; color: #e7cb91; letter-spacing: .08em; }
.scope-stats { margin: 4px 0 8px; opacity: .72; font-size: 12px; }
.scope-modes { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 8px; }
.scope-recent { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.scope-recent input[type='number'] { width: 90px; }
.scope-preset { padding: 4px 10px; border-radius: 999px; border: 1px solid #ad895766; background: transparent; color: inherit; cursor: pointer; }
.scope-preset.is-active { border-color: #e9c579; background: #3b352b; }
.scope-segments-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.scope-segments-head button { padding: 3px 10px; border-radius: 6px; border: 1px solid #ad895766; background: transparent; color: inherit; cursor: pointer; }
.scope-paragraphs { display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
.scope-paragraphs.is-expanded { max-height: 320px; }
.scope-paragraph { display: flex; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.scope-paragraph:hover { background: #ad89571f; }
.scope-paragraph__body { display: flex; flex-direction: column; min-width: 0; }
.scope-paragraph__body small { opacity: .6; font-size: 11px; }
.scope-paragraph__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
.scope-toggle { margin-top: 6px; background: transparent; border: 0; color: #d9ba78; cursor: pointer; text-decoration: underline; }
</style>
