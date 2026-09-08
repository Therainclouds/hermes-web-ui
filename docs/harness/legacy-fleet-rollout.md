# Legacy Fleet Rollout — ≤0.8.2 设备上量路径

状态: active
上游 spec: [update-fleet-spec.md](./update-fleet-spec.md) (R1-5)

## 背景

v0.8.4 引入了 `ORCHESTRATOR_CAPABILITIES` 能力指纹门禁（`agent-data-safety` preflight）和 swap 前后数据核验（`data_inventory` → `data_verified`）。这些保护只对 **已经在 0.8.4+ 的设备**生效。

≤0.8.2 的存量设备**无法自更新到 0.8.4**：

| 起始版本 | 阻断原因 |
|---|---|
| ≤0.7.x (source-deploy) | `update-source-deploy.sh` 对 flat tar 报 "not a valid hermes-web-ui source tree"；更新永远卡在下载后 |
| 0.7.20 出厂 (device-package) | 旧 `manifest-client.ts` 硬性要求 `packageType==='device-package'`；409 `update_manifest_invalid`，更新根本不发起 |
| 0.8.0 | 无 orchestrator；同 ≤0.7.x 的 flat tar 拒绝 |
| 0.8.1 | orchestrator 无 `build_deploy` 也无 `preserve_hermes_data`；swap 后树里无 `node_modules` → 服务起不来 → healthcheck 失败 → 回滚 |
| 0.8.2 | orchestrator 有 preserve 和 build，但对预构建包执行完整设备构建（10分钟 vue-tsc），不可信 |

0.8.3 的 orchestrator 有 `prebuilt_dist` 能力，但 **没有** R1-0 的 lockfile marker 和 node 解析修复，且不会出现在新的 preflight 门禁里（门禁读的是部署后的 orchestrator——即 0.8.3 自己的，不含 `agent-data-safety` 检查）。

**结论：≤0.8.3 一律需要 bootstrap 全新部署，不能依赖 in-place 更新。**

## Bootstrap 清单

对每台存量设备执行以下步骤：

### 1. 数据备份（必须）

```bash
# 在停服务前执行 dry-run 报告留档
scripts/recover-hermes-data.sh --dry-run --deploy-dir /opt/hermes-web-ui

# 手动备份 hermes_data（如果 recover 工具报告异常）
cp -a /opt/hermes-web-ui/hermes_data /tmp/hermes_data.bak-$(date +%s)
```

### 2. 停止服务

```bash
systemctl stop hermes-web-ui
```

### 3. 新 deploy 树

从 0.8.4+ 的 release 下载 source-deploy tar 或 device-package tar，解压到新的 deploy 位置：

```bash
# 方式 A: source-deploy tar（推荐，与 CI 构建一致）
curl -L -o /tmp/hermes-web-ui.tar.gz \
  "https://github.com/tangledup-ai/hermes-web-ui/releases/download/v0.8.4/hermes-web-ui-device-0.8.4-linux-arm64.tar.gz"
mkdir -p /opt/hermes-web-ui.new
tar xzf /tmp/hermes-web-ui.tar.gz -C /opt/hermes-web-ui.new

# 方式 B: 如果已有源码
cd /path/to/source
npm ci --ignore-scripts
npm run build
cp -a . /opt/hermes-web-ui.new
```

### 4. 重写 `/etc/default/hermes-web-ui`

这是**脱 OSS 的关键步骤**（R2）。已部署设备的 env 文件钉着旧的 OSS URL，不重写就永远拉不到新 manifest。

```bash
scripts/bootstrap-device-to-device-package.sh
# 或手动编辑 /etc/default/hermes-web-ui，将 WEBUI_UPDATE_MANIFEST_BASE_URL 改为：
#   https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases
```

### 5. 原子切换

```bash
# 记录 lastgood（用于回滚）
ln -sfn "$(readlink /opt/hermes-web-ui)" /opt/lastgood

# 原子替换 deploy symlink
ln -sfn /opt/hermes-web-ui.new /opt/hermes-web-ui.tmp
mv -Tf /opt/hermes-web-ui.tmp /opt/hermes-web-ui

# 恢复 hermes_data（如果新树是骨架）
scripts/recover-hermes-data.sh --deploy-dir /opt/hermes-web-ui
```

### 6. 刷新 runner

```bash
cp scripts/hermes-web-ui-update-runner.sh /usr/local/sbin/hermes-web-ui-update-runner.sh
chmod +x /usr/local/sbin/hermes-web-ui-update-runner.sh
```

### 7. 启动并验证

```bash
systemctl start hermes-web-ui
sleep 5
curl -sf http://127.0.0.1:6060/health | jq .
# 验证版本
node -e "console.log(require('/opt/hermes-web-ui/package.json').version)"
# 验证 orchestrator 能力
head -20 /opt/hermes-web-ui/scripts/update-orchestrator.sh | grep ORCHESTRATOR_CAPABILITIES
```

## 上量前检查

每台设备在 bootstrap 前必须执行：

- [ ] `scripts/recover-hermes-data.sh --dry-run` 报告留档
- [ ] `/etc/default/hermes-web-ui` 已更新 manifest URL（R2 脱 OSS）
- [ ] `/usr/local/sbin/hermes-web-ui-update-runner.sh` 已刷新
- [ ] hermes_data 恢复验证通过（profiles、state.db 完整）

## 回滚方案

如果 bootstrap 后服务异常：

```bash
# 回滚到 lastgood
ln -sfn "$(readlink /opt/lastgood)" /opt/hermes-web-ui
systemctl restart hermes-web-ui
```

## 后续

0.8.4+ 设备通过 in-place 更新自动获得后续版本。≤0.8.3 设备的 bootstrap 是一次性操作——完成后可享受与全新设备相同的自动更新能力。
