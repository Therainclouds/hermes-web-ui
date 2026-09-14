<script setup lang="ts">
/**
 * 古籍阅读器：把编年史 Markdown 渲染成一本可翻的线装书。
 *
 * 分页优先用隐藏的度量容器真实测量（`.book-measure` 与 `.page-content`
 * 共享同一套排版类），度量不可用时退回字符预算分页。
 *
 * 翻页统一为一个 0→1 的进度模型：叶子绕书脊/外缘做 rotateY，进度由鼠标
 * 拖拽直接驱动（纸张跟随指针），松手后按阈值用缓动过渡补完或弹回；点击、
 * 方向键、底部按钮走同一模型自动补完。宽屏双页对开，窄屏单页。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type MarkdownIt from 'markdown-it'
import MarkdownItConstructor from 'markdown-it'
import { paginateByLength, splitBlocks, splitChronicle, splitLongBlock, splitSentences, type BookImage, type BookPage, type TimelineRow } from './recapBook'
import BookFace from './BookFace'
import './recap-book.css'

const props = withDefaults(defineProps<{
  markdown: string
  title: string
  mode?: string
  tone?: string
  generatedAt?: number
  timeline?: TimelineRow[]
  /** Chapter ids paired with the markdown chapters, in document order. */
  chapters?: { id: string; title: string }[]
  /** Chronicle illustrations to show beside the book. */
  images?: BookImage[]
}>(), { mode: 'literary', tone: 'epic', generatedAt: 0, timeline: () => [], chapters: () => [], images: () => [] })

const { t, locale } = useI18n()
const md: MarkdownIt = new MarkdownItConstructor({ html: false, breaks: true, linkify: false, typographer: false })

const SPREAD_MIN = 820
const DRAG_THRESHOLD_PX = 8
const COMMIT_AT = 0.36
const SETTLE_MS = 720
const BLANK: BookPage = { variant: 'blank' }

interface Turn { dir: 'next' | 'prev'; progress: number; settling: boolean }

const scene = ref<HTMLElement | null>(null)
const measurer = ref<HTMLElement | null>(null)
const pages = ref<BookPage[]>([])
const chapterPages = ref<{ id?: string; title: string; index: number }[]>([])
const spread = ref(0)
const single = ref(false)
const turn = ref<Turn | null>(null)
const ready = ref(false)
const tocOpen = ref(false)
const showImage = ref(false)
const pageW = ref(420)
const pageH = ref(620)
const padPx = ref(36)
const fontSize = ref(18)
let observer: ResizeObserver | null = null
let frame = 0
let settleTimer = 0
let disposed = false
let drag: { id: number; startX: number; startY: number; dir: 'next' | 'prev' | null; decided: boolean; aborted: boolean } | null = null

const sceneStyle = computed(() => ({
  '--page-w': `${pageW.value}px`,
  '--page-h': `${pageH.value}px`,
  '--page-pad': `${padPx.value}px`,
  '--page-font-size': `${fontSize.value}px`,
}))

/** With one page on screen `spread` is a page index, otherwise a spread index. */
const maxIndex = computed(() => single.value ? Math.max(0, pages.value.length - 1) : Math.max(0, Math.ceil(pages.value.length / 2) - 1))
const canPrev = computed(() => !turn.value && spread.value > 0)
const canNext = computed(() => !turn.value && spread.value < maxIndex.value)

const pageAt = (index: number): BookPage => pages.value[index] || BLANK

const singleBase = computed(() => {
  if (turn.value?.dir === 'next') return pageAt(spread.value + 1)
  if (turn.value?.dir === 'prev') return pageAt(spread.value - 1)
  return pageAt(spread.value)
})
const singleLeaf = computed(() => pageAt(spread.value))

const leftPage = computed(() => turn.value?.dir === 'prev' ? pageAt(spread.value * 2 - 2) : pageAt(spread.value * 2))
const rightPage = computed(() => turn.value?.dir === 'next' ? pageAt(spread.value * 2 + 3) : pageAt(spread.value * 2 + 1))
const leafFront = computed(() => turn.value?.dir === 'prev' ? pageAt(spread.value * 2) : pageAt(spread.value * 2 + 1))
const leafBack = computed(() => turn.value?.dir === 'prev' ? pageAt(spread.value * 2 - 1) : pageAt(spread.value * 2 + 2))

