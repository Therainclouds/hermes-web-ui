import type { Quad } from './types'

/**
 * 基于 @huggingface/transformers 的物体检测包装。
 *
 * 模型文件**已内置到应用本地**（packages/client/public/models/，随 Web UI 一起
 * 发布），加载默认走同源静态路径 `{origin}/models/{model}/...`——不依赖外网、
 * 不会被模型源不可用卡住（本地加载失败会快速 404 并自动换下一个源）。
 * 远程模型源仅作兜底（本地文件缺失/被清时自动回退）：
 *   1) ModelScope 魔搭（https://modelscope.cn，国内直连）；
 *   2) Hugging Face Hub（海外）。
 * transformers.js 的下载 URL 是 `{remoteHost}{remotePathTemplate}{file}`，
 * 两个远程平台都支持 HF 兼容的 `{model}/resolve/{revision}/` 路径格式
 * （已在 https://modelscope.cn/models/Xenova/yolos-tiny/resolve/main/ 下验证
 * config.json / preprocessor_config.json / onnx/model_quantized.onnx 均 200）。
 *
 * 优先尝试 WebGPU，回退 WASM（100% 浏览器支持，但慢 4-5 倍）。
 *
 * ⚠️ 模型局限：本模块不是"文档/纸张检测器"。
 *   - 默认模型 Xenova/yolos-tiny 是基于 COCO 预训练的通用物体检测器
 *     （DETR 变体，与 YOLOv8 无关——前者 anchor-free + set prediction，
 *     后者 anchor-based；本仓库用前者是因为 onnx-community/yolov8n
 *     自 2026 年起对匿名下载返回 HTTP 401，需鉴权，浏览器端 transformers.js
 *     不附带 Authorization 头，故换用公开可下载的 YOLOS-tiny 并内置本地副本）。
 *   - COCO 90 类里**没有 "paper" / "document" / "page"**——白纸、作业纸、
 *     单页便签几乎从来不会被检出，可能出框的只有书本（最佳代理）、笔记本 /
 *     手机 / 屏幕 / 键盘 / 鼠标 / 钟等扁平矩形物体；
 *   - 因此本模块返回的是"画面里所有矩形物体的边界框"，由调用方按
 *     「标签先验 × 几何先验」的复合分选最优（详见 compositeScore）：
 *       · book 等少数 COCO 类作为文档代理加权；
 *       · 笔记本 / 屏幕等扁平矩形中等加权；
 *       · 桌椅家电等大件家具略降权；
 *       · 人物 / 动物 / 植物等不规则有机体直接排除（把它们框成"纸"比漏检更糟）；
 *       · 选框贴画面边框越多越像整幅背景，几何先验相应降权；
 *       · 面积 < 2% 一律丢弃（多为小杂物）。
 *   - 没有任何 COCO 标签或全部命中被排除时，本模块不会凭空造一个矩形出来——
 *     此时只能依赖经典识别继续兜底；不要把"AI 不可用"误读成"扫描不可用"。
 *
 * ⚠️ AI 只输出矩形候选框（COCO bbox），不输出纸张四角：
 *   - bbox 是轴对齐矩形，真实纸张在画面里往往带透视畸变；
 *   - 因此 paper-detector 拿到 bbox 后必须在同帧 ROI 内重跑经典寻边
 *     （detectProposal，paper-detector.ts）做四角细化，再用面积 + 四角位移
 *     校验失败才丢弃——也就是说 AI 候选**不能独立完成识别**，经典识别失败
 *     的场景下 AI 也救不回来。
 *
 * 模型默认 Xenova/yolos-tiny：公开仓库（gated=false），transformers.js 可直接加载；
 *
 * 本地模型文件布局（public/models/{model}/，与 transformers.js q8 → _quantized
 * 的文件命名一致，勿改名）：
 *   config.json / preprocessor_config.json / onnx/model_quantized.onnx
 * 更新/重新同步（校验 SHA256 后随仓库提交，勿让构建期依赖外网）：
 *   BASE=https://modelscope.cn/models/Xenova/yolos-tiny/resolve/main
 *   curl -fL -o public/models/Xenova/yolos-tiny/config.json $BASE/config.json
 *   curl -fL -o public/models/Xenova/yolos-tiny/preprocessor_config.json $BASE/preprocessor_config.json
 *   curl -fL -o public/models/Xenova/yolos-tiny/onnx/model_quantized.onnx $BASE/onnx/model_quantized.onnx
 */

