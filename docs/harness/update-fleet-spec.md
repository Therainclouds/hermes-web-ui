# Update Fleet Spec — 旧版兜底 / 去 OSS / Hermes-Agent 跟进

状态: draft → 逐条执行
上游主 spec: [source-deploy-refactor.md](./source-deploy-refactor.md)（phase a 不变量仍然全部有效）
本文取代的讨论: 2026-09 fleet 分析（0.6.15→0.8.3 全档位更新路径审查）

三个工作流，按优先级排序：

- **R1 旧版本兜底与数据安全**（最高优先——先于一切放量）
- **R2 移除 OSS 更新机制**（CI/CD GitHub 全链路）
- **R3 Hermes-Agent 升级跟进**（phase c 的 agent seam）

执行顺序: R1-0 热修 → R1 门禁 → R2 → R3。R2 与 R3 有交叠（agent 资产从 OSS 迁到 GitHub release），R3 依赖 R2 完成。

---

## 背景事实（已验证，file:line 可复核）

### 更新永远由旧代码执行（鸡生蛋）
`scripts/hermes-web-ui-update-runner.sh:188-196`：`orchestrator="${WEBUI_UPDATE_ORCHESTRATOR:-${DEPLOY_DIR}/scripts/update-orchestrator.sh}"` —
runner、orchestrator、installer 全部来自**当前部署树（旧版本）**。0.8.3 的新 orchestrator 只对"已经在 0.8.3+ 的设备"生效。

### 各档位设备更新到 0.8.3 的真实结果（已逐 tag 验证）

| 起始版本 | 执行的旧代码 | 结果 |
|---|---|---|
| ≤0.7.x (source-deploy) | `update-source-deploy.sh`（v0.6.15 与 v0.7.20 逐字节相同，`:250-253`） | 下载 flat tar 成功 → `find -mindepth 1 -maxdepth 1 -type d \| head -1` 选中 `dist/` 或 `scripts/` → "not a valid hermes-web-ui source tree" → 干净失败，**永远卡死** |
| 0.7.20 出厂 (device-package) | 旧 manifest-client 硬性要求 `packageType==='device-package'`（v0.7.20 manifest-client.ts:196-197） | 409 `update_manifest_invalid`，**更新根本不发起** |
| 0.8.0 | 无 orchestrator → 旧 `update-source-deploy.sh` | 同 ≤0.7.x，干净失败 |
| 0.8.1 | 旧 orchestrator（无 build、无 preserve_hermes_data） | swap 后树里无 node_modules → 服务起不来 → healthcheck 失败 → 回滚。数据安全但更新失败 |
| 0.8.2 | 旧 orchestrator（有 preserve_hermes_data + build_deploy，无 prebuilt 检测） | 对预构建包执行 `rm -rf dist && npm run build` 完整设备构建（10 分钟、vue-tsc 全链路）——6.6.6.73 事故路径 |
| 0.8.3+ | 新 orchestrator | ~2 分钟。但存在 R1-0 两个已知缺陷 |

### 数据布局（哪份数据在哪里）

- **`hermes_data/`（agent 状态：profiles、state.db、sessions、skills、bots、模型缓存）默认在 deploy 树内**：`deploy-source-armbian.sh:1760` `HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"`。swap 会把它换成骨架。
- **`~/.hermes-web-ui/`（Web UI 状态：hermes-web-ui.db、.token、.credentials、upload、meetings、updates/journal、identity.json）在树外**，swap 永远不碰。
- **meeting-asr 在 `/var/lib/hermes-web-ui/`**（systemd StateDirectory），树外。
- 回滚 `revert_to_lastgood`（`scripts/_lib/atomic-swap.sh:99-110`）是把 deploy 符号链接指回 lastgood——树内 hermes_data 随旧树整体恢复；树外数据无需恢复。

### 已有保护与其缺口

