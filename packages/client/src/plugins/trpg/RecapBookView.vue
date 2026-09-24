<script setup lang="ts">
/**
 * 编年史古籍阅读页（独立网页）。
 *
 * 由 `recap-book.html` + `recap-book-main.ts` 单独挂载，跑团面板在新标签页
 * 打开 `/recap-book.html?meetingId=..&recapId=..`。它不是 Hermes SPA 路由，
 * 因此这里只用 `location.search` 和 `bookApi`，不 import vue-router / 全局
 * 样式，页面自行铺满整个文档。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadRecap, loadRecapImage, loadRecapMarkdown } from './bookApi'
import { loadRoster, type RosterMember } from './roster'
import type { RecapEntry } from '../../../../shared/trpg-recap'
import type { BookImage } from './recapBook'
import ChronicleBook from './ChronicleBook.vue'

const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const
const COMBAT = ['armorClass', 'hpMax', 'speed', 'initiative', 'proficiencyBonus'] as const

const { t } = useI18n()
const query = new URLSearchParams(location.search)
const meetingId = query.get('meetingId') || ''
const recapId = query.get('recapId') || ''
const entry = ref<RecapEntry | null>(null)
const markdown = ref('')
const loading = ref(true)
const error = ref('')
const roster = ref<RosterMember[]>([])
const rosterOpen = ref(false)
const images = ref<BookImage[]>([])
let releaseRoster: (() => void) | null = null
let imageUrls: string[] = []

/**
 * Fetch every illustration the recap references and expose it as an object URL.
 * The bytes need the auth headers, so an `<img src>` cannot hit the endpoint
 * directly. A missing/failed image is skipped rather than failing the book.
 */
async function loadImages(found: RecapEntry) {
  imageUrls.forEach(url => URL.revokeObjectURL(url))
  imageUrls = []
  const loaded = await Promise.all((found.images || []).map(async (meta): Promise<BookImage | null> => {
    try {
      const blob = await loadRecapImage(meetingId, recapId, meta.kind, meta.chapterId)
      const url = URL.createObjectURL(blob)
      imageUrls.push(url)
      const chapter = meta.chapterId ? found.chapters.find(item => item.id === meta.chapterId) : undefined
      return { kind: meta.kind, chapterId: meta.chapterId, url, label: chapter?.title || meta.model || '' }
    } catch {
      return null
    }
  }))
  images.value = loaded.filter((image): image is BookImage => !!image)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    if (!meetingId || !recapId) {
      error.value = t('trpg.recap.bookFailed')
      return
    }
    const found = await loadRecap(meetingId, recapId)
    if (!found) {
      error.value = t('trpg.recap.bookFailed')
      return
    }
    entry.value = found
    markdown.value = await loadRecapMarkdown(meetingId, recapId)
    // Illustrations are optional decoration; never block reading on them.
    await loadImages(found).catch(() => { images.value = [] })
    // Avatars/stats are local-only; failure must not block reading.
    try {
      const loaded = await loadRoster(meetingId, found.characters || [])
      releaseRoster = loaded.revoke
      roster.value = loaded.members
    } catch {
      roster.value = []
    }
  } catch {
    error.value = t('trpg.recap.bookFailed')
  } finally {
    loading.value = false
  }
}

function back() {
  if (window.opener) window.close()
  else if (history.length > 1) history.back()
  else location.href = '/'
}

