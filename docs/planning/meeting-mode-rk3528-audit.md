# Meeting Mode — RK3528 / Armbian 全链路审计

> 创建日期：2026-07-21
> 适用版本：v0.7.6 起
> 范围：Hermes Web UI Meeting Mode 在 RK3528 / Armbian 设备上的端到端可行性
> 上游方案：[lan-https-mic-adaptation.md](./lan-https-mic-adaptation.md)（v0.7.4 草案）

---

## 1. 背景

Meeting Mode 是 Hermes Web UI 的旗舰功能，链路如下：

```
浏览器 (kiosk Chromium 148)
  ├─ getUserMedia (HTTPS 必须) → 录音 PCM 16kHz
  ├─ WebSocket → Node.js (Koa, :6060)
  └─ /api/meeting-asr/* → Node proxy → Python FastAPI (:8000/:8001)
                            ├─ /ws/asr           → 阿里云 DashScope 实时 ASR
                            ├─ /ws/diarize       → 阿里云 Paraformer-v2 + OSS
                            ├─ /api/analysis/*   → LLM (DeepSeek default)
                            └─ /api/config/*     → 本地文件持久化
```

用户反馈"meeting 功能就是一坨屎"在 RK 设备 Armbian 系统下体感差。本审计在 v0.7.6 完成 venv 打包修复后，基于静态代码 + 部署模型全方面排查，按严重程度分级列出 20 个问题。

---

## 2. 审计方法

| 维度 | 范围 |
|------|------|
| 仓库结构 | `.gitignore`、`dist/` 输出白名单、`.venv/` 提交状态 |
| 前端 | `packages/client/src/views/hermes/MeetingView.vue`、`stores/hermes/meeting.ts`、`composables/useMeetingAgent.ts`、`composables/useMicRecorder.ts`、`utils/meeting-asr-api.ts`、`utils/meeting-storage-api.ts`、`utils/audio-db.ts` |
| 后端 (Node) | `packages/server/src/services/meeting-asr/index.ts`、`controllers/hermes/meeting-asr.ts`、`controllers/hermes/meeting-storage.ts`、相关路由注册顺序 |
| 后端 (Python) | `python-backend/app/{main,config,storage,models,asr_proxy,diarize_server,diarize_endpoint,diarize_proxy,llm_service}.py`、`requirements.txt` |
| 系统集成 | `scripts/hermes-web-ui.service`、`scripts/deploy-source-armbian.sh`、systemd 行为 |
| 平台适配 | ARM64 / RK3528 / aarch64 wheel 可用性、Python venv、麦克风权限 |

设备假设：
- RK3528 / 4 核 ARM Cortex-A55 / 4 GB RAM
- Armbian Bookworm / Debian 12 base（最小化安装）
- 浏览器：kiosk Chromium 148.0.7778.178
- 网络：可能纯局域网（无外网路由）

---

## 3. 审计发现 — 按严重程度分级

### 🔴 P0 — 直接导致 meeting 在 RK Armbian 上不可用

#### #1 `.venv/` 整目录被提交进仓库

- 路径：`packages/server/src/services/meeting-asr/python-backend/.venv/`
- 现状：`.gitignore` 只有 `__pycache__/`、`*.py[cod]`，**没有 `.venv/`**
- 影响：
  - 这是 **Windows 平台** 的 venv（`Scripts/activate.bat`、`jp.py`、`_cffi_errors.h`、`gen_src.c` 等 Windows C 扩展头文件）
  - 每次 `git clone` 拉几百 MB 垃圾，GitHub tarball 同样包含
  - 任何**不严格按白名单打包**的脚本都会把 Windows 二进制塞进 ARM64 设备
- 当前缓解：`scripts/build-server.mjs` 已加 filter 排除 `.venv` 进入 dist；但**源码仓库里依然在**
- 修复：
  ```bash
  # .gitignore
  packages/server/src/services/meeting-asr/python-backend/.venv/
  packages/server/src/services/meeting-asr/python-backend/**/.venv/
  *.venv/
  # 移除已跟踪文件
  git rm -r --cached packages/server/src/services/meeting-asr/python-backend/.venv
  ```