| 机制 | 位置 | 缺口 |
|---|---|---|
| `preserve_hermes_data_across_swap` | update-orchestrator.sh:333-380（0.8.2+ 才有） | 0.8.0/0.8.1 的 orchestrator 没有；">2 entries 跳过"启发式；copy 后无校验 |
| preflight 布局检查 | preflight.ts:125-154 | **`hermes-home-in-deploy-dir` 对 `${DEPLOY_DIR}/hermes_data` 兼容布局显式豁免**（:143-154 isCompatibilityLayout）——历史上吃掉用户数据的正是这个布局 |
| installer sha 门禁 | device-package.ts:54-87 | **只存在于 device-package 策略**；source-deploy 对旧 orchestrator 无任何能力指纹检查 |
| swap 后数据校验 | 无 | **没有任何东西验证 state.db/profiles 在 swap 后还活着**。6.6.6.73 事故：journal 记录 `succeeded`（绿色），live 树里是 6.2MB 骨架 |
| 数据找回 | 无工具 | 唯一恢复途径是手工 SSH 翻 `.previous-*`/lastgood 树（work-log.md:2771-2779 的手术） |

### 0.8.3 已知缺陷（必须在下一个版本前修，即 R1-0）

1. **stale node_modules**：`preserve_node_modules_across_swap`（:490-524）复制旧依赖后，`build_deploy` 幂等检查（:554-572 `nm_populated && dist_ready`）会**整体跳过 npm ci**。未来任何改依赖的版本 → 新代码 + 旧依赖 → 服务崩溃 → 回滚。
2. **`node -e` 依赖 root PATH**：`build_deploy` 的版本校验（:564, :645）直接 `node -e`，未走 `run_build_as_app_user` 的 PATH 修复。root PATH 无 node 的设备 → actual_version 为空 → 误判 mismatch → 回滚一个成功的更新。6.6.6.73 是手动 `ln -sf` 之后才有的 node；全新设备无保证。

### OSS 接线点全景（R2 范围）

- **build/CI**: build-device-package.mjs:169-186,427-428,540-548,550-553,627-636,665-678；device-package-release.yml:191-235,237-251,253-343,424-480,587-642；`packageUrls` 目前 **OSS-only 无 GitHub 兜底**（:540-543,:628-632）
- **server**: config.ts:240 `DEFAULT_MANIFEST_BASE_URL` = OSS；manifest-client.ts 缓存兜底（:184-195，去 OSS 后仍可用）；runtime-version-manager.ts:11-14 versions.json OSS 权威
- **设备脚本**: deploy-source-armbian.sh:1771,1774,1776,1798-1799；`write_service_env`（:1193-1264）把 OSS URL **写死进 `/etc/default/hermes-web-ui`**——已部署设备即使改了代码默认值也仍钉在 OSS
- **bootstrap 写入器**: bootstrap-device-to-device-package.sh:108-166；bootstrap-device-from-v0.6.14-to-v0.6.15.sh:14
- **desktop**: updater.ts:16（OSS 主源，GitHub 兜底自动降级）；runtime-manager.ts:47（无兜底）；harness-check.mjs:524-530 把 OSS-first 写成了 CI 契约
- **hermes-agent 分发是 OSS-only**: wheel/wheelhouse/`hermes-agent/stable/latest.json`（device-package-release.yml:253-343、hermes-agent-oss-mirror.yml、patches/hermes-agent/build-release.sh）
- 测试: build-device-package-script.test.ts:128-145、device-package-manifest.test.ts:125、source-deploy-dry-run.test.ts:108、device-package-executable-bits.test.ts:114 的 ossPublicBaseUrl fixture

### Hermes-Agent 现状（R3 范围）

- 安装形态：pip wheel → venv `~/.hermes/hermes-agent-venv`，CLI 符号链接到 `~/.local/bin/hermes`；更新 = `pip install --upgrade`（deploy-source-armbian.sh:684-760）
- 设备侧 pin：0.17.0 硬编码 wheel URL（:1772）；desktop bundle 是 0.20.0（paths.ts:13）；上游 NousResearch/hermes-agent 已发新 tag
- **CN 补丁链存在**：patches/hermes-agent/build-release.sh 从上游 tag 构建本地化 wheel——跟进上游 = 重新 rebase 补丁，不是简单 bump
- device-package 路径已有 `run_hermes_agent_update`（install-device-package.sh:729-749，调用 deploy 脚本 agent-only 模式，best-effort）；**source-deploy orchestrator 无 agent 步骤**
- 约束（AGENTS.md）：升级路径不得调用 deploy-source-armbian.sh（新逻辑进 orchestrator 或 `scripts/_lib/`）；`agentManifestSha` 哨兵 `"0.0.0-noop"` 占位 phase c，复用槽位不改 schema；`includeAgentUpgrade` 配置默认 true（config.ts:269）与"不得默认搭车"规则冲突，本 spec 裁决见 R3「裁决」段

