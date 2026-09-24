# Phase 4 客户端接入设计稿 v1.0

> 范围：`hermes-web-ui` 客户端专家系统接入
> 状态：v1.0 已冻结，可作为 `SPEC-09 ~ SPEC-14` 事实源
> 输入契约：`G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\expert_client_integration_spec.md v1.0`
> 本地决策：`docs/adr/ADR-0005-expert-marketplace-profile-integration.md`
> 时间：2026-06-23
> 升级自：v0.1（2026-06-23 内部讨论稿）

## 0. 修订记录

| 版本 | 日期 | 主要变更 |
|---|---|---|
| v0.1 | 2026-06-23 | 内部讨论稿 |
| v1.0 | 2026-06-23 | 3 个关键决策定稿：独立 yaml / profiles 扩展入口 / 团长+成员一起安装 |

## 1. 关键决策（已批准）

| 决策 | 选择 | 影响 |
|---|---|---|
| 配置位置 | `A. 独立 yaml`：`config/experts-marketplace.yaml` | 与主 `config.yaml` 解耦；启动时 fail-fast 仅校验 `baseUrl` |
| expert profile 创建入口 | `A. profiles 服务加 _from_expert_package 扩展入口` | 不复用 `createProfile`；命名清晰，幂等性更好 |
| 专家团首版范围 | `B. 团长 + 所有成员一起安装` | install 接口递归处理 `team.members`；本地创建 N+1 个 profile（1 团长 + N 成员） |

## 2. 现状盘点

