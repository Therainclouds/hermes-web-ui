# 05. 设备侧更新流程

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-09
- 依赖：`02-architecture.md`、`03-package-spec.md`

## 当前链路问题

当前 `update-source-deploy.sh` 同时承担了：

- 推导 GitHub archive 地址
- 下载源码归档
- 校验基础结构
- 同步部署目录
- 调用 `deploy-source-armbian.sh` 继续构建和重启

这使得下载源和安装器职责耦合过深，不利于后续引入自有下载源、清单校验和失败回退。

## 第一阶段已确认边界

- 第一阶段先处理“更新不覆盖用户数据”和“更新模块收敛”，暂不直接进入 `device-package` 执行闭环。
- 需要保护的真实数据至少包括：
  - `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`
  - `UPLOAD_DIR`
  - `HERMES_HOME_DIR` / `HERMES_HOME`
- `Web UI` 聊天历史并不只存在于 `Hermes` 数据目录；当前普通聊天的 session/message 由 `Web UI` 本地 SQLite 持久化。
- `Web UI` 默认数据目录继续保持在用户家目录下，更新逻辑必须保证该目录和默认上传目录不会被覆盖。
- 当前 `HERMES_HOME_DIR=${DEPLOY_DIR}/hermes_data` 属于历史兼容布局，第一阶段不强制迁移，但不能继续只靠固定目录名保留来保护数据。
- 第一阶段的目录风险控制采用分级策略：
  - 低风险：正常更新
  - 中风险：告警但允许更新
  - 高风险：阻止更新

## 目标链路

设备侧更新流程调整为：

1. 服务端解析最新版本。
2. 创建更新任务并返回任务 ID。
3. 下载 manifest。
4. 下载设备包到 staging 目录。
5. 校验 manifest 字段和 `sha256`。
6. 创建 last-known-good 备份。
7. 调用受控安装器安装设备包。
8. 重启 `systemd` 服务。
9. 进行 `/health` 健康检查。
10. 成功则标记完成；失败则自动回退。

## 0.6.30 实机基线

`0.6.30` 开始，设备侧更新切换为以下 cutover 时序：

1. 新版本源码或设备包同步到 `DEPLOY_DIR`
2. `deploy-source-armbian.sh` 根据当前锁文件选择包管理器
3. 比对依赖快照：
   - 首次部署或快照缺失：视为依赖已变更
   - `package.json / package-lock.json / pnpm-lock.yaml / yarn.lock` 任一变化：视为依赖已变更
   - 未变化：仍执行一次干净依赖安装，因为 `node_modules` 不在更新包内
4. 显式执行依赖安装，再执行 `npm ls` 基础校验
5. 停止 `hermes-web-ui.service`
6. 若存在且此前处于运行中，停止 `hermes-agent.service`
7. 清理残留的 agent bridge broker / worker 进程与 IPC socket
8. 安装新的 `hermes-web-ui.service`，并以 `KillMode=control-group` 启动
9. 若 `hermes-agent.service` 在更新前处于运行中，则在 Web UI 恢复后重新启动
10. 执行 `/health`、版本切换、认证页和 bridge 日志检查

## 0.6.31 基础闭环收口

为彻底消除“正常重启被误判为失败”这一类低级错误，基础更新闭环进一步调整为：

1. `controller` 只负责接受请求、创建任务、完成 preflight 和把更新 handoff 给 privileged runtime
2. `source-deploy` / `device-package` 脚本成为 update task 的唯一 runtime owner
3. `systemctl start hermes-web-ui-update.service` 返回成功只表示“handoff 成功”，不再表示“更新成功”
4. runtime 通过共享 `update-task-state.py` 显式写入阶段、heartbeat、成功态和失败态
5. 新版本 Web UI 启动后只做两件事：
   - 若任务仍由 runtime owner 持有且 heartbeat 新鲜，则继续展示“更新中”
   - 若是 `npm-package` 这类 controller-owned restart，且当前版本已切到目标版本，则补写成功态
6. 只有 runtime heartbeat 超时后，运行中的任务才会被恢复成 interrupted failed

这条收口后的 owner 规则意味着：

