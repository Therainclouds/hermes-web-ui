# Hermes Web UI 用户功能教程

> 本教程面向 **最终使用者**（管理员 / 普通管理员），覆盖项目启动后 Web 控制台与桌面客户端中所有可见模块的操作方法。  
> 与代码无关，重点是「进入某个页面 → 能做什么 → 怎么操作」。  
> 路由路径以 `#/hermes/xxx` 为基准（项目使用 hash 路由）。

---

## 模块索引

| # | 模块 | 路由 | 权限 |
| - | --- | --- | --- |
| 1 | [登录与账户](./01-login.md) | `/` | 公开 |
| 2 | [AI 对话](./02-chat.md) | `/hermes/chat` | 登录用户 |
| 3 | [全局 Agent](./03-global-agent.md) | `/hermes/global-agent` | 登录用户 |
| 4 | [历史会话](./04-history.md) | `/hermes/history` | 登录用户 |
| 5 | [群聊](./05-group-chat.md) | `/hermes/group-chat` | 登录用户 |
| 6 | [平台渠道](./06-channels.md) | `/hermes/channels` | 登录用户 |
| 7 | [模型管理](./07-models.md) | `/hermes/models` | 登录用户 |
| 8 | [配置 Profile](./08-profiles.md) | `/hermes/profiles` | **仅超级管理员** |
| 9 | [文件浏览](./09-files.md) | `/hermes/files` | 登录用户 |
| 10 | [定时任务](./10-jobs.md) | `/hermes/jobs` | 登录用户 |
| 11 | [看板](./11-kanban.md) | `/hermes/kanban` | 登录用户 |
| 12 | [工作流](./12-workflow.md) | `/hermes/workflow` | 登录用户 |
| 13 | [专家中心](./13-experts.md) | `/hermes/experts` | 登录用户 |
| 14 | [编码代理](./14-coding-agents.md) | `/hermes/coding-agents` | 登录用户 |
| 15 | [技能](./15-skills.md) | `/hermes/skills` | 登录用户 |
| 16 | [技能使用记录](./16-skills-usage.md) | `/hermes/skills-usage` | 登录用户 |
| 17 | [插件](./17-plugins.md) | `/hermes/plugins` | 登录用户 |
| 18 | [记忆](./18-memory.md) | `/hermes/memory` | 登录用户 |
| 19 | [设置](./19-settings.md) | `/hermes/settings` | 登录用户 |
| 20 | [使用统计](./20-usage.md) | `/hermes/usage` | 登录用户 |
| 21 | [性能监控](./21-performance.md) | `/hermes/performance` | **仅超级管理员** |
| 22 | [Web 终端](./22-terminal.md) | `/hermes/terminal` | **仅超级管理员** |
| 23 | [设备发现](./23-devices.md) | `/hermes/devices` | 登录用户 |
| 24 | [MCP 管理](./24-mcp.md) | `/hermes/mcp` | **仅超级管理员** |
| 25 | [版本预览](./25-version-preview.md) | `/hermes/version-preview` | **仅超级管理员** |
| 26 | [日志](./26-logs.md) | `/hermes/logs` | 登录用户 |

---

## 通用提示

- **左下角 Sidebar**：所有路由入口，长期悬浮折叠。
- **主题切换**：左下角「☀ / 🌙」图标。
- **语言切换**：右上角地球图标，支持中 / 英 / 日 / 韩 / 法 / 德 / 西 / 葡 / 俄 / 繁中等。
- **首次登录**：使用管理员下发的初始账户登录后，系统会弹出「请修改默认账户和密码」横幅，点「去修改」即可进入 `设置 → 账户` 修改。
- **遇到问题先看「日志」**：所有运行时报错、连接异常、Agent 执行失败都汇总在 `日志` 页面，按级别、关键字过滤可快速定位。
- **遇到登录锁定或密码丢失**：联系超级管理员在 `设置 → 账户管理` 中重置即可。

---

> 本文档由 Cloud 整理；如功能发生变化请同步更新本文档。
