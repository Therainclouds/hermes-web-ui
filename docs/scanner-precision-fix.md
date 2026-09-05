# Scanner precision fix — 2026-09-05

## Baseline and scope

Based on `main` commit `19b3483eab2783fb3ebee0b70df0470de0901cbd`.
Only scanner client code and focused tests were changed. No server API, credentials,
device update strategy, or Hermes Agent lifecycle changes are included.

## 原因与修复

| 原因 | 修复 |
| --- | --- |
| 当前默认模型是 COCO 通用检测器 `Xenova/yolos-tiny`，不是纸张四角模型；轴对齐 bbox 无法表示倾斜纸张 | ML 只提出候选区域，必须在同帧图像中恢复经典四角轮廓；没有可验证轮廓则不输出 ML 框 |
| Canny 连通域只有边线像素，却被用作纸张面积，导致大纸漏检、边缘策略评分偏低 | 用拟合四边形的包围面积做面积过滤与评分 |
| 膨胀后的边缘外扩，粗略多边形角点不能精确贴边 | 在每条边法线附近寻找灰度梯度，剔除离群点，最小二乘拟合四条直线并求交点；不可靠时保留原轮廓 |
| 追踪 ROI 提前返回，面积阈值变为 ROI 尺度；全帧入口又把 priorQuad 清空 | 全帧统一评分，保留上一帧候选的黏性加分；ML 的局部候选映射回全帧后重新检查面积 |
| 同一 Worker 内 await ML 推理，不是真正独立的实时检测 | ML 独立 Worker；经典检测每帧立即返回；AI 结果只作为后续新帧的候选先验，超过 1.5 秒或分辨率不一致则不用 |
| 初次 videoWidth/Height 为零时 computed 未订阅元数据 tick | 无条件订阅 tick，并监听视频 resize；移除比例过渡动画，避免动画期间图像和框比例不同 |
| Worker 终止时直接清 pending，Promise 不结束 | 终止/错误时结清请求，并给经典请求和 AI 请求添加超时 |
| 关闭/重新扫描/手动拖框后旧请求仍可能覆盖新状态 | 增加检测 revision 检查；统一使用配置的最小面积阈值 |

## Validation

Passed:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run harness:check
npm run test -- tests/client/scanner tests/server/scanner
npm run build
git diff --check
```

The scanner suite contains 88 tests across 12 files, including 10 added tests.
Synthetic geometry checks include a 512×384 image with a large thin edge outline,
slanted low-contrast paper, invalid ROI area, and padded contour refinement.
The targeted checks require under 3 pixels corner error for the axis-aligned
edge case and under 5 pixels for the slanted cases. These are fixture tolerances,
not a measured accuracy claim on real camera images.

Added browser tests:

```bash
npm run test:e2e -- tests/e2e/scanner-precision.spec.ts --workers=1
```

Browser execution was blocked before test bodies ran: this environment had no
Playwright Chromium binary, and downloading it timed out. The desktop/mobile
4:3 synthetic-camera browser tests are included but have NOT passed here.
The full repository test suite and actual camera/ML inference were not run.

## Local installation / acceptance

Use a separate test directory rather than overwriting a running deployment:

```bash
npm ci --ignore-scripts
npm run build
npm run dev
```

The repository requires Node.js >=23. Native terminal features may additionally
need `npm rebuild node-pty` as described in the project worktree runbook.
Use a disposable `HERMES_WEB_UI_HOME` and `HERMES_WEBUI_STATE_DIR` for testing;
do not point test runs at a production account's state.

在插件 → Scanner 中先测试经典模式，再开启 AI assist：

1. 白纸/暗桌面、白纸/浅桌面、斜放纸张、有文字和图案的纸张。
2. 缓慢移动、快速移开、不同横竖分辨率，确认不出现陈旧 AI 框。
3. 手动拖角、重置框、关闭/开启智能模式，确认旧请求不会覆盖操作。
4. 检查裁剪结果不多带明显背景、不截掉文字，并记录设备/browser/分辨率。

## Remaining limitations

- No document-specific model was trained or substituted. This fix cannot give
  a generic COCO detector a paper class it never learned.
- Severely curved pages, occlusions, glare, and paper/background with no visible
  boundary still need real samples and potentially a document segmentation or
  four-corner model. The new gradient fit refines an existing contour; it does
  not recover invisible edges.
- In low-power browsers, an isolated AI worker still competes for CPU/memory.
  AI remains optional and classic detection remains the default. No RK3576 FPS
  or NPU acceleration claim is made.
- No GitHub push was performed: the connector reported `push: false`.
- ZIP is the complete tracked source snapshot, including bundled model assets,
  plus this fix and tests; it excludes `.git`, installed dependencies, build
  output, local state, and test traces.
