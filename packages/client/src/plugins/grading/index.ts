import type { HermesClientPlugin } from '../types'
import { isPluginEnabled } from '../types'
import { messages } from './messages'
const plugin: HermesClientPlugin = {
  id: 'paper-grading', name: 'Paper grading', version: '0.1.0', author: 'Hermes',
  description: 'Teacher grading workspace. Requires Scanner to be enabled.', dependencies: ['scanner'],
  install(ctx) {
    for (const [locale, text] of Object.entries(messages)) ctx.addI18nMessages(locale as keyof typeof messages, { grading: text })
    for (const mode of ['grading', 'grading-batch']) ctx.addRoute({
      path: `/hermes/${mode}`, name: `plugin-paper-grading.${mode}`,
      component: () => import('./GradingView.vue'),
      beforeEnter: () => isPluginEnabled('scanner', true) && isPluginEnabled('paper-grading', true) ? true : '/hermes/client-plugins',
    })
    ctx.addSidebarItem({ routeName: 'plugin-paper-grading.grading-batch', group: 'Tools', labelKey: 'grading.title', iconPath: 'M9 12l2 2 4-4M5 3h14v18H5z' })
  },
}
export default plugin
