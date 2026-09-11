# ADR-0006：专家系统集成首轮联调问题修复与后续约束

## 状态

已接受

## 日期

2026-06-25

## 背景

ADR-0005 已经把"专家 = profile"的集成方案定下。本轮联调发现：**安装专家并点击"立即聊天"后，前端 UI 与实际底层 profile 状态出现多处不同步**。从用户视角看是一个症状，但实际涉及 8 个独立根因，必须分别处理且不能让前一个修复制造新问题。

## 决策概览

| 编号 | 根因 | 修复 |
|------|------|------|
| F-01 | `PUT /api/hermes/profiles/active` 挂了 `requireSuperAdmin` | 新增 `POST /api/hermes/experts/activate-profile`（不挂 super admin） |
| F-02 | `removeExpertProfile` 只调 `hermes profile delete`，目录残留 | CLI 删除 + `fs.rm` 目录兜底 |
| F-03 | `getProfileDir()` 在 profile 目录不存在时回退返回 `hermesBase` | `create-from-expert-package.ts` 用 `detectHermesRootHome()` 独立构造 `profileDir()` |
| F-04 | `updateConfigYamlForProfile` 在 `expert` profile 目录初次创建场景下未真正写入 config.yaml | 改用 `fs.writeFile + js-yaml.dump` 直接写 |
| F-05 | `buildAvailableForProfile` 用 `envHasValue(apiKeyEnv)` 判定 provider 可用 | `copyModelFromActiveProfile` 同时复制 default 的 `.env` 到 expert profile |
| F-06 | `ChatView.onMounted → loadSessions` 整体替换 `sessions.value`，覆盖本地新 session | 新增 `POST /api/hermes/sessions`，前端 `newChatWithRemoteCreate` 先 await server 落库再跳转 |
| F-07 | `chatStore.addMessage` 未在 store 返回对象中 export | 添加到 return |
| F-08 | 前端 `appStore.profileModelGroups` 有 30s 缓存，专家安装后不同步 | `handleStartChat` 调 `appStore.reloadModels({ preserveSelection: true })` |

## 关键细节

### F-03：`getProfileDir` 兜底陷阱

`getProfileDir()` 源码在 profile 目录不存在时回退返回 `hermesBase`（默认 profile 根目录），并用 `pathExists(hermesBase)` 检查——这个检查**永远为 true**。结果：

```
createExpertProfile(name)
  → getProfileDir(name)          → hermesBase (兜底)
  → pathExists(hermesBase)       → true
  → createProfile(name)          → 永远不会被调用
  → 后续 writeFile 写到 hermesBase/ → 写入 default profile 目录
```

**结论**：调用 `getProfileDir` 来"判断是否需要创建 profile"是错的，因为它的兜底返回值让判断逻辑失效。所有"创建 + 写入"路径必须用独立构造的 profileDir。

### F-04 + F-05：写入路径 + 凭据复制

`updateConfigYamlForProfile` 链路在 expert profile 这种"目录刚被 `hermes profile create` 初始化"的场景下表现不可靠——server log 显示 `done: copied` 但磁盘上 `config.yaml` 仍然不存在。

修复采用最小依赖路径：

```ts
// create-from-expert-package.ts
const configPath = join(detectHermesRootHome(), 'profiles', targetProfile, 'config.yaml')
const existing = (await readYaml(configPath)) ?? {}
existing.model = { ...existing.model, default: defaultModel, provider: defaultProvider }
const yamlStr = yaml.dump(existing, { lineWidth: -1, noRefs: true })
await fs.mkdir(dirname(configPath), { recursive: true })
await fs.writeFile(configPath, yamlStr, 'utf-8')

// 关键：还要复制 .env（API key）！
const defaultEnvPath = join(getProfileDir('default'), '.env')
const targetEnvPath = join(dirname(configPath), '.env')
await fs.writeFile(targetEnvPath, await fs.readFile(defaultEnvPath, 'utf-8'), 'utf-8')
```

**`getProfileDir('default')` 返回 `hermesBase` 而非 `profiles/default`**——这是个非显然的语义。Windows 下的 `hermesBase` 默认是 `C:\Users\<user>\AppData\Local\hermes`。

