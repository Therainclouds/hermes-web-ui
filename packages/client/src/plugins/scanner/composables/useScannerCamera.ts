import { onUnmounted, ref, shallowRef } from 'vue'

/**
 * 摄像头采集 composable。
 *
 * 通过 `navigator.mediaDevices.getUserMedia({ video: true })` 访问 UVC USB
 * 摄像头（UVC = USB Video Class，几乎所有 USB 摄像头、内置摄像头都按这个
 * class 暴露给操作系统）。UVC 在浏览器里无需特殊驱动；只要 https/localhost
 * 上下文 + 浏览器/系统授权即可。
 *
 * 用法：
 *   const cam = useScannerCamera()
 *   await cam.start()                       // 打开默认摄像头
 *   await cam.start({ deviceId })           // 切换到指定设备
 *   cam.attach(videoEl)                     // 把流绑到 <video>
 *   const { dataUrl } = await cam.snapshot() // 拍一张 JPEG
 *   cam.stop()
 */

export interface ScannerCameraOptions {
  /** 指定 videoinput 设备 id；缺省用浏览器默认。 */
  deviceId?: string
  /** 期望分辨率（用于 IDE-like 选择器）。 */
  width?: number
  height?: number
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
}

export function useScannerCamera() {
  const stream = shallowRef<MediaStream | null>(null)
  const isStarting = ref(false)
  const isRunning = ref(false)
  const error = ref('')
  const deviceId = ref('')
  const attachedVideo = shallowRef<HTMLVideoElement | null>(null)

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

  async function start(opts: ScannerCameraOptions = {}): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      error.value = 'cameraUnavailable'
      return
    }
    if (isStarting.value || isRunning.value) return
    isStarting.value = true
    error.value = ''
    try {
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          width: { ideal: opts.width || 1280 },
          height: { ideal: opts.height || 720 },
        },
      }
      const next = await navigator.mediaDevices.getUserMedia(constraints)
      // 关闭旧流
      stream.value?.getTracks().forEach(track => track.stop())
      stream.value = next
      const track = next.getVideoTracks()[0]
      deviceId.value = track?.getSettings()?.deviceId || opts.deviceId || ''
      isRunning.value = true
      // 绑定到已挂载的 <video>
      const video = attachedVideo.value
      if (video) {
        video.srcObject = next
        await video.play().catch(() => undefined)
      }
    } catch (err: any) {
      error.value = err?.name === 'NotAllowedError'
        ? 'cameraDenied'
        : err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError'
          ? 'cameraNotFound'
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
    stream,
    listVideoInputs,
    start,
    stop,
    bindVideo,
    snapshot,
  }
}

export type ScannerCamera = ReturnType<typeof useScannerCamera>
