# 6. 平台渠道

**路由**：`/hermes/channels`

> [← 返回索引](./README.md)

统一管理 **8 个外部平台** 的接入凭证与行为设置。所有改动在页面点「保存」后立即生效。

| 平台 | 关键配置 | 备注 |
| --- | --- | --- |
| Telegram | Bot Token、@提及控制、Reaction、自由回复 | 需要先在 Telegram 上创建一个 Bot 并取得 Token，再粘到此处 |
| Discord | Bot Token、@提及、自动开 Thread、Reaction、频道白/黑名单 | |
| Slack | Bot Token、@提及、机器人消息处理 | |
| WhatsApp | 启用开关、@提及控制、提及正则 | |
| Matrix | Access Token、Home Server、自动 Thread、私信 @ 线程 | |
| 飞书 (Lark) | App ID / Secret、@提及控制 | |
| 微信 | 浏览器扫码登录 → 自动保存凭证 | 仅桌面端可用 |
| 企业微信 | Bot ID / Secret | |

## 状态指示

每个平台卡片顶部会显示「已配置 / 未配置」，未配置时只需填写对应字段 → 点保存即可激活。