### F-06：ChatView 覆盖本地 session

`loadSessions` 实现：

```ts
sessions.value = fresh   // 整体替换，本地新建的 session 消失
```

导致"立即聊天"→ `newChat` 本地创建 session → 路由跳到 `hermes.chat` → `ChatView.onMounted` → `loadRouteSession` → `loadSessions` → 整体替换 → 本地 session 消失 → 聊天框"闪退"。

修复要求**新建 session 先在 server 端落库**，再让 `loadSessions` 自然包含它。增加了 `POST /api/hermes/sessions` controller（可指定 id）和前端 `newChatWithRemoteCreate` store action。

### F-08：前端缓存 30s

`appStore.loadModels` 用 30s TTL 缓存 `/api/hermes/available-models` 响应。安装新专家时，expert profile 还没在 cache 中 → groups 为空 → 显示警告。

修复：`handleStartChat` 在切到 expert profile 后强制 `appStore.reloadModels({ preserveSelection: true })` 刷新一次。

## 衍生问题（Q1/Q2/Q3 之外）

| 编号 | 问题 | 修复 |
|------|------|------|
| D-01 | 专家 profile 名称 `expert_content-strategist` 对用户不友好 | `writeMarker` 写入 `display_name`；`listProfilesFromDisk` 读取填充 `alias`；`ProfileCard` 优先显示 alias |
| D-02 | `ExpertsView.handleRefresh` 无 try/catch | 加 catch + i18n key `experts.refreshFailed` |
| D-03 | `copyModelFromActiveProfile` 内部变量重复声明 `modelSection` | 重命名为 `existingModelSection` |
| D-04 | `import { PROVIDER_PRESETS } from '../../shared/providers'` 路径错误 | 改为 `'../../../shared/providers'`（3 个 `..`） |

## 后续约束

1. **创建专家 profile 的代码必须独立构造 `profileDir`，禁止再用 `getProfileDir` 判存在**
2. **凡是涉及"先创建 profile 再写 model"必须同时复制 `.env`**，否则 `buildAvailableForProfile` 的 `envHasValue` 判定会让所有 provider 落空
3. **`newChat` 创建本地 session 后必须 `await` server 落库**，再触发任何会调用 `loadSessions` 的路径
4. **专家系统所有接口不再走 `requireSuperAdmin` 中间件**——activate-profile 用独立路由保证普通用户可用
5. **新增 `addMessage` 等 store action 必须显式 export**，避免"看上去存在但调用报错"
6. **修复路径文件**应当使用**fs.writeFile + js-yaml.dump**，不走 `safeFileStore.updateYaml`（其在新建场景表现不可靠）

## 影响

### 正面影响

- 专家系统可端到端走通：浏览→安装→立即聊天→看到自我介绍→继续对话
- 专家 profile 名称对用户友好
- 卸载专家时彻底清理（含目录 + DB 记录）
- 聊天列表与 session 持久化路径稳定

### 代价

- 创建专家 profile 时需要从 default 复制 `.env`（凭据复制是必要的副作用，复制的是同一台机器上的同一份 .env，不跨账户）
- session 创建多了一次 server round-trip（从 lazy 改为 eager）

## 验证

- 编译：`npx tsc --noEmit` 0 errors
- 单元测试：`npm run test -- tests/server/experts-config.test.ts` 2/2 pass
- server log 应输出：
  - `[experts.copyModel] writing to path= ...`
  - `[experts.copyModel] written yaml= ...`
  - `[experts.copyModel] copied .env from default to ...`
  - `[experts.copyModel] done: copied default=... provider=... to=...`
- 前端 UI 不再出现"该 profile 没有可用的 provider 或模型"

## 关联文档

- `docs/adr/ADR-0005-expert-marketplace-profile-integration.md`：专家 = profile 的总体策略
- `docs/chat-chain-changes/`：本次修复涉及 `newChat` 路径变更，但未触及 chat chain 内部
- `docs/work-log.md` 2026-06-25 节