export interface MLBox {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

export interface MLCandidate {
  quad: Quad
  /** 模型原始评分（0..1）。排序/置信度用复合分（compositeScore），此处保留原始值。 */
  score: number
  label: string
  /** 像素宽 / 像素高。用于过滤纸张比例。 */
  aspect: number
  /** 占帧面积比 (0..1)。 */
  areaRatio: number
  /** 检测框贴近画面边框的边数 (0..4)，越大越像"整幅背景"。 */
  frameSides: number
}

export interface MLOptions {
  /** 评分阈值，低于此丢弃。默认 0.35。 */
  threshold?: number
  /** 最大保留检测数（按复合分排序）。默认 8。 */
  topK?: number
}

/** 默认模型：公开、含量化 ONNX（onnx/ 子目录），transformers.js 免登录即可加载。 */
const DEFAULT_MODEL = 'Xenova/yolos-tiny'
const DEFAULT_THRESHOLD = 0.35
const DEFAULT_TOP_K = 8

/**
 * 模型文件来源（按序尝试）：
 * 1) 本地内置 —— public/models/ 随应用发布，同源加载、零外网依赖；
 * 2) ModelScope 魔搭 —— 国内直连（兜底）；
 * 3) Hugging Face Hub —— 海外（兜底）。
 *
 * transformers.js 的 env.remoteHost 只控制 host，路径模板逐源配置：
 * 本地用平铺布局 `{model}/`（文件放在 public/models/{model}/ 下），
 * 远程两个平台都支持 HF 兼容布局 `{model}/resolve/{revision}/`。
 */
export interface ModelHub {
  /** 展示名（日志 / 状态提示用）。 */
  name: string
  /** transformers.js env.remoteHost 前缀（需以 / 结尾；本地为同源静态目录）。 */
  host: string
  /** 路径模板；缺省用 HF 兼容布局 {model}/resolve/{revision}/。 */
  pathTemplate?: string
  /** 是否本地内置（同源，非外网下载）。 */
  local?: boolean
}

/** 当前页面/Worker 的源（同源静态路径前缀用；Node 测试环境为空串）。 */
function originBase(): string {
  return (typeof self !== 'undefined' && (self as { location?: Location }).location?.origin) || ''
}

export const MODEL_HUBS: readonly ModelHub[] = [
  { name: '本地内置', host: `${originBase()}/models/`, pathTemplate: '{model}/', local: true },
  { name: 'ModelScope（魔搭）', host: 'https://modelscope.cn/models/' },
  { name: 'Hugging Face', host: 'https://huggingface.co/' },
]

/* ------------------------------------------------------------------ *
 * COCO 类别先验（文档扫描领域）。
 *
 * yolos-tiny 是 COCO 检测器，画面里并没有"纸/文档"这个类别——白纸、作业、
 * 便签等通常完全不会被检出，能检出的只有"矩形物体代理"。为了让代理更可靠：
 *  - 书本 = 与文档最接近的代理 → 强加权，且放低进入门槛；
 *  - 笔记本/手机/屏幕等扁平矩形电子设备 → 中等加权；
 *  - 桌椅家电等大件家具 → 略降权（通常不是扫描目标，且多贴背景）；
 *  - 人物/动物/植物等不规则有机体 → 直接排除；
 *  - 小件杂物由面积过滤兜住（占帧 < 2% 一律丢弃）。
 * ------------------------------------------------------------------ */

/** 与"文档"最接近的 COCO 代理类别。 */
const DOC_LIKE_LABELS = new Set(['book'])
/** 扁平矩形、可能被拍摄成文档的 COCO 类别。 */
const FLAT_RECT_LABELS = new Set(['laptop', 'tv', 'cell phone', 'keyboard', 'remote', 'mouse', 'clock'])
/** 体积大、基本不可能是扫描目标的 COCO 类别（略降权而非排除）。 */
const FURNITURE_LABELS = new Set([
  'chair', 'couch', 'bed', 'dining table', 'toilet', 'bench',
  'refrigerator', 'microwave', 'oven', 'toaster', 'sink',
  'suitcase', 'backpack', 'handbag', 'umbrella',
])
/** 不规则有机体 / 食品等，直接排除（框它们当"纸"比漏检更糟）。 */
const ORGANIC_LABELS = new Set([
  'person', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe',
  'potted plant', 'teddy bear',
  'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
])

export function isOrganicLabel(label: string): boolean {
  return ORGANIC_LABELS.has(label)
}

/** 标签加权：文档代理越像"纸"，越值得把选框让给它。 */
export function labelBoost(label: string): number {
  if (DOC_LIKE_LABELS.has(label)) return 1.3
  if (FLAT_RECT_LABELS.has(label)) return 1.1
  if (FURNITURE_LABELS.has(label)) return 0.85
  return 1
}

/**
 * 标签相关进入门槛（乘到 mlThreshold 上）：文档代理在 COCO 里本就难检，
 * 得分普遍偏低——"book" 放低到 0.7× 门槛才不会被误杀。
 */
export function labelThresholdScale(label: string): number {
  if (DOC_LIKE_LABELS.has(label)) return 0.7
  if (FLAT_RECT_LABELS.has(label)) return 0.85
  return 1
}

export function pipelineThreshold(threshold: number): number {
  return Math.max(0, threshold * 0.7)
}

/** 宽高比先验：文档（含旋转视角）多为 0.5..2 的方正矩形；极端细长条更像杂波。 */
export function aspectPrior(aspect: number): number {
  if (aspect >= 0.5 && aspect <= 2.0) return 1.05
  if (aspect >= 0.32 && aspect <= 3.4) return 1
  return 0.8
}

/** 检测框贴画面边框的边数 (0..4)。贴边越多越像整幅背景/桌面，越不像纸上物体。 */
export function quadFrameSides(quad: Quad): number {
  const margin = 0.015
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const xmin = Math.min(...xs)
  const xmax = Math.max(...xs)
  const ymin = Math.min(...ys)
  const ymax = Math.max(...ys)
  let sides = 0
  if (xmin <= margin) sides++
  if (xmax >= 1 - margin) sides++
  if (ymin <= margin) sides++
  if (ymax >= 1 - margin) sides++
  return sides
}

/**
 * 复合分 = 原始分 × 标签先验 × 宽高比先验 × 反"整幅背景"（贴边罚分）。
 * 用于 detectRectangles 的排序 / topK 与 candidateToDetection 的置信度，
 * 让"看起来最像纸"的矩形优先，而不是"得分最高的人"抢走选框。
 */
export function compositeScore(score: number, label: string, aspect: number, frameSides: number): number {
  if (isOrganicLabel(label)) return 0
  const geometry = aspectPrior(aspect) * Math.max(0.15, 1 - 0.22 * frameSides)
  return clamp01(score * labelBoost(label) * geometry)
}

/** 两个检测框的 IoU（0..1），用于合并同一物理目标的重复检测。 */
export function boxesIoU(a: MLBox, b: MLBox): number {
  const x1 = Math.max(a.xmin, b.xmin)
  const y1 = Math.max(a.ymin, b.ymin)
  const x2 = Math.min(a.xmax, b.xmax)
  const y2 = Math.min(a.ymax, b.ymax)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter === 0) return 0
  const areaA = (a.xmax - a.xmin) * (a.ymax - a.ymin)
  const areaB = (b.xmax - b.xmin) * (b.ymax - b.ymin)
  const union = areaA + areaB - inter
  return union <= 0 ? 0 : inter / union
}

