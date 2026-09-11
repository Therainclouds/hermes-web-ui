# Hermes USB 自动识别任务 Specs

> 版本：v1.0
> 更新时间：2026-07-01
> 状态：可派工

---

## 1. 文档目标

本文档定义 `hermes-web-ui` 在“USB 自动识别与 Agent 可读”项目中的本仓库职责、技术收束边界与开发任务拆分，供前后端、Python、运维与 QA 协同和排期使用。

本文档是任务规格文档，不重复展开完整架构设计。技术事实源以 `docs/plans/hermes-usb-integration-plan.md` v1.1 为准。

关联文档：

- `docs/plans/hermes-usb-integration-plan.md`
- `ARCHITECTURE.md`
- `AGENTS.md`

---

## 2. 开发边界

### 2.1 本仓库负责

本仓库负责：

- 监听 Linux block 设备插拔事件
- 自动挂载 USB 存储设备到 Hermes 工作区
- 维护 USB 设备状态与 24 小时事件历史
- 通过 `Socket.IO` 将 USB 状态实时同步到 Web UI
- 提供 USB 列表、目录浏览、文件读取与文件元信息 API
- 提供 USB 设备页、文件浏览器、Toast 与铃铛历史
- 为 Hermes Agent 提供统一的 USB HTTP 读取入口
- 提供 systemd、sudoers、日志、回滚与排查约束

### 2.2 本仓库不负责

本仓库不负责：

- 写入 U 盘
- 加密 U 盘自动解锁
- HFS+ / APFS 的原生读支持
- 网络存储（NFS / SMB）
- 多用户权限隔离
- USB 摄像头、扫码枪等非存储设备

---

## 3. 技术收束边界

### 3.1 固定技术栈

实现保持当前真实技术栈：

- Python 监听器：`pyudev + subprocess + blkid + mount`
- 服务端：`Koa + Socket.IO + SQLite`
- 前端：`Vue 3 + Vue Router + Pinia`
- Agent 接入：本地 HTTP API

### 3.2 固定设备标识模型

固定采用：

- `uuid` = 稳定设备标识
- `device_node` = 运行时设备节点，仅用于诊断与日志
- 挂载点路径 = `hermes_data/mnt/usb/<UUID>/`

明确禁止：

- 使用 `/dev/sdXN` 作为设备主键
- 使用设备 label 作为唯一标识

### 3.3 固定实时通信模型

固定采用：

- 前端实时更新统一走 `Socket.IO` namespace `/usb`
- 事件最少包含：`ready`、`device_event`、`heartbeat`
- 事件历史保存在本地 SQLite

明确禁止：

- 为 USB 再新增一套独立 SSE 通道

### 3.4 固定 Agent 访问模型

固定采用：

- Agent Tool 通过 Node HTTP API 访问 USB 数据
- Node 服务是 USB 状态、路径校验与审计的唯一真实来源

明确禁止：

- Agent 直接读取 `hermes_data/mnt/usb/...` 绕过服务端安全边界

### 3.5 固定部署模型

固定采用：

- `systemd` 托管 Python 监听器
- `sudoers` 仅对白名单二进制授权：`mount`、`umount`、`blkid`
- `Restart=always` + `RestartSec=3`

### 3.6 固定前端体验边界

首版必须包含：

- 页面 Toast
- 顶栏铃铛历史
- USB 设备页
- 文件浏览器
- “让 Agent 读取”入口

首版不包含：

- 文件编辑
- 拖拽上传到 U 盘
- 复杂媒体预览器

---

## 4. 验收总原则

- 不破坏现有 `devices`、`chat`、`profiles`、`files` 主链路
- USB 状态变化必须在 1 秒级反馈到 Web UI
- 所有设备主键、路由参数与挂载目录统一使用 `uuid`
- 所有文件读取都必须经过路径穿越校验
- 100MB 以上文件读取必须被拒绝
- 冷启动扫描不触发声音通知
- 多盘并发不会出现状态串盘
- 失败场景必须能被用户感知并可排查

---

## 5. 任务总览

| Spec | 名称 | 负责人建议 | 依赖 |
|------|------|------------|------|
| `SPEC-15` | Python USB 监听与自动挂载 | Python / 平台 | Phase 0 环境准备 |
| `SPEC-16` | Node USBService、REST 与事件存储 | 本地后端 | `SPEC-15` |
| `SPEC-17` | Socket.IO 实时推送与通知节流 | 前端 + 本地后端 | `SPEC-16` |
| `SPEC-18` | USB 设备页与文件浏览器 | 前端 | `SPEC-16` |
| `SPEC-19` | Agent Tool 与“让 Agent 读取”闭环 | 本地后端 + Agent | `SPEC-16` |
| `SPEC-20` | 部署、回滚与运维约束 | 平台 / 运维 | `SPEC-15` |
| `SPEC-21` | QA、兼容性与安全回归 | QA | `SPEC-15 ~ SPEC-20` |

