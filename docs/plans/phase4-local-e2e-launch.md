# Phase 4 本地端到端测试启动清单

> 范围：在本机完成 hermes-web-ui 客户端专家中心端到端验证
> 云端：`http://127.0.0.1:8000`（Web_Admin_UI_HT）
> 数据：6 个已发布专家/团 + 6 个已发布 ZIP
> 目标：从 `/hermes/experts` 入口走完安装、激活、聊天、升级、卸载

## 0. 准备

- [ ] 云端 Django + DRF 服务已启动：`http://127.0.0.1:8000`
- [ ] 云端 `expert_app` 6 个专家/团均已 publish
- [ ] 云端 OSS / 本地存储可达，下载链接能打开
- [ ] 本机 `node >= 20` 已装（`node -v`）
- [ ] 本机 `pnpm` / `npm` 已装

## 1. 配置文件（已落地）

- 路径：`config/experts-marketplace.yaml`
- 关键字段：
  - `baseUrl: "http://127.0.0.1:8000"`
  - `cacheTtlSeconds: 30`
  - `maxPackageBytes: 104857600`（100 MiB）
- 已加入 `.gitignore`，不会泄漏

## 2. 启本地 dev

```bash
cd G:\AIproject\longxia_keli\hermes-web-ui
npm ci --ignore-scripts
npm run dev
```

预期：

- Vite 监听前端（默认 5173）
- Koa BFF 监听后端（默认 3000 或 4000，看现有配置）
- 浏览器打开：`http://127.0.0.1:<前端端口>`

## 3. 自检顺序

### 3.1 目录页

1. 登录后从左侧菜单点 `专家中心`
2. 应看到 3 个 Tab：已发布 / 已发布专家团 / 已安装
3. `已发布` 应出现 4 个单专家：`fullstack-architect / product-manager / deep-researcher / content-strategist`
4. `已发布专家团` 应出现 2 个：`software-team / content-team`
5. 卡片上显示 `latest_version`

### 3.2 安装单专家

1. 进入 `全栈开发专家 详情`
2. 点 `下载并激活`
3. 看到：底部 toast `安装成功，已创建 1 个专家身份，失败 0 个`
4. 验证：
   - 已安装 Tab 出现一行 `status=installed`
   - Profiles 页面出现一条 `expert_fullstack-architect` profile，带 `专家` 徽标
   - 本地 SQLite：`installed_experts.expert_slug='fullstack-architect'`

### 3.3 启动聊天

1. 在 Profiles 页点 `expert_fullstack-architect` 的 `开始对话`
2. 进 Chat，输入一句话发送
3. 验证：
   - 会话有回复
   - 顶部头像用专家包内的 avatar（若有）
   - 模型继续走当前用户的 provider（无预设）

### 3.4 安装专家团

1. 在 Experts 详情点 `software-team` 的 `下载并激活`
2. 预期：创建 1 团长 + N 成员（member 各自 `latest_version`）
3. 验证：
   - Profiles 出现 `expert_team_software-team` + N 个 `expert_member_*`
   - 所有都带 `专家` 徽标

### 3.5 升级

1. 模拟云端把 `fullstack-architect` 发一个 `1.0.1`
2. 本地点 `升级`
3. 验证：
   - `installed_version` 改变
   - `local_path` 切到 `…/1.0.1`
   - 旧版本目录存在（暂存，等以后清理逻辑上线）
   - user 模型配置保持不变

### 3.6 卸载

1. 在 Experts 详情点 `卸载`（带二次确认）
2. 验证：
   - 资源目录 `<state>/experts/packages/fullstack-architect/...` 被清空
   - `installed_experts` 记录删除
   - `expert_profile_bindings` 对应行删除
   - `expert_fullstack-architect` profile 在 Profiles 中消失
   - 普通 profile 不受影响

### 3.7 失败回滚

1. 临时把 `baseUrl` 改成 `http://127.0.0.1:9999`（不通）
2. 重启 dev，刷新目录
3. 预期：catalog 拉取失败，UI 显示 `catalog 拉取失败`
4. 把 baseUrl 改回，重启

## 4. 数据库自检 SQL

```sql
-- 安装列表
SELECT expert_slug, installed_version, status, last_error, last_error_stage
FROM installed_experts
ORDER BY updated_at DESC;

-- 绑定表
SELECT b.expert_slug, b.profile_name, b.role, b.parent_team_slug, b.installed_version
FROM expert_profile_bindings b
ORDER BY b.created_at DESC;
```

## 5. 文件落盘检查

- 路径：`<HERMES_WEBUI_STATE_DIR>/experts/packages/<slug>/<version>/`
- 包含：`manifest.json / prompts/system.md / assets/avatar.png`
- 不应包含：`config.yaml` / `.env` / 任何用户私钥

## 6. 失败检查表

| 现象 | 排查 |
|---|---|
| 目录为空 | `GET /api/hermes/experts/catalog` 直接 502，查看 Koa 日志；通常是云端 `baseUrl` 不可达 |
| 安装到一半卡住 | 看 `installed_experts.last_error` + `last_error_stage`；先 uninstall 再 retry |
| Profile 没出现 | 检查 `expert_profile_bindings` 与 `installExpert` 返回 `installed[]`；先 `fetchInstalled` 一次 |
| SHA256 mismatch | 云端 manifest sha256 与实际包不一致；重新上传 ZIP |
| 路径穿越报错 | 第三方包内容触发了 `..`，已记 `last_error_stage=extract`；联系上传方修复 |

## 7. 完成后

- 全部通过 → 通知另一边的 AI 同步收尾，更新 `EXPERT_MARKETPLACE_PROGRESS.md`
- 任何失败 → 把现象 + 日志贴回来，我跟进修复

## 8. 关联

- 设计稿：`docs/plans/phase4-client-integration.md`
- ADR：`docs/adr/ADR-0005-expert-marketplace-profile-integration.md`
- 云端进度：`G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\EXPERT_MARKETPLACE_PROGRESS.md`
- 集成契约：`G:\AIproject\longxia_keli\Web_Admin_UI_HT\docs\expert_client_integration_spec.md`
