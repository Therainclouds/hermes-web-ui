# 7. 模型管理

**路由**：`/hermes/models`

> [← 返回索引](./README.md)

## 两个子面板

### 1. Providers（提供商）

- 列出当前 profile 可见的所有模型提供商（预设 + 自定义 OpenAI 兼容）。
- 操作：新增 / 编辑 / 删除提供商；自定义 URL（自动识别 `/v1`、`/v4` 等非 v1 版本）。
- OAuth 一键登录：OpenAI Codex、Nous Portal、GitHub Copilot。

### 2. Auxiliary Models（辅助模型）

- 默认/备用模型选择；分组管理同一提供商的多个模型。
- 点选切换该 provider 下的默认模型。
