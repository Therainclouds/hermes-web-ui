# Legacy Fleet Rollout — ≤0.8.3 存量设备上量路径

状态: active (v2 — 修正版，替代 2026-09-08 首版)
上游 spec: [update-fleet-spec.md](./update-fleet-spec.md) (R1-5)

## 核心原则：Bootstrap 引擎 = 0.8.4 orchestrator standalone 运行

**不要手工执行 tar 解压 + `mv -Tf` 符号链接替换。** 那是在重新发明
`update-orchestrator.sh` 已经做好的事，且每一处都会踩 deploy 链已修过的坑
（root 属主、node_modules 缺失、lastgood 断链）。

正确做法：把 0.8.4 的 orchestrator 从新 tar 里解出来，**standalone 运行一次**，
让它对现有 deploy 执行一次完整的、已测试的更新生命周期：

```
journal → preflight(policy/space) → extract → manifest_self_check
→ atomic swap (capture lastgood)
→ preserve hermes_data (lastgood 链) + preserve node_modules
→ npm ci (lockfile marker 未命中 → 真实安装) + node-pty rebuild
→ prebuilt dist 检测 → 跳过 npm run build
→ chown_r_mount_safe (APP_USER 属主修复)
→ systemctl restart → healthcheck → identity stamp
```

任何一步失败自动 `revert_to_lastgood` + journal 留痕。这是 R1 全部保护的
实战首秀，也是上量前最真实的一次验证。

## 前提条件

- **v0.8.4 已 promote**（stable `latest.json` 指向 0.8.4）——保证设备落点是通道尖端，bootstrap 后立即能走正常自动更新。
- 下载地址（**注意 artifact 名带 `v` 前缀、无 `-linux-arm64` 后缀**，见
  build-device-package.mjs `sanitizeTag`:52-56 与 `artifactName`:461）：

  ```
  https://github.com/tangledup-ai/hermes-web-ui/releases/download/v0.8.4/hermes-web-ui-device-v0.8.4.tar.gz
  https://github.com/tangledup-ai/hermes-web-ui/releases/download/v0.8.4/hermes-web-ui-device-v0.8.4.tar.gz.sha256
  ```

- 已知参考布局（6.6.6.73）：`DEPLOY_DIR=/opt/hermes-web-ui/src`（符号链接），
  `HERMES_HOME=/opt/hermes-web-ui/src/hermes_data`（树内），`APP_USER=hermesui`。
  **每台设备必须先确认实际布局，禁止照抄路径。**

## 为什么 ≤0.8.3 一律 bootstrap（修正版论据）

| 起始版本 | 阻断原因 |
|---|---|
| ≤0.7.x (source-deploy) | 旧 `update-source-deploy.sh` 对 flat tar 报 "not a valid hermes-web-ui source tree"，更新永远卡死在解包 |
| 0.7.20 出厂 (device-package) | 旧 manifest-client 硬性要求 `packageType==='device-package'`，409 `update_manifest_invalid`，更新根本不发起 |
| 0.8.0 | 无 orchestrator，走 legacy 路径，同 ≤0.7.x |
| 0.8.1 | 旧 orchestrator 无 build 步骤也无 preserve：swap 后树里没有 node_modules → 服务起不来 → 回滚 |
| 0.8.2 | 旧 orchestrator 对预构建包执行完整设备构建（`rm -rf dist && npm run build`，10 分钟 vue-tsc 全链路），不可信 |
| 0.8.3 | orchestrator 缺 R1-0 两项修复（lockfile marker、node 解析）。注意：`agent-data-safety` 门禁是 0.8.4 的 **server 代码**，0.8.3 的 server 里根本没有这道门禁，所以没人拦它——它的风险是自己的 orchestrator 在依赖变更或 root PATH 无 node 时误回滚 |

## 每台设备流程

### 0. 确认布局与账号（禁止假设）

```bash
# deploy 符号链接与真实目标
ls -l /opt/hermes-web-ui/            # 找到 src 符号链接（或其他名字）
DEPLOY_LINK=/opt/hermes-web-ui/src
DEPLOY_TARGET=$(readlink -f "$DEPLOY_LINK")
echo "$DEPLOY_TARGET"                 # 记录，回滚要用

# 服务账号与状态目录（以 env 文件为准，不要猜）
grep -E '^(APP_USER|USER)=|hermesui' /etc/default/hermes-web-ui
grep -E '^HERMES_HOME=' /etc/default/hermes-web-ui
grep -E '^HERMES_WEB_UI_HOME=' /etc/default/hermes-web-ui
APP_USER=<上一步结果，通常 hermesui>
STATE_HOME=<HERMES_WEB_UI_HOME 的值，通常 /home/hermesui/.hermes-web-ui>
```

