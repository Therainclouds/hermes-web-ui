# 📋 USB 自动识别集成方案 · 开发文档

**项目代号：** `hermes-usb-bridge`  
**文档版本：** v1.1
**适用环境：** Ubuntu Server（无 GUI）+ Hermes Web UI
**目标：** 让命令行系统的 USB 设备插拔在 Hermes Web 页面"看得见、摸得着、AI 用得了"

> **v1.1 修订说明**（2026-07-01）：根据评审反馈调整 4 项关键决策
> - C1 推送通道：**SSE → Socket.IO**（复用已有长连接，复用鉴权与重连）
> - C2 部署：**新增 systemd unit 模板 + 3 秒自动重启**
> - C3 挂载点命名：**`/dev/sdXN` → UUID**（避免拔插顺序导致的节点漂移）
> - M1 Agent Tool：**方案 B → 方案 A**（走 HTTP，统一鉴权与审计）

---

## 一、需求背景

### 1.1 现状

- 用户使用**命令行 Ubuntu 系统**，无图形界面
- USB 设备插拔后**没有任何视觉反馈**，用户无法感知
- 移动硬盘/U 盘的文件需要**手动 mount** 才能访问
- AI 助手（Hermes Agent）**没有 USB 操作能力**，无法读取外置存储

### 1.2 目标

```
"让命令行 Ubuntu 系统的 USB 设备，在 Hermes Web 页面里拥有图形化体验"
```

**核心价值：**
- 🥇 **用户感知**：插入/拔出立即弹出 toast 通知
- 🥈 **自动挂载**：U 盘自动挂载到 Hermes 工作区
- 🥉 **AI 可用**：Agent 能读取 U 盘文件，复用同一份状态

---

## 二、产品决策（已确认）

| 编号 | 决策项 | 选择 | 备注 |
|------|--------|------|------|
| Q1 | 挂载方式 | **自动挂载** | 插上即用，无需手动操作 |
| Q2 | 挂载路径 | **Hermes 工作区** | `/opt/hermes-web-ui/hermes_data/mnt/usb/<UUID>/` |
| Q2.1 | 挂载点命名 | **UUID（v1.1 修订）** | 原方案用设备节点 `/dev/sdXN`，会被插入顺序影响；改用 `blkid -s UUID -o value` 输出 |
| Q3 | 通知方式 | **视觉 + 铃铛角标 + 声音（按设备能力）** | 有声卡播铃声，无声卡静默 |
| Q3.1 | 通知节流（v1.1 新增） | **2 秒合并同类事件** | 冷启动扫描 + 多盘并发不轰炸；首次/异常才弹系统级 Notification |
| Q4 | 历史保留 | **24 小时** | Node 端 `setInterval` 清理，不用 SQL 时间函数避免时区漂移 |
| Q5 | 设备白名单 | **不需要** | 全量识别 |
| Q6 | 推送通道（v1.1 新增） | **Socket.IO** | 复用项目已有长连接；不复用独立 SSE，避免双通道鉴权 |
| Q7 | Agent Tool（v1.1 新增） | **方案 A：走 HTTP** | Tool 调 Node REST API，统一鉴权 + 审计 + 路径防护 |

---

## 三、系统架构

### 3.1 总体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    👤 用户视角（Hermes Web 浏览器）          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  🔔 顶栏铃铛（角标 + 下拉历史）                       │  │
│  │  📱 页面 Toast（右下角通知，5秒自动消失）             │  │
│  │  💾 USB 设备页（列表 + 文件浏览器 + 操作按钮）        │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────┘
                                   │ HTTPS + Socket.IO
