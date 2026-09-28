# Upstream Merge Rules — Quanthermes 品牌保护与合并策略

本文档定义了从 `upstream/main`（EKKOLearnAI/hermes-web-ui）合并到本地
`main`（tangledup-ai/hermes-web-ui）时必须遵守的规则。

---

## 一、品牌化功能清单

### 1. 品牌标识

| 项目 | 本地值 | 上游值 |
|------|--------|--------|
| npm 包名 | `@quanthermes/hermes-web-ui` | `@anthropic/hermes-studio` 或类似 |
| 桌面 appId | `com.quanthermes.hermeswebui` | 上游原始值 |
| 桌面产品名 | `Quanthermes Studio` | `Hermes Studio` |
| 默认用户名 | `quanthermes` | `admin` 或无 |
| 默认密码 | `12345678` | 上游原始值 |
| OpenRouter App Title | `Quanthermes Web UI` | `Hermes Studio` |
| OpenRouter Referer | `github.com/tangledup-ai/hermes-web-ui` | 上游仓库地址 |
| Website 品牌 | `QuantHermes Web UI` | `Hermes Studio` |
| 源码仓库 | `tangledup-ai/hermes-web-ui` | `EKKOLearnAI/hermes-web-ui` |

### 2. 独立更新基础设施（OSS）

| 组件 | 本地值 |
|------|--------|
| OSS 基础路径 | `tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui` |
| 更新 manifest | `{OSS}/releases/stable/latest.json` |
| manifestBaseUrl 代码默认值 | `{OSS}/releases` |
| 运行时版本 manifest | `{OSS}/versions.json` |
| 下载基础 URL | `{OSS}` |
| Hermes Agent wheelhouse | `{OSS}/hermes-agent/wheelhouse/` |
| Hermes Agent manifest | `{OSS}/hermes-agent/stable/latest.json` |
| 桌面更新 feed | `{OSS}` |
| 设备包 sourceLabel | `Quanthermes Device Releases` |

### 3. 设备包更新系统（device-package）

完全自研的更新链路，上游不存在：

- `.github/device-package-release.json` — 设备发布配置
- `.github/workflows/device-package-release.yml` — 设备包 CI
- `.github/workflows/hermes-agent-oss-mirror.yml` — Agent wheel 镜像
- `.github/workflows/webui-release.yml` — WebUI 发布
- `scripts/install-device-package.sh` — 设备包安装器
- `scripts/bootstrap-device-to-device-package.sh` — 设备引导
- `scripts/bootstrap-device-from-v0.6.14-to-v0.6.15.sh` — 旧设备迁移
- `scripts/hermes-web-ui-update-runner.sh` — 特权更新 runner
- `scripts/hermes-web-ui-update.service` — runner systemd 单元
- `scripts/update-source-deploy.sh` — 源码部署更新
- `packages/server/src/services/update/device-package-contract.ts`
- `packages/server/src/controllers/update.ts` 中的 device-package 策略分流

### 4. USB 监控 Bot

完全自研，上游不存在：

- `hermes_data/bots/usb/` — 完整 Python USB 监控/挂载 bot
- `scripts/deploy-source-armbian.sh` 中的 `prepare_usb_mount_environment()`
- 服务环境中的 `USB_USE_SUDO=true`

### 5. 会议 ASR 定制

- DashScope 标准端点（非百炼工作空间 URL）
- `prewarm_meeting_asr_venv()` 部署预热
- AudioWorklet 重构 + 录音参数优化
- 分步配置向导

### 6. 部署脚本定制

`scripts/deploy-source-armbian.sh` 中本地新增/修改：

- `OSS_PUBLIC_BASE_URL` 默认值
- `WEBUI_UPDATE_PACKAGE` = `@quanthermes/hermes-web-ui`
- `WEBUI_UPDATE_REPO` = `tangledup-ai/hermes-web-ui`
- `WEBUI_UPDATE_SOURCE_LABEL` = `Quanthermes Device Releases`
- `prepare_usb_mount_environment()` 函数
- `prewarm_meeting_asr_venv()` 函数
- systemd `TimeoutStartSec=900`

### 7. 专家市场适配

- `marketplace-client.ts` — skillhub 双栈兼容
- `activator.ts` — 团队成员真实安装
- `orchestrator.ts` — 团队卸载清理

---

## 二、文件保护等级

### 🔴 LOCKED（绝不接受上游覆盖）

这些文件是本地独有或品牌核心，上游冲突时 **100% 保留本地版本**：

```
.github/device-package-release.json
.github/workflows/device-package-release.yml
.github/workflows/hermes-agent-oss-mirror.yml
.github/workflows/webui-release.yml
scripts/install-device-package.sh
scripts/bootstrap-device-to-device-package.sh
scripts/bootstrap-device-from-v0.6.14-to-v0.6.15.sh
scripts/hermes-web-ui-update-runner.sh
scripts/hermes-web-ui-update.service
scripts/update-source-deploy.sh
hermes_data/bots/usb/**
docs/work-log.md
docs/harness/upstream-merge-rules.md
```

