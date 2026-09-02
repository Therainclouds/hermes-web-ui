---
date: 2026-09-02
pr: local
feature: Omni-Realtime 实心圆 + 圆周声纹 + 单色水墨
impact: 实时对话舞台从透明改为不透明单色水墨背景、星体从扭动 blob 改为静止实心圆加圆周连续声纹（32 段 log 频谱映射）、配色统一为黑白水墨加紫蓝高光、气泡容器全宽居中贴边、免提提示文本不再上下滚动、query_hermes_agent 在语音模式被系统提示禁用并引导用户回到文字对话页或工作区。
---

# Omni-Realtime: 实心圆 + 圆周声纹 + 单色水墨 + 气泡居中 + query_hermes_agent 回退

## 背景

用户在 6 处体验问题：舞台背景透明太丑、AI 气泡歪到左下角、"免提模式"提示文字上下滚动、`query_hermes_agent` 在语音里白做、旧 blob 星体扭动丑、配色混乱（淡蓝 + 黑 + 红 + 白）。

## 行为变化

### 1. 舞台不再透明——单色水墨背景
`.omni-stage` 用 `background: var(--bg-primary)` 盖掉 body，nebula/halo 透明度降到 0.10 + `mix-blend-mode: soft-light`，按钮和气泡保留 Apple 式 `backdrop-filter: blur(22px) saturate(160%)` 毛玻璃。

### 2. 气泡容器全宽居中贴边
`.omni-stage__bubbles` 改为 `width: 100%; max-width: 760px; margin: 0 auto`，live-slot 同步 `max-width: 760px` 居中，去掉了 mask 渐变；AI 回复不再"飘到左下角"。免提提示条 max-height 14.5em → 4.8em，去掉了 `overflow-y: auto`，不再上下滚动。

### 3. 实心圆 + 圆周连续声纹（替代旧 blob）
`OmniVisualizer.vue` 整块重写：
- **中心实心圆** —— 径向渐变（左上高光、右下暗），整体半径由能量做唯一驱动，不再有任何顶点级起伏。
- **圆周连续声纹** —— 32 段 log 频谱映射到圆周 32 个等分角，线条 + accent 紫蓝柔光层 + 32 端点颗粒三层叠加，从 12 点钟顺时针闭合。
- 颜色完全跟随 `--text-primary-rgb`（mono 水墨） + `--accent-primary-rgb`（紫蓝高光），不再用旧红/紫/青独立调色板。

### 4. outputAnalyser 升级为 shallowRef
`useOmniRealtime.ts` 把 `let outputAnalyser` 改成 `shallowRef<AnalyserNode | null>(null)`，暴露给 `OmniVisualizer`，让声纹能读到真实频谱而不是仅平滑电平。

### 5. 配色统一成单色黑白水墨 + 紫蓝高光
去掉 `--accent-info-rgb` 在用户气泡里的渐变、去掉错误/静音/结束按钮的红色、tool-indicator 的 red/green 都改成 ink 灰 + glass-realtime tokens。

### 6. `query_hermes_agent` 在实时模式被提示禁用
`realtime-instructions.ts` 新增 REALTIME_SUPPLEMENT 条目：让模型不要调用 `query_hermes_agent`，而是用一句口语告诉用户"回文字对话页或工作区继续"——语音模式下这个工具产物用户拿不到。

## 影响

- 视觉：舞台从透明改为不透明单色背景，星体从扭动 blob 改为静止实心圆 + 圆周律动声纹，配色收敛。
- 功能：语音模式下 `query_hermes_agent` 不再被调用，模型会引导用户回文字对话或工作区拿产物。
- 数据流：`outputAnalyser` 以 `shallowRef` 暴露，`OmniVisualizer` 通过 `watch(props.analyser)` attach，生命周期与 composable 解耦。
- 测试：`tests/server/omni-realtime-wiring.test.ts` 的 analyser 断言从 `let outputAnalyser = ...` 改成 `outputAnalyser.value = analyserNode` 的新写法。
