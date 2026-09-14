<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  output: { step: string; text: string; updatedAt: number }
  label: (name: string) => string
  streaming?: boolean
}>()

const { t } = useI18n()

interface ParsedValue {
  body?: string
  continuity?: string
  warnings?: string[]
  covered?: number[]
  passed?: boolean
  issues?: { detail?: string }[]
  suggestions?: { detail?: string }[]
  coverage?: { eventId?: string; paragraph?: number; quote?: string }[]
  events?: { id?: string; kind?: string; fact?: string; evidence?: { index?: number; quote?: string }[] }[]
  updates?: { entity?: string; attribute?: string; value?: string }[]
  omitted?: { index?: number; reason?: string }[]
  title?: string
  guide?: string
  action?: string
  result?: unknown
  rationale?: string
}

const kind = computed(() => props.output.step.split('-')[0])

const toolBadge = computed(() => {
  const map: Record<string, { label: string; tone: string }> = {
    review: { label: t('trpg.harness.toolBadge.review'), tone: 'review' },
    revision: { label: t('trpg.harness.toolBadge.revision'), tone: 'revision' },
    write: { label: t('trpg.harness.toolBadge.write'), tone: 'write' },
    check: { label: t('trpg.harness.toolBadge.check'), tone: 'check' },
    plan: { label: t('trpg.harness.toolBadge.plan'), tone: 'plan' },
    planpart: { label: t('trpg.harness.toolBadge.plan'), tone: 'plan' },
    bookpart: { label: t('trpg.harness.toolBadge.plan'), tone: 'plan' },
    extract: { label: t('trpg.harness.toolBadge.extract'), tone: 'extract' },
    canon: { label: t('trpg.harness.toolBadge.canon'), tone: 'canon' },
    material: { label: t('trpg.harness.toolBadge.canon'), tone: 'canon' },
    state: { label: t('trpg.harness.toolBadge.canon'), tone: 'canon' },
    read: { label: t('trpg.harness.toolBadge.read'), tone: 'read' },
    memory: { label: t('trpg.harness.toolBadge.read'), tone: 'read' },
    editor: { label: t('trpg.harness.toolBadge.editor'), tone: 'editor' },
    balance: { label: t('trpg.harness.toolBadge.balance'), tone: 'balance' },
    balancecheck: { label: t('trpg.harness.toolBadge.balance'), tone: 'balance' },
    balanceboundary: { label: t('trpg.harness.toolBadge.balance'), tone: 'balance' },
    chapter: { label: t('trpg.harness.toolBadge.chapter'), tone: 'chapter' },
    book: { label: t('trpg.harness.toolBadge.book'), tone: 'book' },
  }
  return map[kind.value] ?? { label: kind.value, tone: 'default' }
})

