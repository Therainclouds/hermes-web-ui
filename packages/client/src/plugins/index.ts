import type { PluginRegistration } from './types'

/**
 * 客户端插件清单。
 *
 * **插件注册 = 修改本文件**：要启用 / 禁用 / 新增插件，在这里增删 import 与
 * registration 即可，**核心代码不需要任何修改**。
 *
 * 删除一个插件的步骤：
 *   1. 删除 `packages/client/src/plugins/<id>/` 整个文件夹；
 *   2. 从下面 import 与 registrations 数组移除对应行。
 *
 * 这样保证：
 *   - vite treeshake 会把未引用的插件从产物里去掉；
 *   - tsc / vue-tsc 不需要解析插件的类型（如果删干净）；
 *   - core 路由 / 侧边栏不会出现插件的孤儿入口。
 */

// 内置插件 import 区（按字母序排列）
import scannerPlugin from './scanner'
import gradingPlugin from './grading'
import knowledgePlugin from './knowledge'

// 内置插件**全部默认关闭**：fresh 安装 / 未做过显式选择时，侧边栏不会出现
// 「扫描」「批改模式」「知识库」入口。需要时到 设置 → 插件管理 手动开启，
// 选择结果记在 localStorage `hermes.plugins.enabled`（有 override 时以它为准）。
// 插件代码仍然随构建产物一起存在，可随时启用，不做编译期下线。
export const BUILTIN_PLUGINS: PluginRegistration[] = [
  { plugin: scannerPlugin, enabledByDefault: false },
  // Grading（批改模式）依赖 Scanner，同样默认关闭。
  { plugin: gradingPlugin, enabledByDefault: false },
  // Knowledge — RAG vaults for document search. 默认关闭。
  { plugin: knowledgePlugin, enabledByDefault: false },
]

/**
 * 列出所有内置插件的元数据，供 UI 展示。
 */
export function listBuiltinPlugins(): Array<{
  id: string
  name: string
  version: string
  description: string
  author?: string
}> {
  return BUILTIN_PLUGINS.map(reg => {
    const p = reg.plugin
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
    }
  })
}

export { installClientPlugins, listSidebarItems } from './registry'
export {
  isPluginEnabled,
  PLUGIN_STATE_STORAGE_KEY,
  readPluginEnabledMap,
  writePluginEnabledMap,
} from './types'
export type { HermesClientPlugin, PluginContext, PluginSidebarItem } from './types'
