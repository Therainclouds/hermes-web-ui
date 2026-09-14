# Hermes Agent 中文本地化 —— 需求评估纪要

> 状态：调研完成（代码库核查 ✅ + 真机核查 ✅ root@6.6.6.49，待实施决策）
> 日期：2026-08-12
> 输入文档：`C:\Users\DELL\Downloads\hermes-agent-cn-localization.md`（需求 & 实施方案）
> 结论先行：需求合理，但**方案原样不可行**——核心注入机制（`PYTHONSTARTUP`）对非交互式进程不生效；且 hermes-agent 更新不锁版本，文档锁定的 v0.15.2 已过期。真机 0.17.0 上发现**官方 i18n 机制**（`agent/i18n.py` + `HERMES_BUNDLED_LOCALES`），是比 monkey-patch 更稳的正统路径，但两处目标文案尚未被国际化，需配合推动上游或做内容锚定 patch。详见下文。

---

## 1. 需求概要

不 fork `hermes-agent`（pip 包）的前提下，为飞书/微信 bot 用户提供中文交互，共 3 处：

1. 配对码提示（`gateway/run.py`，首次绑定）
2. Home Channel 设置提示（`gateway/run.py`，配对成功后）
3. Slash Command 中文别名（`/新会话`→`/new`、`/设为主频道`→`/sethome`、`/停止`→`/stop`、`/帮助`→`/help`）

输入文档推荐 C 路线（运行时 monkey-patch），经 `PYTHONSTARTUP` 环境变量注入 patch 模块。

## 2. 代码库核查结论（G:\AIproject\longxia_keli\hermes-web-ui）

### 2.1 更新机制：hermes-agent 不锁版本（关键前提）

| 更新路径 | 机制 | 版本策略 | 来源 |
|---|---|---|---|
| npm-package 策略 | `packages/server/src/services/update/strategies/npm-package.ts:102` 执行 `python -m pip install --upgrade hermes-agent` | **无锁，拉最新版** | PyPI 默认 index |
| source-deploy 策略 | `scripts/deploy-source-armbian.sh:497-610` 解析 PyPI latest stable wheel；优先 OSS 更新清单 | 优先 OSS 人工固定版本（`hermes-agent/stable/latest.json`，由 `.github/workflows/hermes-agent-oss-mirror.yml` 维护）；不可达回退 **PyPI 最新 stable** | PyPI + 阿里云 OSS（`tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/`） |
| 桌面 runtime | `packages/server/src/services/runtime-version-manager.ts` 按版本下载运行时包 | **构建时锁定**：`packages/desktop/scripts/runtime-config.mjs:1` `DEFAULT_HERMES_VERSION = '0.20.0'`，源码 `github.com/NousResearch/hermes-agent.git` @ `v2026.8.3` commit `3c27eb6…`（`packages/desktop/build/runtime-release.json`） | GitHub Releases（`tangledup-ai/hermes-web-ui`）+ OSS `versions.json` |

**含义**：npm / source-deploy 两条路径每次更新都移动 hermes-agent 版本，任何针对特定版本的 patch 都会被下一版冲掉；桌面 runtime 版本由发布时锁定但也会前进（0.15.2 → 0.20.0）。

### 2.2 注入机制：`PYTHONSTARTUP` 不适用（已实证）

`PYTHONSTARTUP` 的 Python 语义是**仅交互式模式**执行（`python -c`、`python script.py`、`python -m …` 均不触发）。

本机 Python 3.12 实测（2026-08-12）：

| 注入方式 | `python -c "..."` | `python script.py` |
|---|---|---|
| `PYTHONSTARTUP=<file>` | ❌ 未执行 | ❌ 未执行 |
| `PYTHONPATH=<dir>`（dir 内放 `sitecustomize.py`） | ✅ 执行 | ✅ 执行 |

gateway 进程经 `packages/server/src/services/hermes/gateway-runner.ts:336` 以 `spawnHermesWithBin(hermesBin, ['gateway', 'run', '--replace'])` 拉起，Linux 侧是非交互式 `hermes` 可执行文件（Python 入口脚本），**不是交互式进程** → `PYTHONSTARTUP` 永远不会执行。

**修正方案**：patch 模块改为 `sitecustomize.py`（或 `sitecustomize.py` 内 import 业务 patch 模块），service 注入 `Environment=PYTHONPATH=/opt/hermes-web-ui/patches`。`sitecustomize` 是 Python 启动时 `site` 模块自动 import 的标准钩子，交互/非交互均生效，且同样可整行回滚。