### 🟠 BRANDED（保留本地品牌值，接受上游结构变更）

这些文件包含品牌化配置，合并时保留本地 URL/名称/标识，但接受上游的
结构性改动（新字段、新逻辑）：

```
package.json                          → name, version, homepage, repository
package-lock.json                     → name, version
packages/desktop/package.json         → name, version, homepage
packages/desktop/package-lock.json    → name, version
packages/desktop/electron-builder.yml → appId, productName, publish.url
packages/server/src/config.ts         → DEFAULT_MANIFEST_BASE_URL, remoteRelay
packages/server/src/services/runtime-version-manager.ts → DEFAULT_* 常量
packages/server/src/services/hermes/agent-bridge/manager.ts → OPENROUTER 环境变量
packages/server/src/services/update/device-package-contract.ts → DEFAULT_DEVICE_PACKAGE_SOURCE_LABEL
packages/server/src/db/hermes/users-store.ts → DEFAULT_USERNAME
packages/client/src/i18n/locales/*.ts → quanthermes 用户名引用
packages/website/src/i18n/*.ts        → 全部品牌文案
scripts/deploy-source-armbian.sh      → OSS URL、包名、仓库地址、自研函数
```

### 🟡 ADAPTED（本地有适配修改，需逐行审查）

这些文件上游也会改，本地也做了适配，合并时需要 **手动逐行审查**：

```
packages/server/src/controllers/update.ts          → device-package 策略分流
packages/server/src/services/hermes/experts/marketplace-client.ts → skillhub 适配
packages/server/src/services/hermes/experts/activator.ts
packages/server/src/services/hermes/experts/orchestrator.ts
packages/server/src/services/meeting-asr/**        → DashScope 端点 + 生命周期修复
packages/client/src/stores/hermes/meeting.ts       → 端点 + IDB Blob
packages/client/src/views/hermes/MeetingView.vue   → AudioWorklet + 配置向导
scripts/hermes-web-ui.service                      → TimeoutStartSec=900
```

### 🟢 ACCEPT（直接接受上游）

不在上述列表中的所有文件，默认接受上游版本。包括但不限于：

- 上游新增的功能模块（新 route、新 view、新 service）
- 上游 bug 修复
- 上游重构（不涉及品牌文件的）
- 上游测试用例
- 上游文档（非本地独有的）

---

## 三、合并冲突解决规则

### 优先级排序

```
本地品牌标识 > 本地自研功能 > 上游新功能 > 上游重构
```

### 具体规则

| 冲突类型 | 处理方式 |
|----------|----------|
| 品牌名称/URL 冲突 | 保留本地值（quanthermes / tangledup-ai / OSS） |
| 版本号冲突 | 取本地较高版本，或按发布计划决定 |
| 上游新增文件 | 直接接受 |
| 上游删除本地独有文件 | 拒绝删除，保留本地文件 |
| 上游修改 LOCKED 文件 | 忽略上游修改 |
| 上游修改 BRANDED 文件 | 接受结构变更，恢复品牌值 |
| 上游修改 ADAPTED 文件 | 手动合并，保留本地适配逻辑 |
| i18n 文件冲突 | 手动合并，保留 quanthermes 引用 |
| package.json 依赖冲突 | 取并集，版本取较高 |
| CI workflow 冲突 | 本地独有 workflow 保留；共有 workflow 手动合并 |

### 合并后必检项

1. `grep -r "hermes-studio" packages/ scripts/` — 确认无上游品牌残留
2. `grep -r "EKKOLearnAI" packages/ scripts/ .github/` — 确认无上游仓库残留
3. `grep -r "download.ekkolearnai.com" .` — 确认无上游 CDN 残留
4. `grep -r "api.hermes-studio.ai" .` — 确认无上游 API 残留
5. `npm run build` — TypeScript 编译通过
6. `npm run harness:check` — 仓库一致性检查通过

---

## 四、合并操作流程

```bash
# 1. 准备
git fetch upstream --prune
git checkout main && git pull origin main
git checkout -b merge/upstream-main-$(date +%Y%m%d)

# 2. 合并
git merge --no-ff upstream/main

# 3. 解决冲突（按本文档规则）
#    - LOCKED 文件: git checkout --ours <file>
#    - BRANDED 文件: 手动编辑，保留品牌值
#    - ADAPTED 文件: 手动逐行合并
#    - 其他: git checkout --theirs <file> 或手动

# 4. 品牌残留检查
grep -rn "hermes-studio\|EKKOLearnAI\|download.ekkolearnai.com\|api.hermes-studio.ai" \
  packages/ scripts/ .github/ --include='*.{ts,vue,json,yml,sh}'

# 5. 验证
npm run harness:check
npm run build
npm run test -- tests/server/update-controller.test.ts

# 6. 完成
git checkout main
git merge --no-ff merge/upstream-main-YYYYMMDD
git push origin main
git push org main
```

