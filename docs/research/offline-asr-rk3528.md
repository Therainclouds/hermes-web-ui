# 离线 ASR 在 RK3528 / Armbian 上的可行性调研

> 创建日期：2026-07-21
> 上游审计：[meeting-mode-rk3528-audit.md](../planning/meeting-mode-rk3528-audit.md) P0#2
> 目标：在 RK3528 (4-core Cortex-A55, 4GB RAM) 上实现**无外网依赖**的实时 ASR

---

## 1. 问题定义

现状：Meeting 模式 100% 依赖阿里云 DashScope + OSS（外网）。RK 设备如果是纯局域网（kiosk 场景），整个 meeting 模式不可用。

**目标候选**：能在 ARM64 + ARM Cortex-A55 上**本地推理**实时中文 ASR，且首次启动 < 90 秒、持续运行内存 < 800 MB、模型体积 < 500 MB。

**非目标**：不替换 LLM 分析（那是另一个独立问题，本地 LLM 远超 RK3528 能力）。

---

## 2. 候选方案对比

### 方案 A：sherpa-onnx（推荐）

- **仓库**：https://github.com/k2-fsa/sherpa-onnx
- **官方 wheel**：`pip install sherpa-onnx` 提供 aarch64 manylinux2014 wheel
- **支持模型**：
  - **Paraformer**（阿里达摩院，中文 SOTA）— 与现有 DashScope 切换零摩擦
  - Whisper.cpp converted to ONNX
  - Zipformer（英文为主）
  - Moonshine（轻量英文）
- **流式支持**：原生 streaming API，~200ms latency
- **中文模型**：[sherpa-onnx-paraformer-zh-2023-09-14](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) ~250 MB
- **RK3528 性能预估**：
  - Paraformer-zh 实时率（RTF）≈ 0.3-0.5（4 核 Cortex-A55 NEON 加速）
  - 内存占用：模型加载后 ~400 MB
- **优势**：
  - 单一 Python wheel，集成简单
  - Paraformer 中文识别率与 DashScope 持平（同一架构）
  - 流式 API 与现有 ParaformerProxy 兼容
- **劣势**：
  - 模型首次下载需外网（或升级包内置 ~250 MB）
  - Diarization（说话人分离）需另外的模型

### 方案 B：whisper.cpp

- **仓库**：https://github.com/ggerganov/whisper.cpp
- **二进制**：提供 aarch64 静态编译 release
- **模型**：GGML 格式
  - `ggml-tiny.bin` 39 MB（中文勉强）
  - `ggml-base.bin` 142 MB（中文可用）
  - `ggml-small.bin` 466 MB（中文良好）
- **RK3528 性能预估**：
  - tiny: RTF ≈ 0.5（实时）
  - base: RTF ≈ 1.2（基本实时）
  - small: RTF ≈ 3.5（不实时）
- **优势**：
  - 多语言、模型生态成熟
  - 中文识别率 base 模型已可用
- **劣势**：
  - 需要 C++ binding 或 REST server（如 whisper.cpp 的 `whisper-server`）
  - 中文识别率不如 Paraformer / 阿里专用模型
  - 集成为独立子进程，复杂度比 sherpa-onnx 高

### 方案 C：Vosk

- **仓库**：https://github.com/alphacep/vosk-api
- **官方 wheel**：`pip install vosk` 提供 aarch64 wheel
- **模型**：
  - `vosk-model-small-cn-0.22` 42 MB（中文基本可用）
  - `vosk-model-cn-0.22` 1.4 GB（中文 SOTA）
- **RK3528 性能预估**：
  - small-cn: RTF ≈ 0.2-0.4（实时）
  - cn-0.22: RTF ≈ 1.0（实时边界）
- **优势**：
  - Python 原生集成最简单（同步 API）
  - small 模型体积小
- **劣势**：
  - 模型需要单独下载 + 解压
  - 中文 large 模型 1.4GB，存储压力
  - 流式 API 不如 sherpa-onnx 优雅

---

## 3. 评估矩阵

