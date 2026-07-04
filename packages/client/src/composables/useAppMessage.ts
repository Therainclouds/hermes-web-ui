import {
  createDiscreteApi,
  darkTheme,
  type ConfigProviderProps,
  type MessageApi,
  type NotificationApi,
} from 'naive-ui'
import { getThemeOverrides } from '@/styles/theme'

type DiscreteFeedbackApis = {
  message: MessageApi
  notification: NotificationApi
}

let cachedApis: DiscreteFeedbackApis | null = null
let cachedThemeKey = ''

function readThemePrefs() {
  if (typeof window === 'undefined') {
    return { isDark: false, isComic: false }
  }
  const savedBrightness = localStorage.getItem('hermes_brightness') || 'system'
  const savedStyle = localStorage.getItem('hermes_style') || 'ink'
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = savedBrightness === 'dark' || (savedBrightness === 'system' && prefersDark)
  return {
    isDark,
    isComic: savedStyle === 'comic',
  }
}

function themeKey(): string {
  const { isDark, isComic } = readThemePrefs()
  return `${isDark ? 'dark' : 'light'}:${isComic ? 'comic' : 'ink'}`
}

function discreteConfig(): { configProviderProps: ConfigProviderProps } {
  const { isDark, isComic } = readThemePrefs()
  return {
    configProviderProps: {
      theme: isDark ? darkTheme : null,
      themeOverrides: getThemeOverrides(isDark, isComic),
    },
  }
}

function ensureDiscreteApis(): DiscreteFeedbackApis {
  const nextThemeKey = themeKey()
  if (!cachedApis || cachedThemeKey !== nextThemeKey) {
    const { message, notification } = createDiscreteApi(['message', 'notification'], discreteConfig())
    cachedApis = { message, notification }
    cachedThemeKey = nextThemeKey
  }
  return cachedApis
}

export function useMessage(): MessageApi {
  return ensureDiscreteApis().message
}

export function useNotification(): NotificationApi {
  return ensureDiscreteApis().notification
}
