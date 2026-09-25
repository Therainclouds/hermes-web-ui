# 可合并代码块清单（upstream/main → main，2026-09-25）

> 按**代码块粒度**列出，每块给出：上游位置 → 本地落点 → 合并方式 → 成本。
> 前置判断见 `upstream-sync-20260925-triage.md`，功能对照见 `upstream-sync-20260925-feature-diff.md`。

---

## A 类｜直接 cherry-pick（零结构冲突，60 个提交）

筛选口径：改动路径不含 `src/modules/`、`api/studio/`、`controllers/`、`routes/`、`db/`，
且不含品牌字符串。已剔除 release / changelog / 纯文档提交。

### A1 客户端细节修复（38 个）

| 主题 | 提交 |
|---|---|
| 会话 UI 状态保持 | `b9e1dfb19`(#2754) `bcfaacb7b`(#2742) `60b2e5d68`(#2896) |
| 消息引用样式 | `95b4a4153`(#2903) `fd78aeb84`(#2893) |
| 会话操作菜单 / 分类 | `33088f3ef`(#2912) `ada175c21`(#2887) |
| 附件与文件链接预览 | `412ca4846`(#2885) `c63d9a54c`(#2947) `62eb90494` `e992931cc`(#2908) `b37c76dfd`(#2732)* |
| 文件树 | `08fe91c1f`(#2965) |
| TTS 语义符号 / provider | `ef4360d33`(#2945) `ed1354b16`(#2839) |
| 聊天推理显示 | `8a194dc71`(#2723) `bb1cd8343`(#3052) `4aa6d34c4`(#2950) |
| Coding agent 上下文保留 | `a51340535`(#2735) `8dc6d1937`(#2730) `cd4c1347e`(#2728) |
| 群聊移动端对齐 | `3bf90f706`(#2927) |
| Profile / 模型筛选 | `7c64fd24c`(#3142) `d16725ab7`(#3138) `56888de63`(#2755) |
| 技能 / mind 开关 | `acc80a484`(#2933) `32eaed6eb`(#2845) |
| 头像 / 图标 | `d2fbdff18`(#2875) `bcf49d67c` `02395db20`(#2794) |
| 设置与 runtime | `45c55d27d`(#2910) `0ff02c9d6`(#2842) `94ec39fc3`(#2925) `4c87afcbb`(#2780) `4ae23c69b`(#2761) |
| Claude Code 代理 | `068791def`(#2714) |
| App 聊天恢复缓存 | `b8b546145`(#2719) |
| 任务计划位置 | `01606823a`(#3080) |
| 微信绑定说明 | `be0681f31`(#2731) |

> \* `b37c76dfd`(#2732) 需检查是否夹带品牌字样。

### A2 桌面端（10 个）

`239d0d5c5`(#2944) `628246308`(#2949) `df1e56404`(#2956) `66d65e4ae`(#2979) `3be62aba0`(#2981)
`8b4a7cda2`(#2852) `42a7026ed`(#2928) `a13b14d5c`(#2931) `c3c54b970`(#3073) `e7c2c3819`(#2781)

### A3 服务端 / 基础设施（4 个）

`84bb199d3`(#2960 Docker) `a0b344297`(#3006 Docker) `89e1bf7bc`(#2920 MCP Node 模式)
`b6293a11d`(#3096 npm tarball)

### A4 ekko-agent 包内的修复（10 个，随 B1 一并处理更省事）

`4601a323f`(#2812) `ff74f5a84`(#2788) `f1331998a`(#2776) `700036719`(#2777) `c96ae3a55`(#2772)
`d36b3fc53`(#2847) `28ac292cf`(#2849) `9f844962c`(#3081) `46a6cf63b`(#3083) `39b2e4477`(#3030)

---

## B 类｜整包同步（1 块，成本最低）

### B1 `packages/ekko-agent/` — 170 个文件

| 项 | 值 |
|---|---|
| 上游 | `packages/ekko-agent/**` |
| 本地 | 同名，**自分叉以来 0 改动** |
| 方式 | `git checkout upstream/main -- packages/ekko-agent/` |
| 风险 | 需单独核对品牌字符串；上层 `services/ekko-agent/` 不在本块内，不受影响 |

**关键：这块还顺带带来以下能力的主体实现，等于白赚：**

| 能力 | 落在包内的文件 |
|---|---|
| **JEV 核心** | `src/jev/{index,client,config}.ts`、`src/memory/jev-{candidates,filter,policy,recall,rerank,routing}.ts` |
| OpenCode session model | `src/model/opencode-session.ts` |
| Grok 图生视频技能 | `skills/grok-image-to-video/` |

> 所以 JEV 不必单独移植，跟着 B1 走即可，只需补前端那两个文件（见 C4）。

---

## C 类｜手工移植（4 块）

路径需要按本地旧结构改写，**不能 cherry-pick**。

### C1 会话分享与作用域权限 ⭐ 推荐优先

| 上游（`modules/studio/`） | 本地落点 |
|---|---|
| `routes/session-shares.ts` | `packages/server/src/routes/hermes/session-shares.ts` |
| `controllers/session-shares.ts` | `packages/server/src/controllers/session-shares.ts` |
| `contracts/session-shares.ts` | `packages/server/src/shared/session-shares.ts` |
| `repositories/session-shares-store.ts` | `packages/server/src/db/hermes/session-shares-store.ts` |
| `services/session-shares/{service,settings,app-identity,http-access}.ts` | `packages/server/src/services/session-shares/` |

参考提交：`e582cea76`(#3122) `1e1ad5517`(#3123) `0cc8271ed`(#3129) `55a09e297`(#3128)
`32a2fb5a7`(#3121) `6b4513e77`(#3134) `ad24abf62`(#3144) `27544731b`
参考测试：`tests/server/session-share-access.test.ts` 等 4 个可直接搬运。
成本：中。**有本地同构参照**（群聊邀请分享 `SharedGroupChatView.vue`）。

### C2 Grok 编码 Agent

上游 `modules/coding-agents/services/grok/`：
`config.ts` `definition.ts` `event-adapter.ts` `streaming-json.ts` `turn-process.ts`
→ 本地 `packages/server/src/services/coding-agents/grok/`

另需：`packages/client/public/coding-agents/grok.svg`
参考：`17321c152`(#2832) `8b7032795`(#3002) `884d8354c`(#2868) `446415f7c`(#2857) `c42f9825e`(#2870) `b201ac91b`(#2855)
成本：中低（纯新增，5 个文件，不碰存量）。

### C3 OpenCode 编码 Agent

| 上游 | 本地落点 |
|---|---|
| `modules/hermes/services/providers/opencode-free.ts` | `services/hermes/providers/opencode-free.ts` |
| `modules/studio/public/opencode-session.ts` | `services/opencode-session.ts` |
| `modules/studio/contracts/opencode-free.ts` | `shared/opencode-free.ts` |
| `packages/ekko-agent/src/model/opencode-session.ts` | **随 B1 自动带入** |
| `client/public/coding-agents/opencode.png` | 同名 |

参考：`efd63a10f`(#2890) `092e8de60`(#2932) `b44c74318`(#2996) `c62d451a4`(#3010) `2b78b7e1b`(#3005)
测试：`tests/server/opencode-*.test.ts`（5 个）可搬运。
成本：中。

### C4 JEV 前端部分（配合 B1）

| 上游 | 本地落点 |
|---|---|
| `packages/client/src/api/studio/jev.ts` | `packages/client/src/api/hermes/jev.ts` |
| `packages/client/src/components/hermes/models/JevSettingsPanel.vue` | 同名 |

参考：`8295cb439`(#3159) `347005e8a`(#3160) `d9ebfde95`(#3161) `6cbf17f0e`(#3169)
文档：`docs/jev.md`、`docs/harness/jev-integrations.md`、`packages/ekko-agent/docs/{memory,skills}-jev.md`
成本：低（B1 之后只剩这两个前端文件）。

---

## D 类｜拒绝（5 块）

| 块 | 范围 | 原因 |
|---|---|---|
| D1 架构重命名 | `modules/**`、`api/studio/**`、`bootstrap/**` | 本地全部基于旧结构，约 1007 冲突的根源 |
| D2 品牌化 | `91466ab28` `d4d0b9327` `c1918941e` `92822accd`、51 个含 `ekko-studio` 的文件 | 与 Quanthermes 品牌对撞 |
| D3 iOS Live Activities | `e7e4fdd8e` `2ef4c445f` `7be044018` `3d2fe623f` + `services/notifications/live-activity*` | 用户已确认不需要；iOS + APNs 强依赖 |
| D4 消息推送 | `f8f854fa2` `66066fc5b` `f9e002e52` `002fcec16` `85e1f0d52` `133fc71be` `32a2fb5a7` 等 | 用户已确认完全不需要；依赖其 App 连接生态 |
| D5 版本发布 | 15 个 `chore(release)/bump/changelog` | 上游 0.7.x vs 本地 0.8.9，取本地 |

**另需防御**：上游删除的 242 个 `docs/*`（主要是 `chat-chain-changes/`）本地全都有，
不得跟随删除。

---

## 执行顺序建议

```
Step 1  A1+A2+A3  60 个 bugfix cherry-pick     → 低风险，立刻见效
Step 2  B1        ekko-agent 整包同步          → 顺带拿到 JEV 核心
Step 3  C4        JEV 前端两个文件             → 补完 JEV
Step 4  C1        session-shares 移植          → 有本地同构参照
Step 5  C2/C3     Grok / OpenCode              → 纯新增，不碰存量
```

每步之后：`npm run harness:check` + `npm run build`（或单独的类型检查，
见文末备注）+ 相关 Vitest。

> **构建备注**：当前环境下 `npm run build` 会被 IDE 的批量删除守卫拦住
> （`vite:prepare-out-dir` 清空 `dist` 时触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED count:500`）。
> 这是环境问题不是代码问题。可先 `node scripts/clean-dist.mjs` 手动清理，
> 或用 `npx tsc --noEmit -p packages/server/tsconfig.json` + `npx vue-tsc -b` 单独做类型检查。