/**
 * 一次加载失败后的冷却时间。冷却期内 getMLPipeline 直接抛缓存错误、不再发网络请求，
 * 避免智能捕捉每帧重试导致刷屏（每 ~140 ms 一次失败的模型下载请求 + 双份 console.warn）。
 * 冷却结束后允许自动重试一次，网络瞬时故障可在不重开智能模式的情况下自愈。
 */
const RETRY_COOLDOWN_MS = 30_000

/**
 * 单次「模型源 × 推理后端」加载尝试的超时。
 *
 * transformers.js 内部 fetch 不设超时：模型源不可达或网速极慢时 pipeline() 的
 * promise 既不 resolve 也不 reject，状态机会卡死在 loading（UI 一直显示
 * "AI 模型加载中…"）。给每次尝试设上限：
 * - 单次超时视为"该模型源整体不可达"（不是后端问题），跳过它的剩余后端、
 *   换下一个模型源（本地内置 → 魔搭 → HF）；
 * - 全部尝试结束后才进入 failed + 冷却，冷却到期自动重试，不再无限空转。
 */
const ATTEMPT_TIMEOUT_MS = 15_000
/** 整次模型加载的兜底总超时（覆盖动态 import / transformers.js 初始化等耗时）。 */
const TOTAL_LOAD_TIMEOUT_MS = 45_000
/** 模型源可达性预检超时：小文件几秒内失败即判定该源不可用，不等大文件下载超时。 */
const PREFLIGHT_TIMEOUT_MS = 5_000
/** 加载超时错误码：用于区分"源不可达（超时）"与"后端真报错（可降级 wasm 再试）"。 */
const ML_LOAD_TIMEOUT_CODE = 'ML_LOAD_TIMEOUT'