#### #2 整套 ASR 强依赖阿里云公网，设备纯内网直接全废

- 实时 ASR：[`main.py:259` `ws_asr`](../../packages/server/src/services/meeting-asr/python-backend/app/main.py) → `wss://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com`
- 文件转写 + 说话人分离：[`diarize_proxy.py:81`](../../packages/server/src/services/meeting-asr/python-backend/app/diarize_proxy.py) → `https://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription`
- 音频上传：[`diarize_proxy.py:48`](../../packages/server/src/services/meeting-asr/python-backend/app/diarize_proxy.py) → `*.oss-cn-beijing.aliyuncs.com` 公网 bucket
- 后果：RK 设备如果只在内网（kiosk 场景典型），**所有 meeting 功能 100% 不可用**
- 这是用户体感最差的核心原因
- 修复方向（待评估）：
  - 选项 A：集成离线 ASR（whisper.cpp / sherpa-onnx / vosk）ARM64 推理
  - 选项 B：增加配置项，允许替换 ASR endpoint（但仍需外网）
  - 选项 C：明确文档化 meeting 模式"必须外网访问阿里云"

#### #3 首次启动在 ARM64 上重建 venv，冷启动 5-10 分钟无任何 UI 反馈

- 入口：[`services/meeting-asr/index.ts:108-149` `ensureVirtualEnv`](../../packages/server/src/services/meeting-asr/index.ts)
- 流程：`python -m venv` → `pip install -r requirements.txt`
- `requirements.txt` 里 `pycryptodome`、`cryptography`、`pydantic-core` 都有 aarch64 wheel，但要解压/编译几十 MB
- 关键问题：
  - **systemd 默认 `TimeoutStartSec=90s`**（在没有显式设置的 unit 文件里）→ 90 秒没启动完 = 启动失败 → systemd 杀进程
  - 当前 `hermes-web-ui.service` 也没显式覆盖 → 走默认 90s
  - 用户在前端看到的现象：点了"开始会议" → 进度卡 60-90 秒 → "ASR service is not running"
- 修复：
  - `hermes-web-ui.service` 加 `TimeoutStartSec=600`
  - 或：首启脚本预热 venv（Deploy 时主动跑一次 `pip install`）

#### #4 默认 Armbian 没有 `python3-venv`，`ensurepip is not available` 错误被吞掉

- 裸 Armbian base image 不装 `python3-venv`
- 用户看到的错误是泛化的 "Failed to create venv, exit code: 1"，看不出要装哪个包
- 修复：`scripts/deploy-source-armbian.sh` 加：
  ```bash
  apt-get install -y python3 python3-venv python3-dev build-essential
  ```
- 错误信息升级：`ensureVirtualEnv` 把 stderr 重定向到 logger，让前端能看到原始错误

---

### 🟠 P1 — 链路不稳，会随机挂

#### #5 Python 进程被 SIGTERM 后不等待 exit，下一次 start 立即撞端口

- 入口：[`services/meeting-asr/index.ts:314-340` `stop`](../../packages/server/src/services/meeting-asr/index.ts)
- 现状：`kill('SIGTERM')` fire-and-forget，不 `await exit`
- 现象：用户停止 → 立即开始 → `address already in use`，要等 30-60 秒 TIME_WAIT
- 修复：
  ```ts
  const exitPromise = new Promise<void>((resolve) => {
    proc.on('exit', () => resolve())
    setTimeout(() => proc.kill('SIGKILL'), 5000)
  })
  proc.kill('SIGTERM')
  await exitPromise
  ```

#### #6 Diarize 进程（端口 8001）fire-and-forget，没健康检查