---

## R1 — 旧版本兜底与数据安全

目标：**任何档位的设备在数据不安全时更新必须被拒绝（409，带明确指引），在数据安全时更新后必须可验证数据完好；被吃掉的数据有自动恢复工具。**

### R1-0 热修（0.8.4，先于一切）

1. **lockfile 标记防 stale node_modules**
   - `build_deploy`：npm ci 成功后写 `${nm}/.hermes-lock-sha256`（= `sha256sum package-lock.json`）。
   - 幂等条件改为：`nm_populated && dist_ready && marker == 当前 lockfile sha`。
   - `preserve_node_modules_across_swap`：复制前比对旧树/新树 `package-lock.json` sha，**不一致直接不复制**（省掉几百 MB 无效拷贝，且保证复制后 marker 必然匹配）。
2. **node 二进制解析**
   - orchestrator 顶部解析一次 `NODE_BIN`（复用 run_build_as_app_user 的探测逻辑：command -v node → 常见安装目录探测），`build_deploy` 所有 `node -e` 改用 `"${NODE_BIN}"`；解析失败时跳过版本校验并 warn（不得因此回滚成功更新——版本一致性已由 manifest_self_check 保证）。
3. 测试：dry-run 用例覆盖 marker 匹配/不匹配、NODE_BIN 缺失路径。

### R1-1 能力指纹 + 数据安全门禁（server preflight）

新增 preflight 检查 `agent-data-safety`（preflight.ts，update.ts 挂到 source-deploy 与 device-package 两条路径的 download 之前）：

- 触发条件：`HERMES_HOME` 解析在 deploy 树内（即兼容布局，preflight.ts:143-154 现在豁免的那个）。
- 检查 deployed 树 `scripts/update-orchestrator.sh` 顶部的 `ORCHESTRATOR_CAPABILITIES` 行（见 R1-2）：必须同时含 `hermes_data_preservation` 与 `prebuilt_dist` 两个能力词。
- 缺标记 → 409 `update_data_preservation_unavailable`，错误信息直接给出 bootstrap 指引（"该设备的数据目录在部署树内且已部署的更新器无数据保留能力，请运行 scripts/bootstrap-device-*.sh 全新部署"）。
- 无 orchestrator 文件（≤0.8.0 走 legacy 路径）→ 同样拒绝。
- 豁免条件：`hermes_data` 不在树内（数据天然安全）或树内 `hermes_data` 顶层条目 ≤2（无实质数据，丢了也无感）。

这一条实现"智能判断迁移"：**有数据 + 旧更新器 = 拒绝并指路；无数据或新更新器 = 放行**。旧版设备不再可能进入"swap 成功但数据被骨架覆盖"的路径。

### R1-2 orchestrator 能力标记

`update-orchestrator.sh` 顶部常量：
```bash
ORCHESTRATOR_CAPABILITIES="hermes_data_preservation prebuilt_dist node_modules_preservation"
```
按实际能力逐版本增长；preflight grep 该行。0.8.2 的 orchestrator 只有 `hermes_data_preservation` → 仍被拒（它会对预构建包做完整设备构建，不可信）；0.8.3+ 三项全有 → 放行。

### R1-3 swap 前后数据核验（orchestrator，关闭"绿色 succeeded 但数据没了"）

- 新增 `scripts/_lib/data-inventory.sh`：`inventory_hermes_data <tree>` → 输出 JSON（顶层条目数、state.db 字节数、profiles 数、总字节数）。
- `JOURNAL_STAGES` 增加 `data_inventory`、`data_verified`（journal-write.sh）。
- `swap_deploy` 前 inventory 旧树 → journal stage `data_inventory`；`preserve_hermes_data_across_swap` 后 inventory 新树 → 比对：
  - 新树 state.db 字节数 < 旧树的 90% 且旧树 >1MB → 判定保留失败 → `revert_to_lastgood` + journal `failed`（原因 `hermes_data_preservation_mismatch`）。
  - 顶层条目数骤减同样判定失败。