### 1. 备份与留档（必须）

```bash
# recover 工具来自新 tar（设备旧树里没有这个脚本！），先下载解压：
curl -fL -o /tmp/hui.tar.gz \
  "https://github.com/tangledup-ai/hermes-web-ui/releases/download/v0.8.4/hermes-web-ui-device-v0.8.4.tar.gz"
curl -fL -o /tmp/hui.tar.gz.sha256 \
  "https://github.com/tangledup-ai/hermes-web-ui/releases/download/v0.8.4/hermes-web-ui-device-v0.8.4.tar.gz.sha256"
cd /tmp && sha256sum -c hui.tar.gz.sha256       # 必须通过
mkdir -p /tmp/hui-bootstrap && tar -xzf /tmp/hui.tar.gz -C /tmp/hui-bootstrap

# dry-run 报告留档（对照的是 live 树）
sudo bash /tmp/hui-bootstrap/scripts/recover-hermes-data.sh \
  --dry-run --deploy-dir "$DEPLOY_LINK" | tee ~/recover-report-$(date +%s).txt

# 独立冷备份（dry-run 报告异常时必须做；正常也建议做）
sudo cp -a "${DEPLOY_TARGET}/hermes_data" "/tmp/hermes_data.bak-$(date +%s)"
```

### 2. Standalone 运行 0.8.4 orchestrator（核心步骤）

```bash
sudo env \
  DEPLOY_DIR="$DEPLOY_LINK" \
  APP_USER="$APP_USER" \
  HERMES_WEB_UI_UPDATE_APP_USER="$APP_USER" \
  HERMES_WEB_UI_UPDATE_VERSION=0.8.4 \
  HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE=/tmp/hui.tar.gz \
  HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256=$(cut -d' ' -f1 /tmp/hui.tar.gz.sha256) \
  HERMES_WEB_UI_HOME="$STATE_HOME" \
  HERMES_WEBUI_STATE_DIR="$STATE_HOME" \
  bash /tmp/hui-bootstrap/scripts/update-orchestrator.sh
```

**`HERMES_WEB_UI_HOME` 必须显式传**：不传的话 journal/identity 会按
`journal_state_home()`（journal-write.sh:26）落到 `/root/.hermes-web-ui`，
服务端永远读不到，identity 断链。

预期时长 2–5 分钟（npm ci 占大头，npmmirror 源）。观察输出应出现：
`pre-built archive detected` → `preserving hermes_data` →
`data_verified`（journal 阶段）→ `deploy tree built and verified: 0.8.4` →
`succeeded`。

任何一步失败：orchestrator 自动回滚到 lastgood 并 journal `rolled_back`，
设备保持原状。**不要在回滚后重试前不看 journal 就再来一次**——先
`cat "$STATE_HOME/updates/history/" 最新的 .jsonl`。

### 3. 刷新 runner（真实路径无 `.sh` 后缀）

```bash
# systemd 调用的是 /usr/local/sbin/hermes-web-ui-update-runner（无后缀，
# deploy-source-armbian.sh:1786）。复制成带 .sh 的名字 = 没有替换成功。
sudo install -o root -g root -m 0755 \
  "${DEPLOY_TARGET}/scripts/hermes-web-ui-update-runner.sh" \
  /usr/local/sbin/hermes-web-ui-update-runner
```

0.7.20 出厂 runner 没有 orchestrator 分支（只会调 `update-source-deploy.sh`），
**必须**刷新；0.8.x 设备也刷新以对齐。刷新后，下次自动更新时 runner 会从
`${DEPLOY_DIR}/scripts/update-orchestrator.sh` 调到新 orchestrator。

### 4. 重写 `/etc/default/hermes-web-ui` 的更新相关键

已部署设备的 env 文件钉着旧值（OSS URL / device-package 策略），必须逐键修正。
**只动下面这些键，其余（PORT、HERMES_HOME、HERMES_WEB_UI_HOME、HERMES_AGENT_*、
HERMES_BIN…）一律不碰**：