- [`services/meeting-asr/index.ts:240`](../../packages/server/src/services/meeting-asr/index.ts)
- `waitForReady()` 只 poll 主进程的 `/healthz`，diarize 没人管
- 后果：diarize 死了用户不知道，转写会一直沉默
- 修复：并行 poll `:8001/healthz`，任何一个失败就整体重试

#### #7 Python 进程崩了不自动重启

- [`services/meeting-asr/index.ts:232`](../../packages/server/src/services/meeting-asr/index.ts) `close` handler 只设 `_isRunning=false`，不重启
- 后果：开会中途掉线 → 用户得手动重 start
- 修复：增加 `restart()` 方法 + 启动时 `_autoRestart` 标志

#### #8 API Key 泄露到 `.env` 写进安装目录

- [`storage.py:17`](../../packages/server/src/services/meeting-asr/python-backend/app/storage.py) `ENV_FILE = Path(".env")`
- cwd 是 `python-backend/`，所以 `.env` 写在 `python-backend/.env`
- 升级时被 `device-package-release.json` 白名单 include → **API key 持久化在源码包内**
- 修复：`.env` 写 `DATA_DIR/config.env`，跟 `config.json` 同目录，受 systemd 保护、不进升级包

#### #9 前端录音用 ScriptProcessorNode + echo cancellation，对 ASR 反而有害

- [`MeetingView.vue:567-571`](../../packages/client/src/views/hermes/MeetingView.vue)
- `echoCancellation: true, noiseSuppression: true`
- 这两个在浏览器里会扭曲语音频谱，对 ASR 识别率有 5-15% 损伤（学术研究普遍结论）
- ScriptProcessorNode 是 deprecated API，主线程跑会卡 UI
- 修复：
  - 关掉 echo/noise suppression（至少 meeting 模式）
  - 迁移到 AudioWorkletNode

#### #10 `MediaRecorder` 不设 `timeslice`，长会议把整段录音留在内存

- [`MeetingView.vue:600`](../../packages/client/src/views/hermes/MeetingView.vue)
- `new MediaRecorder(mediaStream, { mimeType: 'audio/webm' })`
- 2 小时会议 = 几十 MB Blob 全在内存
- 不能 `timeslice` 切片是为了上传方便——但代价是浏览器可能 OOM
- 修复：`{ mimeType: 'audio/webm', timeslice: 5000 }` + 增量上传到 IndexedDB

---

### 🟡 P2 — 设计粗糙，体验差

#### #11 ASR 启动要 5 个 secret，前端 UI 没分步引导

- DashScope API Key + LLM API Key + OSS Bucket + OSS AccessKey + OSS Secret = 5 个 secret
- 第一次用户铁定一头雾水
- 修复：分步配置向导，每步只显示一个字段并提示去哪里获取

#### #12 `storage.update_config` 是替换不是合并

- [`storage.py:113`](../../packages/server/src/services/meeting-asr/python-backend/app/storage.py)
- `self._config = config` — 替换整对象
- 前端只改一个字段、整 config 被覆盖 → 旧 key 丢失
- 修复：改为深合并，未提供的字段保留旧值

#### #13 `useMeetingAgent.sendToAgent` 失败被 try/catch 吞掉

- [`useMeetingAgent.ts:281`](../../packages/client/src/composables/useMeetingAgent.ts)
- `catch (err: any) { error.value = err.message }`
- UI 上只看到 `isRunning=false`，错误只在 console
- 修复：把 `error.value` 暴露给模板，弹 toast 提示

#### #14 IndexedDB 音频用 base64 存储，比 binary 大 33%

- [`audio-db.ts:33-39`](../../packages/client/src/utils/audio-db.ts)
- `atob` + `Uint8Array` 转换开销大
- 长会议浪费存储
- 修复：直接存 `Blob` 到 IDB，避免 base64

#### #15 localStorage `hermes.meeting.sessions` 无限增长