const leafClass = computed(() => [
  turn.value?.dir === 'next' ? 'leaf--next' : 'leaf--prev',
  turn.value?.settling ? 'leaf--settling' : '',
])
/** Paper follows the pointer: rotateY straight from drag progress, plus a small lift. */
const leafStyle = computed(() => {
  const current = turn.value
  if (!current) return {}
  const angle = current.dir === 'next' ? -180 * current.progress : 180 * current.progress
  const lift = Math.sin(Math.PI * current.progress) * 26
  return { transform: `translateZ(${lift.toFixed(2)}px) rotateY(${angle.toFixed(2)}deg)` }
})
const turnAmount = computed(() => turn.value ? Math.sin(Math.PI * turn.value.progress) : 0)
const sheenStyle = computed(() => ({ opacity: (turnAmount.value * 0.8).toFixed(3) }))
const shadowStyle = computed(() => ({ opacity: (turnAmount.value * 0.55).toFixed(3) }))

const modeLabel = computed(() => t(`trpg.recap.${props.mode}`))
const toneLabel = computed(() => t(`trpg.recap.${props.tone}`))
const dateText = computed(() => props.generatedAt ? new Date(props.generatedAt).toLocaleDateString(locale.value) : '')
const showSpread = computed(() => !single.value && ready.value)

/**
 * Which illustration belongs beside the current spread.
 *
 * The left page of a spread (or the only page in single mode) decides the
 * chapter context: the cover page shows the cover image, every later page shows
 * the last chapter that started at or before it. A chapter-bound content image
 * wins over the chronicle-wide one.
 */
const currentPageIndex = computed(() => single.value ? spread.value : spread.value * 2)
const onCoverPage = computed(() => pages.value[currentPageIndex.value]?.variant === 'cover')
const currentChapter = computed(() => {
  if (onCoverPage.value) return null
  let found: { id?: string; title: string; index: number } | null = null
  for (const chapter of chapterPages.value) if (chapter.index <= currentPageIndex.value) found = chapter
  return found
})
const hasImages = computed(() => ready.value && props.images.length > 0)
const currentImage = computed<BookImage | null>(() => {
  if (onCoverPage.value) return props.images.find(image => image.kind === 'cover') || null
  const content = props.images.filter(image => image.kind === 'content')
  const chapterId = currentChapter.value?.id
  return (chapterId ? content.find(image => image.chapterId === chapterId) : undefined)
    || content.find(image => !image.chapterId)
    || null
})
const imageCaption = computed(() => currentImage.value?.label || (onCoverPage.value ? t('trpg.recap.bookImageCover') : currentChapter.value?.title || t('trpg.recap.bookImageContent')))

const motes = Array.from({ length: 18 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  top: (i * 53 + 7) % 100,
  delay: (i % 7) * 0.9,
  duration: 8 + (i % 5) * 1.7,
  size: 2 + (i % 3),
}))

function budgetChars() {
  const contentW = Math.max(120, pageW.value - padPx.value * 2)
  const contentH = Math.max(120, pageH.value - padPx.value * 2)
  const perLine = Math.max(6, Math.floor(contentW / (fontSize.value * 1.05)))
  const lines = Math.max(3, Math.floor(contentH / (fontSize.value * 1.95)))
  return Math.max(90, Math.floor(perLine * lines * 0.92))
}

