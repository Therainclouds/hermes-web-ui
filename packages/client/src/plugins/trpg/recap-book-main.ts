import { createApp, defineAsyncComponent } from 'vue'
import { createI18n } from 'vue-i18n'
import RecapBookView from './RecapBookView.vue'
import { messages } from './messages'
import type { SupportedLocale } from '../types'

/**
 * Entry point for the standalone `recap-book.html` page.
 *
 * It builds a tiny Vue app with only the reader's i18n (the TRPG panel's
 * messages), so the page never imports the Hermes SPA, its router or its global
 * theme. Locale matches the SPA's so the reader chrome speaks the same language.
 */
const LOCALES: SupportedLocale[] = ['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh', 'zh-TW']

function normalize(tag: string): SupportedLocale | null {
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh')) {
    const traditional = lower.includes('hant') || lower.includes('-tw') || lower.includes('-hk') || lower.includes('-mo')
    return traditional ? 'zh-TW' : 'zh'
  }
  const short = tag.slice(0, 2)
  if (LOCALES.includes(tag as SupportedLocale)) return tag as SupportedLocale
  if (LOCALES.includes(short as SupportedLocale)) return short as SupportedLocale
  return null
}

function resolveLocale(): SupportedLocale {
  const saved = localStorage.getItem('hermes_locale')
  if (saved && LOCALES.includes(saved as SupportedLocale)) return saved as SupportedLocale
  for (const language of navigator.languages || [navigator.language]) {
    const resolved = normalize(language)
    if (resolved) return resolved
  }
  return 'en'
}

// Without a stored token every API call would 401; send the reader to login
// instead of showing a broken book.
if (!localStorage.getItem('hermes_api_key')) {
  location.replace('/')
}

const locale = resolveLocale()
document.documentElement.lang = locale

const query = new URLSearchParams(location.search)
const workspace = query.get('workspace')
const profile = query.get('profile') || localStorage.getItem('hermes_active_profile_name') || 'default'
// `novel` is the long-form workbench, `highlights` the standalone highlight
// manager (used when a meeting has no novel job yet), the default the reader.
const view = workspace === 'novel'
  ? defineAsyncComponent(() => import('./NovelWorkbench.vue'))
  : workspace === 'highlights'
    ? defineAsyncComponent(() => import('./HighlightWorkbench.vue'))
    : RecapBookView
const rootProps = workspace === 'highlights'
  ? { meetingId: query.get('meetingId') || '', profile, jobId: query.get('jobId') || undefined, focusId: query.get('highlight') || undefined }
  : undefined

createApp(view, rootProps)
  .use(createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: {
      en: { trpg: messages.en },
      [locale]: { trpg: messages[locale] },
    },
  }))
  .mount('#recap-book-app')
