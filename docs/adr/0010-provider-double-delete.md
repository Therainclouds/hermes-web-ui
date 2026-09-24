# ADR-0010：Provider 删除必须双清 legacy list 与 v12 dict

- 状态：accepted
- 日期：2026-06-23

## 背景

Hermes Agent 的 config.yaml 中，custom provider 同时存在两种 schema：

- `custom_providers:` —— list 形态（Studio 历史写入路径）
- `providers:` —— dict 形态（Hermes Agent v12 引入的 canonical）

Studio 的 list 接口 [controllers/hermes/models.ts `getAvailable`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/controllers/hermes/models.ts#L452) 走的是 `getCompatibleCustomProviders()`，这个 helper 会**同时**读取两个位置并按 name+baseUrl+model 去重，**legacy list 优先**。

Hermes Agent CLI 在执行 v12 迁移时，存在**只把 entry 写入 dict 而保留 legacy list** 的窗口。`config.yaml` 里同一条 provider 物理上被存了两份。

历史上 `controllers/hermes/providers.ts` 里的 `remove()` 使用 "found-then-stop" 策略：

```ts
if (removeLegacy) {
  // splice from custom_providers
  didRemove = true
}
if (!didRemove && removeDict) {
  // delete from providers dict
}
```

`didRemove = true` 之后第二个分支被短路。当 legacy list 命中时，dict 那份**永远不会被清**。下个 list 请求里，dict 那条以"幽灵 provider"的形态被读出来 —— 用户看到的就是"刚删的 provider 刷新后复活"。

## 决策

将 `remove()` 的"found-then-stop"改为"两边都尝试"：

- `requestedSource === ''`（自动模式） → **同时**尝试 `custom_providers` 和 `providers` 两侧，任一命中即视为成功（`legacyRemoved || dictRemoved`）
- `requestedSource === 'custom_providers'` → 只清 legacy（保留既有行为）
- `requestedSource === 'providers'` → 只清 dict（保留既有行为）

并将内联 `splice` / `delete` 抽成两个内部 helper：

- `removeCustomProviderAtIndex(config, poolKey)` —— 返回被删的 index
- `deleteProviderDictEntry(config, poolKey, requestedProviderKey)` —— 返回是否删成功

抽函数的目的是让 controller 主体保持声明式风格，方便回归测试。

## 后果

正向影响：

- 不再出现"删除后刷新即复活"的幽灵 provider
- 既有"显式 source 锁定单边"的行为完全保留
- 审计日志 `[providers] removed poolKey=... legacy=... dict=... source=...` 方便未来排查
- 单测覆盖：双清 + 单边锁定各一个回归用例

负向影响：

- 当 poolKey 只在 dict 中存在且 `requestedSource === ''` 时，**也会**被删（之前是只删 legacy、dict 残留但不会 404）；这是修 bug 必须接受的副作用
- 自动模式会写盘一次（之前命中即返回 `{ result: true }`，现在也写盘，但本来就走 `updateYaml` 的 lock）

## 验证

- 新增 `tests/server/provider-delete-controller.test.ts` 两条用例：
  - 不带 source 时双清双侧
  - 带 `source=providers` 时只清 dict（保护既有断言）
- 运行 `npm run test -- tests/server/provider-delete-controller.test.ts`
- 端到端复现：手工 `config.yaml` 里同 name 同时存在 `custom_providers` 和 `providers`，点删除，刷新，确认两条都不再出现

## 不在本次范围

- `custom_providers:` ↔ `providers:` 的写入统一（属于"完全收敛到 v12"的更大重构）
- 触发 Hermes Agent v12 迁移的 root cause 调查（CLI 侧行为）
- 客户端 `useModelsStore` 的相关改动
