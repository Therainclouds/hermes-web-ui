# 08. 验证、失败回退与未来回滚

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-10
- 依赖：`05-device-update-flow.md`、`07-implementation-plan.md`、`docs/adr/ADR-0004-device-update-rollback-strategy.md`

## 验证目标

第一阶段的验证目标不是只证明“服务能启动”，而是证明以下三个闭环都成立：

- 发布闭环：真实 tag 发布后可产出、可访问、可校验设备包
- 消费闭环：设备端能按 `release-manifests + device-package` 配置识别并消费更新
- 回退闭环：安装失败或健康检查失败时，设备不会停留在半损坏状态

## 验证矩阵

### 发布后校验

- GitHub Release 下存在 `hermes-web-ui-device-vX.Y.Z.tar.gz`
- GitHub Release 下存在对应 `.sha256`
- GitHub Release 下存在 `manifest.json`
- `release-manifests` 分支存在 `releases/<channel>/latest.json`
- `release-manifests` 分支存在 `releases/vX.Y.Z/manifest.json`
- `latest.json` 中的 `packageUrl` 可真实下载
- 下载后的文件摘要与 `latest.json.sha256` 一致

### 功能验证

- 能识别当前版本与最新版本
- 能识别更新源标签、策略、通道和包类型
- 能成功触发更新并看到阶段状态
- 更新成功后服务恢复可用，版本号变化正确
- 更新后 `/health` 继续返回 `status=ok`

### 设备侧消费验收

- 进程环境中存在 `device-package` 所需 `WEBUI_UPDATE_*` 变量
- `/health` 返回 `webui_update_strategy=device-package`
- `/health` 返回 `webui_update_channel`
- `/health` 返回 `webui_update_package_type=device-package`
- 状态文件和日志目录可被设备侧定位
- 前端可显示更新源与阶段状态

### 安全验证

- 登录用户可触发稳定版更新
- 普通用户不能切换更新源或关闭校验
- 摘要不匹配时安装被拒绝
- manifest 字段缺失时安装被拒绝
- 真实数据目录位于危险布局时更新被阻止

### 兼容性验证

- 未启用 `device-package` 的旧设备仍按旧策略工作
- 旧环境变量仍能正确启动服务
- `systemd` 服务定义不因新方案失效
- 历史兼容布局 `${DEPLOY_DIR}/hermes_data` 仍可继续运行，但带有明确告警

### 工程验证

- 相关 server 测试通过
- 相关 client store 测试通过
- `npm run build` 通过
- 安装器脚本至少完成语法与 dry-run 级验证
- 发布 workflow 的发布后校验步骤通过

### 更新能力接口验证

- `GET /api/hermes/update/capabilities` 返回：
  - 当前策略、包类型、channel、源标签
  - `supports` 能力矩阵
  - `runtime` 配置与运维路径
  - `preflight` 风险等级、阻断文本、告警文本
- 当前阶段约束：
  - `deltaPackage=false`
  - `resumableDownload=false`
  - `fullPackage=true`
  - `checksumVerification=true` 仅对 `device-package` 强保证
  - 设备侧写权限/剩余空间强预检默认只在非 Windows 运行态生效

## P4 收口验收清单

### 发布侧

1. 触发真实 `device-package-release.yml`。
2. 记录 workflow run URL、tag、channel。
3. 检查 Release 资产完整性。
4. 检查 `release-manifests` 分支上的 `latest.json`。
5. 真实下载设备包并执行 `sha256` 校验。
6. 确认本次结果已写入 workflow summary 或人工发布记录。

### 设备侧

1. 用 `device-package` 配置启动服务。
2. 检查 `/health` 更新字段。
3. 检查状态文件和日志目录路径。
4. 页面确认更新源标签、可更新提示和阶段状态。
5. 若现场已有新版本可触发，则执行一次真实更新验收。
6. 若现场不具备真实更新条件，至少完成“发现更新配置正确、状态/日志路径正确、安装器路径正确”的前置验收。

### 基础闭环自动化回归

当前仓库内已经补了围绕“handoff 后不误报失败”的自动化回归，至少覆盖：

1. `source-deploy` launcher 退出后，任务继续保持 `runtime owner + running`
2. `device-package` launcher 退出后，任务继续保持 `runtime owner + running`
3. runtime heartbeat 新鲜时，不会被恢复成 interrupted failed
4. runtime heartbeat 超时后，才会被恢复成 interrupted failed
5. 连续 `10` 轮 `source-deploy` handoff 回归中，不会把 launcher 退出误判成成功或失败

这组自动化验证的目标不是替代实机，而是把这次最核心的误判根因长期锁在 CI 回归面里。

### 0.6.30 实机验证顺序

建议按以下顺序直接验证 `0.6.30`：

1. 发布 `v0.6.30`，确认 Release 资产和 `release-manifests` 已刷新
2. 在目标设备打开页面内更新，确认 `/health` 已返回：
   - `webui_update_strategy`
   - `webui_update_channel`
   - `webui_update_package_type`
3. 触发一次真实更新，更新前记录：
   - `systemctl status hermes-web-ui.service`
   - 若设备有独立 Agent service，再记录 `systemctl status hermes-agent.service`
   - `ps -ef | grep hermes | grep -v grep`