function isLoadTimeout(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === ML_LOAD_TIMEOUT_CODE
}

/** 给任意 promise 加超时：到期 reject（带 ML_LOAD_TIMEOUT_CODE），提前 settle 则清理定时器。 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error(`${what}超时（${Math.round(ms / 1000)}s）`), { code: ML_LOAD_TIMEOUT_CODE }))
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 模型源可达性预检：用最小的 config.json 探测某个源当前是否可用。
 * - 本地内置源：同源 404（文件缺失/未发布）会立刻暴露，换下一个源；
 * - 网络不可达 / CORS 被拦 / 仓库不存在 → 几秒内判定失败，跳过该源，
 *   不必等大文件（~9.6 MB）下载把单次尝试的超时耗尽；
 * - fetch 同时验证了浏览器跨域（CORS）权限——被 CSP/CORS 拦截会在这里现形。
 */
async function probeHubReachable(hub: ModelHub, modelId: string): Promise<boolean> {
  const template = (hub.pathTemplate ?? '{model}/resolve/{revision}/')
    .replaceAll('{model}', modelId)
    .replaceAll('{revision}', 'main')
  const url = `${hub.host}${template}config.json`
  try {
    const res = await withTimeout(
      fetch(url, { method: 'GET', cache: 'no-store' }),
      PREFLIGHT_TIMEOUT_MS,
      `模型源预检（${hub.name}）`,
    )
    return res.ok
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[scanner-ml] 模型源 ${hub.name} 预检失败：`, (error as Error)?.message ?? error)
    return false
  }
}

interface PipelineBox {
  label: string
  score: number
  box: MLBox
}

interface PipelineLike {
  (input: HTMLCanvasElement | OffscreenCanvas | HTMLImageElement, opts?: { threshold?: number; percentage?: boolean }): Promise<PipelineBox[]>
}

/** transformers.js env 中本项目用到的最小字段。 */
interface TransformersEnv {
  backends?: { onnx?: { wasm?: { numThreads?: number; wasmPaths?: string | string[] } } }
  allowLocalModels?: boolean
  useFs?: boolean
  remoteHost?: string
  remotePathTemplate?: string
}

/**
 * 配置 transformers.js 环境：
 * - 模型文件从指定来源拉取：remoteHost = hub.host，路径模板逐源配置
 *   （本地平铺 {model}/；远程 {model}/resolve/{revision}/，ModelScope / HF 均支持）；
 * - WASM 路径指向 public/transformers/ 本地副本（避免 CDN 404 + 不依赖外网）
 * - 多线程需要 cross-origin isolation（COOP/COEP + SharedArrayBuffer）；未隔离时
 *   ort 会忽略 numThreads 并打 "numThreads is set to N..." 告警再回退单线程，
 *   这里直接探测隔离状态，未隔离就显式设 1，静音该告警。
 */
function configureTransformersEnv(env: TransformersEnv, hub: ModelHub): void {
  env.remoteHost = hub.host
  env.remotePathTemplate = hub.pathTemplate ?? '{model}/resolve/{revision}/'
  const wasmBase = `${originBase()}/transformers/`
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = wasmBase
    const isolated =
      typeof self !== 'undefined' && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2
    env.backends.onnx.wasm.numThreads = isolated ? Math.min(4, cores) : 1
  }
  env.allowLocalModels = false
  env.useFs = false
}

let pipelinePromise: Promise<PipelineLike> | null = null
let pipelineKey = ''
/** 上次失败的时间戳（Date.now()），用于冷却期快速失败。 */
let lastFailureAt = 0

/**
 * ML pipeline 加载状态。worker 内修改、主线程通过 worker postMessage 镜像。
 *
 * - off    ：未启用（默认）
 * - 'loading'：正在加载 transformers.js / 下载模型 / 初始化 WebGPU/WASM
 * - 'ready' ：pipeline 就绪，可以推理
 * - 'failed'：加载失败（模型源不通 / 模型需鉴权 / wasm 不可用 / 设备拒绝）。
 *   失败进入 RETRY_COOLDOWN_MS 冷却：期间不再重试，worker 安静使用经典策略；
 *   冷却结束后自动重试一次
 */
export type MLStatusState = 'off' | 'loading' | 'ready' | 'failed'

export interface MLStatus {
  state: MLStatusState
  /** 失败时附带的错误描述（UI 调试用）。 */
  error?: string
}

let mlStatus: MLStatus = { state: 'off' }

/** 取 worker 内的当前状态。main thread 通过 worker 消息镜像同步。 */
export function getMLStatus(): MLStatus {
  return mlStatus
}

/**
 * 是否处于失败冷却期。冷却期内调用方应跳过 ML（getMLPipeline 也会快速失败）；
 * 冷却结束返回 false，下一次调用会真正发起一次重试（网络故障可自愈）。
 */
export function isMLRetryCooldown(): boolean {
  return mlStatus.state === 'failed' && Date.now() - lastFailureAt < RETRY_COOLDOWN_MS
}

function setMLStatus(state: MLStatusState, error?: string): void {
  mlStatus = error ? { state, error } : { state }
}

let webgpuProbe: Promise<boolean> | null = null

/**
 * WebGPU 是否真的可用。仅凭 `'gpu' in navigator` 判断不够：无 GPU / 软渲染的
 * Chrome（虚拟机、远程桌面等）也会暴露该 API，但 requestAdapter() 返回 null，
 * 硬选 webgpu 会在创建推理会话时报 "Failed to get GPU adapter" 而失败。
 * 结果缓存，worker 生命周期内只探测一次。
 *
 * 实现细节：GPU.requestAdapter 是绑定到 GPU 实例的宿主方法，必须用成员访问
 * 形式 `gpu.requestAdapter()` 调用（保留 `this`），否则 Chrome 会抛
 * "TypeError: Illegal invocation"。早期版本把方法解构成 `const fn = gpu.requestAdapter;
 * fn()` 裸调，在支持 WebGPU 的浏览器里反被 try/catch 吞掉、一律返回 false，
 * 导致 webgpu 后端永远走不到、推理静默降级 wasm（慢 4-5 倍）。
 *
 * Exported for tests; not part of the public API.
 */
export function hasUsableWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined') return Promise.resolve(false)
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
  if (!gpu || typeof gpu.requestAdapter !== 'function') return Promise.resolve(false)
  // Bind through a non-null local: gpu.requestAdapter is typed as optional on
  // our minimal GPU interface, but the typeof guard above proves it's a
  // function on `gpu`. Capturing the bound form lets TS narrow away the
  // optional, while keeping `this` = `gpu` (required by the host API).
  const boundRequestAdapter = gpu.requestAdapter.bind(gpu)
  if (!webgpuProbe) {
    webgpuProbe = (async () => {
      try {
        const adapter = await boundRequestAdapter()
        return adapter != null
      } catch {
        return false
      }
    })()
  }
  return webgpuProbe
}

/** Test-only: reset the cached WebGPU probe between cases. */
export function __resetWebGPUProbeForTests(): void {
  webgpuProbe = null
}

/** 解析首选推理后端：真能拿到 GPU adapter 才用 webgpu，否则 wasm。 */
async function resolveDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    return (await hasUsableWebGPU()) ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

type PipelineFactory = (
  task: string,
  model: string,
  opts?: Record<string, unknown>,
) => Promise<PipelineLike>

type TransformersModule = { pipeline: PipelineFactory; env: TransformersEnv }

/**
 * 按序尝试「模型源 × 推理后端」的所有组合，直到第一个成功：
 * 源顺序 MODEL_HUBS（本地内置 → 魔搭 → HF），后端顺序（探测首选 → wasm）。
 * configureTransformersEnv 每次尝试前重设 env.remoteHost，且每次 pipeline()
 * 都 await 到结束才改下一次 —— env 不会被下一次尝试提前改掉。
 *
 * 每次尝试有 ATTEMPT_TIMEOUT_MS 超时：超时说明该模型源不可达（fetch 挂起），
 * 跳过该源剩余的推理后端，直接换下一个模型源；后端"真报错"（如 WebGPU 算子
 * 不支持）仍会降级到 wasm 再试一次。每个源先做 probeHubReachable 预检，
 * 网络/CORS 问题几秒内就能判死该源，不用等下载超时。
 */
async function tryLoadFromHubs(
  mod: TransformersModule,
  modelId: string,
  devices: Array<'webgpu' | 'wasm'>,
): Promise<PipelineLike> {
  let lastError: unknown = null
  for (const hub of MODEL_HUBS) {
    // 可达性预检：失败（网络/CORS/仓库不存在）直接换下一个源
    if (!(await probeHubReachable(hub, modelId))) {
      lastError = new Error(`模型源 ${hub.name} 不可达（预检失败）`)
      continue
    }
    let hubTimedOut = false
    for (const device of devices) {
      try {
        configureTransformersEnv(mod.env, hub)
        // 先登记再 await：并发调用复用同一份 in-flight promise，避免重复下载
        const p = mod.pipeline('object-detection', modelId, { device, dtype: 'q8' })
        pipelineKey = `${modelId}@${device}`
        pipelinePromise = p
        return await withTimeout(p, ATTEMPT_TIMEOUT_MS, `模型下载（${hub.name} / ${device}）`)
      } catch (error) {
        lastError = error
        pipelinePromise = null
        const timedOut = isLoadTimeout(error)
        if (timedOut) hubTimedOut = true
        // eslint-disable-next-line no-console
        console.warn(
          `[scanner-ml] 模型源 ${hub.name} / ${device} 加载失败${timedOut ? '（超时，跳过该源剩余后端）' : ''}，尝试下一个：`,
          (error as Error)?.message ?? error,
        )
        // 单次尝试超时 = 该源整体不可达（不是后端问题），跳过它的剩余后端
        if (hubTimedOut) break
      }
    }
  }
  if (lastError !== null) {
    throw new Error(
      `模型加载失败（已尝试模型源：${MODEL_HUBS.map((h) => h.name).join('、')}）：${
        (lastError as Error)?.message ?? String(lastError)
      }`,
    )
  }
  throw new Error('no inference backend available')
}

/** 获取（懒加载）Transformers.js + 检测 pipeline。模型默认本地内置加载，后端 WebGPU 优先（真探测）。 */
export async function getMLPipeline(modelId = DEFAULT_MODEL): Promise<PipelineLike> {
  const device = await resolveDevice()
  const key = `${modelId}@${device}`
  // 已就绪 / 加载中：复用同一份 promise，避免智能模式每 ~140 ms 触发的并发重复下载。
  if (pipelinePromise && pipelineKey === key) return pipelinePromise

  // 冷却期快速失败：上次失败后 RETRY_COOLDOWN_MS 内不再发起网络请求（复读错误信息）。
  // 真正的重试由冷却到期后的下一次调用触发。
  if (isMLRetryCooldown()) {
    throw new Error(mlStatus.error ?? 'ML pipeline unavailable (recent load failure)')
  }

  setMLStatus('loading')
  try {
    const mod = (await import('@huggingface/transformers')) as unknown as TransformersModule
    // 多后端按序尝试：探测出的首选后端建会话失败时（如 adapter 中途不可用、
    // WebGPU 不支持某算子）自动降级到 wasm；全部失败才计入冷却。
    // 总超时兜底：即使每个单次尝试都设了上限，import/初始化等阶段也不能无限等。
    const devices: Array<'webgpu' | 'wasm'> = device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']
    const load = tryLoadFromHubs(mod, modelId, devices)
    // 孤儿 promise 防护：总超时弃用 load 后，其内部后续的延迟失败不能变成 unhandled rejection
    void load.catch(() => undefined)
    const pipe = await withTimeout(load, TOTAL_LOAD_TIMEOUT_MS, '模型加载')
    setMLStatus('ready')
    return pipe
  } catch (error) {
    lastFailureAt = Date.now()
    setMLStatus('failed', (error as Error)?.message ?? String(error))
    pipelinePromise = null
    // eslint-disable-next-line no-console
    console.warn('[scanner-ml] pipeline failed:', (error as Error)?.message ?? error)
    throw error
  }
}

/** 取消加载中的 pipeline（用于 unmount）。 */
export function disposeMLPipeline(): void {
  pipelinePromise = null
  pipelineKey = ''
  setMLStatus('off')
}

interface RawDet {
  box: MLBox
  score: number
  label: string
  areaRatio: number
}

export function normalizeMLBox(box: MLBox, W: number, H: number): MLBox | null {
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null
  if (![box.xmin, box.ymin, box.xmax, box.ymax].every(Number.isFinite)) return null
  const xmin = Math.max(0, Math.min(W, box.xmin))
  const ymin = Math.max(0, Math.min(H, box.ymin))
  const xmax = Math.max(0, Math.min(W, box.xmax))
  const ymax = Math.max(0, Math.min(H, box.ymax))
  if (xmax <= xmin || ymax <= ymin) return null
  return { xmin, ymin, xmax, ymax }
}

/** 把像素坐标系下的检测框（相对输入帧 W×H）转成归一化 Quad（0..1）。 */
function boxToQuad(box: MLBox, W: number, H: number): Quad {
  return [
    { x: box.xmin / W, y: box.ymin / H },
    { x: box.xmax / W, y: box.ymin / H },
    { x: box.xmax / W, y: box.ymax / H },
    { x: box.xmin / W, y: box.ymax / H },
  ]
}

/**
 * 合并同一物理目标的重复检测（YOLOS/DETR 偶发"同物多标签 / 近邻重复"）。
 * 按模型评分降序贪心保留：与已保留框 IoU >= iouThreshold 的检测视为重复丢弃。
 */
function mergeDuplicateBoxes(dets: RawDet[], iouThreshold = 0.55): RawDet[] {
  const byScore = dets
    .slice()
    .sort((a, b) => b.score - a.score || b.areaRatio - a.areaRatio)
  const kept: RawDet[] = []
  for (const det of byScore) {
    const dup = kept.some((k) => boxesIoU(k.box, det.box) >= iouThreshold)
    if (!dup) kept.push(det)
  }
  return kept
}

/**
 * 调一次 YOLOS，返回"高分矩形检测"列表，按复合分降序。
 *
 * 输入需为 HTMLCanvasElement / OffscreenCanvas（Transformers.js 不直接吃 ImageData）。
 * 输入像素 (W, H) 用于把 box 转归一化 + 过滤 aspect/area。
 */
export async function detectRectangles(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  W: number,
  H: number,
  modelId: string = DEFAULT_MODEL,
  opts: MLOptions = {},
): Promise<MLCandidate[]> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const topK = opts.topK ?? DEFAULT_TOP_K

  const pipe = await getMLPipeline(modelId)
  const raw = await pipe(canvas, { threshold: pipelineThreshold(threshold), percentage: false })

  // 1) 初筛：有机体直接排除；文档代理类放低进入门槛；几何（占帧面积）粗滤。
  const dets: RawDet[] = []
  for (const det of raw) {
    const box = normalizeMLBox(det.box, W, H)
    if (!box) continue
    const w = box.xmax - box.xmin
    const h = box.ymax - box.ymin
    if (isOrganicLabel(det.label)) continue
    if (det.score < threshold * labelThresholdScale(det.label)) continue
    const areaRatio = (w * h) / (W * H)
    if (areaRatio < 0.02 || areaRatio > 0.9) continue
    dets.push({ box, score: det.score, label: det.label, areaRatio })
  }

  // 2) 合并同一物理目标的重复框（同物多标签 / 近邻重复），优先保留模型评分更高的框。
  const merged = mergeDuplicateBoxes(dets)

  // 3) 排序 + topK：按复合分（原始分 × 标签先验 × 几何先验）降序。
  const candidates: MLCandidate[] = []
  for (const det of merged) {
    const quad = boxToQuad(det.box, W, H)
    const w = det.box.xmax - det.box.xmin
    const h = det.box.ymax - det.box.ymin
    candidates.push({
      quad,
      score: det.score,
      label: det.label,
      aspect: w / h,
      areaRatio: det.areaRatio,
      frameSides: quadFrameSides(quad),
    })
  }
  candidates.sort(
    (a, b) => compositeScore(b.score, b.label, b.aspect, b.frameSides) - compositeScore(a.score, a.label, a.aspect, a.frameSides),
  )
  return candidates.slice(0, topK)
}

/**
 * 把 MLCandidate 转成 PaperDetection 兼容的结果。
 * caller 负责 aspect / area 等业务校验。
 * 置信度 = 复合分（与排序一致：有机体为 0、文档代理标签更高、贴背景更低）。
 */
export function candidateToDetection(c: MLCandidate): {
  quad: Quad
  confidence: number
  strategy: 'ml'
  ms: number
} {
  return {
    quad: c.quad,
    confidence: compositeScore(c.score, c.label, c.aspect, c.frameSides),
    strategy: 'ml',
    ms: 0,
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