| 维度 | sherpa-onnx (Paraformer) | whisper.cpp (base) | Vosk (small-cn) |
|------|---------------------------|---------------------|------------------|
| 中文识别率 | ★★★★★ | ★★★☆☆ | ★★★★☆ |
| ARM64 实时 | ★★★★☆ | ★★★☆☆ | ★★★★★ |
| 集成复杂度 | ★★★★☆ | ★★☆☆☆ | ★★★★★ |
| 模型体积 | 250 MB | 142 MB | 42 MB |
| 流式支持 | ★★★★★ | ★★☆☆☆ | ★★★★☆ |
| Diarization | 需额外 | 需额外 | 需额外 |
| 升级包友好 | ★★★★★ | ★★★☆☆ | ★★★★☆ |

---

## 4. 推荐方案

### Phase 2A（短期，1 周）— sherpa-onnx + Paraformer 集成

实施路径：
1. 设备升级包内置 `sherpa-onnx-paraformer-zh-2023-09-14`（~250 MB）
2. 修改 `packages/server/src/services/meeting-asr/python-backend/app/asr_proxy.py`：
   - 增加 `LocalParaformerEngine` 类，封装 sherpa-onnx
   - 与现有 DashScope 路径共存，通过 `config.json: asr.provider` 切换
   - 默认 `provider: "dashscope"`，可选 `"local"`
3. 修改 `startASRService` controller 接收 `provider` 字段
4. MeetingView.vue 增加 provider 选择 UI（首次配置向导里）

### Phase 2B（中期，1-2 周）— Diarization 离线化

sherpa-onnx 的说话人分离基于 clustering（不是端到端模型）：
- 实时提取 speaker embedding
- 在 ASR 输出后做聚类
- 中文准确率 80-85%（vs 阿里云 90%+）

可作为"够用即可"的本地降级方案。

### Phase 2C（远期）— 替换 LLM 分析

RK3528 跑不动 7B+ LLM。可选：
- llama.cpp + Qwen-1.5B 量化模型（~1 GB）做轻量总结
- 仅生成"5 个 key points"而非完整分析报告
- 接受质量下降换取离线能力

---

## 5. 风险与未知项

### 待验证（需要 RK3528 实测）

1. sherpa-onnx aarch64 wheel 在 Armbian Bookworm 上的兼容性
2. NEON 加速在 Cortex-A55 vs Cortex-A76 的差距（A55 弱 30%）
3. 模型首次加载时间（冷启动 vs 热启动）
4. 多 session 并发的内存压力（4 GB 总内存紧张）
5. 长期运行（2 小时）内存泄漏情况

### 业务风险

1. 离线 ASR 中文识别率比 DashScope 略差，需 UX 解释
2. 模型升级路径复杂（升级包增大 250 MB）
3. 与现有 DashScope 用户的数据迁移（无法简单迁移）

---

## 6. 不推荐的方案

### ❌ 在 RK3528 上跑 Whisper large 模型
- 模型 1.5 GB + 内存峰值 4 GB → OOM
- 推理速度 RTF > 5，无法实时

### ❌ 训练自有中文 ASR
- 需要几千小时标注数据 + GPU 集群
- 投入产出比不划算

### ❌ 维持纯云依赖 + 要求所有设备联网
- 与"kiosk 纯局域网"业务场景冲突
- 用户已明确反馈 "meeting 是一坨屎"

---

## 7. 决策点（待用户确认）

| 选项 | 描述 | 工作量 |
|------|------|--------|
| A | **接受 Phase 2A 推荐**：sherpa-onnx + Paraformer，1 周集成 | 1 周 |
| B | 进一步调研 whisper.cpp + 大量测试 | 2 周 |
| C | 暂不投入离线 ASR，仅优化文档说明"必须外网" | 0 |
| D | 换更便宜的云方案（如讯飞、腾讯云）以缓解用户对阿里云单点依赖的担忧 | 1 周 |

---

## 8. 参考资料

- sherpa-onnx 文档：https://k2-fsa.github.io/sherpa/onnx/index.html
- sherpa-onnx Paraformer 中文模型：https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- whisper.cpp ARM 性能：https://github.com/ggerganov/whisper.cpp#arm-cortex-a
- Vosk 中文模型：https://alphacephei.com/vosk/models
- RK3528 datasheet：https://www.rock-chips.com/a/en/products/RK35_Series/2024/0523/1695.html
- Cortex-A55 NEON 性能：https://developer.arm.com/Processors/Cortex-A55