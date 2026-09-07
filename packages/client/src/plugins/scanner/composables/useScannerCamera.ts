import { onUnmounted, ref, shallowRef } from 'vue'

/**
 * 摄像头采集 composable。
 *
 * 通过 `navigator.mediaDevices.getUserMedia({ video: true })` 访问 UVC USB
 * 摄像头（UVC = USB Video Class，几乎所有 USB 摄像头、内置摄像头都按这个
 * class 暴露给操作系统）。UVC 在浏览器里无需特殊驱动；只要 https/localhost
 * 上下文 + 浏览器/系统授权即可。
 *
 * 移动端（手机 / 平板）默认按 `facingMode: 'environment'` 申请后置摄像头，
 * 适合拍文档/发票；通过 `setFacingMode('user')` 或 UI 上的「翻转」按钮
 * 切换前置。桌面端该参数被忽略，UVC 摄像头没有 facingMode 概念。
 *
 * 用法：
 *   const cam = useScannerCamera()
 *   await cam.start()                       // 打开默认摄像头
 *   await cam.start({ deviceId })           // 切换到指定设备
 *   cam.bindVideo(videoEl)                  // 把流绑到 <video>
 *   const { dataUrl } = await cam.snapshot() // 拍一张 JPEG
 *   cam.stop()
 */

export type ScannerFacingMode = 'environment' | 'user' | 'auto'

/**
 * 摄像头分辨率预设。`id` 给 UI 绑定用；`width`/`height` 通过
 * `getUserMedia({ video: { width: { ideal }, height: { ideal } } })`
 * 传给浏览器，浏览器会从设备支持的 UVC 帧格式里选最接近的一档。
 * 预设按"画质优先 → 性能优先"排列，便于下拉里默认从高到低展示。
 *
 * `auto` 不传 width/height，让浏览器/驱动挑默认档（多数 UVC 摄像头
 * 默认返回 640×480 或 1280×720）。
 *
 * `highest` 是 2592×1944——大多数 4:3 模式的 UVC 摄像头（包括 16MP
 * 传感器以"视频模式"暴露时）的常见上限；用它作"尽量清晰"档，比
 * 把 `width/height` 留空（→ 1280×720）清晰度高得多，又比强制 4K
 * 失败率低。
 */
export interface ScannerResolutionPreset {
  id: string
  labelKey: string
  width: number
  height: number
}

export const SCANNER_RESOLUTION_PRESETS: ScannerResolutionPreset[] = [
  { id: 'auto', labelKey: 'scanner.camera.resolutionAuto', width: 0, height: 0 },
  { id: 'highest', labelKey: 'scanner.camera.resolutionHighest', width: 2592, height: 1944 },
  { id: '4k', labelKey: 'scanner.camera.resolution4k', width: 3840, height: 2160 },
  { id: '2k', labelKey: 'scanner.camera.resolution2k', width: 2560, height: 1440 },
  { id: '1080p', labelKey: 'scanner.camera.resolution1080p', width: 1920, height: 1080 },
  { id: '720p', labelKey: 'scanner.camera.resolution720p', width: 1280, height: 720 },
]

export function findScannerResolutionPreset(id: string | null | undefined): ScannerResolutionPreset | null {
  if (!id) return null
  return SCANNER_RESOLUTION_PRESETS.find(p => p.id === id) ?? null
}

export interface ScannerCameraOptions {
  /** 指定 videoinput 设备 id；缺省用浏览器默认。 */
  deviceId?: string
  /** 期望分辨率（用于 IDE-like 选择器）。 */
  width?: number
  height?: number
  /**
   * 预设分辨率 id（如 '2k' / '1080p' / 'auto'）。与显式
   * `width`/`height` 同时传时，width/height 优先；找不到对应 id
   * 时自动忽略。
   */
  resolutionId?: string
  /**
   * 移动端希望使用的镜头方向：
   *   - 'environment' = 后置（文档扫描推荐）
   *   - 'user'        = 前置（自拍/远程展示）
   *   - 'auto'        = 浏览器默认（PC / UVC 摄像头）
   */
  facingMode?: ScannerFacingMode
}