- 路由：[router/index.ts](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/router/index.ts) 已有 `hermes.profiles / hermes.globalAgent / hermes.chat / hermes.groupChat / hermes.jobs / hermes.kanban` 等，**没有** `hermes.experts` / `hermes.expertDetail`。
- Profile 入口：[ProfilesView.vue](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/ProfilesView.vue) 顶部有 `导入/创建` 按钮；底部挂 `ProfilesPanel / ProfileCreateModal / ProfileRenameModal / ProfileImportModal`。
- Profile 后端 API：[profiles.ts](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/api/hermes/profiles.ts) 已有 `fetchProfiles / fetchProfileDetail / createProfile / importProfile / exportProfile / switchHermesProfile / updateProfileAvatar` 等，**没有** "由 manifest 激活为 profile" 的方法。
- Chat / Global Agent：[ChatPanel.vue](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/components/hermes/chat/ChatPanel.vue) 与 [GlobalAgentView.vue](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/GlobalAgentView.vue) 都基于 `profile` 启动会话；**只要 profile 是"专家激活出来的"，它们自动支持**，零改动。
- SQLite schema 中心：[schemas.ts](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/db/hermes/schemas.ts)；`installed_experts` / `expert_profile_bindings` 还没建。
- 侧边栏文案：[zh.ts](file:///G:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/i18n/locales/zh.ts) 把 `sidebar.profiles` 翻译为 `用户`；首版不改它，新增 `sidebar.experts: '专家中心'`。

## 3. 关键设计判断

- A. 不引入新的 profile 类型字段：用云端 manifest 直接生成一份和 user-created profile 一样的实体，再通过 `installed_experts + expert_profile_bindings` 做来源标记。Chat / Global Agent 不动。
- B. 安装链路在本地后端（Koa BFF）完成：前端只发 `installExpert / uninstallExpert / upgradeExpert` 三个动作；Node 端做 `fs / crypto / stream`；OSS URL 不透出到 renderer。
- C. 错误回滚走 SQLite 事务 + 文件系统分阶段提交：每阶段写 status，失败保留 `last_error + stage`，不污染 user profile。
- D. 不让 Chat 自动切到 expert profile：激活后只在 Profiles 出现，UI 上"开始对话"按钮跳 Chat。
- E. 模型配置继续由用户掌控：激活时 `profile.model` 不预设；`appStore.profileModelGroups` 数据流不动。
- F. 专家团（`kind=team`）递归安装：团长 + 成员一起装；本地为团长创建 1 个 `expert_team_<slug>` profile，为每个成员创建 `expert_member_<member-slug>` profile（标记 `isTeamMemberOf=<team-slug>`）。
- G. 配置走独立 yaml：与 `config.yaml` 解耦，避免污染主配置；启动 fail-fast 仅校验 `baseUrl`，其余给默认值。

## 4. 数据对象

### 4.1 `installed_experts`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `expert_slug` | TEXT UNIQUE | 云端 slug |
| `expert_name` | TEXT | |
| `kind` | TEXT | `expert` / `team` |
| `category` | TEXT | |
| `installed_version` | TEXT | |
| `status` | TEXT | `downloading` / `verifying` / `extracting` / `installing_profile` / `installed` / `failed` |
| `local_path` | TEXT | `<state>/experts/packages/<slug>/<version>/` |
| `manifest_json` | TEXT | 服务端权威 manifest 缓存 |
| `last_error` | TEXT | |
| `last_error_stage` | TEXT | `download` / `verify` / `extract` / `activate` |
| `installed_at` | INTEGER | |
| `updated_at` | INTEGER | |
| `team_slug` | TEXT NULL | 当 `kind=team` 时记录团长 slug，成员行用 `parent_team_slug` 关联 |

索引：`(expert_slug)`，可选 `(status)`。

### 4.2 `expert_profile_bindings`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `expert_slug` | TEXT | |
| `profile_name` | TEXT | 实际创建的 profile 名 |
| `role` | TEXT | `captain` / `member` / `expert` |
| `parent_team_slug` | TEXT NULL | 成员的所属团长 |
| `installed_version` | TEXT | |
| `created_at` | INTEGER | |
| `updated_at` | INTEGER | |

索引：`(expert_slug)`，可选 `(parent_team_slug)`。

## 5. 配置文件

新增 `config/experts-marketplace.yaml`：

```yaml
# 专家市场 / 专家团本地接入配置
baseUrl: "http://127.0.0.1:8000"   # 必填，启动 fail-fast
cacheTtlSeconds: 30
localPackagesRoot: "${HERMES_WEBUI_STATE_DIR}/experts/packages"
clientIdTemplate: "hermes-web-ui-v{version}-user-{userId}"
maxPackageBytes: 104857600          # 100 MiB，与云端一致
downloadTimeoutMs: 60000
verifyTimeoutMs: 30000
```

启动校验：仅 `baseUrl` 必填；`localPackagesRoot` 缺省走 `<state>/experts/packages`。

## 6. 后端 API 设计

### 6.1 路由表

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/hermes/experts/catalog` | 转发云端 catalog，30s 内存缓存 |
| `GET` | `/api/hermes/experts/:slug/detail` | 转发云端 detail |
| `GET` | `/api/hermes/experts/:slug/versions/:version/manifest` | 转发云端 manifest |
| `GET` | `/api/hermes/experts/installed` | 读本地 `installed_experts` + `expert_profile_bindings` |
| `POST` | `/api/hermes/experts/install` | 安装/激活；支持 `team` 递归 |
| `POST` | `/api/hermes/experts/:slug/upgrade` | 升级；不删 user 模型配置 |
| `POST` | `/api/hermes/experts/:slug/uninstall` | 卸载；删资源 + 绑定 + expert profile |

### 6.2 `POST /install` 入参/出参

入参：

```json
{ "slug": "software-team", "version": "1.0.0", "client_id": "hermes-web-ui-v1.0.0-user-abc" }
```

返回（成功）：

```json
{
  "installed": [
    { "slug": "software-team", "profile_name": "expert_team_software-team", "role": "captain" },
    { "slug": "fullstack-architect", "profile_name": "expert_member_fullstack-architect", "role": "member", "parent_team_slug": "software-team" }
  ],
  "installed_expert": { "slug": "software-team", "version": "1.0.0", "status": "installed" }
}
```

错误（任一阶段失败）：

```json
{ "code": 500, "stage": "verify", "message": "SHA256 mismatch" }
```

### 6.3 profiles 服务扩展入口

新增 `services/hermes/profiles/create-from-expert-package.ts`：

```ts
interface CreateExpertProfileInput {
  profileName: string;     // 由本地决定，规则：expert_<role>_<slug>
  displayName: string;
  expertSlug: string;
  expertKind: 'expert' | 'team' | 'team-member';
  installedVersion: string;
  sourceManifestPath: string; // 解压目录内的 manifest.json
  parentTeamSlug?: string;
}
```

命名规则：

- 单专家：`expert_<slug>`
- 团长：`expert_team_<slug>`
- 成员：`expert_member_<slug>`，`parent_team_slug=<team-slug>`

幂等：若同名 profile 已存在，**覆盖** 预设内容（system prompt / avatar），**不** 覆盖 user 自定义内容（`config.yaml` / env 凭据）。

## 7. 前端集成

### 7.1 路由

```ts
{
  path: '/hermes/experts',
  name: 'hermes.experts',
  component: () => import('@/views/hermes/ExpertsView.vue'),
},
{
  path: '/hermes/experts/:slug',
  name: 'hermes.expertDetail',
  component: () => import('@/views/hermes/ExpertDetailView.vue'),
}
```

### 7.2 侧边栏

`AppSidebar.vue` 在 `Profiles` 之后、`Plugins` 之前插入 `experts`。

`zh.ts` 新增：

```ts
sidebar.experts: '专家中心',
experts.title: '专家中心',
experts.tabPublished: '已发布',
experts.tabTeam: '已发布专家团',
experts.tabInstalled: '已安装',
experts.detail.install: '下载并激活',
experts.detail.upgrade: '升级',
experts.detail.uninstall: '卸载',
experts.detail.starterPrompts: '预设提示',
experts.detail.defaultSkills: '默认技能',
experts.status.downloading: '下载中...',
experts.status.verifying: '校验中...',
experts.status.extracting: '解压中...',
experts.status.installing_profile: '激活中...',
experts.status.installed: '已安装',
experts.status.failed: '失败',
```

### 7.3 组件

- `views/hermes/ExpertsView.vue`
  - Tab：`已发布` / `已发布专家团` / `已安装`
  - 已发布列表：调 `catalog`
  - 已安装列表：调 `installed`
- `views/hermes/ExpertDetailView.vue`
  - 上半：基础信息 + 最新版本
  - 中部：`下载并激活` / `升级` / `卸载`
  - 下半：manifest 预展示（system prompt path、starter prompts、default skills、default launch target）
- `stores/hermes/experts.ts`
  - 状态：`catalog / installed / detailBySlug / status`
  - 动作：`fetchCatalog / fetchDetail / fetchInstalled / install / upgrade / uninstall`
- `api/hermes/experts.ts`
  - 不直连云端，统一走本地 Koa

### 7.4 Profiles 页面

`ProfilesPanel.vue` 列表里若某 profile 名匹配 `expert_*` 且在 `expert_profile_bindings` 中存在，显示 `专家` 徽标。

### 7.5 Chat / Global Agent

**首版零改动**。用户从 `ProfilesView` 点 `开始对话` 走现有 `chatStore.newChat({profile: 'expert_<role>_<slug>'})`。

## 8. 状态机

```
                  ┌──────────┐
                  │ (none)   │
                  └────┬─────┘
                       │ install
                       ▼
                ┌──────────────┐
                │ downloading  │
                └────┬─────────┘
                     ▼
                ┌──────────────┐
                │ verifying    │
                └────┬─────────┘
                     ▼
                ┌──────────────┐
                │ extracting   │
                └────┬─────────┘
                     ▼
                ┌────────────────────┐
                │ installing_profile │
                └────┬───────────────┘
                     ▼
                ┌──────────────┐
                │ installed    │
                └────┬─────────┘
                     │ upgrade
                     ▼
                (回到 downloading)
                     │ uninstall
                     ▼
                (回到 none)

任一阶段失败 → status=failed，last_error + last_error_stage 记录
```

## 9. 文件改动清单

| 文件 | 改动 | 理由 | 风险/回滚 |
|---|---|---|---|
| `config/experts-marketplace.yaml.example` | 新增 | 配置模板 | 文档级 |
| `config/experts-marketplace.yaml` | 新增（gitignore 不提交） | 本地配置 | 不阻塞主流程 |
| `packages/server/src/db/hermes/schemas.ts` | 修改 | 新增 `installed_experts` / `expert_profile_bindings` schema | `addMissingSafeColumns` 保护 |
| `packages/server/src/db/hermes/experts-store.ts` | 新增 | 安装/升级/卸载/查询 store | 事务不严会半安装 |
| `packages/server/src/services/hermes/experts/config.ts` | 新增 | 加载 `experts-marketplace.yaml` | 启动读不到不阻塞 chat |
| `packages/server/src/services/hermes/experts/marketplace-client.ts` | 新增 | 转发 catalog/detail/manifest/download | 网络失败需有降级 |
| `packages/server/src/services/hermes/experts/installer.ts` | 新增 | download → verify → extract → activate | 路径穿越/SHA256/并发写 |
| `packages/server/src/services/hermes/experts/activator.ts` | 新增 | manifest → expert profile | 与 profiles 服务耦合需谨慎 |
| `packages/server/src/services/hermes/profiles/create-from-expert-package.ts` | 新增 | profiles 服务扩展入口 | 不复用 createProfile |
| `packages/server/src/routes/hermes/experts.ts` | 新增 | 7 个本地路由 | 路由前缀不与已有冲突 |
| `packages/server/src/controllers/hermes/experts.ts` | 新增 | 校验 + 委托 service | 控制器过重可下沉 |
| `packages/client/src/api/hermes/experts.ts` | 新增 | 前端 API 封装 | 与本地 Koa 契约同步 |
| `packages/client/src/stores/hermes/experts.ts` | 新增 | catalog/installed/status | 状态复杂化需测试 |
| `packages/client/src/views/hermes/ExpertsView.vue` | 新增 | 目录页 | 首版可简化为表格 |
| `packages/client/src/views/hermes/ExpertDetailView.vue` | 新增 | 详情页 | 抽屉版本可降复杂度 |
| `packages/client/src/components/layout/AppSidebar.vue` | 小改 | 增加 `experts` 入口 | 侧栏拥挤可降级 |
| `packages/client/src/components/hermes/profiles/ProfilesPanel.vue` | 小改 | expert profile 显示徽标 | UI 干扰可改 tooltip |
| `packages/client/src/router/index.ts` | 小改 | 注册 experts 路由 | 路由膨胀可合并 |
| `packages/client/src/i18n/locales/*.ts` | 新增文案 | 专家中心相关 | 漏翻译可分批补 |
| `tests/server/experts/*` | 新增 | catalog/install/upgrade/uninstall | 需 mock 云端 + filesystem |

## 10. 验收口径

- 专家目录：打开 `/hermes/experts` 看到 6 个已发布专家/专家团；`已安装` tab 显示本地安装态。
- 安装：选 `全栈架构专家 1.0.0` 点 `下载并激活` 1-3 秒完成；Profiles 出现新条目并带 `专家` 徽标；`installed_experts.status=installed`；`experts/packages/fullstack-architect/1.0.0/` 存在。
- 专家团安装：选 `软件开发专家团 1.0.0` 后，Profiles 出现 1 团长 + N 成员条目，全部带徽标。
- 升级：模拟新版本后升级，`installed_version` 改变，user 模型配置不变。
- 卸载：资源目录被删除；绑定表行被删除；普通 profile 不受影响。
- 回滚：下载到一半断网 → `status=failed` + `last_error + last_error_stage` 明确；临时文件清理。

## 11. Self-Test Commands

```bash
npm run test:changed
npm run build
npm run test:coverage
```

## 12. 范围红线（明确不做）

- 不做"Group Chat 接入"
- 不做"Jobs / Kanban 接入"
- 不做"自动推荐专家"
- 不做"本地多版本并存"
- 不动 user/profile/session 主表
- 不动 Chat / Global Agent 既有逻辑

## 13. 风险与依赖

- 依赖 1：云端 `baseUrl`（首版用 `http://127.0.0.1:8000`）
- 依赖 2：`HERMES_WEBUI_STATE_DIR` 默认值（已在代码中存在）
- 风险 1：解压路径穿越；必须 `path.resolve` 强校验
- 风险 2：专家团队递归安装时部分成员失败需保留已成功部分，并在响应里详细列出
- 风险 3：`createExpertProfile` 幂等覆盖 vs 不覆盖：明确 `不覆盖 user 自定义内容`

## 14. 关联文档

- `G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\expert_client_integration_spec.md v1.0`
- `docs/adr/ADR-0005-expert-marketplace-profile-integration.md`
- `docs/plans/expert_marketplace_local_task_specs.md`
- `docs/plans/README.md`（本目录索引）