```bash
sudo sed -i \
  -e 's|^WEBUI_UPDATE_MANIFEST_BASE_URL=.*|WEBUI_UPDATE_MANIFEST_BASE_URL=https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases|' \
  -e 's|^WEBUI_UPDATE_MANIFEST_URLS=.*|WEBUI_UPDATE_MANIFEST_URLS=https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/stable/latest.json|' \
  -e 's|^WEBUI_UPDATE_STRATEGY=.*|WEBUI_UPDATE_STRATEGY=source-deploy|' \
  -e 's|^WEBUI_UPDATE_PACKAGE_TYPE=.*|WEBUI_UPDATE_PACKAGE_TYPE=source-deploy|' \
  /etc/default/hermes-web-ui
# 文件里没有的键用 >> 追加；改完 grep 核对四行
sudo systemctl restart hermes-web-ui
```

说明：
- `WEBUI_UPDATE_STRATEGY=source-deploy` 对 **0.7.20 出厂设备是硬要求**——它们出厂写的是 `device-package`，不改的话下次自动更新 409 `update_manifest_invalid`。
- 显式 env 优先于脚本默认值，所以本步骤在 R2-3（设备脚本默认值切 GitHub）落地前后都成立。
- **不要用 `bootstrap-device-to-device-package.sh`**：它写死 `WEBUI_UPDATE_STRATEGY=device-package`
  （:105-106,146-147），与 source-deploy manifest 不匹配，会把设备再次锁死在 409。
- `HERMES_AGENT_*` 键保留不动：R3 之前 agent 资产仍在 OSS，删了会断 agent 安装。

### 5. 验证清单

```bash
curl -sf http://127.0.0.1:6060/health
sudo node -e "console.log(require('$DEPLOY_TARGET/package.json').version)"   # 0.8.4
grep ORCHESTRATOR_CAPABILITIES "$DEPLOY_TARGET/scripts/update-orchestrator.sh"
sudo cat "$STATE_HOME/state/identity.json"        # version=0.8.4, agentManifestSha=0.0.0-noop
sudo bash /tmp/hui-bootstrap/scripts/recover-hermes-data.sh \
  --dry-run --deploy-dir "$DEPLOY_LINK"           # 应报告"无需恢复"
sudo sha256sum "$DEPLOY_TARGET/scripts/hermes-web-ui-update-runner.sh" \
  /usr/local/sbin/hermes-web-ui-update-runner     # 两两一致
grep -E '^WEBUI_UPDATE_(MANIFEST_BASE_URL|MANIFEST_URLS|STRATEGY|PACKAGE_TYPE)=' /etc/default/hermes-web-ui
```

全部通过后，在 Web UI 更新页面手动触发一次"检查更新"——确认设备能从
raw.githubusercontent 拉到 stable latest.json（应显示已是最新或指向下一个候选）。

## 回滚

- **orchestrator 内失败**：自动 `revert_to_lastgood`（deploy 链接指回旧树），
  journal `rolled_back`。无需人工干预，可修因后重试。
- **bootstrap "成功"但服务异常**（healthcheck 绿但功能不对）：

  ```bash
  # 第 0 步记录过的 $DEPLOY_TARGET 与回滚目标
  sudo ln -sfn "$OLD_DEPLOY_TARGET" "$DEPLOY_LINK"
  sudo systemctl restart hermes-web-ui
  # hermes_data 也在旧树内，随链接切回；env 不用动
  ```

- **数据异常**（profiles/state.db 缺失）：跑 recover 工具（不带 --dry-run），
  从 `.previous-*`/lastgood 树恢复；极端情况用第 1 步的冷备份。

## 上量前检查（每台一台一行留档）

- [ ] 布局确认：`$DEPLOY_LINK` / `$DEPLOY_TARGET` / `$APP_USER` / `$STATE_HOME` 已记录
- [ ] `sha256sum -c` 通过，artifact 名为 `hermes-web-ui-device-v0.8.4.tar.gz`
- [ ] recover dry-run 报告留档 + hermes_data 冷备份完成
- [ ] orchestrator 输出含 `data_verified` 与 `succeeded`
- [ ] runner 已刷到无后缀路径且 sha 一致
- [ ] env 四键已改且 grep 核对（0.7.20 出厂设备特别确认 STRATEGY）
- [ ] 验证清单全过 + Web UI 检查更新正常

## 与 spec 其他工作流的时序

- **R2-3（设备脚本默认值切 GitHub）落地后**，新装/重装设备的 env 自动正确，
  本文档第 4 步对它们不再是必需（存量设备仍需要一次性修正）。
- **R3（agent 升级）**不受本流程影响：`HERMES_AGENT_*` 键保留，agent 资产
  在 R2-4/R3-1 完成前仍走 OSS。
- 0.8.4 promote 之前不要开始上量（前提条件）。