---

## 6. SPEC-15 Python USB 监听与自动挂载

### 背景

命令行 Ubuntu 环境中，USB 插拔默认没有图形反馈，也没有自动挂载链路。

### 目标

实现 Python 监听器，负责检测 block 设备插拔、完成自动挂载、输出结构化事件。

### 范围

- `pyudev` 监听 block 分区设备
- 冷启动扫描现有分区
- 通过 `blkid` 获取 `uuid` 与文件系统类型
- 挂载到 `hermes_data/mnt/usb/<UUID>/`
- 输出 JSON Lines 事件到 stdout
- 失败诊断映射到 `mount_failed`

### 改动范围

- `hermes_data/bots/usb/usb_monitor.py`
- `hermes_data/bots/usb/mounter.py`
- `hermes_data/bots/usb/config.py`

### 验收标准

- 插入 FAT32 / NTFS / exFAT / ext4 设备可以生成 `device_event:add`
- 拔出设备可以生成 `device_event:remove`
- 事件中包含 `uuid`、`device_node`、`mount_point`、`status`
- 同一设备重复拔插不会因为 `/dev/sdXN` 漂移导致挂载目录变化
- HFS+ / APFS / 损坏文件系统会返回明确失败信息，不会假成功

### 不包含

- 不包含 systemd 安装
- 不包含前端通知显示

---

## 7. SPEC-16 Node USBService、REST 与事件存储

### 背景

Python 监听器只负责底层设备事件，Web UI 仍需要一个稳定的本地服务层做状态整合、API 暴露和历史存储。

### 目标

实现 `USBService`、`USBEventStore` 和 USB REST API，形成服务端唯一真实来源。

### 范围

- 管理 Python 子进程生命周期
- 解析 JSON Lines 并维护 `Map<uuid, USBDevice>`
- 暴露 `/api/usb/devices`
- 暴露目录列表、文件读取、文件元信息、磁盘用量接口
- 保存 24 小时事件历史
- 启动 Node 定时清理任务

### 改动范围

- `packages/server/src/services/usb/USBService.ts`
- `packages/server/src/services/usb/USBDevice.ts`
- `packages/server/src/services/usb/USBEventStore.ts`
- `packages/server/src/services/usb/index.ts`
- `packages/server/src/routes/usb.ts`
- `packages/server/src/controllers/` 下对应 USB 控制器入口

### 验收标准

- 服务端以内存 `uuid -> device` 模型返回当前设备状态
- `/api/usb/devices/:uuid/*` 路由可以工作
- 路径穿越请求会被拒绝
- 100MB 以上文件读取被拒绝
- 历史事件超过 24 小时后会被自动清理
- Python 子进程退出后可以自动重启

### 不包含

- 不包含前端 UI
- 不包含 Agent Tool 封装

---

## 8. SPEC-17 Socket.IO 实时推送与通知节流

### 背景

USB 首版要求“插拔可见”，仅有 REST 查询不足以提供实时体验。

### 目标

复用项目已有 `Socket.IO`，为 USB 建立统一实时推送与通知节流机制。

### 范围

- 注册 `Socket.IO` namespace `/usb`
- 定义 `ready`、`device_event`、`heartbeat`
- 客户端 composable 订阅 `/usb`
- 2 秒同类事件去重
- 冷启动扫描静默
- 铃铛历史与 Toast 同步更新

### 改动范围

- `packages/server/src/index.ts`
- `packages/server/src/services/usb/USBService.ts`
- `packages/client/src/composables/useUSBStream.ts`
- `packages/client/src/composables/useUSBNotification.ts`
- `packages/client/src/components/USBToast.vue`
- `packages/client/src/components/USBBell.vue`

### 验收标准

- 插入或拔出设备时前端无需刷新即可更新
- 冷启动同步只更新列表，不播放声音
- 2 秒内重复同类事件不会产生通知轰炸
- `/usb` namespace 断线后可自动恢复

### 不包含

- 不包含 USB 文件浏览 UI 细节

---

## 9. SPEC-18 USB 设备页与文件浏览器

### 背景

用户不仅要“知道插了 U 盘”，还要能在 Web UI 中看到设备详情并浏览文件。

### 目标

新增 `USB` 设备页和文件浏览器，提供设备列表、目录浏览和基础文件操作入口。