┌──────────────────────────────────▼──────────────────────────┐
│              ⚙️ Hermes Web UI 后端（Node.js）              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  USBService（内存设备状态表 + 事件总线）              │  │
│  │  ├─ REST API: /api/usb/*                            │  │
│  │  ├─ Socket.IO namespace: /usb                      │  │
│  │  │    ├─ event: 'device_event'                     │  │
│  │  │    ├─ event: 'mount_failed'                     │  │
│  │  │    └─ event: 'heartbeat' (30s)                  │  │
│  │  └─ Web Notification API（前端调用，浏览器播声音）  │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────┘
                                   │ spawn + stdout
┌──────────────────────────────────▼──────────────────────────┐
│              🐍 Python 监听器（独立子进程）                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  pyudev 监听 → 检测插拔                             │  │
│  │  subprocess mount → 自动挂载到工作区                 │  │
│  │  JSON 事件流 → 输出到 stdout                        │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────┘
                                   │ Linux kernel uevent
┌──────────────────────────────────▼──────────────────────────┐
│              💾 内核层（block subsystem）                   │
│  /dev/sdb1, /dev/sdc1 ...                                 │
└─────────────────────────────────────────────────────────────┘
                                   │
                                   │ 文件系统访问
┌──────────────────────────────────▼──────────────────────────┐
│              🤖 Hermes Agent（独立进程）                    │
│  ├─ usb_list_devices()                                   │
│  ├─ usb_read_file()                                      │
│  └─ usb_copy_to_workspace()                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 数据流（插入 U 盘）

```
1. 内核检测到 block 设备插入
   ↓
2. pyudev 监听器收到 uevent
   ↓
3. Python 监听器执行 mount，挂载到 hermes_data/mnt/usb/<UUID>/
   ↓
4. Python 输出 JSON 事件到 stdout
   {"type":"device_event","action":"add","device_node":"/dev/sdb1",
    "uuid":"4A1B-2C3D","mount_point":"...","label":"KINGSTON",
    "fs_type":"vfat","size_bytes":...,"status":"mounted"}
   ↓
5. Node USBService 解析事件，更新内存 Map（key = UUID）
   ↓
6. USBService 通过 Socket.IO namespace `/usb` 广播 `device_event`
   ↓
7. 前端显示 Toast（视觉）+ 浏览器播声音（如有声卡）+ 铃铛角标 +1
   ↓
8. 用户点击 Toast，跳转 USB 设备页
   ↓
9. 用户点击「🤖 让 Agent 读取」
   ↓
10. 前端发 chat 消息，Agent 调用 usb tool
   ↓
11. Agent 读取文件，前端显示完成 Toast
```

---

## 四、目录结构

```
/opt/hermes-web-ui/
├── hermes_data/
│   ├── mnt/
│   │   └── usb/                    ← 【新增】USB 自动挂载根目录
│   │       ├── .gitkeep
│   │       ├── 4A1B-2C3D/        ← U 盘 1（FAT32 label "KINGSTON"）
│       └── 8E9F-A0B1/        ← U 盘 2（vfat label "Samsung"）
│   │
│   ├── usb_events.db              ← 【新增】SQLite 事件历史库
│   │
│   ├── bots/
│   │   └── usb/                    ← 【新增】Python 监听器
│   │       ├── usb_monitor.py     ← 主监听脚本
│   │       ├── mounter.py         ← 挂载逻辑封装
│   │       ├── config.py          ← 配置（挂载点、日志路径）
│   │       └── README.md
│   │
│   └── agents/
│       └── usb_tools.py            ← 【新增】Hermes Agent Tool 模块

packages/
├── server/src/
│   ├── services/
│   │   └── usb/
│   │       ├── USBService.ts       ← 【新增】设备状态服务
│   │       ├── USBDevice.ts        ← 【新增】设备数据模型
│   │       ├── USBEventStore.ts    ← 【新增】SQLite 事件持久化
│   │       └── index.ts
│   │
│   └── routes/
│       └── usb.ts                  ← 【新增】REST + Socket.IO 路由
│
└── client/src/
    ├── views/
    │   ├── USBView.vue            ← 【新增】USB 设备页
    │   └── USBFileBrowser.vue     ← 【新增】文件浏览器组件
    │
    ├── components/
    │   ├── USBToast.vue           ← 【新增】Toast 通知组件
    │   ├── USBBell.vue            ← 【新增】顶栏铃铛组件
    │   └── USBEventHistory.vue    ← 【新增】历史下拉列表
    │
    ├── composables/
    │   ├── useUSBStream.ts        ← 【新增】Socket.IO 订阅 composable
    │   └── useUSBNotification.ts  ← 【新增】浏览器通知 + 声音
    │
    └── router/
        └── index.ts               ← 【修改】加 /usb 路由
```

---

## 五、模块详细设计

### 5.1 Python 监听器层

#### 5.1.1 职责

- 监听 Linux 内核 uevent（block 子系统）
- 识别 U 盘/移动硬盘插入与拔出
- 自动执行 mount 命令
- 输出结构化 JSON 事件

#### 5.1.2 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| 监听库 | `pyudev` | 直接绑定 libudev，性能好，无需轮询 |
| 挂载工具 | `mount` 命令（subprocess） | 不依赖 udisks2/D-Bus，兼容性最强 |
| 文件系统识别 | `blkid` 命令 | 自动探测 vfat/ntfs/exfat/ext4 |
| 输出格式 | JSON Lines（每行一个事件） | 流式解析友好 |

#### 5.1.3 事件类型

```typescript
// 设备插入
{
  "type": "device_event",
  "action": "add",
  "device_node": "/dev/sdb1",       // 运行时元数据，可能下次插入变 sdc1
  "uuid": "4A1B-2C3D",               // 【v1.1】稳定标识，挂载点与 Map key 都用这个
  "mount_point": "/opt/hermes-web-ui/hermes_data/mnt/usb/4A1B-2C3D",
  "fs_type": "vfat",
  "label": "KINGSTON",
  "vendor": "Kingston",
  "model": "DataTraveler 3.0",
  "serial": "E0D55EA573FCE6C1",
  "size_bytes": 32212254720,
  "status": "mounted",
  "ts": "2026-06-30T14:23:15.123Z"
}

// 设备拔出
{
  "type": "device_event",
  "action": "remove",
  "uuid": "4A1B-2C3D",
  "device_node": "/dev/sdb1",       // 拔出时仍记录，便于排查
  "label": "KINGSTON",
  "status": "removed",
  "ts": "2026-06-30T14:35:22.456Z"
}

// 挂载失败
{
  "type": "device_event",
  "action": "add",
  "uuid": "unknown-hfsplus-xxx",    // blkid 取不到 UUID 时的占位
  "device_node": "/dev/sdb1",
  "status": "mount_failed",
  "error": "unknown filesystem type 'hfsplus'",
  "ts": "2026-06-30T14:23:15.123Z"
}

// 启动就绪
{ "type": "ready", "ts": "...", "existing_devices": [ ... ] }

// 心跳（每 30 秒）
{ "type": "heartbeat", "ts": "..." }
```

#### 5.1.4 关键逻辑

**挂载策略【v1.1 修订】：**
1. **获取稳定标识**：执行 `blkid -s UUID -o value <device_node>` 取 UUID
   - 取不到（无文件系统 / 加密盘 / 不识别 FS）→ UUID 占位 `unknown-<device_node>`
2. **挂载点路径**：`mnt/usb/<UUID>/`
   - 用 UUID 而非设备节点，避免拔插顺序导致路径漂移
3. **挂载命令**：`mount -t auto -o rw,noexec,nodev,nosuid,utf8=1 <device_node> <mount_point>`
   - 优先 auto；失败 → `blkid -o value -s TYPE` 指定类型再试一次
4. **失败诊断**（v1.1 增强）：
   - `unknown filesystem type 'hfsplus'` → 提示"macOS HFS+ 不支持，请在 Mac 转 exFAT"
   - `unknown filesystem type 'apfs'` → 同上
   - `mount: /dev/sdb1 is write-protected` → 提示"只读盘"
   - `mount: wrong fs type, bad option` → 提示"文件系统损坏，建议 fsck"
   - 错误信息直接进 `error` 字段，前端 Toast 显示
5. **不支持 FS 白名单**：vfat / ntfs / exfat / ext4 / btrfs，**其他一律进 mount_failed**

**拔出处理：**
- 监听 `remove` 事件
- **不主动 umount**（内核自动清理）
- 但**清理挂载点目录**（防止目录堆积），保留 `.gitkeep` 占位

**冷启动扫描：**
- 服务启动时枚举 `subsystem='block', device_type='partition'` 的现有设备
- 对每个设备检查 `mnt/usb/<UUID>/` 是否存在，存在则标记 `mounted`
- 输出 `{"type": "ready", "existing_devices": [...]}` 一次性同步状态
- **v1.1 新增**：冷扫结果不触发声音通知，只更新列表（避免开机声光轰炸）

#### 5.1.5 错误处理

| 场景 | 处理 |
|------|------|
| mount 命令不存在 | 启动时检查，缺失则报错退出 |
| 挂载点目录无写权限 | 启动时检查，权限不足则报错 |
| 设备节点不存在 | 静默忽略（可能已被拔出） |
| 文件系统损坏 | 输出 `mount_failed`，前端显示警告 |
| 子进程被 kill | Node 端捕获，3 秒后自动重启 |

---

### 5.2 Node 服务层

#### 5.2.1 职责

- 管理 Python 监听器子进程
- 解析 JSON 事件流，维护设备状态 Map
- 提供 REST API（设备列表、文件读取、目录列表）
- 提供 **Socket.IO namespace `/usb`** 实时事件推送【v1.1 替代 SSE】
- SQLite 持久化事件历史（24 小时滚动清理，Node 端定时器驱动）

#### 5.2.2 USBService 核心设计【v1.1 修订】

```typescript
class USBService extends EventEmitter {
  private devices: Map<string, USBDevice>  // UUID → device【v1.1】用 UUID 作 key
  private monitor: ChildProcess | null     // Python 子进程
  private socketIo: Server                  // 【v1.1】Socket.IO 实例
  private notificationCoalescer: Coalescer  // 【v1.1】2 秒合并同类事件
  
  // 启动监听器 + 订阅 Socket.IO namespace
  start(io: Server): void  // 【v1.1】从外部注入 io，复用项目已有连接
  
  // 暴露给前端/API 的方法（参数由 deviceNode 改为 uuid）
  listDevices(): USBDevice[]
  getDevice(uuid: string): USBDevice | undefined
  listFiles(uuid: string, dirPath: string): Promise<string[]>
  readFile(uuid: string, filePath: string): Promise<Buffer>
  
  // Socket.IO 推送【v1.1】
  private broadcastDeviceEvent(event: DeviceEvent): void {
    this.socketIo.of('/usb').emit('device_event', event)
  }
  
  // 内部事件总线（保持原有 EventEmitter，供其他服务订阅）
  emit('device_event', device: USBDevice)
}
```

#### 5.2.3 API 设计【v1.1 修订】

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/usb/devices` | 列出当前所有设备（key 为 UUID） |
| GET | `/api/usb/devices/:uuid/ls?path=/` | 列出设备目录 |
| GET | `/api/usb/devices/:uuid/read?path=/xxx.txt` | 读取文件 |
| GET | `/api/usb/devices/:uuid/stat?path=/xxx` | 文件元信息（含 statvfs total/used/free） |
| GET | `/api/usb/devices/:uuid/disk-usage` | 【v1.1 新增】statvfs 一次性返回磁盘用量 |
| GET | `/api/usb/history?since=24h` | 历史事件查询 |
| **WS** | **`socket.io /usb` namespace** | 【v1.1 替代 SSE】实时事件推送 |
| | └─ event `device_event` | add / remove / mount_failed |
| | └─ event `heartbeat` | 30s 心跳（含设备数量） |
| | └─ event `ready` | 冷扫完成，初始状态 |

#### 5.2.4 安全边界

- **路径穿越防护**：`path.normalize().startsWith(mountPoint)` 必做
- **文件大小限制**：readFile 加 100MB 上限
- **扩展名黑名单**（可选）：禁止 `.exe` `.dll` `.so` `.bin`
- **API 鉴权**：复用现有 Hermes Web UI 的认证中间件

---

### 5.3 前端 UI 层

#### 5.3.1 组件清单

| 组件 | 位置 | 功能 |
|------|------|------|
| `USBToast.vue` | 全局挂载 | 右下角 Toast 通知 |
| `USBBell.vue` | 顶栏 | 铃铛图标 + 角标 + 下拉历史 |
| `USBView.vue` | `/usb` 路由页 | 设备列表 + 文件浏览器入口 |
| `USBFileBrowser.vue` | 弹窗/独立页 | 文件树 + 预览 + 操作按钮 |
| `useUSBStream.ts` | composable | Socket.IO `/usb` namespace 订阅 + 事件分发 |
| `useUSBNotification.ts` | composable | 浏览器通知 + 声音 |

#### 5.3.2 通知触发逻辑

```typescript
// useUSBNotification.ts
async function notify(deviceEvent: DeviceEvent) {
  // 1. 浏览器原生通知（需用户授权）
  if (Notification.permission === 'granted') {
    new Notification('USB 设备已插入', {
      body: `${deviceEvent.label} 已挂载`,
      icon: '/usb-icon.png'
    })
  }
  
  // 2. 声音播放（探测能力）
  const audio = new Audio('/sounds/usb-insert.mp3')
  audio.play().catch(() => {
    // 无声卡设备静默失败，不报错
    console.debug('[USB] 声音设备不可用')
  })
  
// 3. 通知节流：【v1.1 新增】同类事件 2 秒内合并
const COALESCE_WINDOW_MS = 2000
const recentEvents = new Map<string, number>()  // uuid → timestamp

function shouldNotify(event: DeviceEvent): boolean {
  const key = `${event.uuid}:${event.action}`
  const now = Date.now()
  if (recentEvents.has(key) && now - recentEvents.get(key)! < COALESCE_WINDOW_MS) {
    return false
  }
  recentEvents.set(key, now)
  return true
}

// 4. Toast（视觉）
if (shouldNotify(deviceEvent)) {
  showToast({
    type: 'success',
    title: '✅ U 盘已挂载',
    message: `${deviceEvent.label} (${deviceEvent.uuid})`,
    duration: 5000,
    onClick: () => router.push('/usb')
  })
  
  // 5. 铃铛角标
  bellStore.increment()
}

// 6. 冷启动静默：不触发声音，只更新列表
```

#### 5.3.3 铃铛历史下拉

```
┌─────────────────────────────────┐
│  🔔 最近 24 小时                │
├─────────────────────────────────┤
│  14:23  ✅ KINGSTON 已挂载      │
│  13:05  ❎ Samsung T5 已拔出    │
│  09:12  ✅ Samsung T5 已挂载    │
│  08:45  ⚠️ 未知设备挂载失败     │
├─────────────────────────────────┤
│  [查看全部]                     │
└─────────────────────────────────┘
```

#### 5.3.4 USB 设备页布局

```
┌─────────────────────────────────────────────────────┐
│  💾 USB 设备                          [🔄 刷新]      │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ 💾 KINGSTON DataTraveler        [已挂载]     │  │
│  │ 容量: 32GB | 已用: 12GB | 文件系统: vfat    │  │
  │ 路径: .../mnt/usb/4A1B-2C3D               │  │
│  │ ──────────────────────────────────────────  │  │
│  │ [📂 浏览文件] [🤖 让 Agent 读取]            │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ 💾 Samsung T5                 [未挂载]       │  │
│  │ [手动挂载]                                   │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

#### 5.3.5 文件浏览器

```
┌─────────────────────────────────────────────────────┐
│  📂 KINGSTON DataTraveler              [✕ 关闭]    │
├─────────────────────────────────────────────────────┤
│  路径: /文档/                                       │
│  ────────────────────────────────────────────────  │
│  📁 ..                                              │
│  📁 照片                                            │
│  📁 视频                                            │
│  📄 report.pdf                  [👁️ 预览]         │
│  📄 data.csv                    [👁️ 预览]         │
│  ────────────────────────────────────────────────  │
│  选中: report.pdf                                  │
│  [🤖 让 Agent 读取] [📥 下载] [📋 复制路径]       │
└─────────────────────────────────────────────────────┘
```

---

### 5.4 Hermes Agent Tool 层

#### 5.4.1 工具清单

| 工具名 | 签名 | 功能 |
|--------|------|------|
| `usb_list_devices` | `() -> Device[]` | 列出当前所有 USB 设备 |
| `usb_list_files` | `(device: str, path: str = "/") -> FileInfo[]` | 列出目录 |
| `usb_read_file` | `(device: str, path: str) -> str` | 读取文本文件 |
| `usb_copy_to_workspace` | `(device: str, path: str, dest: str) -> str` | 复制到 Hermes 工作区 |

#### 5.4.2 Tool 实现策略【v1.1 修订：方案 A】

**方案 A（最终选择）：走 Node REST API**
- Tool 通过 HTTP 调 Node 服务
- 优势：
  - 复用服务端的路径穿越防护（`normalize + startsWith`）
  - 复用 API 鉴权中间件
  - 状态一致性（Node 处的内存 Map 是唯一真实来源）
  - 审计日志自动记录
  - 不暴露底层文件系统路径给 Agent
- 劣势：文件读取需经 HTTP 中转，流式返回大文件会增加少量延迟

```python
def usb_list_devices() -> List[Dict]:
    """方案 A：通过 HTTP 查询 Node 服务获取设备状态"""
    return requests.get(f"{USB_API}/devices").json()["devices"]

def usb_read_file(uuid: str, relative_path: str) -> str:
    """方案 A：通过 HTTP 读取文件，Node 端做安全校验"""
    resp = requests.get(f"{USB_API}/devices/{uuid}/read",
                        params={"path": relative_path})
    if resp.status_code == 413:
        raise Exception("文件超出 100MB 限制")
    if resp.status_code == 403:
        raise Exception("路径已被安全策略拦截")
    resp.raise_for_status()
    return resp.text

def usb_list_files(uuid: str, path: str = "/") -> List[Dict]:
    """方案 A：通过 HTTP 获取目录列表"""
    resp = requests.get(f"{USB_API}/devices/{uuid}/ls",
                        params={"path": path})
    resp.raise_for_status()
    return resp.json()["files"]
```

> **v1.1 决策理由：** 性能差异对 USB 读取而言可忽略（USB 2.0 理论 60MB/s，HTTP localhost 延迟 <1ms）。统一安全边界 > 微小的性能优势。

#### 5.4.3 Agent 使用场景

**典型对话：**

```
用户: 我刚插了个 U 盘，帮我看看里面有什么 Excel 文件

Agent 思考:
1. 调用 usb_list_devices() → 看到 KINGSTON（uuid: "4A1B-2C3D"）
2. 调用 usb_list_files(uuid="4A1B-2C3D", path="/")
3. 找到 *.xlsx 文件
4. 调用 usb_read_file(uuid="4A1B-2C3D", path="数据/销售报表.xlsx")
5. 用 pandas 读取分析
6. 回复用户分析结果

前端看到:
- "🤖 Agent 正在读取 KINGSTON (4A1B-2C3D) /数据/销售报表.xlsx" Toast
- 聊天窗口显示分析结果
```

---

## 六、关键技术决策

### 6.1 推送通道对比【v1.1 新增】

| 维度 | SSE | Socket.IO（选择） |
|------|-----|-------------------|
| 通信方向 | 单向（服务器→客户端） | 双向（可扩展为前端确认/状态同步） |
| 鉴权 | 需 cookie 或 URL 参数 | 复用项目中 `middleware/user-auth.ts`，自动带认证 |
| 重连 | 原生 `EventSource` 自动重连但不可配置 | Socket.IO 客户端自带指数退避重连 + 房间恢复 |
| 心跳 | 需自行实现 | 内置 ping/pong |
| 多 tab 同步 | 每个 tab 独立连接，后端无感知 | Socket.IO 可配合 Redis adapter 跨进程广播 |
| 项目已有 | ❌ 未使用 | ✅ `packages/server/src/index.ts` 已初始化 |
| 维护成本 | 新增一套端点 + 鉴权逻辑 | 注册一个 namespace 即可 |

**决策：** 复用 Socket.IO，不引入 SSE 端点。

### 6.2 挂载方案对比

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| `udisksctl` | 无需 root，自动处理权限 | 依赖 D-Bus session，命令行 server 可能没 | ❌ |
| `mount` 命令 + sudo | 通用，可控 | 需要 sudo 配置 | ⚠️ |
| `mount` 命令 + 用户身份 | 简单 | 需要用户有 mount 权限（`/etc/sudoers` 或 `fuse`） | ✅ |
| FUSE 文件系统 | 无需 root | 性能差，配置复杂 | ❌ |

**最终方案：** `mount` 命令 + systemd 服务以授权用户运行 + `/etc/sudoers` 配置 `NOPASSWD` 仅限 mount/umount 命令。

### 6.3 通知声音策略

```
页面加载时探测:
const audioCtx = new AudioContext()
if (audioCtx.state === 'running') {
  // 有声音设备，加载铃声
} else {
  // 无声卡，跳过
}

或者懒探测:
new Audio('/sounds/usb.mp3').play().catch(() => {
  // 静默失败
})
```

**铃声资源：**
- 插入音：`/public/sounds/usb-insert.mp3`（清脆短促）
- 拔出音：`/public/sounds/usb-remove.mp3`（低沉短促）
- 失败音：`/public/sounds/usb-error.mp3`（警示短促）

### 6.4 历史清理策略【v1.1 修订】

```typescript
// Node 端用 setInterval 驱动，不依赖 SQLite 时间函数
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000  // 1 小时
const RETENTION_MS = 24 * 60 * 60 * 1000    // 24 小时

setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS
  eventStore.deleteBefore(cutoff)  // 对应 SQL: DELETE FROM usb_events WHERE ts < ?
}, CLEANUP_INTERVAL_MS)
```

**实现位置：** `USBEventStore.ts` 启动时注册定时器。

### 6.5 多 U 盘并发

**场景：** 同时插 2 个 U 盘（少见）

**处理：**
- pyudev 天然支持，按 UUID 区分
- 挂载点 `mnt/usb/<UUID1>/` 与 `<UUID2>/` 隔离
- 前端显示多张卡片，独立操作
- 拔出后清理对应 UUID 目录

### 6.6 部署方案【v1.1 新增】

#### 6.6.1 Python 监听器 systemd unit

```ini
# /etc/systemd/system/hermes-usb-monitor.service
[Unit]
Description=Hermes USB Monitor - pyudev listener and auto-mounter
After=local-fs.target
Wants=hermes-web-ui.service

[Service]
Type=exec
# 以运行 Hermes Web UI 的同一用户执行
User=hermesui
# mount 命令通过 sudoers 白名单授权，不需要 root
ExecStart=/usr/bin/python3 /opt/hermes-web-ui/hermes_data/bots/usb/usb_monitor.py
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes-usb-monitor
# 安全限制
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/opt/hermes-web-ui/hermes_data/mnt/usb/
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

#### 6.6.2 sudoers 配置

```bash
# /etc/sudoers.d/hermes-usb
# 仅允许 hermesui 用户执行 mount/umount/blkid，无需密码
hermesui ALL=(root) NOPASSWD: /usr/bin/mount, /usr/bin/umount, /usr/sbin/blkid
```

> **安全说明：** `ProtectSystem=strict` 限制监听器只能写入 `/opt/hermes-web-ui/hermes_data/mnt/usb/`；sudoers 白名单精确到二进制路径，不含通配符。

#### 6.6.3 安装脚本

```bash
# 安装 systemd unit
sudo cp hermes-usb-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hermes-usb-monitor --now

# 配置 sudoers
sudo cp hermes-usb-sudoers /etc/sudoers.d/hermes-usb
sudo chmod 440 /etc/sudoers.d/hermes-usb

# 验证
sudo systemctl status hermes-usb-monitor
```

#### 6.6.4 回滚

```bash
# 禁用监听器（保留数据）
sudo systemctl disable --now hermes-usb-monitor
sudo rm /etc/systemd/system/hermes-usb-monitor.service
sudo rm /etc/sudoers.d/hermes-usb
sudo systemctl daemon-reload

# USB 设备回归手动 mount，Web UI 保留只读浏览
```

---

## 七、实施计划

### Phase 0：基础准备（0.5 天）

- [ ] 系统依赖检查（ntfs-3g, exfat-fuse, blkid, python3-pyudev, pip3）
- [ ] hermesui 用户 sudoers 配置（`NOPASSWD` mount/umount/blkid）
- [ ] 工作区目录创建（`hermes_data/mnt/usb/`）
- [ ] 创建 `hermes-usb-monitor.service` systemd unit 文件
- [ ] 创建 `hermes-usb-sudoers` sudoers 配置文件
- [ ] 权限验证（手动 mount 测试）

### Phase 1：Python 监听器（1 天）

- [ ] 实现 `usb_monitor.py` 核心逻辑
- [ ] 实现 `mounter.py` 挂载封装
- [ ] 实现冷启动扫描
- [ ] 手动测试（插拔 3 种文件系统：vfat/ntfs/exfat）
- [ ] 验证 JSON 输出格式

### Phase 2：Node 服务层（1 天）

- [ ] 实现 `USBService.ts`（Socket.IO namespace `/usb` 事件推送）
- [ ] 实现 `USBEventStore.ts`（SQLite + Node 端 24h 定时清理）
- [ ] 实现 REST API 路由（参数使用 UUID）
- [ ] 将 `USBService` 注入到项目已有 Socket.IO Server
- [ ] 验证子进程自动重启 + 冷启动扫描不触发声音

### Phase 3：前端 UI 层（1.5 天）

- [ ] 实现 `USBToast.vue` 组件（含 2 秒节流去重逻辑）
- [ ] 实现 `USBBell.vue` 顶栏组件
- [ ] 实现 `USBView.vue` 设备页
- [ ] 实现 `useUSBStream.ts` composable（订阅 Socket.IO `/usb` namespace）
- [ ] 实现浏览器通知 + 声音探测
- [ ] 路由配置 + 全局挂载
- [ ] **i18n**：USBView、USBToast、USBBell 文案同步更新 9 语言 locale 文件

### Phase 4：文件浏览器（0.5 天）

- [ ] 实现 `USBFileBrowser.vue`
- [ ] 文件树渲染（递归组件）
- [ ] 文件预览（文本/图片）
- [ ] 「复制路径」「下载」按钮

### Phase 5：Hermes Agent 集成（0.5 天）

- [ ] 实现 `usb_tools.py`
- [ ] 注册到 Agent SOUL.md
- [ ] 实现「🤖 让 Agent 读取」按钮
- [ ] 验证完整对话流程

### Phase 6：测试与优化（1 天）

- [ ] 异常场景测试（加密 U 盘、文件系统损坏、权限不足）
- [ ] 并发测试（同时插 2 个 U 盘）
- [ ] 性能测试（大文件 100MB+）
- [ ] 24 小时历史清理验证
- [ ] UI/UX 微调

**总预估：5-6 天**

---

## 八、验收标准

### 8.1 功能验收

- [ ] 插入 U 盘后 1 秒内页面出现 Toast
- [ ] Toast 点击可跳转设备详情
- [ ] 顶栏铃铛角标实时更新
- [ ] U 盘自动挂载到工作区，无需手动操作
- [ ] 文件浏览器能正常列出目录和文件
- [ ] Agent 能读取 U 盘文件并在聊天窗口展示
- [ ] 拔出 U 盘后状态正确更新
- [ ] 24 小时后历史自动清理

### 8.2 兼容性验收

- [ ] FAT32 格式 U 盘 ✅
- [ ] NTFS 格式 U 盘 ✅
- [ ] exFAT 格式 U 盘 ✅
- [ ] ext4 格式移动硬盘 ✅
- [ ] 同时插多个设备 ✅
- [ ] 无声卡设备静默不报错 ✅

### 8.3 安全验收

- [ ] 路径穿越攻击被拦截
- [ ] 100MB 以上文件读取被拒
- [ ] API 鉴权复用现有中间件
- [ ] mount 命令受 sudoers 限制

### 8.4 用户体验验收

- [ ] 命令行用户能"看见"USB 状态
- [ ] Toast 不阻塞主操作
- [ ] 铃声不刺耳（短促柔和）
- [ ] 铃铛下拉历史清晰可查

---

## 九、风险与限制

### 9.1 已知风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 加密 U 盘无法识别 | 中 | 模态框提示，不阻塞流程 |
| U 盘文件系统损坏 | 低 | mount_failed 状态 + 警告 Toast |
| systemd 服务挂掉 | 高 | Node 端 3 秒自动重启 |
| Node 服务挂掉 | 高 | systemd 自动拉起 |
| 大文件读取超时 | 中 | 100MB 上限 + 进度提示 |
| 多个用户同时操作 | 低 | 当前为单用户场景，未来扩展 |

### 9.2 不在范围内

- ❌ 写入 U 盘（仅读取 + 复制）
- ❌ 加密 U 盘自动解锁
- ❌ 网络存储（NFS/SMB）
- ❌ 多用户权限隔离
- ❌ USB 摄像头/扫码枪等非存储设备

---

## 十、运维与监控

### 10.1 日志

**Python 监听器日志：** `/var/log/hermes/usb-monitor.log`
- 启动、停止、错误
- 每次 mount/umount 结果

**Node 服务日志：** 复用 Hermes Web UI 现有日志
- 子进程状态、Socket.IO 监听器连接数

### 10.2 监控指标（可选）

- 当前设备数
- 24h 插拔次数
- 挂载失败率
- 子进程重启次数

### 10.3 故障排查

| 现象 | 排查命令 |
|------|---------|
| 监听器没启动 | `systemctl status hermes-usb-monitor` |
| mount 失败 | `tail -f /var/log/hermes/usb-monitor.log` |
| Socket.IO 没推送 | 浏览器 Console 检查 `/usb` namespace 连接状态 |

---

## 十一、参考资源

### 11.1 文档

- [Socket.IO 文档](https://socket.io/docs/v4/)
- [pyudev 文档](https://pyudev.readthedocs.io/)
- [Linux udev 规则](https://wiki.archlinux.org/title/Udev)
- [Web Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)

### 11.2 关键依赖

```bash
# 系统包
sudo apt install ntfs-3g exfat-fuse exfatprogs util-linux python3-pyudev

# Python 包
pip3 install pyudev --break-system-packages

# Node 包（已包含在 Hermes Web UI）
# 无需新增
```

---

## 十二、附录

### 12.1 术语表

| 术语 | 含义 |
|------|------|
| **uevent** | Linux 内核向用户空间发送的设备事件 |
| **block device** | 块设备，U 盘/硬盘属于此类 |
| **mount point** | 挂载点，文件系统访问的入口目录 |
| **Socket.IO** | 基于 WebSocket 的双向实时通信库，项目已有 |
| **Toast** | 短暂出现的通知消息 |
| **FUSE** | Filesystem in Userspace，用户态文件系统 |

### 12.2 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| v1.0 | 2026-06-30 | 初始方案设计 |
| v1.1 | 2026-07-01 | 评审修订：SSE → Socket.IO、UUID 挂载点命名、Agent 方案 A、systemd 部署模板、通知节流、i18n 要求 |

---

**文档结束**

> 💡 **下一步建议：** 团队评审本方案 → 确认 UI 细节（toast 样式、设备页布局） → 进入 Phase 1 开发。如需调整方案请直接提出，本文档是开发指导，会随实施迭代更新。