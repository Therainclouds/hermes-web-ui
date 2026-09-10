import type { HermesClientPlugin } from '../types'
import KnowledgeView from './KnowledgeView.vue'
import { loadPluginMessages, SUPPORTED_LOCALES } from './i18n-loader'

/**
 * Knowledge 插件入口。
 *
 * 通过 `install(ctx)` 把 KnowledgeView 路由、侧边栏入口、各 locale 文案注入
 * 到 Web UI 核心。核心代码不直接 import 本文件，只通过 `plugins/index.ts`
 * 的 BUILTIN_PLUGINS 间接加载。
 */
const knowledgePlugin: HermesClientPlugin = {
  id: 'knowledge',
  name: 'Knowledge',
  version: '0.1.0',
  description: 'Document knowledge base with RAG search.',
  author: 'Hermes',

  async install(ctx) {
    // 1) 合并 i18n 文案
    const results = await Promise.all(
      SUPPORTED_LOCALES.map(async (locale) => ({
        locale,
        messages: await loadPluginMessages(locale),
      })),
    )
    for (const { locale, messages } of results) {
      if (messages && Object.keys(messages).length > 0) {
        ctx.addI18nMessages(locale, messages)
      }
    }

    // 2) 注册路由
    ctx.addRoute({
      path: '/hermes/knowledge',
      name: 'plugin-knowledge.vaults',
      component: KnowledgeView,
    })

    // 3) 注册侧边栏入口
    ctx.addSidebarItem({
      routeName: 'plugin-knowledge.vaults',
      group: 'Tools',
      labelKey: 'pluginsKnowledge.sidebarLabel',
      iconPath: 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20',
    })
  },
}

export default knowledgePlugin