### 2.3 版本漂移

输入文档锁定 v0.15.2 并引用具体行号（`gateway/run.py:6850/8732`、`hermes_cli/commands.py:46/64/230/243/482/1020`）。当前桌面 runtime 默认已是 **0.20.0**，行号引用已过期。patch 必须**按字符串内容匹配**而非行号，且每次 hermes-agent 升级后需重验。

## 3. 稳定性与运维成本评估

- **稳定性（按输入文档原样）：不可行**。机制零覆盖率 + 依赖内部实现 + try/except 静默失败（patch 失效时无任何告警，用户静默回到英文）。
- **修正后的稳定性**：别名 patch（`CommandDef.aliases` 数据结构）相对稳定；两个提示文案 patch 仍依赖上游内部字符串，属脆弱项。
- **运维成本：中偏高且持续**。hermes-agent 是移动靶，每次上游发版需人工重验；本仓库无针对实际安装版本的测试，验证只能在真机用飞书/微信测试。
- **降本手段**：① 按内容匹配不按行号；② 加自检（patch 生效后校验 `resolve_command('/新会话')` 等，失败打可检索 warning）；③ 把自检挂进 hermes-agent 升级流程做冒烟。

## 4. 真机核查结果（root@6.6.6.49，2026-08-12）

### 4.1 环境事实

- 设备：Armbian 26.02 (RK35xx aarch64)，source-deploy 部署于 `/opt/hermes-web-ui`
- **hermes-agent 实际版本：0.17.0**（`site-packages/hermes_agent-0.17.0.dist-info`），装在 `/home/hermesui/.hermes/hermes-agent-venv/`；当前 wheel 通过 `/etc/default/hermes-web-ui` 的 `HERMES_AGENT_WHEEL_URL` 锁定（files.pythonhosted.org 的 0.17.0 wheel）
- 更新策略：`WEBUI_UPDATE_STRATEGY=source-deploy` + `update-source-deploy.sh` → 每次更新解析 PyPI latest stable / OSS 清单，**hermes-agent 版本随更新移动**（确认 2.1 的结论）
- gateway 启动方式：`python3 /home/hermesui/.local/bin/hermes gateway run --replace`（**非交互式**，确认 `PYTHONSTARTUP` 无效）；node 侧 spawn env = `{...process.env, HERMES_HOME}`，`/etc/default/hermes-web-ui` 的环境变量可直达 gateway 子进程
- 当前配置：`hermes_data/config.yaml:216` `display.language: en`；无 `~/.hermes/hooks/` 目录（官方 hooks 未启用）

### 4.2 三处 patch 目标在 0.17.0 的实际位置（与文档 0.15.2 行号全部对不上）

| 目标 | 文档(0.15.2) | 实际(0.17.0) | 说明 |
|---|---|---|---|
| 配对码文案 | `run.py:6850` | `run.py:7243`，位于 **`_handle_message`**（7145）内 | 内联 f-string，直接 `adapter.send`，无汇聚点 |
| home channel 文案 | `run.py:8732` | `run.py:9306`，位于 `_handle_message_with_agent`（8697）内 | 文案经 **`_deliver_platform_notice`**（7114，紧凑小方法）投递 ← 单点 patch 位 |
| 命令注册表 | `commands.py:46/64/230/243` | `CommandDef`(46)、`COMMAND_REGISTRY`(64)、`_build_command_lookup`(245)、`resolve_command`(258) | `_COMMAND_LOOKUP` import 时一次性构建；**0.17.0 无 `rebuild_lookups()` 函数**（注释过时） |

### 4.3 官方机制核查（重要）

1. **`agent/i18n.py` —— 官方 i18n，支持 zh**
   - 语言解析：`HERMES_LANGUAGE` env → `display.language` config → `"en"`；支持 zh/zh-hant/ja/…共 16 种
   - **`HERMES_BUNDLED_LOCALES` 环境变量**可覆盖目录（官方注释明确写给"sealed-packaging 系统"用）
   - 缺失 key 回退英文、再缺失回退 key 路径，永不崩溃
   - **现状限制**：wheel 0.17.0 **未携带 `locales/` 目录**（`find` 无结果）；当前 i18n scope 仅"approval prompts、少量 gateway slash 回复、restart-drain 通知"——**配对/home 两处文案尚未用 `t()` 包装**，i18n 目前覆盖不到
