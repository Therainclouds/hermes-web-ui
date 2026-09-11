# ADR-0011：Managed Gateway 必须"杀旧" + 跨平台 Orphan Reaper

- 状态：accepted
- 日期：2026-06-23

## 背景

Hermes Web UI 启动 gateway 时存在**两套并行的进程管理者**，且二者未对齐：

| 管理者 | 路径 | 入口 |
|--------|------|------|
| Hermes Agent CLI / OS service | `hermes gateway start`/`stop`/`restart` | `hermes-cli.ts:454 restartGateway()` |
| Hermes Web UI (managed) | `spawn(detached)` + `Map<profileDir, state>` | `gateway-runner.ts` + `gateway-autostart.ts` |

**问题**：
1. `startGatewayRunManagedInternal` 起新 child 时**直接覆盖** `state.current` 引用，**老 child 进程从未被显式 kill**，导致：
   - 飞书 / 微信等 exclusive 平台：老 child 仍持有 platform lock，新 child 拿不到 → 飞书消息被老 child 消费，profile 看起来运行的是新 child 但消息走的是老 child。
   - 多 profile 场景：A 改飞书凭据后，A 的旧 gateway 没死，新 gateway 起不来 / 起在新端口 → A 失效但占着锁。
2. `restartGatewayForProfile` 调 `stopGatewayForProfile`（CLI stop，async）后**没有** `waitForGatewayLockReleasedAfterStop`，紧接着就 `startGatewayForProfile` → 端口 / lock 竞态。
3. `recoverWindowsDesktopGatewayOrphans` 只在 Windows 桌面启动时跑一次，**Linux/ARMbian 完全无兜底**。本仓库实际部署环境就是 ARMbian（用户 4 次实测复现）。

## 决策

### 1. 杀旧（`gateway-runner.ts`）

`startGatewayRunManagedInternal` 起新 child **之前**，先 `stopManagedGateway(state.current)`。**fire-and-forget**（不阻塞新 child 启动）：

```ts
if (state.current) {
  const old = state.current
  state.current = null
  stopManagedGateway(old, { timeoutMs: 3000, ... }).catch(err => logger.warn(...))
}
```

**理由**：用户的飞书凭据更新必须尽快起新 gateway；老 child 杀不掉的话，reaper 会兜底。

### 2. 等锁释放（`gateway-autostart.ts`）

`restartGatewayForProfile` 在 stop 与 start 之间加 `waitForGatewayLockReleaseInPlace(profileDir, 5000)`。**不 throw**——超时就 warn 一条继续往下走（reaper 兜底）。

不直接 import `hermes-cli.ts` 的 `waitForGatewayLockReleasedAfterStop` 是为了避免循环依赖。

### 3. 跨平台 Reaper（`gateway-autostart.ts`）

新增 `reapGatewayOrphans()` 跨平台扫描所有 profile 目录里的 `gateway.pid` / `gateway.lock` / `gateway_state.json`：

| 状态 | 处理 | 理由 |
|------|------|------|
| 文件说 running，进程死了 | ✅ 删文件 | 明确的"stale"，无副作用 |
| 进程活着，且在 `getAllManagedGatewayPids()` | ❌ 跳过 | 我们自己管的 |
| 进程活着，但**不在**我们的 `managedPids` | ⚠️ **只 log，不杀** | 可能是合法 CLI-managed gateway；自动杀风险大；用户可通过日志看到"liveOrphans"自决 |

新增 `startPeriodicGatewayReaper(intervalMs)` / `stopPeriodicGatewayReaper()`，由 `index.ts` bootstrap 完成后启动，`shutdown.ts` 在停止 managed gateway 之前先停掉 timer（避免 timer 在 shutdown 期间触发竞态）。

**Env 门控**：
- `HERMES_WEB_UI_DISABLE_GATEWAY_REAPER=1` → 关闭
- `HERMES_WEB_UI_GATEWAY_REAPER_INTERVAL_MS=15000` → 自定义间隔（默认 30s；最小 1s）

## 后果

正向影响：
- 飞书 / 微信等 exclusive 平台 lock 不会再被老 child 抢占
- 多 profile 反复改飞书凭据也不会累积 ghost 进程
- 任何 stale PID 文件会被 reaper 在 30s 内清掉
- Linux/ARMbian / macOS / Windows 行为一致

负向影响：
- `startGatewayRunManaged` 多一次 fire-and-forget stop，最多 3s 内会回报（不阻塞新 child）
- `restartGatewayForProfile` 多一次 lock wait，最多 +5s；可通过 env 收紧
- reaper 每 30s 扫一次 profile 目录，I/O 极小但有；可通过 env 关闭

## 验证

- 新增 `gateway-respawn.test.ts` 用例：连续两次 `startGatewayRunManaged` 同一 profile，断言第一个 child 收到 SIGTERM
- 新增 `gateway-reaper.test.ts`（共 9 个 it）：
  - 平台门控（linux/darwin/win32 启用，aix 拒绝，env 禁用生效）
  - 间隔读取（含兜底 30s）
  - `reapGatewayOrphans`：stale 文件清理、managed PID 跳过、liveOrphan 只 log 不杀、缺失 home 是 no-op
  - 周期 reaper 启停幂等
- 运行 `npm run test -- tests/server/gateway-respawn.test.ts tests/server/gateway-reaper.test.ts`

## 不在本次范围

- Q1=b 的"exclusive 平台专杀"（用户在 Q1=a 跳过）
- Q5 的"手动清理端点"（用户在 Q5=否）
- 把 CLI-managed 和 web-managed 两套合一的彻底重构
- 修复 Hermes Agent 侧的 `--replace` flag 行为不一致

## 决策前后对比

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| profile A 改飞书凭据 → restartGatewayForProfile | ghost 进程残留，老 gateway 持飞书锁 | 新 gateway 起来前显式 stop 旧；5s 内未释放就 warn |
| `gateway.pid` 残留指向死 PID | 文件骗人 | reaper 30s 内清理 |
| 同一 profile 多次 startGatewayRunManaged | 多个 ghost 进程累积 | 每次起新前都先 stop 旧 |
| Linux/ARMbian 完全没 reaper | ghost 持续积累 | reaper 默认开启 |
| reaper 误杀合法 CLI-managed gateway | — | 不会，managed PID 集合过滤；外部 PID 只 log |
