# 02. 整体架构

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-07
- 依赖：`01-requirements.md`、`docs/adr/ADR-0001-device-update-release-source.md`

## 架构原则

- 单一事实源：设备更新相关元数据逐步收敛到 manifest。
- 兼容演进：保留现有 `source-deploy`，新增 `device-package` 策略。
- 最小提权：主服务非 `root` 常驻，安装器短时提权。
- 先校验后替换：清单、版本兼容性、摘要全部通过后才允许覆盖部署目录。
- 更新可查询：正式更新任务必须具备状态查询能力。

## 逻辑模块

### 1. Update Controller

职责：

- 接收前端更新请求。
- 创建更新任务。
- 返回任务受理结果与状态查询入口。

不承担职责：

- 不直接拼接下载 URL。
- 不直接写安装流程。
- 不直接做版本比较。

### 2. Update Service Module

建议拆分为：

- `manifest-client`：拉取并解析清单。
- `version-compare`：做 semver 比较。
- `strategy adapters`：按策略执行更新。
- `task-store`：持久化更新任务状态。
- `errors`：统一错误码与错误语义。

### 3. Strategy Adapters

- `npm-package`：兼容现有全局 npm 安装模式。
- `source-deploy`：兼容现有源码部署模式。
- `device-package`：新增设备包模式，作为主目标方案。

### 4. Privileged Installer

- 以脚本或独立 helper 形式存在。
- 运行时拥有安装所需高权限。
- 只接受受控参数和固定来源，不接受前端直接传入任意 URL。
- 负责安装、健康检查、失败回退。

## 推荐运行时关系

```mermaid
flowchart TD
  UI[Web UI 用户] --> API[Server Update Controller]
  API --> TASK[Task Store]
  API --> CHECK[Manifest Client]
  API --> STRATEGY[Device Package Strategy]
  STRATEGY --> DL[自有下载源]
  STRATEGY --> HELPER[Privileged Installer]
  HELPER --> DEPLOY[/opt/hermes-web-ui]
  HELPER --> SYSTEMD[systemd restart]
  HELPER --> HEALTH[/health]
```

## 权限模型

### 用户能力

允许登录用户执行：

- 检查更新
- 触发升级到当前通道最新官方版本
- 查看更新进度和结果

### 受限能力

不开放给普通用户：

- 修改下载源
- 修改更新通道
- 安装任意版本
- 手动回滚
- 关闭摘要校验

### 系统权限

- Web UI 主服务：普通用户运行
- 安装器：短时高权限执行
- 目标：避免全服务 root 化，只让必要步骤拥有提权能力

## 技术边界

本方案覆盖：

- Koa 后端更新检测与触发接口
- 设备包格式与下载源设计
- Bash 安装与回退流程
- `systemd` 兼容运行方式
- 发布工作流产物生成

本方案不覆盖：

- Electron 桌面更新器
- Docker 更新机制
- 批量设备管理后台
- 用户可配置的第三方更新源

## 设计落点

- 近期：`npm` 可继续作为版本发现源，自有下载源负责真正的设备包分发。
- 中期：检测与执行都转向 manifest，形成单一事实源。
- 长期：加入通道化、签名校验、指定版本回滚。