- 通过后 journal stage `data_verified`。失败时**必须回滚**（数据完整性优先于更新可用性）。
- 旧树无 hermes_data 或条目 ≤2 时跳过核验（与保留逻辑的豁免条件一致）。

### R1-4 数据恢复工具

`scripts/recover-hermes-data.sh`（可手工运行，后续可挂到 identity repair 端点后面）：
- 扫描 `dirname(DEPLOY_DIR)/.previous-*` 与 lastgood 目标树中的 `hermes_data`；
- 与 live `hermes_data` 比对（条目数/state.db 大小）；
- live 明显是骨架而旧树是全量 → 交互确认后 `cp -a` 恢复 + journal 记录。
- 附带 `--dry-run` 默认输出差异报告。
- 验收：模拟 6.6.6.73 现场（swap 后骨架 live + .previous 全量），一条命令恢复 5 profiles + 112MB state.db。

### R1-5 存量设备上量路径（运维文档）

写入 `docs/harness/legacy-fleet-rollout.md`：
- ≤0.8.2 一律 bootstrap 全新部署（0.7.20 出厂 device-package 策略设备连 manifest 都收不到；0.8.1 无法自更新；0.8.2 设备构建不可信）。
- bootstrap 清单：新 deploy 树 + 重写 `/etc/default/hermes-web-ui`（顺带完成 R2 的 URL 切换）+ 刷 `/usr/local/sbin` runner。
- 上量前每台执行 R1-4 的 dry-run 报告留档。

### R1 验收标准

- [ ] 模拟 0.8.1 设备（无标记 orchestrator + 树内 hermes_data）请求更新 → 409 `update_data_preservation_unavailable`，不发生 swap。
- [ ] 0.8.3+ 设备正常更新，journal 出现 `data_inventory → … → data_verified`，故意构造保留失败时自动回滚。
- [ ] R1-0 两项缺陷回归测试全绿。
- [ ] R1-4 在事故复刻现场一键恢复。

---

## R2 — 移除 OSS，GitHub 全链路

目标：manifest 与包分发全部走 GitHub（release assets + `release-manifests` 分支 raw URL），删除全部 ossutil/ALIYUN_OSS_* 面积。

### 已知风险（接受并缓解）

GitHub 在中国大陆可达性不稳定。缓解：manifest `sourceUrls`/`packageUrls` 天然支持多镜像有序轮转 + orchestrator `curl -C -` 断点续传 + server 下载重试 + manifest 缓存兜底（manifest-client.ts:184-195）。镜像列表后续可加自建反代（如 CF worker），机制已就位，本 spec 不引入新依赖。

### R2-1 构建侧（build-device-package.mjs）

- `packageUrls`/`sourceUrls` 改为 GitHub-first：`[githubPackageUrl]`（release asset）。删除 `buildOssObjectUrl`/`buildOssObjectPath`（:169-186）与全部 oss* 变量读取（:427-428）。
- `release-metadata.json` 删除 oss* 字段（:665-678），保留 `manifestBaseUrl`/`latestUrl`（:680-681，raw.githubusercontent 已是现成值）。
- `.github/device-package-release.json` 删除 `ossPath`/`ossPublicBaseUrl`。
- 测试：build-device-package-script.test.ts:128-145 断言改 GitHub URL；device-package-manifest.test.ts:125 fixture 删 OSS 字段。

### R2-2 server 默认值

- config.ts:240 `DEFAULT_MANIFEST_BASE_URL` → `https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases`。
- 检查 `getDefaultManifestSourceLabel`（config.ts:273-275）对 OSS 形状的特殊处理。
- runtime-version-manager.ts:11-14：versions.json 权威源切到 release-manifests 分支 raw URL（该分支已随 CI 备份 versions.json，device-package-release.yml:378-382——R2-4 把备份变成权威）。

### R2-3 设备脚本默认值 + 环境文件