2. **Hook 系统**（`~/.hermes/hooks/`，`HOOK.yaml` + `handler.py`，事件含 `command:*`）：官方但**纯追加式**（fire-and-forget，不阻断主流程），不能替换内置文案、不能加别名
3. **`display_config.py`**：显示/verbosity 配置，与文案无关

### 4.4 别名 patch 可行性验证（0.17.0 实测通过）

`CommandDef` 是 dataclass（`aliases` 字段不可直接赋值，需 `object.__setattr__`），且改完必须重建 `_COMMAND_LOOKUP`：

```python
import hermes_cli.commands as C
for name, aliases in [("new", ("新会话", "新对话")), ("sethome", ("设为主频道",))]:
    cmd = C.resolve_command(name)
    object.__setattr__(cmd, "aliases", tuple(dict.fromkeys(cmd.aliases + aliases)))
C._COMMAND_LOOKUP = C._build_command_lookup()   # 关键：不重建则 resolve 仍查旧缓存
```

实测 `resolve_command("/新会话") → new`、`resolve_command("设为主频道") → sethome` ✅

## 5. 落地建议

### 5.1 注入机制（已验证）

- 用 **`sitecustomize.py` + `PYTHONPATH`**（`sitecustomize` 是 Python 启动标准钩子，非交互进程生效，2.2 节实测），**弃用 `PYTHONSTARTUP`**
- 注入点：`/etc/default/hermes-web-ui`（已是 service 的 `EnvironmentFile`，node → gateway 子进程环境变量链路已验证）或 systemd 模板
- patch 模块放 `/opt/hermes-web-ui/patches/`，全量 `try/except` 兜底 + **自检**（校验 `resolve_command("新会话")` 非空、校验 `_deliver_platform_notice` 已包装，失败打可检索 warning）

### 5.2 按稳定性排序的方案

| 方案 | 覆盖 | 稳定性 | 成本 |
|---|---|---|---|
| **D. 自维护 wheel（推荐长期）**：fork hermes-agent，维护一个小补丁（把两处文案 i18n-ify 或直接改文案 + zh 目录），`pip wheel` 构建后走**已有的** `hermes-agent-oss-mirror.yml` 工作流上传 OSS wheelhouse + 更新 `stable/latest.json`；source-deploy 从 OSS 清单拉取（设备 env 已配 `HERMES_AGENT_WHEELHOUSE_URL` / `HERMES_AGENT_UPDATE_MANIFEST_URL`） | 全覆盖（不止 3 处，后续 /help、错误消息等都可扩展） | 高（无运行时脆弱性，补丁 rebase 通常微小） | 中（需维护 fork + 构建 CI；每次上游发版 rebase 小补丁并重发 wheel） |
| **A. 上游 i18n-ify（PR 贡献）**：把两处文案改成 `t()` key 并提交 zh 翻译；本地用 `HERMES_BUNDLED_LOCALES` + `HERMES_LANGUAGE=zh` | 3 处全覆盖 | 最高（官方机制） | 低（但依赖上游合入，周期不可控；**无需加入团队，开源 PR 即可**） |
| **B. 本地 sitecustomize monkey-patch**：别名（4.4 已验证）+ home channel（包装 `_deliver_platform_notice`，内容锚定）+ 配对（内容锚定） | 3 处全覆盖 | 中（依赖上游内部结构，升级需重验 + 自检兜底） | 每次 hermes-agent 升级重验 |
| **C. 折中（推荐短期落地）**：别名用 B（数据结构，最稳），两处文案推 A/D；`HERMES_LANGUAGE=zh` + 自建 locales 目录先行启用官方 i18n 覆盖的其余文案 | 别名立即可用 | 中高 | 中等 |

> **D 的关键依据**：设备 env 已有 `HERMES_AGENT_WHEEL_URL`（当前锁 0.17.0）、`HERMES_AGENT_WHEELHOUSE_URL`（自家 OSS）、`HERMES_AGENT_UPDATE_MANIFEST_URL`（自家 OSS `stable/latest.json`）；`hermes-agent-oss-mirror.yml` 的 `wheel_url` 输入是任意 URL（可指向自建 wheel）。即"构建自定义 hermes-agent wheel 并分发"的基础设施**已全部就绪**，source-deploy 会优先从 OSS 清单取版本——还顺带获得**受控发布**（先验证再翻 manifest）。

### 5.3 明确的不建议项

