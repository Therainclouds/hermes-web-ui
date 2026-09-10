import type { SupportedLocale } from '../types'

/**
 * Knowledge plugin — i18n locale loader.
 * Matches the scanner/grading loader pattern.
 */
const LOADERS: Partial<Record<SupportedLocale, () => Promise<Record<string, unknown>>>> = {
  en: () => import('./locales/en'),
  zh: () => import('./locales/zh'),
  'zh-TW': () => import('./locales/zh-TW'),
}

export async function loadPluginMessages(locale: SupportedLocale): Promise<Record<string, unknown>> {
  const loader = LOADERS[locale]
  if (!loader) return {}
  try {
    const mod = await loader()
    return (mod.default || mod) as Record<string, unknown>
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[plugins/knowledge] failed to load locale "${locale}":`, error)
    return {}
  }
}

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = Object.keys(LOADERS) as SupportedLocale[]
