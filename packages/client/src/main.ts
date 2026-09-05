import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18nReady } from './i18n'
import App from './App.vue'
import './styles/global.scss'
import { desktopBridge } from '@/utils/desktop-bridge'
import { BUILTIN_PLUGINS, installClientPlugins } from '@/plugins'

// Apply theme classes before mount to prevent FOUC (Flash of Unstyled Content)
const savedBrightness = localStorage.getItem('hermes_brightness') || 'system'
const savedStyle = localStorage.getItem('hermes_style') || 'ink'

// Resolve dark mode
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const isDark = savedBrightness === 'dark' || (savedBrightness === 'system' && prefersDark)

// Resolve style
const isComic = savedStyle === 'comic'
const bridge = desktopBridge()
const isDesktopShell = bridge?.isDesktop === true

// Apply classes to prevent FOUC
if (isDark) {
  document.documentElement.classList.add('dark')
}
if (isComic) {
  document.documentElement.classList.add('comic')
}
if (isDesktopShell) {
  document.documentElement.classList.add('hermes-desktop-shell')
}
if (isDesktopShell && bridge?.platform === 'win32') {
  document.documentElement.classList.add('hermes-desktop-windows')
}

// Read token from URL BEFORE router initializes (hash router strips params)
const urlParams = new URLSearchParams(window.location.search)
const hashQuery = window.location.hash.split('?')[1]
const urlToken = urlParams.get('token') || (hashQuery ? new URLSearchParams(hashQuery).get('token') : null)
if (urlToken) {
  ;(window as any).__LOGIN_TOKEN__ = urlToken
}

async function mountApp(): Promise<void> {
  const i18n = await i18nReady
  const app = createApp(App)
  app.use(createPinia())
  app.use(i18n)
  app.use(router)
  await router.isReady().catch(() => undefined)
  // 客户端插件：每个插件 install() 自己注册路由 / 侧边栏 / i18n。
  // 核心代码不直接 import 任何插件；安装与否完全由 BUILTIN_PLUGINS + localStorage 决定。
  await installClientPlugins(app, router, i18n, BUILTIN_PLUGINS)
  app.mount('#app')
}

void mountApp()