- 几十次会议后 5MB 配额爆掉，`try/catch` 静默吞 → 新 session 不持久化
- 修复：超过 N 条自动归档到 IndexedDB；session 删除时同步清理

#### #16 `meetingStorage.uploadAudio` 无大小限制

- [`meeting-storage.ts controller:40-48`](../../packages/server/src/controllers/hermes/meeting-storage.ts)
- `Buffer.concat(chunks2)` 全读进内存
- 一次上传几 GB 直接 OOM 杀 Node 进程
- 修复：
  - 加 `Content-Length` 校验 + 100MB 硬上限
  - 流式写文件，不要全读进内存

#### #17 死代码：`/api/meeting-asr/prompts`、`/api/meeting-asr/transcript`

- 前端调了但前端组件没人调用
- 修复：删除或加 TODO 注释

---

### 🟢 P3 — 锦上添花

#### #18 Browser sampleRate constraint 可能被 kiosk Chromium 忽略

- `getUserMedia({ audio: { sampleRate: 16000 } })` 在某些 Chromium 上不生效
- 前端有 resample 兜底，但需要确认兜底逻辑正确（[`MeetingView.vue:656-660`](../../packages/client/src/views/hermes/MeetingView.vue)）

#### #19 `asr_max_audio_seconds: 7200` → diarize buffer 上限 230 MB

- 单 session 内存压力
- 短会议可调低

#### #20 `ParaformerProxy` 没重连

- 上游断线后 WS 直接断，前端收到 `stopped` → 用户得手动重连
- 修复：增加指数退避重连

---

## 4. 推荐修复路线

### Phase 1 — 让现有 meeting 至少能跑起来（外网依赖保留）

| 项 | 工作量 | 价值 |
|----|--------|------|
| #1 `.venv/` 加 .gitignore + `git rm --cached` | 5 分钟 | 仓库健康 |
| #4 `apt install python3-venv` 进 deploy 脚本 | 10 分钟 | 解 80% 启动失败 |
| #3 `hermes-web-ui.service` 加 `TimeoutStartSec=600` | 5 分钟 | 解冷启动超时 |
| #5 `stop()` 等 exit | 20 分钟 | 解端口冲突 |
| #6 diarize healthcheck 并行 | 15 分钟 | 解静默挂 |
| #8 `.env` 移到 DATA_DIR | 30 分钟 | 安全 + 升级数据保留 |

合计：~1.5 小时

### Phase 2 — 离线 ASR 评估（解决 #2 根本问题）

调研候选：
- **sherpa-onnx** ARM64 推理 Paraformer / Whisper
- **whisper.cpp** + ggml-tiny.en/base 量化模型（~150MB / 500MB）
- **Vosk** 中小模型（~1.8GB）

需要回答的未知项：
- RK3528 CPU 实时 ASR 性能（Paraformer streaming 模型推理速度）
- 模型下载/分发策略（升级包内置？按需下载？）
- 离线后 LLM 分析怎么办？DeepSeek 本地化？

### Phase 3 — 体验优化

- #9 #10 录音管线重写（AudioWorklet + timeslice）
- #11 分步配置向导
- #12 #13 错误可见性

---

## 5. 风险与未知项

### 已知风险

1. **Phase 1 修复后，meeting 仍依赖外网**——纯内网设备仍不可用
2. **venv 重建耗时**——升级时如果改 requirements.txt，venv 也要重装；目前 `ensureVirtualEnv` 只在缺失时创建，不升级现有 venv
3. **OSS 配置门槛高**——diarize 模式用户必须额外配置阿里云 OSS

### 未验证项

- RK3528 上 `pip install` 实际耗时（未实测，估算 3-10 分钟）
- 系统依赖完整列表（`libsndfile`、`portaudio`、`libssl` 是否需要 apt 装）
- kiosk Chromium 148 是否支持 `MediaRecorder` `timeslice`
- `audio/webm` 在 ARM64 Chromium 上的 opus 编码器质量

---

## 6. 相关文件清单

