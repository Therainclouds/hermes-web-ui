# 24. MCP 管理

**路由**：`/hermes/mcp`  
**权限**：**仅超级管理员**

> [← 返回索引](./README.md)

管理本地 MCP（Model Context Protocol）服务器，供所有 Agent 调用工具。

## 操作

1. **新增服务器**：右上角「+」→ 选择 JSON / YAML 输入模式 → 填入 `command` / `args` / `env` 等。
2. **测试连接**：保存前点「测试」验证服务可启动。
3. **工具可见性**：点「工具」按钮 → 选择 all / include / exclude + 具体工具名，控制暴露给 Agent 的工具集。
4. **热重载**：点「Reload」让所有 Agent 重新读取 MCP 工具清单。
5. **删除**：行内「删除」按钮。