4. 更新完成后确认：
   - `systemctl status hermes-web-ui.service` 为 active
   - 若更新前 `hermes-agent.service` 为 active，则更新后仍为 active
   - `/health` 返回 `status=ok`
   - `/health` 返回 `webui_version=0.6.30`
   - `journalctl -u hermes-web-ui.service -n 200 --no-pager` 中无持续重启
   - `~/.hermes-web-ui/logs/bridge.log` 中无新的 `bridge exited unexpectedly`
5. 再发布一个仅增加依赖的小版本进行第二次更新，确认：
   - 依赖安装阶段正常通过
   - 不残留旧的 bridge socket / 旧 agent 进程
   - 两次更新后服务都正常恢复
6. 在设备验证通过后，继续按相同流程累计完成不少于 `10` 次实机更新闭环，并记录每次：
   - tag / 版本
   - 更新开始时间和结束时间
   - `/health` 最终版本
   - `update-task-state.json` 最终状态
   - `journalctl -u hermes-web-ui.service -n 200 --no-pager`
   - 是否出现人工清除状态或手工重启

只有这 `10` 次实机记录都收敛到“无人工干预、无误报失败、版本切换成功”，才视为基础闭环在设备侧完成验收。

## 失败自动回退

第一阶段的回退目标是安装失败不把设备留在半损坏状态。

建议流程：

1. 开始安装前创建 last-known-good 快照。
2. 安装过程失败则立刻停止。
3. 恢复快照内容。
4. 重新执行 `update-only` 自检。
5. 记录失败原因、回退结果和日志路径。

## 异常场景应急流程

### 场景一：页面内更新没有进入受控 runner

- 立即检查是否生成 `update-runner-request.json`、`update-task-state.json` 和本次更新日志。
- 若三者都缺失，按“入口分流异常”处理，禁止继续重复点击更新。
- 优先排查服务端 `strategy` 配置、runner service、request allowlist 和 controller 分流逻辑。

### 场景二：固定版本引导后端口漂移

- 先检查 `/etc/default/hermes-web-ui` 中的 `PORT`、`BIND_HOST`。
- 确认现场是否误用了 `stable/latest.json` 或未保留原环境变量。
- 恢复原端口后执行健康检查，再决定是否重试安装。

### 场景三：发布资产存在但设备无法正常升级

- 先验证最终设备包资产可真实下载并校验摘要。
- 再确认包内关键脚本和 `dist` 资产完整。
- 若发布契约或资产不一致，优先修复发布链路，不在现场继续试错部署。

### 场景四：更新后仍发现旧 agent / bridge 幽灵进程

- 先检查新版本设备上的 `hermes-web-ui.service` 是否已经带 `KillMode=control-group`
- 再检查 `journalctl -u hermes-web-ui.service -n 200 --no-pager` 是否出现 stop/restart 时序异常
- 若设备有独立 `hermes-agent.service`，确认它在更新前为 active、更新过程中被 stop、恢复后被 start
- 检查 `/tmp/hermes-agent-bridge.sock` 及 `hermes-agent-bridge-workers` 目录是否仍残留旧 socket
- 若 socket 已清空但旧进程仍在，采集 `ps -ef | grep hermes | grep -v grep` 后再决定是否追加更严格的进程匹配规则

## 回退触发条件

- manifest 拉取失败
- 设备包下载失败
- `sha256` 校验失败
- 解包结构非法
- 部署脚本执行失败
- `systemd` 重启后健康检查失败

## 回退后观测项

发生自动回退后，至少确认以下事实：

- 状态文件中的 `status` 为 `rolled_back`
- 状态文件中的 `rollbackMessage` 已写入
- 状态文件中的 `logPath` 指向本次任务日志
- 回退后 `/health` 再次返回 `status=ok`
- `journalctl -u hermes-web-ui` 中不存在持续崩溃

## 未来手动回滚

第二阶段开始支持：

- 列出最近可回滚版本
- 指定版本回滚
- 回滚后再次进行健康检查

第三阶段可演进为：

- 版本化 release 目录
- `current` 符号链接切换
- 更快的切换式回滚

## 运维可观察项

建议固定以下路径：

- 更新任务状态文件：`${HERMES_WEB_UI_HOME}/updates/update-task-state.json`
- 安装日志目录：`${HERMES_WEB_UI_HOME}/updates/logs/`
- 备份目录：`${DEPLOY_DIR}/.releases/backups`
- staging 目录：`${DEPLOY_DIR}/.releases/staging`
- 健康检查地址：`WEBUI_UPDATE_HEALTHCHECK_URL`

前端当前也会通过能力接口直接暴露以下运行时信息，便于排障：

- `stateFile`
- `logDir`
- `stagingDir`
- `backupDir`
- `minFreeSpaceBytes`

这些路径已要求同步写入 `docs/deploy-update-runbook.md`，作为设备侧排障基线。

## 最低应急收集项

- 设备当前版本与目标版本
- 更新策略、channel、package type
- 触发更新的时间点和操作人
- `update-task-state.json`
- 最新更新日志路径
- `journalctl -u hermes-web-ui.service` 最近 200 行
- `journalctl -u hermes-web-ui-update.service` 最近 200 行