---

## 五、版本文件同步清单

每次版本号变更时必须同步更新的文件：

```
package.json                          → "version"
package-lock.json                     → "version" (2处)
packages/desktop/package.json         → "version"
packages/desktop/package-lock.json    → "version" (2处)
.github/device-package-release.json   → "version"
```

---

## 六、上游不存在的本地独有目录/文件

合并时如果上游的 `.gitignore` 或清理脚本试图删除这些路径，必须拒绝：

```
hermes_data/bots/usb/
scripts/bootstrap-device-*.sh
scripts/install-device-package.sh
scripts/hermes-web-ui-update-runner.sh
scripts/hermes-web-ui-update.service
scripts/update-source-deploy.sh
.github/workflows/device-package-release.yml
.github/workflows/hermes-agent-oss-mirror.yml
.github/workflows/webui-release.yml
.github/device-package-release.json
docs/work-log.md
docs/harness/upstream-merge-rules.md
docs/planning/
docs/research/
config/experts-marketplace.yaml
```

---

## 七、不可逆分叉与选择性合并策略

> 确立时间：2026-09-25。起因：上游 `upstream/main` 在 2026-08-26 之后发生了两次不可逆变更。

### 分叉事实

1. **架构重命名**（8/26，`refactor: enforce canonical server module ownership`）：
   服务端 `services/ controllers/ routes/ db/ middleware/ lib/ shared/ config.ts security.ts`
   → `modules/{hermes,studio,ekko,coding-agents}/` + `bootstrap/`；
   客户端 `api/hermes/*` → `api/studio/*`。本地 828 个独有提交全部基于旧结构。
2. **品牌分叉**（9/8 起）：上游改名为 **Ekko Studio**（`package.json` name = `ekko-studio`），
   本地保持 `@quanthermes/hermes-web-ui`。
3. 实测 `git merge-tree`：**2071 文件变更、约 1007 个冲突文件**。

### 硬规则

- **禁止对 `upstream/main` 执行 `git merge --no-ff`**。本文件第四节的**全量 merge 流程自
  2026-09-25 起作废**，仅保留其中的冲突解决规则与品牌残留检查，作为 cherry-pick 后的核对项。
- 所有上游代码一律通过 **cherry-pick** 或**文件级手工移植**进入本地。
- 每次同步必须先做**提交级筛选**（是否触及重构路径 / 是否含品牌字符串 / 是否落在本地独有域），
  再决定「接受 / 移植 / 拒绝」，筛选结论写入同步评审文档。
- 上游删除文件**不得**自动跟随。尤其 `docs/chat-chain-changes/`
  （上游删了 242 个，本地全都有），`AGENTS.md` 要求这些 fragment 必须保留。

### 判定速查

| 上游改动落在 | 处置 |
|---|---|
| `packages/server/src/modules/**` | ❌ 拒绝整体；有价值的能力按旧结构手工重写 |
| `packages/client/src/api/studio/**` | ❌ 拒绝；对应能力改到 `api/hermes/**` |
| `packages/server/src/{services,controllers,routes,db}/**`（旧结构残留提交） | ✅ 可直接 cherry-pick |
| `packages/ekko-agent/**` | ⚠️ 可整包同步（本地零改动），需单独核对品牌字符串 |
| 品牌改名 / Ekko 重命名 / release + changelog | ❌ 拒绝 |
| 仅 `tests/**` `docs/**` | ⚠️ 按需，且上游删文档不得跟随 |
| 上游新增的独立功能模块（Grok / OpenCode / JEV / session-shares 等） | ⚠️ L3 手工移植到旧结构 |

### 本地自研域（上游为零，永不冲突，但也无人维护）

`services/update/`（device-package OTA）、`services/usb/`、`services/knowledge/`、
`services/scanner/` + `services/grading/`、`services/meeting-asr/`、
`services/hermes/experts/`、`packages/client/src/plugins/`（上游无 plugins 目录）。
对照数据见 `upstream-sync-20260925-feature-diff.md` 第三节。

### iOS / 手机 App 生态依赖判定

上游部分能力依赖其自有手机 App 与 APNs 证书，**这类功能搬了也无法运行**，直接拒绝：

- iOS Live Activities（#3111 #3151 #3152 #3167）—— iOS 独占 + APNs p8 证书
- 消息推送投递侧（#2940 #3131 等）—— 依赖 App 连接与 APNs/FCM
- 例外：**会话分享与作用域权限**（`session-shares`）是纯服务端 + Web 能力，**可以移植**。

> 每次同步前先问一句：这个功能是否需要手机 App 或 Apple/Google 证书？是则直接拒绝。