/** Blocks that can be split at sentence level without breaking their markup. */
function splittable(block: string): boolean {
  return !/^\s*(#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(block)
}

/** Greedily pack Markdown blocks into pages with the real layout box. */
function paginateMeasured(blocks: string[]): string[][] {
  const box = measurer.value
  if (!box || !blocks.length) return blocks.length ? paginateByLength(blocks, budgetChars()) : []
  const fits = (html: string) => {
    box.innerHTML = html
    return box.scrollHeight <= box.clientHeight + 1
  }
  const budget = budgetChars()
  const result: string[][] = []
  const pending = [...blocks]
  let current: string[] = []
  let html = ''
  try {
    while (pending.length) {
      const block = pending.shift() as string
      const blockHtml = md.render(block)
      if (fits(html + blockHtml)) {
        current.push(block)
        html += blockHtml
        continue
      }
      // The block does not fit the space left on this page. Fill the rest of a
      // chapter-opening page by adding whole sentences, so a `##` heading is not
      // stranded alone; headings, quotes, lists and tables always start fresh.
      if (current.length && splittable(block)) {
        const units = splitSentences(block)
        if (units.length > 1) {
          let consumed = 0
          while (consumed < units.length) {
            const unitHtml = md.render(units[consumed])
            if (!fits(html + unitHtml)) break
            current.push(units[consumed])
            html += unitHtml
            consumed++
          }
          if (consumed > 0) {
            const rest = units.slice(consumed).join('').trim()
            if (rest) pending.unshift(rest)
            continue
          }
        }
      }
      if (current.length) {
        result.push(current)
        current = []
        html = ''
      }
      if (fits(blockHtml)) {
        current.push(block)
        html = blockHtml
        continue
      }
      // A single block taller than a page: split at sentence boundaries.
      const pieces = splitLongBlock(block, budget)
      if (pieces.length > 1) {
        pending.unshift(...pieces)
        continue
      }
      current.push(block)
      html += blockHtml
    }
    if (current.length) result.push(current)
    return result
  } finally {
    // The measurer is hidden but still real DOM: leaving the last probe in it
    // would duplicate page text for assistive tech and text-based tests.
    box.innerHTML = ''
  }
}

function renderPages(blocks: string[][], variant: BookPage['variant'], offset: number): BookPage[] {
  return blocks.map((page, i) => ({ variant, html: page.map(block => md.render(block)).join('\n'), number: offset + i + 1 }))
}

function rebuild() {
  if (disposed) return
  turn.value = null
  clearSettleTimer()
  const doc = splitChronicle(props.markdown)
  const blocks: string[] = []
  const anchors: { title: string; block: number }[] = []
  for (const chapter of doc.chapters) {
    anchors.push({ title: chapter.title, block: blocks.length })
    blocks.push(`## ${chapter.title}`)
    blocks.push(...splitBlocks(chapter.markdown))
  }
  const contentBlocks = paginateMeasured(blocks)
  const list: BookPage[] = [{ variant: 'cover' }]
  const contentPages = renderPages(contentBlocks, 'content', 0)
  list.push(...contentPages)

  const timelineBlocks = props.timeline.length
    ? [`## ${t('trpg.recap.bookTimeline')}`, ...props.timeline.map(row => row.time ? `**${row.time}**　${row.text}` : row.text)]
    : []
  const appendixPages = renderPages(paginateMeasured(timelineBlocks), 'appendix', contentPages.length)
  list.push(...appendixPages)

  if (list.length % 2 !== 0) list.push({ variant: 'blank' })
  pages.value = list
  chapterPages.value = anchors.map((anchor, index) => {
    const blockIndex = contentBlocks.findIndex(page => page.includes(blocks[anchor.block]))
    // The Markdown chapters come from the saved recap in the same order, so the
    // prop list can supply the ids the images are bound to.
    return { id: props.chapters[index]?.id, title: anchor.title, index: 1 + Math.max(0, blockIndex) }
  })
  spread.value = Math.min(spread.value, maxIndex.value)
  ready.value = true
}

function layout() {
  const el = scene.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  single.value = rect.width < SPREAD_MIN
  const bookW = Math.min(rect.width * 0.94, single.value ? 640 : 1200)
  pageW.value = single.value ? bookW : bookW / 2
  pageH.value = Math.max(320, Math.min(rect.height * 0.86, pageW.value * 1.5))
  padPx.value = Math.max(18, Math.min(44, pageW.value * 0.09))
  fontSize.value = Math.max(14, Math.min(21, pageW.value / (single.value ? 24 : 29)))
}

function relayout() {
  layout()
  nextTick(() => { if (!disposed) rebuild() })
}

function onResize() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(relayout)
}

function clearSettleTimer() {
  if (!settleTimer) return
  window.clearTimeout(settleTimer)
  settleTimer = 0
}

function armSettleTimer() {
  clearSettleTimer()
  // Safety net for hosts where `transitionend` never fires (reduced motion,
  // background tab, jsdom); bounds the turn so the reader never gets stuck.
  settleTimer = window.setTimeout(finishTurn, SETTLE_MS + 260)
}

/** Finish the current turn, committing the page change only if it completed. */
function finishTurn() {
  const current = turn.value
  if (!current) return
  clearSettleTimer()
  if (current.progress >= 1) {
    const target = spread.value + (current.dir === 'next' ? 1 : -1)
    spread.value = Math.max(0, Math.min(maxIndex.value, target))
  }
  turn.value = null
}

function onLeafTransitionEnd(event: TransitionEvent) {
  if (event.propertyName && event.propertyName !== 'transform') return
  finishTurn()
}