export interface ScannerSnapshot {
  /** data:image/jpeg;base64,… */
  dataUrl: string
  /** 原图尺寸 */
  width: number
  height: number
}

export interface ScannerCameraState {
  isStarting: boolean
  isRunning: boolean
  error: string
  deviceId: string
  hasStream: boolean
  facingMode: ScannerFacingMode
}

export function useScannerCamera() {
  const stream = shallowRef<MediaStream | null>(null)
  const isStarting = ref(false)
  const isRunning = ref(false)
  const error = ref('')
  const deviceId = ref('')
  const facingMode = ref<ScannerFacingMode>('environment')
  const attachedVideo = shallowRef<HTMLVideoElement | null>(null)

  /** 上一次 start() 调用使用的约束，便于 devicechange / flip 后重建。 */
  let lastOpts: ScannerCameraOptions = {}

  function detachVideo() {
    const video = attachedVideo.value
    if (video) video.srcObject = null
    attachedVideo.value = null
  }

  function bindVideo(video: HTMLVideoElement | null) {
    if (video) {
      attachedVideo.value = video
      video.srcObject = stream.value
      video.play().catch(() => undefined)
    }
  }

  async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter(d => d.kind === 'videoinput')
    } catch {
      return []
    }
  }

  /** 当前 Track 的实际 facingMode（部分 UVC/桌面设备返回空串）。 */
  function currentTrackFacing(): string {
    const track = stream.value?.getVideoTracks()[0]
    if (!track) return ''
    const settings = track.getSettings?.() ?? {}
    return String(settings.facingMode ?? '')
  }

  /** 切换前后摄像头（仅在同时存在两个镜头时生效）。 */
  async function setFacingMode(next: ScannerFacingMode): Promise<void> {
    if (next === facingMode.value) return
    facingMode.value = next
    if (isRunning.value) {
      // 用新方向重新请求流；保留 deviceId 以便桌面 UVC 设备不被误切换。
      await start({ ...lastOpts, facingMode: next })
    }
  }

  /** 一键翻转：environment ↔ user。auto 时按 'user' 当作 fallback。 */
  async function flipCamera(): Promise<void> {
    const next: ScannerFacingMode = facingMode.value === 'environment' ? 'user' : 'environment'
    await setFacingMode(next)
  }

  /**
   * 把当前 `lastOpts` + 临时覆写解析成 `width/height`。显式传入的
   * `width/height` 优先；缺省时按 `resolutionId` 查预设；都没有就
   * 退回 `1280×720`（与旧行为一致）。
   */
  function resolveTargetSize(override?: ScannerCameraOptions): { width: number; height: number } {
    const src = override ?? lastOpts
    if (src.width && src.height) return { width: src.width, height: src.height }
    const preset = findScannerResolutionPreset(src.resolutionId)
    if (preset && preset.width > 0 && preset.height > 0) {
      return { width: preset.width, height: preset.height }
    }
    return { width: 1280, height: 720 }
  }

  /**
   * 申请一个 MediaStream；若 `OverconstrainedError` 且请求源自某个
   * 分辨率预设，按像素数从高到低逐档降级重试，确保低端摄像头不会因为
   * 用户选了 `4K` 直接失败。降级成功后会更新 `lastOpts`，下次 start()
   * 默认按这档走。
   *
   * 全失败时抛出原始错误，由 `start()` 的外层 catch 转成 `error.value`。
   */
  async function acquireStream(
    constraints: MediaStreamConstraints,
    opts: ScannerCameraOptions,
  ): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err: any) {
      const isOverconstrained = err?.name === 'OverconstrainedError'
        || err?.name === 'NotFoundError'
      if (!isOverconstrained) throw err
      const preset = opts.resolutionId ? findScannerResolutionPreset(opts.resolutionId) : null
      const currentPixels = preset && preset.width > 0
        ? preset.width * preset.height
        : -1
      // 按像素数从高到低排序，跳过 `auto`（width/height 都为 0）和当前预设。
      const fallbacks = SCANNER_RESOLUTION_PRESETS
        .filter(p => p.width > 0 && p.height > 0 && (currentPixels < 0 || p.width * p.height < currentPixels))
        .sort((a, b) => b.width * b.height - a.width * a.height)
      if (fallbacks.length === 0) throw err
      for (const lower of fallbacks) {
        try {
          const fallbackConstraints: MediaStreamConstraints = {
            audio: false,
            video: {
              ...(constraints.video as MediaTrackConstraints),
              width: { ideal: lower.width },
              height: { ideal: lower.height },
            },
          }
          const stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints)
          // 同步回写：下次 devicechange / flipCamera 按这档走。
          lastOpts = {
            ...lastOpts,
            resolutionId: lower.id,
            width: lower.width,
            height: lower.height,
          }
          return stream
        } catch {
          continue
        }
      }
      throw err
    }
  }

  async function start(opts: ScannerCameraOptions = {}): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      error.value = 'cameraUnavailable'
      return
    }
    if (opts.facingMode) facingMode.value = opts.facingMode
    lastOpts = { ...opts }
    isStarting.value = true
    error.value = ''
    try {
      const { width, height } = resolveTargetSize(opts)
      const videoConstraint: MediaTrackConstraints = {
        width: { ideal: width },
        height: { ideal: height },
      }
      if (opts.deviceId) {
        videoConstraint.deviceId = { exact: opts.deviceId }
      } else if (facingMode.value !== 'auto') {
        // 注意：deviceId 与 facingMode 互斥；指定设备时不传 facingMode。
        videoConstraint.facingMode = { ideal: facingMode.value }
      }
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: videoConstraint,
      }
      const next = await acquireStream(constraints, opts)
      // 关闭旧流
      stream.value?.getTracks().forEach(track => track.stop())
      stream.value = next
      const track = next.getVideoTracks()[0]
      const trackSettings = track?.getSettings?.() ?? {}
      deviceId.value = trackSettings.deviceId || opts.deviceId || ''
      // 部分浏览器忽略 facingMode ideal，回写真实值供 UI 显示。
      const actualFacing = trackSettings.facingMode
      if (typeof actualFacing === 'string' && (actualFacing === 'user' || actualFacing === 'environment')) {
        facingMode.value = actualFacing
      }
      isRunning.value = true
      // 绑定到已挂载的 <video>
      const video = attachedVideo.value
      if (video) {
        video.srcObject = next
        // iOS Safari：必须在用户手势内 play()，否则视频会卡在第一帧。
        await video.play().catch(() => undefined)
      }
    } catch (err: any) {
      const name = err?.name || ''
      error.value =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'cameraDenied'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'cameraNotFound'
            : name === 'NotReadableError' || name === 'TrackStartError'
              ? 'cameraInUse'
              : name === 'AbortError'
                ? 'cameraError'
                : 'cameraError'
    } finally {
      isStarting.value = false
    }
  }

  function stop(): void {
    stream.value?.getTracks().forEach(track => track.stop())
    stream.value = null
    isRunning.value = false
    detachVideo()
  }

  /**
   * 注册 devicechange 监听器：当用户热插拔 USB 摄像头 / 系统授予新设备权限时
   * 触发回调（典型场景：先打开页面再插 UVC 摄像头）。仅在支持的环境调用，
   * 老 Safari / 微信内置浏览器无 navigator.mediaDevices.addEventListener 时
   * 直接返回 false，调用方按需忽略。
   */
  function onDeviceChange(handler: () => void): () => void {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) {
      return () => undefined
    }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
  }

  /**
   * 从当前视频流拍一张 JPEG。
   * - 长边限制 2400 px，控制 base64 payload 不至于过大；
   * - 默认 0.92 质量，可由调用方覆盖。
   */
  async function snapshot(quality = 0.92, maxEdge = 2400): Promise<ScannerSnapshot | null> {
    const video = attachedVideo.value
    if (!video || !stream.value) return null
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return null
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, width, height)
    try {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      return { dataUrl, width, height }
    } catch {
      return null
    }
  }

  onUnmounted(stop)

  return {
    isStarting,
    isRunning,
    error,
    deviceId,
    facingMode,
    stream,
    listVideoInputs,
    start,
    stop,
    bindVideo,
    snapshot,
    setFacingMode,
    flipCamera,
    onDeviceChange,
    currentTrackFacing,
  }
}

export type ScannerCamera = ReturnType<typeof useScannerCamera>