- deploy-source-armbian.sh:1771 `OSS_PUBLIC_BASE_URL` 删除；:1798-1799 `WEBUI_UPDATE_MANIFEST_BASE_URL(S)` 默认 → raw.githubusercontent。
- bootstrap-device-to-device-package.sh:9 `BASE_URL` → raw.githubusercontent（这是重写 `/etc/default/hermes-web-ui` 的写入器，是**存量设备脱 OSS 的唯一途径**，与 R1-5 bootstrap 合并执行）。
- update-source-deploy.sh / install-device-package.sh 透传键不变（键名与源无关）。
- **已部署设备的 env 文件钉着 OSS URL**：不 bootstrap 就永远看不到新 manifest。server 默认值只救"env 没写这些键"的设备。R1-5 文档必须写明这一点。

### R2-4 CI 工作流

- device-package-release.yml：删除 :191-235（ossutil/凭证/校验）、:237-251（OSS 上传）、:587-642（promote 的 OSS latest.json 上传，git 分支 promote :515-585 保留不动）。
- 校验步骤（:424-480）改为从 manifest 的 GitHub URL 下载验证。
- versions.json：release job 直接把 versions.json 提交到 release-manifests 分支为权威（替换 :307-343 的 OSS 发布）。
- hermes-agent-oss-mirror.yml / hermes-agent-custom-wheel.yml：OSS 上传步骤删除，资产改挂 GitHub release（与 R3-1 合并做）。
- 删除 3 个 `ALIYUN_OSS_*` secrets 的全部引用。

### R2-5 desktop

- updater.ts:16 主源切 GitHub release latest feed（:31-46 的 GitHub 兜底升为主）；harness-check.mjs:524-530 契约同步反转。
- runtime-manager.ts:47 `DEFAULT_RUNTIME_BASE_URL` → GitHub release 下载基址。

### R2 验收标准

- [ ] `grep -r "aliyuncs" scripts/ .github/ packages/server/src/ packages/desktop/src/` 仅剩 DashScope/ASR 等无关命中。
- [ ] 全新 bootstrap 设备（env 由新脚本写入）从 raw.githubusercontent 拉到 latest.json 并完成一次端到端更新。
- [ ] promote 后无需 OSS，设备在 5 分钟内可见新版本。
- [ ] CI 两阶段（candidate→promote）在无 OSS secrets 的 runner 上全绿。

---

## R3 — Hermes-Agent 升级跟进（phase c 的 agent seam）

目标：web-ui 发布可携带（可选的）hermes-agent 目标版本；设备更新时由 orchestrator 完成 agent venv 的 pip 升级；identity 复用 `agentManifestSha` 槽位记录真实值。

裁决：本 spec 即 AGENTS.md 所说 "release plan explicitly enables a wider scope" 的授权文件——**agent 升级随 web-ui 更新搭车是本 spec 明确开启的行为**，但保留独立开关与"manifest 未声明 agent 版本时不搭车"的默认。

### R3-1 发布链（依赖 R2）

- `patches/hermes-agent/build-release.sh`：从上游新 tag 重建补丁轮子（rebase CN 本地化补丁），产物流改为 **GitHub release asset**（`hermes-agent-<version>-py3-none-any.whl` + wheelhouse tar）。
- `.github/device-package-release.json` 新增可选字段 `"agentVersion": "x.y.z"`（缺省 = 本次发布不携带 agent 升级）。
- build-device-package.mjs：manifest 增加 `agentVersion` / `agentWheelUrl` / `agentWheelSha256`（仅当 agentVersion 配置时输出）。不声明时设备行为与今天完全一致。

### R3-2 设备侧执行（新 lib，不回调 deploy 脚本）

- 新增 `scripts/_lib/agent-update.sh`：
  - 输入：manifest 的 agentWheelUrl/agentWheelSha256（优先）→ 退化到 env `HERMES_AGENT_UPDATE_MANIFEST_URL` → 退化 PyPI（复用 resolve_hermes_agent_wheel_url 的三级解析思路，但代码独立、GitHub-first）。
  - 执行：stop `hermes-agent.service` → `pip install --upgrade` 目标 wheel 进既有 venv（`~/.hermes/hermes-agent-venv`）→ `ensure_wheel_anthropic_pin` 逻辑保留 → `hermes version` 校验 → restart service。
  - 失败语义：**best-effort**——warn + journal 记录 `agent_upgrade_failed`，绝不阻断/回滚 web-ui 更新（对齐 install-device-package.sh:749 既有语义）。
