/**
 * Scanner 插件视觉类型定义。
 *
 * 检测/透视矫正由插件内置的 OpenCV.js（vendor/opencv.js）引擎完成；
 * 本文件只保留纯 TypeScript 图像增强链路（filters / enhance）用到的类型，
 * 以及 UI 层共用的几何类型。全部为 typed-array 数据，无 DOM / 无第三方依赖。
 */

/** 二维点（坐标单位由使用场景决定：像素 / 归一化 0..1）。 */
export interface Pt {
  x: number
  y: number
}

/**
 * 四边形，顺序约定：tl -> tr -> br -> bl（左上、右上、右下、左下，顺时针）。
 * 相机坐标系 y 向下，顺时针的 cross 积为正。
 */
export type Quad = readonly [Pt, Pt, Pt, Pt]

/** RGBA 图像缓冲。data 长度 = width * height * 4。 */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** 灰度图缓冲。data 长度 = width * height。 */
export interface GrayImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** 图像增强预设。 */
export type EnhancePreset = 'none' | 'auto' | 'gray' | 'bw'

/** 图像增强参数。contrast 100 = 不变；brightness 0 = 不变；sharpen 0..100。 */
export interface EnhanceParams {
  preset: EnhancePreset
  /** 对比度 0..200，100 为不变。 */
  contrast: number
  /** 亮度 -100..100，0 为不变。 */
  brightness: number
  /** 锐化强度 0..100，0 为关闭。 */
  sharpen: number
}

/** 各预设对应的默认参数（对比度/亮度/锐化保持中性，只有预设动作生效）。 */
export const ENHANCE_DEFAULTS: Record<EnhancePreset, EnhanceParams> = {
  none: { preset: 'none', contrast: 100, brightness: 0, sharpen: 0 },
  auto: { preset: 'auto', contrast: 100, brightness: 0, sharpen: 0 },
  gray: { preset: 'gray', contrast: 100, brightness: 0, sharpen: 0 },
  bw: { preset: 'bw', contrast: 100, brightness: 0, sharpen: 0 },
}

/** 透视矫正输出比例（宽/高）。auto = 按检测四边形自然比例。 */
export type WarpAspect = 'auto' | 'a4' | 'a4-landscape'

/** 输出比例对应的宽高比。 */
export const WARP_ASPECT_RATIOS: Record<Exclude<WarpAspect, 'auto'>, number> = {
  a4: 1 / Math.sqrt(2), // 竖版 A4：宽:高 = 1:1.414
  'a4-landscape': Math.sqrt(2),
}