### 范围

- `/usb` 路由入口
- 设备卡片列表
- 挂载状态、文件系统、容量、路径展示
- 文件浏览器目录列表
- 文本 / 图片基础预览
- 复制路径、下载入口

### 改动范围

- `packages/client/src/router/index.ts`
- `packages/client/src/views/USBView.vue`
- `packages/client/src/views/USBFileBrowser.vue`
- `packages/client/src/components/USBEventHistory.vue`
- `packages/client/src/api/` 下对应 USB API 调用封装

### 验收标准

- 用户可以看到当前所有 USB 存储设备
- 用户可以浏览指定设备目录
- 能看到当前路径、文件类型、文件大小等基础信息
- 点击 Toast 可以跳转到 USB 页面
- UI 文案同步更新所有 locale 文件

### 不包含

- 不包含写入、删除、重命名 U 盘文件

---

## 10. SPEC-19 Agent Tool 与“让 Agent 读取”闭环

### 背景

“AI 可用”是 USB 项目的核心价值之一，仅有页面浏览不能满足需求。

### 目标

让 Hermes Agent 能通过统一 HTTP API 列表目录、读取文件并触发前端可见反馈。

### 范围

- `usb_list_devices`
- `usb_list_files`
- `usb_read_file`
- `usb_copy_to_workspace`
- 前端“让 Agent 读取”按钮
- Agent 读取时的前端提示

### 改动范围

- `hermes_data/agents/usb_tools.py`
- 服务端 USB 读取接口
- 前端 USB 页面与文件浏览器中的 Agent 触发入口

### 验收标准

- Agent 可以枚举当前 USB 设备
- Agent 可以读取指定文本文件
- Agent 可以把文件复制到工作区
- Agent 不会绕过服务端安全校验直接访问挂载目录
- 用户能看到“Agent 正在读取”或“读取完成”的反馈

### 不包含

- 不包含 Agent 自动分析模板

---

## 11. SPEC-20 部署、回滚与运维约束

### 背景

没有可安装、可回滚、可排查的部署约束，USB 功能无法进入可运维状态。

### 目标

明确 Python 监听器的 systemd 托管方式、sudoers 授权范围、回滚步骤和排查入口。

### 范围

- systemd unit 模板
- sudoers 白名单
- 安装步骤
- 回滚步骤
- 日志路径
- 故障排查命令

### 改动范围

- `scripts/` 下后续部署脚本或安装说明
- systemd unit 目标安装位置
- sudoers 目标安装位置

### 验收标准

- 监听器可以开机自启
- 子进程退出 3 秒内可重启
- sudoers 只授权必要命令
- 回滚后系统仍可手动 mount USB
- 故障排查信息可复现问题来源

### 不包含

- 不包含云端监控平台接入

---

## 12. SPEC-21 QA、兼容性与安全回归

### 背景

USB 功能横跨 Python、服务端、前端和运维，回归面广，必须有明确 QA 范围。

### 目标

为 USB 功能建立可执行的兼容性、安全性和用户体验回归清单。

### 范围

- FAT32 / NTFS / exFAT / ext4 兼容性
- 多盘并发
- 冷启动扫描
- 无声卡静默
- 大文件限制
- 路径穿越防护
- mount 失败与损坏文件系统提示

### 建议测试层级

- Python：监听与挂载逻辑单元测试
- Server：REST、路径校验、事件存储测试
- Client：通知、路由、文件浏览交互测试
- E2E：插拔到页面反馈主链路

### 验收标准

- 目标文件系统兼容性通过
- 多设备状态不会串盘
- 无声卡设备不会报错
- 100MB 限制生效
- 恶意路径无法读取宿主机任意文件
- USB 功能不影响现有 Hermes 聊天主链路

### 不包含

- 不包含真实量产硬件认证

---

## 13. 排期建议

```text
SPEC-15 -> SPEC-16 -> SPEC-17 -> SPEC-18 -> SPEC-19 -> SPEC-20 -> SPEC-21
```

推荐并行方式：

- Python / 平台先完成 `SPEC-15`
- 本地后端在 `SPEC-15` 输出稳定事件后推进 `SPEC-16`
- 前端可在 API 草约稳定后并行推进 `SPEC-17` 与 `SPEC-18`
- Agent 与 QA 在主链路可用后推进 `SPEC-19 ~ SPEC-21`

---

## 14. 派工建议

- Python / 平台：`SPEC-15`
- 本地后端：`SPEC-16`、`SPEC-19`
- 前端：`SPEC-17`、`SPEC-18`
- 运维 / 平台：`SPEC-20`
- QA：`SPEC-21`