- 不改 site-packages 源码（`HERMES_BUNDLED_LOCALES` 即为此设计的官方通道，避免 B 路线 .patch 重打的运维负担）
- 不整体包装 `_handle_message` / `_handle_message_with_agent`（方法巨大，风险高）；配对文案宁可内容锚定包装 adapter `send`（校验 `"Here's your pairing code:" in text`）或等价汇聚点

### 5.4 落地文件与验证状态（2026-08-12）

**方案 C（`patches/`）—— 真机 0.17.0 已全部 PASS**

| 文件 | 说明 |
|---|---|
| `patches/hermes_cn_localization.py` | 别名 patch（改 aliases + 重建 `_COMMAND_LOOKUP`）+ 内容锚定文案翻译（包装 `FeishuAdapter.send` / `WeixinAdapter.send` / `BasePlatformAdapter.send` / `send_private_notice`）+ `verify()` 自检 |
| `patches/sitecustomize.py` | Python 启动钩子（经 `PYTHONPATH` 注入，替代不可用的 `PYTHONSTARTUP`） |
| `patches/selfcheck.py` | 设备自检脚本 |

安装：`/etc/default/hermes-web-ui` 追加 `PYTHONPATH=/opt/hermes-web-ui/patches` + `HERMES_LANGUAGE=zh`，重启 hermes-web-ui（详见 `patches/README.md`）。
验证：`patches/selfcheck.py` 在真机 0.17.0 上 4 个别名 + 4 个包装点 + 2 个翻译函数 **ALL PASS**；本地 0.18.2 上别名/包装/翻译 PASS（feishu 模块未打包，优雅降级为 WARN）。

**方案 D（`patches/hermes-agent/`）—— 补丁脚本在真机 0.17.0 真实源码上验证通过**

| 文件 | 说明 |
|---|---|
| `patches/hermes-agent/apply_cn_patch.py` | 对上游 checkout：run.py 两处文案 → `t("pairing.code_prompt"` / `t("gateway.no_home_channel"`（run.py 第 56 行已有 `from agent.i18n import t`，无需加 import）+ locales/en|zh.yaml 各加 2 个 key；精确替换 + 计数校验 + py_compile；`--revert` 可回滚 |
| `patches/hermes-agent/build-release.sh` | clone 上游 tag（默认 `v2026.6.19`==0.17.0）→ 打补丁 → `pip wheel` → 校验 wheel 内容 → 可选上传 OSS + 更新 `stable/latest.json` |
| `.github/workflows/hermes-agent-custom-wheel.yml` | CI 草案：构建 + 上传 OSS + 更新 manifest（复用 `hermes-agent-oss-mirror.yml` 的 ossutil/secrets 模式） |

验证：对真机 0.17.0 的 `gateway/run.py`（17555 行）与 `locales/`（venv `data` scheme 下，非 site-packages）做 apply → 两处 t() 化成功、en/zh.yaml 插入成功、py_compile OK → revert 完美还原。
发布后设备行为：source-deploy 从 `HERMES_AGENT_UPDATE_MANIFEST_URL` 拉取（受控发布），配合 `HERMES_LANGUAGE=zh` 覆盖其余已 i18n-化文案。

## 6. 验收清单（设备）

- [ ] `display.language: zh` 或 `HERMES_LANGUAGE=zh` 生效（官方 i18n 覆盖的文案变中文）
- [ ] `HERMES_BUNDLED_LOCALES` 指向的目录含 `zh.yaml`（若走方案 A/C）
- [ ] 别名自检：`resolve_command("新会话")` / `resolve_command("设为主频道")` 非空
- [ ] 未配对飞书/微信账号 → 中文配对提示；配对后 → 中文 home channel 提示
- [ ] 每次 hermes-agent 升级后冒烟：自检项 + 真机文案抽查

## 7. 参考

- 输入文档：`C:\Users\DELL\Downloads\hermes-agent-cn-localization.md`
- 更新机制：`npm-package.ts`、`deploy-source-armbian.sh`、`runtime-version-manager.ts`、`desktop-runtime.yml`、`hermes-agent-oss-mirror.yml`
- 进程拉起：`gateway-runner.ts`、`hermes-process.ts`
- 真机源码（0.17.0）：`/home/hermesui/.hermes/hermes-agent-venv/lib/python3.12/site-packages/{gateway/run.py, gateway/display_config.py, gateway/hooks.py, hermes_cli/commands.py, agent/i18n.py}`
