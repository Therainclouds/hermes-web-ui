---
date: 2026-09-02
pr: local
feature: Omni-Realtime 月亮/太阳双主题天体 + 径向柱状声纹 + 主题分设计
impact: 暗主题天体为手绘 SVG 月亮（celestial-moon.svg：左上受光、月海、五座环形山、terminator 渐暗），亮主题为 SVG 太阳（celestial-sun.svg：暖金核心、双层日冕、光斑 mottling），OmniVisualizer 按主题经 MutationObserver 跟随 html.dark 切换素材并保留 64 根径向柱状声纹（月亮柱顶光为紫蓝 accent、太阳为暖琥珀）；素材加载失败回退 canvas 矢量球。亮主题舞台单独设计：星云隐藏、改为太阳暖光 + 天光蓝反光晨光渐变背层，控件实底白 + 深描边 + 投影，气泡玻璃对比度增强。修复 sidebar 配置过滤 NSelect 运行时切主题偶发不刷新 CSS 变量的问题（按 isDark re-key 强制重建实例）。清理实时对话入口残留：ChatInput 工具栏「语音模式」（voiceClick）原指向旧版 RealtimeVoiceStage（浏览器 STT/TTS），已改指现行 OmniRealtimeStage 并拆除旧舞台在 ChatPanel 的全部挂载（showRealtimeVoice/openRealtimeVoice/RealtimeVoiceStage 导入），组件文件与其测试保留。合并 org/main 口语对练功能后，将其舞台 SpeechPracticeStage 的样式整体换肤：去掉硬编码深紫夜色背景与青/绿/红/黄霓虹色（原文件 0 个主题变量），改为 var(--bg-primary) 底 + --glass-realtime-* 玻璃面板 + accent 紫蓝强调，评分语义色（good/ok/weak）改用 --success/--warning/--error 主题令牌，控件/气泡/工具指示器与 Omni 舞台同一套规则（静音=ink 灰、挂断=accent、done/error=ink 灰），并补 light 模式控件实底白 + 深描边覆盖。口语对练入口按会话类型分流：练习配置按 sessionId 落 localStorage（hermes_practice_config_v1:*），openOmniRealtime 对非新建进入先查活动会话的练习配置——对练会话改开口语对练舞台（普通会话仍进 Omni 实时对话），同时解决刷新后历史对练会话无法恢复配置重进的问题。提示词冲突修复：对练舞台不再注入用户 Agent 的 SOUL.md（工作台助理人格与口语教练人格直接冲突），改用 PRACTICE_COACH_SOUL 固定教练人格作为 soul 位输入；对练守则显式声明解除通用约束里「不要调用 query_hermes_agent」的限制，消除与 REALTIME_SUPPLEMENT 的矛盾。二次合并 org 的对练增强（ab5df210：语言纪律守则、摄像头 bodyLanguage 评分、定时练习时长与节奏控制、UI 计时器），对方基于我们的提交开发故零冲突，所有本地优化幸存；其新增 UI（计时器/时长 chip/错误提示/摄像头预览）仍带霓虹硬编码色，已重新调色到主题令牌（计时器=accent 玻璃胶囊、告警=--warning、摄像头预览=glass 边框+投影）。
---

# Omni-Realtime: 实心圆 + 圆周声纹 + 单色水墨 + 气泡居中 + query_hermes_agent 回退

## 背景

用户在 6 处体验问题：舞台背景透明太丑、AI 气泡歪到左下角、"免提模式"提示文字上下滚动、`query_hermes_agent` 在语音里白做、旧 blob 星体扭动丑、配色混乱（淡蓝 + 黑 + 红 + 白）。

## 行为变化

### 1. 舞台不再透明——单色水墨背景
`.omni-stage` 用 `background: var(--bg-primary)` 盖掉 body，nebula/halo 透明度降到 0.10 + `mix-blend-mode: soft-light`，按钮和气泡保留 Apple 式 `backdrop-filter: blur(22px) saturate(160%)` 毛玻璃。

### 2. 气泡容器全宽居中贴边
`.omni-stage__bubbles` 改为 `width: 100%; max-width: 760px; margin: 0 auto`，live-slot 同步 `max-width: 760px` 居中，去掉了 mask 渐变；AI 回复不再"飘到左下角"。免提提示条 max-height 14.5em → 4.8em，去掉了 `overflow-y: auto`，不再上下滚动。

### 3. 月亮球体 + 64 根径向柱状声纹（替代旧 blob / 线条声纹）
`OmniVisualizer.vue` 整块重写（第三轮）：
- **月亮本体** —— 左上受光的 ink 渐变球（受光面 0.96 alpha → 边缘 0.52），5 块固定位置的低 alpha onInk 月海斑。**圆心不再画 accent 高光**——旧版在圆心叠 accent 渐变，暗主题下读成一团黑影，用户反馈"不像月亮"。accent 紫蓝只留作球外柔光环。
- **径向柱状声纹** —— 64 根柱均匀分布圆周（每 5.6° 一根），从内圈沿径向伸出，长度 = 该段频谱能量；频谱左右镜像（低频在正下、高频在正上），能量 >0.35 的柱顶叠加 accent 短光。静音段不画柱。
- 颜色完全跟随 `--text-primary-rgb`（mono 水墨） + `--accent-primary-rgb`（紫蓝高光）。

### 3.5 布局：控件沉底 + 气泡不叠字
- `.omni-stage__visualizer-zone` 改 `flex: 1 1 auto` 撑满上方剩余空间（月亮垂直居中），气泡 + caption + 控件自然贴住页面底部，控件带 `max(24px, env(safe-area-inset-bottom))` 底边距。之前固定 38vh 的 visualizer 高度把一切都挤在屏幕中段。
- live 气泡不再是 absolute 叠加层（叠在 committed 气泡上导致文字叠文字的"挤兑"）：TransitionGroup 去掉 `tag` 渲染 fragment，live 气泡作为普通流内子项排在 committed 之后。
- 气泡入场从 420ms scale 弹簧改为 180ms 轻淡入 + 10px 上浮——弹簧和 live 淡出叠跑就是"挤出再弹入"的丑感来源。

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
