# 25. 版本预览

**路由**：`/hermes/version-preview`  
**权限**：**仅超级管理员**

> [← 返回索引](./README.md)

在不破坏当前主版本的前提下，试用 GitHub 上某个 commit / PR 的预编译版本。

## 操作

- 填入 GitHub 引用（branch / tag / commit SHA / PR 号）。
- 点「拉取并启动预览」→ 后台下载并并行启动预览实例，不影响主服务。
- 预览结束后可一键回滚。

> 适合 QA、回归测试、给客户演示未发布特性。