/** Auto turn for click / keyboard / toolbar: create the leaf, then settle to 1. */
function autoTurn(dir: 'next' | 'prev') {
  if (turn.value) return
  if (dir === 'next' && !canNext.value) return
  if (dir === 'prev' && !canPrev.value) return
  turn.value = { dir, progress: 0, settling: false }
  armSettleTimer()
  requestAnimationFrame(() => {
    const current = turn.value
    if (!current || current.dir !== dir) return
    current.settling = true
    current.progress = 1
  })
}

function beginSettle(target: number) {
  const current = turn.value
  if (!current) return
  current.settling = true
  current.progress = target
  armSettleTimer()
}

function pointerDown(event: PointerEvent) {
  if (turn.value || !ready.value) return
  if (event.button !== 0) return
  drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, dir: null, decided: false, aborted: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function pointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  const dx = event.clientX - drag.startX
  if (!drag.decided) {
    if (Math.abs(dx) < DRAG_THRESHOLD_PX || Math.abs(dx) < Math.abs(event.clientY - drag.startY)) return
    drag.decided = true
    const dir: 'next' | 'prev' = dx < 0 ? 'next' : 'prev'
    if ((dir === 'next' && !canNext.value) || (dir === 'prev' && !canPrev.value)) {
      drag.aborted = true
      return
    }
    drag.dir = dir
    turn.value = { dir, progress: 0, settling: false }
  }
  if (!drag.dir || !turn.value) return
  event.preventDefault()
  turn.value.progress = Math.max(0, Math.min(1, Math.abs(dx) / pageW.value))
}

function pointerUp(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  const { decided, dir, aborted } = drag
  drag = null
  if (!decided) {
    // A plain click: turn toward the clicked side.
    const host = event.currentTarget as HTMLElement
    const rect = host.getBoundingClientRect()
    autoTurn(event.clientX - rect.left < rect.width / 2 ? 'prev' : 'next')
    return
  }
  if (aborted || !dir) return
  beginSettle((turn.value?.progress || 0) > COMMIT_AT ? 1 : 0)
}

function pointerCancel(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  drag = null
  if (turn.value) beginSettle(0)
}

function jumpToPage(index: number) {
  if (turn.value) return
  const target = single.value ? index : Math.floor(index / 2)
  spread.value = Math.max(0, Math.min(maxIndex.value, target))
  tocOpen.value = false
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && showImage.value) { showImage.value = false; return }
  if (showImage.value) return
  if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); autoTurn('next') }
  else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); autoTurn('prev') }
}

onMounted(() => {
  layout()
  nextTick(() => {
    rebuild()
    if (scene.value && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onResize)
      observer.observe(scene.value)
    }
  })
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frame)
  clearSettleTimer()
  observer?.disconnect()
  window.removeEventListener('keydown', onKey)
})

watch(() => [props.markdown, props.timeline, props.chapters], () => nextTick(rebuild), { deep: false })
// Regenerating a picture or deleting it swaps the slot; close the lightbox so it
// never keeps showing an image that no longer belongs to this page.
watch(currentImage, value => { if (!value) showImage.value = false })
</script>