- `update-orchestrator.sh`：`build_deploy` 与 `restart_runtime` 之间新 stage `agent_upgrading`；仅当 manifest 携带 agentVersion 且 `HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE != false` 时执行。
- JOURNAL_STAGES 增加 `agent_upgrading`（journal-write.sh）。
- runner `allowed_keys` / controller `UPDATE_RUNNER_ENV_KEYS` 增加 agent 三键透传。

### R3-3 身份与配置

- identity：stamping 时若 manifest 声明了 agentVersion，`agentManifestSha` 写入 wheel 的 sha256（字符串，schema 不变）；否则维持哨兵。`identity-stamp.sh:102` 与 `identity-stamp.ts:97` 同步。
- config.ts `includeAgentUpgrade` 默认从 true 改为 **`'auto'`**：manifest 有 agentVersion = 升级，没有 = 跳过。显式 env 覆盖优先。（消除与 AGENTS.md "不得默认搭车"的字面冲突，同时满足本 spec 的搭车需求。）
- 更新 API/UI：更新任务完成面板显示 "Hermes Agent: 0.17.0 → x.y.z（成功/跳过/失败不影响本次更新）"。

### R3-4 测试

- `_lib/agent-update.sh` seam 测试（解析优先级、sha 校验失败跳过、pip 失败不阻断、service 停起）。
- orchestrator dry-run：manifest 带/不带 agentVersion 两条路径；`agentManifestSha` 真值/哨兵两态（现有断言哨兵的测试按条件更新）。
- manifest 测试：agentVersion 缺省时 manifest 与现状逐字节一致（向后兼容）。

### R3 验收标准

- [ ] 带 agentVersion 的 manifest 更新后：`hermes version` = 目标版本，identity.agentManifestSha = wheel sha。
- [ ] 人为断网 pip 失败：web-ui 更新成功，journal 有 `agent_upgrade_failed`，服务正常。
- [ ] 不带 agentVersion 的 manifest：行为与 0.8.3 完全一致（哨兵、无新 stage 执行）。

---

## 执行顺序与提交切分

| # | 提交 | 内容 | 前置 |
|---|---|---|---|
| 1 | `fix(orchestrator): lockfile marker + node resolution` | R1-0 | 无 |
| 2 | `feat(update): agent-data-safety preflight gate` | R1-1 + R1-2 | #1（0.8.3 树打标记） |
| 3 | `feat(orchestrator): data inventory & verification` | R1-3 | 无硬前置，随 #2 |
| 4 | `feat(scripts): recover-hermes-data.sh` | R1-4 | 无 |
| 5 | `docs: legacy-fleet-rollout.md` | R1-5 | #1-#4 |
| 6 | `feat(release): github-only artifact urls` | R2-1 | 无 |
| 7 | `feat(server): github manifest defaults` | R2-2 | #6 |
| 8 | `feat(device): github manifest env defaults` | R2-3 | #7 |
| 9 | `ci: remove OSS from release workflows` | R2-4 | #6 |
| 10 | `feat(desktop): github update feeds` | R2-5 | 无 |
| 11 | `feat(release): agent wheel on github release` | R3-1 | #6, #9 |
| 12 | `feat(orchestrator): agent upgrade stage` | R3-2 + R3-3 | #11 |
| 13 | `test: agent update seam coverage` | R3-4 | #12 |

每个提交独立可回滚；#2/#3 合入后打 0.8.4（R1-0+R1-1 必须同版本上线，门禁依赖新标记）；R2 各提交可分散在 0.8.4–0.9.0；R3 对应 0.9.0。

## 明确不做（本 spec 范围外）

- 不改两阶段 candidate→promote 机制（24h 门控保留）。
- 不引入多版本回滚仓（单代 lastgood 不变）。
- 不改 desktop 打包分发。
- 不做 agent 独立更新通道 UI（搭车即可，独立通道等真实需求）。
