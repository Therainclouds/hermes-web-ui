# 上游同步评审 — upstream/main → main（2026-09-25）

> 分析对象：`upstream/main` `9363b9955`
> 本地基线：`main` `0535234f9`（v0.8.9）
> 分叉点（merge-base）：`d2a5cf6ec`
> 上游区间：2026-08-24 → 2026-09-24

---

## 一、结论：这次**不能**走常规的 `git merge upstream/main`

跑过 `git merge-tree` 内存演练：

```
2071 files changed, +158076 / -30104
冲突文件：~1007 个
```

三个阻断因素 + 一个隐性风险，决定了这次必须是**挑拣式同步**（cherry-pick / 文件级移植），
而不是 runbook 里的标准 `merge --no-ff`。

### 阻断 1 — 上游做了一次架构重命名（8/26，#2744 `refactor: enforce canonical server module ownership`）

上游把服务端扁平目录收编成模块域：

```
上游（新）                              本地（旧，仍是）
packages/server/src/
  modules/hermes/          ←────────   services/ + controllers/ + routes/
  modules/studio/                        db/ + middleware/ + lib/
  modules/ekko/                          shared/ + utils/
  modules/coding-agents/                 config.ts + security.ts
  bootstrap/
```

客户端同样做了命名空间迁移：
`packages/client/src/api/hermes/*` → `packages/client/src/api/studio/*`（约 60 个文件，R087–R100）。

冲突几乎全部堆在这里：`modules` 218 + `services` 135 + `controllers` 19 + `routes` 13 + `db` 6。
本地 828 个独有提交全部基于旧结构，合进来等于把服务端重写一遍。

### 阻断 2 — 上游把自己品牌化成了 **Ekko Studio**，与本地品牌直接对撞

| 提交 | 内容 |
|---|---|
| `91466ab28` (9/8) | `feat: rebrand Studio as Ekko Studio and migrate MCP names (#2966)` |
| `d4d0b9327` (9/9) | `feat(branding): unify Ekko CLI and domains, round desktop icons (#2980)` |
| `c1918941e` (9/10) | `fix(desktop): repair MCP and Windows startup across Ekko rename (#2988)` |
| `92822accd` (9/22) | `chore: point Studio repository references to ekko-studio (#3147)` |

上游 `package.json` 的 `name` 已是 **`ekko-studio`**；全仓 **51 个文件**含 `ekko-studio`、**22 个**含 `EKKOLearnAI`。

本地是 `@quanthermes/hermes-web-ui` / `tangledup-ai` / Quanthermes OSS。**这一组提交一个都不能进**——
正是你说的"两边都做了品牌化"。

### 阻断 3 — 版本线已经分叉

上游 `0.7.24`，本地 `0.8.9`。上游 15 个 `chore(release)/bump/changelog` 提交全部跳过；
按 `upstream-merge-rules.md`，版本号取本地。

### 隐性风险 — 上游删了 242 个文档，本地全都有

上游删除的 `docs/*` 有 **242 个**，与本地现存文件**完全重叠**（主要是 `docs/chat-chain-changes/`）。
全量 merge 会把它们删掉——而 `AGENTS.md` 明确要求 chat/bridge/compression/group-chat 改动必须留 fragment 文档。
**挑拣式同步顺带规避了这个坑**，但如果哪天走 merge，必须先保护这批文件。

---

## 二、好消息

| 检查项 | 结果 |
|---|---|
| 上游是否触碰 LOCKED 保护文件（device-package 系列 / install-device-package.sh / update-runner / bots/usb） | **没有** ✅ |
| 上游是否删除本地独有的 `client/src/plugins/`、`client/src/audio/`、`packages/website/` | **没有** ✅ |
| `packages/ekko-agent/` 本地自分叉以来的改动 | **0 个文件** ✅ |

最后一条是关键机会：本地的 `packages/ekko-agent` 是原封不动带过来的，而上游这一个月改了其中 **170 个文件**。
这是唯一可以**整块同步**的大面积区域。

---

## 三、上游这一个月做了什么（按主题）

| 主题 | 规模 | 代表 PR | 本地相关性 |
|---|---|---|---|
| **Ekko Agent 运行时整合** | 最大，170 文件 | #2752 #2770 #2772 #2775 #2785 #2846 #2952 #3053 | 高（本地零改动，可整包同步） |
| **Coding agents 扩展** | 大 | Grok #2832、OpenCode #2890/#2932、DSH #3020/#3026/#3038、全局隔离模式 #2828、Skills/MCP 视图统一 #2871 | 中（部分可移植） |
| **推送通知 / iOS Live Activities** | 中 | #2718 #2940 #3111 #3127 #3131 #3146 #3151 #3152 #3167 | 低—中（取决于本地是否保留 App 推送） |
| **会话分享与作用域权限** | 中 | #3121 #3122 #3123 #3128 #3129 #3134 #3144 | 中（安全相关，值得看） |
| **JEV（技能匹配 / 记忆召回 / 学习评估）** | 中，全新 | #3159 #3160 #3161 #3169 #3171 | 待评估 |
| **UI 细节修复** | 多且碎 | 折叠状态保持、附件预览、文件链接预览、会话分页、TTS 语义符号、runtime 故障恢复 | **高（性价比最高）** |
| **桌面端修复** | 中 | #2944 #2949 #2956 #2979 #2981 #2852 #3008 | 中 |
| **品牌化 / 重命名** | — | #2966 #2980 #2988 #3147 | ❌ 拒绝 |
| **架构重构** | — | #2744 | ❌ 拒绝 |
| **版本发布** | 15 个 | 0.7.11 → 0.7.24 | ❌ 拒绝 |

