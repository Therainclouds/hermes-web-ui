# Hermes Agent 中文本地化 —— 方案 C / D 落地文件

目标：不 fork hermes-agent 的前提下为飞书/微信 bot 提供中文交互（配对码提示、
home channel 提示、slash 命令中文别名）。背景与决策见
`docs/planning/hermes-cn-localization-memo.md`。

---

## 方案 C（短期，运行时 monkey-patch）

### 文件

| 文件 | 作用 |
|---|---|
| `hermes_cn_localization.py` | patch 核心：别名 + 两处文案翻译 + 自检 |
| `sitecustomize.py` | Python 启动钩子，自动调用 patch（替代不可用的 `PYTHONSTARTUP`） |
| `selfcheck.py` | 自检脚本（设备上运行） |

### 安装（设备 root@6.6.6.49）

```bash
# 1. 部署 patches 目录（本仓库同步后复制或 rsync）
mkdir -p /opt/hermes-web-ui/patches
cp -r patches/*.py /opt/hermes-web-ui/patches/

# 2. 在 /etc/default/hermes-web-ui 末尾追加两行（该文件是 service 的 EnvironmentFile，
#    环境变量经 node -> gateway 子进程链路生效；PYTHONPATH 若已有值用冒号追加）
cat >> /etc/default/hermes-web-ui <<'EOF'

# --- Hermes CN localization (方案 C) ---
PYTHONPATH=/opt/hermes-web-ui/patches
HERMES_LANGUAGE=zh
EOF

# 3. 重启生效
systemctl daemon-reload
systemctl restart hermes-web-ui
```

### 验证

```bash
# 自检（用 hermes-agent 的 venv python；退出码 0 = 全部 PASS）
/home/hermesui/.hermes/hermes-agent-venv/bin/python3 /opt/hermes-web-ui/patches/selfcheck.py

# gateway 日志应有 "all patches applied" 或告警（journalctl -u hermes-web-ui）
# 真机测试：未配对账号 -> 中文配对提示；配对后 -> 中文 home channel 提示；/新会话 等价 /new
```

### 机制说明

- `sitecustomize.py` 由 Python 启动时自动 import（交互/非交互均生效），经
  `PYTHONPATH` 注入。`PYTHONSTARTUP` 仅交互式生效，**不可用**（已实证）。
- 别名 patch：改 `CommandDef.aliases` 后必须重建 `_COMMAND_LOOKUP`
  （0.17.0 无 `rebuild_lookups()`）。
- 文案 patch：内容锚定包装 `FeishuAdapter.send` / `WeixinAdapter.send` /
  `BasePlatformAdapter.send` / `send_private_notice`，非目标文案原样透传（幂等）。
- 全部 `try/except` 兜底，失败只告警不阻断启动。**已在真机 0.17.0 全部 PASS**。

### 回滚

```bash
# 注释掉 /etc/default/hermes-web-ui 里新增的两行
systemctl daemon-reload && systemctl restart hermes-web-ui
```

---

## 方案 D（长期，自维护 wheel）

fork hermes-agent + 小补丁（两处文案 i18n-化）+ 构建发布到自家 OSS；
设备 source-deploy 从 OSS manifest 拉取，天然受控发布。

### 文件

| 文件 | 作用 |
|---|---|
| `hermes-agent/apply_cn_patch.py` | 对上游 checkout 应用补丁（run.py 两处文案 -> `t()` + locales 加 key），支持 `--revert` |
| `hermes-agent/build-release.sh` | clone 上游 tag -> 打补丁 -> 构建 wheel -> 校验 ->（可选）上传 OSS |
| `../../.github/workflows/hermes-agent-custom-wheel.yml` | CI：构建 + 上传 OSS + 更新 `stable/latest.json` |

### 用法

```bash
# 本地构建（默认 tag v2026.6.19 == 0.17.0，只构建）
bash patches/hermes-agent/build-release.sh
# 指定新版本 tag（rebase 时）：上游发新版后改 --tag
bash patches/hermes-agent/build-release.sh --tag v2026.8.3 --version 0.20.0
# 构建 + 上传 OSS + 更新 stable 清单（需 OSS_ACCESS_KEY_ID/SECRET）
bash patches/hermes-agent/build-release.sh --upload
```

或走 GitHub Actions：手动触发 `hermes-agent-custom-wheel` workflow。

### 验证

```bash
# 补丁脚本对真实源码应用/回滚（已在真机 0.17.0 验证通过）
python3 patches/hermes-agent/apply_cn_patch.py <checkout>          # apply
python3 patches/hermes-agent/apply_cn_patch.py <checkout> --revert # revert
```

### 发布后的设备行为

- 新装设备：source-deploy 读 `HERMES_AGENT_UPDATE_MANIFEST_URL`
  （`.../hermes-agent/stable/latest.json`）→ 装自定义 wheel。
- 存量设备：下次 Web UI 更新时 `update-source-deploy.sh` 同样从该 manifest 解析版本。
- 建议同时设置 `HERMES_LANGUAGE=zh`（或 config.yaml `display.language: zh`），
  配合 wheel 内完整的官方 zh 目录，覆盖其余已 i18n-化的文案。

### 可选：上游 PR（方案 A）

同一补丁内容（run.py 两处 `t()` 化 + locales 新 key）可直接提给上游
`NousResearch/hermes-agent`，合入后可不再维护 fork 补丁。
