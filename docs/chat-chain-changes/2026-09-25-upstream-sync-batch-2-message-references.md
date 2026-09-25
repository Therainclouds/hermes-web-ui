# 2026-09-25 — upstream 同步第二批：消息引用图标 + 工作区内联预览

## 日期
2026-09-25

## 来源（upstream cherry-pick）

- `e992931cc` #2908 `fix(files): render workspace Markdown previews`
- `62eb90494` `fix(chat): preview code-styled local file links`
- `95b4a4153` #2903 `fix: restore reply arrow for message references`
- `ada175c21` #2887 `feat: create categories from the session move menu`

## 触及的功能

- **消息引用气泡**（message reference）图标：恢复为回复箭头 SVG
- **工作区文件 diff 面板**：Markdown 与代码块内联富文本预览
- **会话列表分类**：可从「移动到」菜单直接新建分类

## 行为影响

- 引用气泡按钮恢复箭头图标。相关旧提交 `#2893`（改用 quote 图标）**已跳过**——
  它早于 `#2903`，cherry-pick 会把图标倒退回去
- `WorkspaceFileDiff.vue` 对 Markdown 文件渲染富文本预览，而非纯文本
- 会话移动菜单新增「新建分类」入口

## 本地适配说明

- 冲突解决时一律保留本地 `@/api/hermes/*` 路径，拒绝上游 `@/api/studio/*` 重构路径
  （见 `docs/harness/upstream-sync-20260925-conflict-analysis.md` D1）
- `ChatPanel.vue` 在自动合并中产生了重复的 `FilePreview` 异步组件声明（第 92/94 行同值），
  已手工去重；该重复行是本批唯一需要修复的类型错误
- 本批仅挑入 4 个提交，其余因 social-messages 域、本地先做重构（chat store 拆分）、
  prettier 风格差异、或引入未就绪的新依赖而跳过，转入手工移植清单