// Extract ```json ... ``` blocks (also match unclosed ones for streaming).
function extractJson(text: string): { json: ParsedValue | null; raw: string; lang: string } {
  // Find the first fenced code block (with optional ```json or just ```).
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/.exec(text)
  if (!fence) {
    // Maybe the whole text is bare JSON.
    const trimmed = text.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return { json: JSON.parse(trimmed) as ParsedValue, raw: trimmed, lang: 'json' } }
      catch { return { json: null, raw: trimmed, lang: 'json' } }
    }
    return { json: null, raw: text, lang: '' }
  }
  const lang = fence[1] || 'json'
  const body = fence[2].replace(/\n```$/, '').trim()
  try { return { json: JSON.parse(body) as ParsedValue, raw: body, lang } }
  catch { return { json: null, raw: body, lang } }
}

const extracted = computed(() => extractJson(props.output.text))
const parsed = computed(() => extracted.value.json)
const rawText = computed(() => extracted.value.raw)
const isStreaming = computed(() => Boolean(props.streaming))

const body = computed(() => parsed.value?.body)
const continuity = computed(() => parsed.value?.continuity)
const warnings = computed(() => parsed.value?.warnings ?? [])
const covered = computed(() => parsed.value?.covered ?? [])
const passed = computed(() => parsed.value?.passed)
const issues = computed(() => parsed.value?.issues ?? [])
const suggestions = computed(() => parsed.value?.suggestions ?? [])
const coverage = computed(() => parsed.value?.coverage ?? [])
const events = computed(() => parsed.value?.events ?? [])
const updates = computed(() => parsed.value?.updates ?? [])
const omitted = computed(() => parsed.value?.omitted ?? [])
const title = computed(() => parsed.value?.title)
const guide = computed(() => parsed.value?.guide)
const editorAction = computed(() => parsed.value?.action)
const editorResult = computed(() => parsed.value?.result)
const editorRationale = computed(() => parsed.value?.rationale)

const paragraphs = computed(() => {
  const text = body.value ?? ''
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
})

const hasStructuredContent = computed(() => Boolean(
  body.value || continuity.value || warnings.value.length || covered.value.length ||
  typeof passed.value === 'boolean' || issues.value.length || suggestions.value.length ||
  coverage.value.length || events.value.length || updates.value.length || omitted.value.length ||
  (title.value && guide.value) || editorAction.value
))
</script>
<template>
  <div class="live-stream" :data-streaming="isStreaming ? '1' : '0'" :data-kind="kind">
    <div class="stream-header">
      <span class="tool-badge" :class="`tone-${toolBadge.tone}`">
        <span class="badge-glyph" aria-hidden="true">●</span>
        <span class="badge-label">{{ toolBadge.label }}</span>
      </span>
      <span class="step-name">{{ label(output.step) }}</span>
      <code class="step-id">{{ output.step }}</code>
      <span v-if="isStreaming" class="stream-cursor" aria-hidden="true">▍</span>
    </div>

    <template v-if="hasStructuredContent">
      <!-- Prose body -->
      <div v-if="body && paragraphs.length" class="stream-prose">
        <p v-for="(p, i) in paragraphs" :key="i">{{ p }}</p>
      </div>

      <!-- Plan title + guide -->
      <div v-else-if="title && guide" class="stream-plan">
        <h4>{{ title }}</h4>
        <p class="stream-prose">{{ guide }}</p>
      </div>

      <!-- Pass / fail status -->
      <div v-if="typeof passed === 'boolean'" class="stream-status" :class="passed ? 'passed' : 'failed'">
        <span class="status-icon" aria-hidden="true">{{ passed ? '✓' : '⚠' }}</span>
        <span class="status-text">{{ passed ? t('trpg.harness.passed') : t('trpg.harness.blocked') }}</span>
      </div>

      <!-- Coverage (event → paragraph map for prose) -->
      <details v-if="coverage.length" class="stream-section" open>
        <summary>
          <span class="section-title">{{ t('trpg.harness.coverage') }}</span>
          <span class="section-count">{{ coverage.length }}</span>
        </summary>
        <ol class="stream-coverage">
          <li v-for="(item, i) in coverage" :key="i">
            <span class="coverage-meta">
              <code>{{ item.eventId }}</code>
              <span v-if="item.paragraph != null" class="coverage-para">¶{{ item.paragraph + 1 }}</span>
            </span>
            <blockquote v-if="item.quote">{{ item.quote }}</blockquote>
          </li>
        </ol>
      </details>

      <!-- Issues (blocking) -->
      <details v-if="issues.length" class="stream-section" open>
        <summary>
          <span class="section-title">{{ t('trpg.harness.issues') }}</span>
          <span class="section-count">{{ issues.length }}</span>
        </summary>
        <ol class="stream-issues">
          <li v-for="(issue, i) in issues" :key="i">{{ issue.detail }}</li>
        </ol>
      </details>

      <!-- Suggestions (non-blocking) -->
      <details v-if="suggestions.length" class="stream-section">
        <summary>
          <span class="section-title">{{ t('trpg.harness.suggestions') }}</span>
          <span class="section-count">{{ suggestions.length }}</span>
        </summary>
        <ul class="stream-suggestions">
          <li v-for="(s, i) in suggestions" :key="i">{{ s.detail }}</li>
        </ul>
      </details>

      <!-- Continuity -->
      <details v-if="continuity" class="stream-section">
        <summary>
          <span class="section-title">{{ t('trpg.harness.continuity') }}</span>
        </summary>
        <p class="stream-section-text">{{ continuity }}</p>
      </details>

      <!-- Warnings -->
      <ul v-if="warnings.length" class="stream-warnings">
        <li v-for="(w, i) in warnings" :key="i">
          <span class="warn-icon" aria-hidden="true">!</span>
          <span>{{ w }}</span>
        </li>
      </ul>

      <!-- Covered row indexes -->
      <div v-if="covered.length" class="stream-covered">
        <span class="covered-label">{{ t('trpg.harness.coveredRows') }}</span>
        <span class="covered-rows">{{ covered.join(', ') }}</span>
      </div>

      <!-- Events ledger (canon/extract) -->
      <details v-if="events.length" class="stream-section" open>
        <summary>
          <span class="section-title">{{ t('trpg.harness.events') }}</span>
          <span class="section-count">{{ events.length }}</span>
        </summary>
        <ol class="stream-events">
          <li v-for="(event, i) in events" :key="i">
            <strong>{{ event.id }}<span v-if="event.kind"> · {{ event.kind }}</span></strong>
            <p v-if="event.fact">{{ event.fact }}</p>
            <blockquote v-for="(cite, ci) in event.evidence ?? []" :key="ci">
              <span v-if="cite.index != null">#{{ cite.index }}</span> {{ cite.quote }}
            </blockquote>
          </li>
        </ol>
      </details>

      <!-- State updates -->
      <details v-if="updates.length" class="stream-section">
        <summary>
          <span class="section-title">{{ t('trpg.harness.state') }}</span>
          <span class="section-count">{{ updates.length }}</span>
        </summary>
        <ul class="stream-updates">
          <li v-for="(fact, i) in updates" :key="i">
            <span v-if="fact.entity"><strong>{{ fact.entity }}</strong><span v-if="fact.attribute"> · {{ fact.attribute }}</span></span>
            <span v-if="fact.value || fact.attribute">：{{ fact.value }}</span>
          </li>
        </ul>
      </details>

      <!-- Omitted rows -->
      <details v-if="omitted.length" class="stream-section">
        <summary>
          <span class="section-title">{{ t('trpg.harness.omitted') }}</span>
          <span class="section-count">{{ omitted.length }}</span>
        </summary>
        <ul class="stream-omitted">
          <li v-for="row in omitted" :key="row.index">
            <code v-if="row.index != null">#{{ row.index }}</code>
            <span>{{ row.reason }}</span>
          </li>
        </ul>
      </details>

      <!-- Editor action -->
      <div v-if="editorAction" class="stream-editor">
        <div class="editor-action"><span class="editor-label">{{ t('trpg.harness.toolBadge.editor') }}</span><code>{{ editorAction }}</code></div>
        <pre v-if="editorResult !== undefined" class="editor-result">{{ typeof editorResult === 'string' ? editorResult : JSON.stringify(editorResult, null, 2) }}</pre>
        <p v-if="editorRationale" class="editor-rationale">{{ editorRationale }}</p>
      </div>

      <!-- Source-of-truth (collapsed, click to inspect raw JSON) -->
      <details class="stream-source">
        <summary>{{ t('trpg.harness.rawSource') }}</summary>
        <pre>{{ rawText }}</pre>
      </details>
    </template>

    <!-- Raw fallback (streaming, incomplete JSON, unknown shape) -->
    <pre v-else>{{ output.text }}</pre>
  </div>
</template>
<style scoped>
.live-stream {
  --ls-line: var(--line, #405149);
  --ls-text: var(--text, #e5e9df);
  --ls-muted: var(--muted, #a6b5a9);
  --ls-bg: var(--paper, #202a27);
  --ls-accent: var(--accent, #d4be8d);
  --ls-tint: var(--quote, #2b3830);
  --ls-warn: #d59b6a;
  --ls-pass: #8fc39a;
  --ls-fail: #e2a89a;
  font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  display: flex; flex-direction: column; gap: 12px;
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--ls-bg);
  color: var(--ls-text);
  border: 1px solid var(--ls-line);
  font-size: 13px; line-height: 1.65;
  overflow: hidden;
}
.stream-header {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--ls-line);
}
.tool-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: .04em;
  border: 1px solid transparent; white-space: nowrap;
}
.tool-badge .badge-glyph { font-size: 9px; line-height: 1; }
.tool-badge.tone-review { background: #e8d3a533; border-color: #d4be8d; color: #f0dba6; }
.tool-badge.tone-revision { background: #d59b6a22; border-color: #d59b6a; color: #f0bf90; }
.tool-badge.tone-write { background: #9fc7e222; border-color: #9fc7e2; color: #b5d6ea; }
.tool-badge.tone-check { background: #c7a4e222; border-color: #c7a4e2; color: #d5b9ea; }
.tool-badge.tone-plan { background: #bfa67b22; border-color: #bfa67b; color: #dec396; }
.tool-badge.tone-extract { background: #91aa9822; border-color: #91aa98; color: #b3c8b8; }
.tool-badge.tone-canon { background: #88b7c522; border-color: #88b7c5; color: #aecbd6; }
.tool-badge.tone-read { background: #a3a08e22; border-color: #a3a08e; color: #c5c1ad; }
.tool-badge.tone-editor { background: #b48ea722; border-color: #b48ea7; color: #cfb1c5; }
.tool-badge.tone-balance { background: #e0b78722; border-color: #e0b787; color: #ebcfa1; }
.tool-badge.tone-chapter { background: #d4be8d22; border-color: #d4be8d; color: #f0dba6; }
.tool-badge.tone-book { background: #d4be8d22; border-color: #d4be8d; color: #f0dba6; }
.tool-badge.tone-default { background: var(--ls-tint); border-color: var(--ls-line); color: var(--ls-muted); }
.step-name { font-weight: 500; font-size: 13px; color: var(--ls-text); }
.step-id { font: 11px/1.4 ui-monospace, monospace; color: var(--ls-muted); padding: 2px 6px; border-radius: 4px; background: var(--ls-tint); }
.stream-cursor {
  display: inline-block;
  margin-inline-start: auto;
  color: var(--ls-accent);
  font-size: 14px;
  animation: ls-blink 1.05s steps(2, jump-none) infinite;
}
@keyframes ls-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .stream-cursor { animation: none; } }

/* Prose body — match the manuscript serif feel */
.stream-prose {
  font-family: Georgia, 'Noto Serif SC', 'Songti SC', serif;
  font-size: 14.5px; line-height: 1.95;
  max-width: 78ch;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.stream-prose p { margin: 0 0 14px; }
.stream-prose p:last-child { margin-bottom: 0; }

/* Status pill */
.stream-status {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 6px;
  font-weight: 600; font-size: 12px;
  border: 1px solid transparent;
  align-self: flex-start;
}
.stream-status.passed { background: #6f9e7b22; border-color: #8fc39a; color: var(--ls-pass); }
.stream-status.failed { background: #b97a6c22; border-color: #e2a89a; color: var(--ls-fail); }
.status-icon { font-size: 13px; }

/* Collapsible sections */
.stream-section {
  border: 1px solid var(--ls-line);
  border-radius: 6px;
  background: var(--ls-tint);
  overflow: hidden;
}
.stream-section > summary {
  cursor: pointer;
  list-style: none;
  padding: 8px 12px;
  font-size: 12px;
  display: flex; align-items: center; gap: 8px;
  user-select: none;
}
.stream-section > summary::-webkit-details-marker { display: none; }
.stream-section > summary::before {
  content: '▸'; display: inline-block; margin-inline-end: 6px; color: var(--ls-muted); transition: transform .15s;
}
.stream-section[open] > summary::before { transform: rotate(90deg); }
.stream-section[open] > summary { border-bottom: 1px solid var(--ls-line); }
.stream-section .section-title { font-weight: 600; color: var(--ls-text); }
.stream-section .section-count {
  margin-inline-start: auto;
  font: 10px/1.4 ui-monospace, monospace;
  color: var(--ls-muted);
  padding: 1px 7px; border-radius: 999px;
  background: var(--ls-bg);
  border: 1px solid var(--ls-line);
}
.stream-section-text { padding: 10px 14px 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ls-text); }

/* Coverage list */
.stream-coverage { list-style: none; padding: 6px 14px 12px; margin: 0; }
.stream-coverage li {
  padding: 6px 0; border-bottom: 1px dashed var(--ls-line);
  display: flex; flex-direction: column; gap: 4px;
}
.stream-coverage li:last-child { border-bottom: 0; }
.coverage-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.coverage-meta code { font: 11px/1.4 ui-monospace, monospace; padding: 1px 6px; border-radius: 3px; background: var(--ls-bg); border: 1px solid var(--ls-line); color: var(--ls-accent); }
.coverage-para { color: var(--ls-muted); font-size: 11px; }
.stream-coverage blockquote { margin: 4px 0 0; padding: 6px 10px; border-inline-start: 2px solid var(--ls-accent); color: var(--ls-muted); font-size: 12px; background: var(--ls-bg); border-radius: 0 4px 4px 0; }

/* Issues (ordered, blocking) */
.stream-issues { padding: 8px 14px 12px; margin: 0; padding-inline-start: 28px; }
.stream-issues li { margin-bottom: 6px; color: var(--ls-text); }
.stream-issues li:last-child { margin-bottom: 0; }

/* Suggestions */
.stream-suggestions { padding: 8px 14px 12px; margin: 0; padding-inline-start: 20px; list-style: disc; }
.stream-suggestions li { margin-bottom: 4px; color: var(--ls-muted); }

/* Warnings */
.stream-warnings { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.stream-warnings li {
  display: flex; gap: 8px;
  padding: 8px 12px;
  border: 1px solid #d59b6a55;
  border-inline-start-width: 3px;
  border-radius: 4px;
  background: #d59b6a11;
  font-size: 12px;
  color: var(--ls-text);
}
.stream-warnings .warn-icon {
  flex-shrink: 0;
  width: 18px; height: 18px;
  display: inline-grid; place-items: center;
  border-radius: 50%;
  background: var(--ls-warn); color: #1a1a1a;
  font-weight: 700; font-size: 12px;
}

/* Covered row indexes */
.stream-covered {
  display: flex; gap: 8px; align-items: baseline;
  padding: 6px 12px; border-radius: 4px;
  background: var(--ls-tint); border: 1px solid var(--ls-line);
  font-size: 12px;
}
.stream-covered .covered-label { color: var(--ls-muted); flex-shrink: 0; }
.stream-covered .covered-rows { font: 11px/1.5 ui-monospace, monospace; color: var(--ls-text); overflow-wrap: anywhere; }

/* Events (canon/extract) */
.stream-events { list-style: none; padding: 8px 14px 12px; margin: 0; }
.stream-events li { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--ls-line); }
.stream-events li:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }
.stream-events strong { color: var(--ls-accent); font-size: 12px; }
.stream-events p { margin: 4px 0; color: var(--ls-text); font-size: 13px; }
.stream-events blockquote { margin: 4px 0; padding: 4px 10px; border-inline-start: 2px solid var(--ls-accent); color: var(--ls-muted); font-size: 12px; background: var(--ls-bg); border-radius: 0 4px 4px 0; }

/* Updates */
.stream-updates { list-style: none; padding: 8px 14px 12px; margin: 0; }
.stream-updates li { padding: 4px 0; font-size: 12px; color: var(--ls-text); border-bottom: 1px dashed var(--ls-line); }
.stream-updates li:last-child { border-bottom: 0; }
.stream-updates strong { color: var(--ls-accent); }

/* Omitted */
.stream-omitted { list-style: none; padding: 8px 14px 12px; margin: 0; }
.stream-omitted li { padding: 4px 0; font-size: 12px; color: var(--ls-muted); display: flex; gap: 8px; }
.stream-omitted code { font: 11px/1.4 ui-monospace, monospace; padding: 1px 6px; border-radius: 3px; background: var(--ls-bg); border: 1px solid var(--ls-line); }

/* Editor action */
.stream-editor { padding: 10px 12px; border: 1px solid var(--ls-line); border-radius: 6px; background: var(--ls-tint); display: flex; flex-direction: column; gap: 8px; }
.stream-editor .editor-action { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.stream-editor .editor-label { color: var(--ls-muted); }
.stream-editor .editor-action code { font: 11px/1.4 ui-monospace, monospace; padding: 2px 8px; border-radius: 3px; background: var(--ls-bg); border: 1px solid var(--ls-line); color: var(--ls-accent); }
.stream-editor .editor-result { font: 11px/1.5 ui-monospace, monospace; padding: 8px 10px; background: var(--ls-bg); border: 1px solid var(--ls-line); border-radius: 4px; max-height: 180px; overflow: auto; margin: 0; white-space: pre-wrap; }
.stream-editor .editor-rationale { margin: 0; color: var(--ls-muted); font-size: 12px; font-style: italic; }

/* Raw source (collapsed by default) */
.stream-source { border: 1px dashed var(--ls-line); border-radius: 6px; background: transparent; }
.stream-source > summary { cursor: pointer; padding: 6px 10px; font-size: 11px; color: var(--ls-muted); list-style: none; }
.stream-source > summary::-webkit-details-marker { display: none; }
.stream-source > summary::before { content: '</>'; display: inline-block; margin-inline-end: 6px; font-family: ui-monospace, monospace; }
.stream-source pre { font: 11px/1.5 ui-monospace, monospace; padding: 8px 12px; margin: 0; max-height: 180px; overflow: auto; color: var(--ls-muted); border-top: 1px dashed var(--ls-line); background: var(--ls-bg); }

/* Plain-text fallback (streaming) */
.live-stream > pre {
  font: 12px/1.65 ui-monospace, monospace;
  padding: 12px 14px;
  margin: 0;
  background: var(--ls-bg);
  border: 1px solid var(--ls-line);
  border-radius: 6px;
  color: var(--ls-text);
  max-height: 280px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
}

/* Light theme overrides */
:global(.novel-workbench[data-theme="light"]) .live-stream {
  --ls-line: #d6dccb;
  --ls-bg: #fbf7e8;
  --ls-tint: #f3eed7;
  --ls-text: #2d382f;
  --ls-muted: #6f7561;
  --ls-accent: #8c6f3c;
}
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-revision { color: #8c482b; border-color: #d59b6a; background: #d59b6a18; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-review { color: #6b5524; border-color: #bfa67b; background: #bfa67b1a; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-write { color: #3a6580; border-color: #9fc7e2; background: #9fc7e218; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-check { color: #6b487e; border-color: #c7a4e2; background: #c7a4e218; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-plan { color: #6e5828; border-color: #bfa67b; background: #bfa67b1a; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-extract { color: #42654a; border-color: #91aa98; background: #91aa9818; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-canon { color: #365c69; border-color: #88b7c5; background: #88b7c518; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-read { color: #5b5840; border-color: #a3a08e; background: #a3a08e18; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-editor { color: #63415e; border-color: #b48ea7; background: #b48ea718; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-balance { color: #7a5524; border-color: #e0b787; background: #e0b78718; }
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-chapter,
:global(.novel-workbench[data-theme="light"]) .tool-badge.tone-book { color: #6b5524; border-color: #d4be8d; background: #d4be8d18; }
:global(.novel-workbench[data-theme="light"]) .stream-status.passed { color: #3a7050; border-color: #8fc39a; background: #8fc39a18; }
:global(.novel-workbench[data-theme="light"]) .stream-status.failed { color: #8c3a2a; border-color: #e2a89a; background: #e2a89a18; }
:global(.novel-workbench[data-theme="light"]) .stream-warnings li { border-color: #d59b6a88; background: #d59b6a10; }
</style>