---

## 四、建议的分层处理策略

```
L1  整包同步    packages/ekko-agent/          ← 本地零改动，最干净
L2  cherry-pick 不碰重构路径的纯 bugfix        ← 性价比最高，见下方清单
L3  手工移植    有价值的新功能（改成旧结构）    ← Grok/OpenCode、分享权限、部分 JEV
L4  拒绝        品牌化、#2744 重构、release/changelog
```

### 筛选口径

对 226 个提交按改动路径打标：

| 标记 | 含义 | 数量 |
|---|---|---|
| R | 触及 `src/modules/`、`api/studio/`、`controllers/`、`routes/`、`db/` | 137 |
| E | 触及 `packages/ekko-agent/` | 36 |
| B | 触及品牌字符串 / electron-builder | 8 |
| —（不碰重构且无品牌） | **可 cherry-pick 候选** | **88** |

88 个候选里再剔除 release/changelog/docs，得到约 **60 个真 bugfix / 小功能**。

---

## 五、L2 候选 cherry-pick 清单

> `[E]` = 触及 `packages/ekko-agent/`，建议归入 L1 整包同步一并处理。
> 全部**未**触及重构路径，理论上可 `git cherry-pick`，但仍需逐个验证是否夹带品牌字样。

### 客户端 / 通用

| 提交 | 主题 |
|---|---|
| `7c64fd24c` | `[codex] Filter model settings by page-selected Profile (#3142)` |
| `d16725ab7` | `fix models page Hermes scope labels (#3138)` |
| `01606823a` | `fix(chat): keep task plans at the end of each turn (#3080)` |
| `bb1cd8343` | `fix(chat): show agent logos in thinking indicators (#3052)` |
| `08fe91c1f` | `feat(files): add gapless workspace tree collapse (#2965)` |
| `4aa6d34c4` | `fix(chat): skip thinking blocks in speech (#2950)` |
| `c63d9a54c` | `fix(chat): preview file links at referenced lines (#2947)` |
| `ef4360d33` | `fix(tts): preserve semantic symbols in speech text (#2945)` |
| `acc80a484` | `fix: restore skill enable switches by default (#2933)` |
| `3bf90f706` | `[codex] align group chat tool folding and mobile layout with single chat (#2927)` |
| `94ec39fc3` | `fix: stop idle Runtime polling and restrict it to super admins (#2925)` |
| `33088f3ef` | `[verified] feat: consolidate session action menus (#2912)` |
| `45c55d27d` | `add cross-platform settings shortcut (#2910)` |
| `e992931cc` | `[verified] fix(files): render workspace Markdown previews (#2908)` |
| `62eb90494` | `[verified] fix(chat): preview code-styled local file links` |
| `95b4a4153` | `fix: restore reply arrow for message references (#2903)` |
| `60b2e5d68` | `fix: preserve session category collapse during refresh (#2896)` |
| `fd78aeb84` | `[verified] fix(chat): use quote icon for message references (#2893)` |
| `ada175c21` | `feat: create categories from the session move menu (#2887)` |
| `412ca4846` | `fix: preview uploaded images before sending (#2885)` |
| `d2fbdff18` | `replace generated avatars with Boring Avatars (#2875)` |
| `32eaed6eb` | `fix(skills): encode reserved path characters (#2845)` |
| `ed1354b16` | `fix(tts): hydrate active provider on startup (#2839)` |
| `0ff02c9d6` | `fix(runtime): persist handled restart prompts (#2842)` |
| `56888de63` | `fix: show profile and agent identities in chats (#2755)` |
| `b9e1dfb19` | `fix(chat): preserve Recent collapse across refresh (#2754)` |
| `bcfaacb7b` | `fix(chat): preserve category collapse from Recent (#2742)` |
| `a51340535` | `[codex] preserve global coding agent context after stop (#2735)` |
| `8dc6d1937` | `fix(chat): preserve tool calls across coding agent runs (#2730)` |
| `cd4c1347e` | `[codex] hide global Coding Agent reasoning effort control (#2728)` |
| `8a194dc71` | `fix(chat): preserve thinking elapsed time across navigation (#2723)` |
| `b8b546145` | `add conditional App chat resume cache (#2719)` |
| `068791def` | `fix(claude-code-proxy): merge multiple system messages into one leading message (#2714)` |
| `be0681f31` | `clarify Weixin notification binding limits (#2731)` |
| `4c87afcbb` | `fix Studio settings and agent management flows (#2780)` |
| `4ae23c69b` | `fix agent manager status loading (#2761)` |
| `bcf49d67c` | `fix: use supplied OpenCode icon across Studio` |
| `02395db20` | `fix: remove border from Ekko agent logo (#2794)` |