- 正常的 `SIGINT` / `systemd stop` 不再被解释成更新失败
- `source-deploy` 和 `device-package` 终于共享同一套任务状态语义
- 前端看到的失败态只来自真实失败或 stale heartbeat，而不是旧进程被正常替换

这条基线的目标不是升级 Hermes Agent 版本，而是保证更新切换期间：

- 旧 Web UI 派生的 bridge 子进程不会残留
- 活跃的 `hermes-agent.service` 会被同步 stop/start
- 新增依赖会在服务重启前完成安装
- 后续版本可以基于依赖快照继续判断依赖文件是否变化

## 脚本职责演进

### `update-source-deploy.sh`

建议演进为以下两种角色之一：

- 兼容 wrapper：保留旧入口，但内部改为读取 manifest 并调用新安装器。
- fallback adapter：仅在旧策略下继续工作，新策略改用 `install-device-package.sh`。

推荐方案：第二种。原因是职责更清晰，可减少历史逻辑与新逻辑互相污染。

在第一阶段，旧脚本仍需继续承担现有 `source-deploy` 更新职责，但要先补齐两项能力：

- 在真正清理或覆盖 `DEPLOY_DIR` 前识别真实数据路径，而不是只保留固定目录名。
- 对历史兼容布局给出明确告警，对明显危险布局直接失败退出。

### `install-device-package.sh`

新增脚本，作为 privileged installer：

- 输入：已下载且待安装的设备包路径、目标版本、健康检查参数
- 输出：成功 / 失败 / 日志路径 / 回退结果
- 职责：
  - 解包到 staging
  - 校验包结构
  - 备份当前部署目录
  - 执行替换
  - 调用 `deploy-source-armbian.sh` 的 update-only 模式
  - 健康检查失败时回退

## 建议状态机

- `idle`
- `checking`
- `downloading`
- `verifying`
- `backing_up`
- `installing`
- `restarting`
- `health_checking`
- `succeeded`
- `failed`
- `rolled_back`

## 任务持久化

建议把更新任务状态落盘到 Web UI home，而不是只保存在内存：

- 可在服务重启后恢复状态
- 可向前端提供查询
- 可为运维提供日志索引

当前已落地的基础字段包括：

- `owner`: `controller` 或 `runtime`
- `heartbeatAt`: runtime 最近一次确认仍在推进任务的时间
- `stage` / `message` / `targetVersion`
- `logPath` / `healthcheckUrl`

其中 `owner + heartbeatAt` 是这次基础闭环的核心。它们负责区分：

- 正常 handoff
- 长时间构建中的运行态任务
- 真实中断后需要恢复失败的 stale task

## 用户视角

用户能看到：

- 当前版本
- 最新版本
- 更新源标签
- 更新进度状态
- 失败原因摘要

用户不应直接接触：

- 下载 URL
- 摘要关闭开关
- 任意版本回滚入口

## 第一阶段落地说明

- `source-deploy` 和 `npm-package` 都要接入统一 preflight。
- preflight 的主要职责是判断“哪些目录是程序目录，哪些目录是数据目录”，并输出风险级别。
- 自动回退在第一阶段只回退程序替换，不处理用户数据迁移，也不回滚用户数据内容。
- 若现场目录结构属于兼容布局，系统应返回可追溯的告警信息，供后续运维逐步治理。

## P3-A 当前落地范围

- 已新增 `device-package` 策略主入口，用于：
  - 严格读取 manifest
  - 校验 `packageType / artifactFormat / sha256 / compatibleNodeMajor / minCurrentVersion`
  - 下载设备包到 staging 目录
  - 校验下载包 `sha256`
  - 调用受控安装器
- 已新增 `install-device-package.sh`，当前职责包括：
  - 解包到 staging/work 目录
  - 校验包结构
  - 创建程序目录备份
  - 保护数据目录后执行受控替换
  - 调用 `deploy-source-armbian.sh update-only`
- 当前 P3-A 尚未完成：
  - `/health` 健康检查失败后的自动回退
  - 更新任务状态的磁盘持久化
  - 目标设备环境中的实际安装验收