### 后端 (Node)
- [`packages/server/src/services/meeting-asr/index.ts`](../../packages/server/src/services/meeting-asr/index.ts)
- [`packages/server/src/controllers/hermes/meeting-asr.ts`](../../packages/server/src/controllers/hermes/meeting-asr.ts)
- [`packages/server/src/routes/hermes/meeting-asr.ts`](../../packages/server/src/routes/hermes/meeting-asr.ts)
- [`packages/server/src/controllers/hermes/meeting-storage.ts`](../../packages/server/src/controllers/hermes/meeting-storage.ts)
- [`packages/server/src/services/meeting-storage/index.ts`](../../packages/server/src/services/meeting-storage/index.ts)

### 后端 (Python)
- [`packages/server/src/services/meeting-asr/python-backend/app/main.py`](../../packages/server/src/services/meeting-asr/python-backend/app/main.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/asr_proxy.py`](../../packages/server/src/services/meeting-asr/python-backend/app/asr_proxy.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/diarize_server.py`](../../packages/server/src/services/meeting-asr/python-backend/app/diarize_server.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/diarize_endpoint.py`](../../packages/server/src/services/meeting-asr/python-backend/app/diarize_endpoint.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/diarize_proxy.py`](../../packages/server/src/services/meeting-asr/python-backend/app/diarize_proxy.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/llm_service.py`](../../packages/server/src/services/meeting-asr/python-backend/app/llm_service.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/storage.py`](../../packages/server/src/services/meeting-asr/python-backend/app/storage.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/config.py`](../../packages/server/src/services/meeting-asr/python-backend/app/config.py)
- [`packages/server/src/services/meeting-asr/python-backend/app/models.py`](../../packages/server/src/services/meeting-asr/python-backend/app/models.py)
- [`packages/server/src/services/meeting-asr/python-backend/requirements.txt`](../../packages/server/src/services/meeting-asr/requirements.txt)

### 前端
- [`packages/client/src/views/hermes/MeetingView.vue`](../../packages/client/src/views/hermes/MeetingView.vue)
- [`packages/client/src/components/hermes/meeting/MeetingAgentPanel.vue`](../../packages/client/src/components/hermes/meeting/MeetingAgentPanel.vue)
- [`packages/client/src/stores/hermes/meeting.ts`](../../packages/client/src/stores/hermes/meeting.ts)
- [`packages/client/src/composables/useMeetingAgent.ts`](../../packages/client/src/composables/useMeetingAgent.ts)
- [`packages/client/src/composables/useMicRecorder.ts`](../../packages/client/src/composables/useMicRecorder.ts)
- [`packages/client/src/utils/meeting-asr-api.ts`](../../packages/client/src/utils/meeting-asr-api.ts)
- [`packages/client/src/utils/meeting-storage-api.ts`](../../packages/client/src/utils/meeting-storage-api.ts)
- [`packages/client/src/utils/audio-db.ts`](../../packages/client/src/utils/audio-db.ts)

### 系统集成
- [`scripts/hermes-web-ui.service`](../../scripts/hermes-web-ui.service)
- [`scripts/deploy-source-armbian.sh`](../../scripts/deploy-source-armbian.sh)
- [`scripts/build-server.mjs`](../../scripts/build-server.mjs)
- [`.github/device-package-release.json`](../../.github/device-package-release.json)
- [`.gitignore`](../../.gitignore)

### 上游规划
- [lan-https-mic-adaptation.md](./lan-https-mic-adaptation.md) — v0.7.4 HTTPS 方案
- [learn-command-integration.md](./learn-command-integration.md)
- [tool-call-workspace-diffs.md](./tool-call-workspace-diffs.md)

---

## 7. 状态

- **本次审计完成日期**：2026-07-21
- **当前版本**：v0.7.6（meeting 模式打包修复已合并）
- **下一步**：等待用户确认修复范围（Phase 1 / Phase 2 / 全部）