### 桌面端

| 提交 | 主题 |
|---|---|
| `3be62aba0` | `style(desktop): reduce Windows icon corner radius (#2981)` |
| `66d65e4ae` | `fix(desktop): preserve Chromium profile across app rename (#2979)` |
| `df1e56404` | `fix(desktop): reveal browser panel before page load (#2956)` |
| `a13b14d5c` | `[codex] fix MCP-triggered Desktop restart loops and orphaned Web UI startup (#2931)` |
| `628246308` | `fix(desktop): support deleting and undoing browser annotations (#2949)` |
| `239d0d5c5` | `fix(desktop): guard browser debugger cleanup (#2944)` |
| `42a7026ed` | `feat(desktop): configure Markdown link opening target (#2928)` |
| `8b4a7cda2` | `fix(desktop): let tray quit cancel pending relaunch (#2852)` |
| `c3c54b970` | `fix: validate Hermes runtime browser bundles and preserve desktop latest (#3073)` |
| `e7c2c3819` | `[codex] default desktop runtime to Hermes 0.20.6 (#2781)` |

### 服务端 / 基础设施小修

| 提交 | 主题 |
|---|---|
| `b6293a11d` | `fix: publish npm release tarballs as local files (#3096)` |
| `84bb199d3` | `fix(docker): keep optional Hermes patches from blocking startup (#2960)` |
| `a0b344297` | `fix Docker coding agent installation persistence (#3006)` |
| `89e1bf7bc` | `chore: enforce Node mode in managed MCP launch harness (#2920)` |

### `[E]` ekko-agent 包（建议 L1 整包同步）

`46a6cf63b`(#3083) · `9f844962c`(#3081) · `39b2e4477`(#3030) · `28ac292cf`(#2849) ·
`d36b3fc53`(#2847) · `4601a323f`(#2812) · `ff74f5a84`(#2788) · `700036719`(#2777) ·
`f1331998a`(#2776) · `c96ae3a55`(#2772)

---

## 六、执行方式建议

```bash
# 1. 建同步分支（沿用 runbook 命名，不走 integration/rebuild-from-upstream）
git checkout -b merge/upstream-main-20260925

# 2. 按上面的清单分批 cherry-pick（建议按主题分批，每批后跑一次校验）
git cherry-pick <hash>...

# 3. 每批之后
npm run harness:check
npm run build

# 4. L1 ekko-agent 整包（可选，单独一个提交，便于回滚）
git checkout upstream/main -- packages/ekko-agent/
```

### 挑拣时必须盯的两件事

1. **品牌残留**——即便是 bugfix 也可能夹带 "Ekko Chat" / "across Studio" 字样
   （如 #3030、#2761、#2794、`bcf49d67c`）。按 `upstream-merge-rules.md` 必检项：

   ```bash
   git grep -n -i 'ekko-studio\|EKKOLearnAI' -- packages scripts bin .github
   ```

2. **脚本 `+x` 位**——若挑中的提交改动/新增 `scripts/*.sh` 或带 shebang 的 `.py`，
   Windows 上必须 `git update-index --chmod=+x`，并用
   `git ls-tree HEAD -- scripts/` 确认每行是 `100755`。

3. **`getWebUiHome()`**——新增的有状态 service 必须走它，不能直读 env 或 `process.cwd()` 兜底。

---

## 七、需要你拍板的问题

1. **`packages/ekko-agent` 要不要整包跟上？** 本地零改动、上游 170 文件改动，是最干净的一块；
   但它现在是上游 Ekko 品牌的组成部分，需确认里面有没有品牌字符串（`f1331998a` 这类 dev-data 隔离要重点看）。
2. **推送 / Live Activities / 会话分享权限这一组要不要？** 它们大多落在重构后的 `modules/` 路径，
   只能手工移植，成本较高。需要你判断本地产品是否还需要这套 App 推送能力。
3. **JEV（#3159–#3171）要不要？** 全新模块，上游自己也在规划中（最后一个提交还是 docs plan）。
4. **Grok / OpenCode coding agent 要不要？** 纯新增能力，移植成本中等。
5. 若确认走挑拣路线，**是否接受"本地永久放弃跟随上游结构"**——即后续同步都只能 cherry-pick，
   因为两边目录结构已经不可逆地分叉了。这一点建议写进 `upstream-merge-rules.md`。