<template>
  <div class="book-scene" :style="sceneStyle" :class="{ 'is-single': single, 'is-ready': ready, 'has-visual': hasImages }">
    <div v-for="(mote, i) in motes" :key="i" class="mote" aria-hidden="true" :style="{ left: mote.left + '%', top: mote.top + '%', width: mote.size + 'px', height: mote.size + 'px', animationDelay: mote.delay + 's', animationDuration: mote.duration + 's' }" />
    <div class="torch-glow" aria-hidden="true" />

    <div ref="scene" class="book-main">
      <p v-if="!ready" class="book-loading">{{ t('trpg.recap.bookLoading') }}</p>

      <div
        v-show="ready"
        class="book-stage"
        :class="{ 'book-stage--single': single, 'book-stage--turning': !!turn }"
        @pointerdown="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerUp"
        @pointercancel="pointerCancel"
      >
        <!-- 宽屏：双页对开 -->
        <div v-if="showSpread" class="book" :class="{ 'book--turning': !!turn }">
          <div class="book-spine" aria-hidden="true" />
          <div class="page page--left"><BookFace :page="leftPage" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /></div>
          <div class="page page--right"><BookFace :page="rightPage" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /></div>
          <div v-if="turn" class="leaf-cast-shadow" :class="[turn.dir === 'next' ? 'leaf-cast-shadow--right' : 'leaf-cast-shadow--left', { 'is-settling': turn.settling }]" :style="shadowStyle" aria-hidden="true" />
          <div v-if="turn" class="leaf" :class="leafClass" :style="leafStyle" @transitionend="onLeafTransitionEnd">
            <div class="leaf-face leaf-face--front"><BookFace :page="leafFront" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /><span class="leaf-sheen" :class="{ 'is-settling': turn.settling }" :style="sheenStyle" /></div>
            <div class="leaf-face leaf-face--back"><BookFace :page="leafBack" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /><span class="leaf-sheen" :class="{ 'is-settling': turn.settling }" :style="sheenStyle" /></div>
          </div>
        </div>

        <!-- 窄屏：单页 -->
        <div v-else class="book book--single" :class="{ 'book--turning': !!turn }">
          <div class="page page--single"><BookFace :page="singleBase" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /></div>
          <div v-if="turn" class="leaf leaf--single" :class="leafClass" :style="leafStyle" @transitionend="onLeafTransitionEnd">
            <div class="leaf-face leaf-face--front"><BookFace :page="singleLeaf" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /><span class="leaf-sheen" :class="{ 'is-settling': turn.settling }" :style="sheenStyle" /></div>
            <div class="leaf-face leaf-face--back"><BookFace :page="BLANK" :title="title" :mode-label="modeLabel" :tone-label="toneLabel" :date-text="dateText" /><span class="leaf-sheen" :class="{ 'is-settling': turn.settling }" :style="sheenStyle" /></div>
          </div>
        </div>
      </div>

      <div v-show="ready" class="book-toolbar">
        <button type="button" class="book-btn" :disabled="!canPrev" :aria-label="t('trpg.recap.bookPrev')" @click="autoTurn('prev')">‹</button>
        <button type="button" class="book-btn book-btn--toc" :aria-expanded="tocOpen" @click="tocOpen = !tocOpen">{{ t('trpg.recap.bookToc') }}</button>
        <span class="book-position">{{ t('trpg.recap.bookPage', { page: spread + 1, total: maxIndex + 1 }) }}</span>
        <button v-if="hasImages" type="button" class="book-btn book-btn--image" data-testid="book-image-btn" :disabled="!currentImage" :aria-label="t('trpg.recap.bookImage')" @click="showImage = !showImage">🖼</button>
        <button type="button" class="book-btn" :disabled="!canNext" :aria-label="t('trpg.recap.bookNext')" @click="autoTurn('next')">›</button>
      </div>

      <p v-show="ready" class="book-hint">{{ t('trpg.recap.bookHint') }}</p>

      <nav v-if="tocOpen" class="book-toc" :aria-label="t('trpg.recap.bookToc')">
        <p class="book-toc__title">{{ t('trpg.recap.bookToc') }}</p>
        <button v-for="chapter in chapterPages" :key="chapter.title" type="button" class="book-toc__item" @click="jumpToPage(chapter.index)">
          <span>{{ chapter.title }}</span><small>{{ chapter.index + 1 }}</small>
        </button>
        <p v-if="!chapterPages.length" class="muted">{{ t('trpg.recap.empty') }}</p>
      </nav>

      <!-- 与 .page-content 共用排版类，保证测量与真实分页一致 -->
      <div ref="measurer" class="page-content book-measure" aria-hidden="true" />
    </div>

    <!-- 书本右侧的插画栏：封面显示封面图，正文显示当前章节的内容图 -->
    <aside v-if="hasImages" class="book-visual" data-testid="book-visual" :aria-label="t('trpg.recap.bookImage')">
      <button type="button" class="book-visual__frame" :disabled="!currentImage" data-testid="book-visual-frame" @click="currentImage && (showImage = true)">
        <img v-if="currentImage" :src="currentImage.url" :alt="imageCaption" />
        <span v-else class="book-visual__empty">{{ t('trpg.recap.bookImageNone') }}</span>
      </button>
      <p class="book-visual__caption"><small>{{ t('trpg.recap.bookImage') }}</small>{{ imageCaption }}</p>
    </aside>

    <!-- Teleported to <body>: .book-scene isolates a stacking context, so an
         in-place fixed overlay would sit under the reader's top bar. -->
    <Teleport to="body">
      <div v-if="showImage && currentImage" class="book-lightbox" data-testid="book-lightbox" role="dialog" :aria-label="t('trpg.recap.bookImage')" @click.self="showImage = false">
        <img :src="currentImage.url" :alt="imageCaption" />
        <button type="button" class="book-lightbox__close" :aria-label="t('trpg.recap.bookImageClose')" @click="showImage = false">×</button>
      </div>
    </Teleport>
  </div>
</template>