async function download() {
  if (!markdown.value) return
  try {
    const text = await loadRecapMarkdown(meetingId, recapId, true)
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${entry.value?.title || recapId}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch {
    error.value = t('trpg.recap.bookFailed')
  }
}

function initial(name: string): string {
  return (name || '?').trim().slice(0, 1)
}

onMounted(load)
onBeforeUnmount(() => { releaseRoster?.(); imageUrls.forEach(url => URL.revokeObjectURL(url)); imageUrls = [] })
</script>

<template>
  <div class="recap-book-view">
    <header class="recap-book-bar">
      <button type="button" class="bar-btn" @click="back">‹ {{ t('trpg.recap.back') }}</button>
      <div class="bar-title">
        <small>{{ t('trpg.recap.bookCover') }}</small>
        <strong>{{ entry?.title || '' }}</strong>
      </div>
      <button type="button" class="bar-btn" :disabled="!markdown" @click="download">{{ t('trpg.recap.download') }}</button>
    </header>

    <template v-if="!loading && !error">
      <!-- 左侧：人物名册（头像 + 基础属性） -->
      <button
        type="button"
        class="roster-tab"
        :class="{ 'roster-tab--open': rosterOpen }"
        :aria-expanded="rosterOpen"
        :aria-label="t('trpg.recap.roster')"
        @click="rosterOpen = !rosterOpen"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
          <circle cx="12" cy="10" r="2.2" />
          <path d="M8.5 16c.7-1.6 2-2.4 3.5-2.4s2.8.8 3.5 2.4" />
        </svg>
        <span>{{ t('trpg.recap.roster') }}</span>
      </button>

      <aside v-if="rosterOpen" class="roster-drawer" :aria-label="t('trpg.recap.roster')">
        <header class="roster-head">
          <div>
            <small>{{ t('trpg.recap.bookCover') }}</small>
            <h2>{{ t('trpg.recap.roster') }}</h2>
          </div>
          <button type="button" class="roster-close" :aria-label="t('trpg.recap.rosterClose')" @click="rosterOpen = false">×</button>
        </header>

        <p v-if="!roster.length" class="roster-empty">{{ t('trpg.recap.rosterEmpty') }}</p>

        <article v-for="member in roster" :key="member.id" class="roster-card">
          <div class="roster-portrait">
            <img v-if="member.imageUrl" :src="member.imageUrl" :alt="member.name" />
            <span v-else class="roster-initial">{{ initial(member.name) }}</span>
          </div>
          <div class="roster-body">
            <h3>{{ member.name || t('trpg.unnamed') }}</h3>
            <p v-if="member.player" class="roster-player">{{ t('trpg.recap.rosterPlayer') }} · {{ member.player }}</p>
            <p v-if="member.sheet.classLevel || member.sheet.race || member.sheet.alignment" class="roster-tags">
              <span v-if="member.sheet.classLevel">{{ member.sheet.classLevel }}</span>
              <span v-if="member.sheet.race">{{ member.sheet.race }}</span>
              <span v-if="member.sheet.alignment">{{ member.sheet.alignment }}</span>
            </p>

            <p class="roster-section">{{ t('trpg.recap.rosterAbilities') }}</p>
            <div class="roster-abilities">
              <div v-for="ability in ABILITIES" :key="ability">
                <small>{{ t(`trpg.fields.${ability}`) }}</small>
                <b>{{ member.sheet[ability] || '—' }}</b>
              </div>
            </div>

            <div class="roster-combat">
              <span v-for="key in COMBAT" :key="key">{{ t(`trpg.fields.${key}`) }} <b>{{ member.sheet[key] || '—' }}</b></span>
            </div>

            <p v-if="member.appearance" class="roster-appearance">
              <small>{{ t('trpg.recap.rosterAppearance') }}</small>{{ member.appearance }}
            </p>
          </div>
        </article>
      </aside>
    </template>

    <p v-if="loading" class="recap-book-state">{{ t('trpg.recap.bookLoading') }}</p>
    <p v-else-if="error" class="recap-book-state recap-book-state--error" role="alert">{{ error }}</p>
    <ChronicleBook
      v-else
      :markdown="markdown"
      :title="entry?.title || ''"
      :mode="entry?.mode"
      :tone="entry?.tone"
      :generated-at="entry?.generatedAt"
      :timeline="entry?.timeline || []"
      :chapters="(entry?.chapters || []).map(chapter => ({ id: chapter.id, title: chapter.title }))"
      :images="images"
    />
  </div>
</template>

<style scoped>
.recap-book-view {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #140d05;
  font-family: 'Ma Shan Zheng', 'ZCOOL KuaiLe', 'Kaiti SC', 'STKaiti', 'KaiTi', '楷体', serif;
}

.recap-book-bar {
  position: relative;
  z-index: 14;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 16px;
  color: #f0dcae;
  background: linear-gradient(180deg, rgba(38, 24, 10, 0.96), rgba(24, 15, 6, 0.92));
  border-bottom: 1px solid rgba(214, 178, 112, 0.32);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
}

.bar-title {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
  text-align: center;
}

.bar-title small {
  font-size: 10px;
  letter-spacing: 0.32em;
  color: rgba(233, 197, 121, 0.72);
}

.bar-title strong {
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
  font-size: 17px;
  letter-spacing: 0.1em;
}

.bar-btn {
  font: inherit;
  cursor: pointer;
  padding: 7px 14px;
  color: #efd9a4;
  background: linear-gradient(180deg, #4d3316, #2f1e0b);
  border: 1px solid rgba(214, 178, 112, 0.5);
  border-radius: 8px;
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.bar-btn:hover:not(:disabled) {
  border-color: #e9c579;
  transform: translateY(-1px);
}

.bar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.recap-book-state {
  flex: 1;
  display: grid;
  place-items: center;
  margin: 0;
  color: #e6cd96;
  letter-spacing: 0.22em;
}

.recap-book-state--error {
  color: #f0a99a;
  letter-spacing: 0.06em;
  text-align: center;
  padding: 0 24px;
}

/* 左侧名册按钮：挂在书页左缘的木牌 */
.roster-tab {
  position: fixed;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 16;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 9px;
  cursor: pointer;
  color: #f2dda6;
  font: inherit;
  font-size: 13px;
  letter-spacing: 0.16em;
  writing-mode: vertical-rl;
  background: linear-gradient(180deg, #5a3d1c, #33200c);
  border: 1px solid rgba(214, 178, 112, 0.55);
  border-left: 0;
  border-radius: 0 12px 12px 0;
  box-shadow: 4px 0 18px rgba(0, 0, 0, 0.45);
  transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}

.roster-tab:hover { border-color: #e9c579; transform: translateY(-50%) translateX(2px); }
.roster-tab--open { background: linear-gradient(180deg, #7a5426, #452c11); border-color: #e9c579; }
.roster-tab svg { writing-mode: horizontal-tb; }

/* 名册抽屉 */
.roster-drawer {
  position: fixed;
  left: 0;
  top: 54px;
  bottom: 0;
  z-index: 15;
  width: min(360px, 86vw);
  padding: 16px 16px 24px;
  overflow-y: auto;
  color: #3b2a16;
  background:
    radial-gradient(120% 90% at 20% 0%, #fdf3da 0%, rgba(253, 243, 218, 0) 55%),
    repeating-linear-gradient(0deg, rgba(122, 88, 42, 0.05) 0 2px, rgba(122, 88, 42, 0) 2px 5px),
    #ecdcb6;
  border-right: 1px solid rgba(120, 80, 30, 0.5);
  box-shadow: 12px 0 34px rgba(0, 0, 0, 0.55);
  animation: roster-in 0.3s cubic-bezier(0.22, 0.72, 0.2, 1) both;
}

@keyframes roster-in {
  from { opacity: 0; transform: translateX(-26px); }
  to { opacity: 1; transform: translateX(0); }
}

.roster-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid rgba(140, 90, 36, 0.4);
}

.roster-head small {
  display: block;
  font-size: 10px;
  letter-spacing: 0.3em;
  color: rgba(122, 74, 29, 0.8);
}

.roster-head h2 {
  margin: 2px 0 0;
  font-size: 22px;
  font-weight: 400;
  letter-spacing: 0.14em;
  color: #663813;
}

.roster-close {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  cursor: pointer;
  color: #663813;
  font-size: 22px;
  line-height: 1;
  background: transparent;
  border: 1px solid rgba(140, 90, 36, 0.45);
  border-radius: 8px;
}

.roster-close:hover { border-color: #a6321f; color: #a6321f; }

.roster-empty {
  margin: 24px 4px;
  font-size: 13px;
  line-height: 1.8;
  color: rgba(90, 60, 25, 0.75);
}

.roster-card {
  display: flex;
  gap: 14px;
  padding: 14px;
  margin-bottom: 14px;
  background: rgba(255, 250, 235, 0.5);
  border: 1px solid rgba(140, 90, 36, 0.38);
  border-radius: 12px;
  box-shadow: 0 3px 12px rgba(92, 58, 20, 0.14), inset 0 0 22px rgba(150, 105, 45, 0.12);
}

.roster-portrait {
  flex-shrink: 0;
  width: 84px;
  height: 84px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 10px;
  background: linear-gradient(150deg, #f6ead0, #dcc398);
  border: 2px solid rgba(120, 80, 30, 0.6);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), inset 0 0 14px rgba(150, 105, 45, 0.25);
}

.roster-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.roster-initial {
  font-size: 38px;
  color: #7a4a1d;
}

.roster-body { min-width: 0; flex: 1; }

.roster-body h3 {
  margin: 0;
  font-size: 20px;
  font-weight: 400;
  letter-spacing: 0.08em;
  color: #5a3210;
}

.roster-player {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: rgba(107, 74, 36, 0.9);
}

.roster-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
}

.roster-tags span {
  padding: 2px 8px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: #6b4420;
  background: rgba(166, 50, 31, 0.09);
  border: 1px solid rgba(166, 50, 31, 0.3);
  border-radius: 999px;
}

.roster-section {
  margin: 12px 0 6px;
  font-size: 11px;
  letter-spacing: 0.24em;
  color: rgba(122, 74, 29, 0.85);
}

.roster-abilities {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.roster-abilities > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 2px;
  background: rgba(166, 50, 31, 0.06);
  border: 1px solid rgba(140, 90, 36, 0.3);
  border-radius: 8px;
}

.roster-abilities small {
  font-size: 10px;
  color: rgba(107, 74, 36, 0.85);
}

.roster-abilities b {
  font-size: 20px;
  font-weight: 400;
  color: #4a2a0c;
  line-height: 1.2;
}

.roster-combat {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 10px;
  font-size: 12px;
  color: rgba(90, 60, 25, 0.95);
}

.roster-combat b { font-weight: 400; color: #a6321f; }

.roster-appearance {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: rgba(70, 48, 20, 0.95);
}

.roster-appearance small {
  display: block;
  font-size: 10px;
  letter-spacing: 0.2em;
  color: rgba(122, 74, 29, 0.8);
}

@media (max-width: 620px) {
  .roster-drawer { width: 92vw; }
}
</style>
