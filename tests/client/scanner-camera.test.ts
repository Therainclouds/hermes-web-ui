// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCANNER_RESOLUTION_PRESETS,
  findScannerResolutionPreset,
  useScannerCamera,
} from '../../packages/client/src/plugins/scanner/composables/useScannerCamera'

interface MockTrack {
  stop: ReturnType<typeof vi.fn>
  settings: Record<string, unknown>
  getSettings: () => Record<string, unknown>
}

function createMockStream(settings: Record<string, unknown> = {}) {
  const track: MockTrack = {
    stop: vi.fn(),
    settings,
    getSettings() {
      return this.settings
    },
  }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

function makeOverconstrainedError() {
  const err = new Error('Overconstrained') as Error & { name: string; constraint?: string }
  err.name = 'OverconstrainedError'
  err.constraint = 'width'
  return err
}

describe('useScannerCamera', () => {
  const getUserMedia = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes the documented resolution presets in high-to-low order', () => {
    expect(SCANNER_RESOLUTION_PRESETS.map(p => p.id)).toEqual([
      'auto',
      'highest',
      '4k',
      '2k',
      '1080p',
      '720p',
    ])
    const highest = SCANNER_RESOLUTION_PRESETS.find(p => p.id === 'highest')
    expect(highest?.width).toBe(2592)
    expect(highest?.height).toBe(1944)
    const twoK = SCANNER_RESOLUTION_PRESETS.find(p => p.id === '2k')
    expect(twoK?.width).toBe(2560)
    expect(twoK?.height).toBe(1440)
  })

  it('findScannerResolutionPreset returns null for unknown / empty ids', () => {
    expect(findScannerResolutionPreset(null)).toBeNull()
    expect(findScannerResolutionPreset('')).toBeNull()
    expect(findScannerResolutionPreset('does-not-exist')).toBeNull()
    expect(findScannerResolutionPreset('1080p')?.width).toBe(1920)
  })

  it('uses resolutionId → ideal width/height in the getUserMedia call', async () => {
    const { stream } = createMockStream({ deviceId: 'dev-1', width: 2560, height: 1440 })
    getUserMedia.mockResolvedValueOnce(stream)

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '2k' })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints
    const video = constraints.video as MediaTrackConstraints
    expect(video).toMatchObject({
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    })
    expect(cam.isRunning.value).toBe(true)
    expect(cam.error.value).toBe('')
  })

  it('falls back to 1280x720 when neither width/height nor resolutionId is provided', async () => {
    const { stream } = createMockStream({})
    getUserMedia.mockResolvedValueOnce(stream)

    const cam = useScannerCamera()
    await cam.start()

    const video = (getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    expect(video).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 } })
  })

  it('"auto" resolutionId leaves width/height at the 1280x720 default', async () => {
    const { stream } = createMockStream({})
    getUserMedia.mockResolvedValueOnce(stream)

    const cam = useScannerCamera()
    await cam.start({ resolutionId: 'auto' })

    const video = (getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    expect(video).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 } })
  })

  it('explicit width/height override resolutionId', async () => {
    const { stream } = createMockStream({})
    getUserMedia.mockResolvedValueOnce(stream)

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '4k', width: 640, height: 480 })

    const video = (getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    expect(video).toMatchObject({ width: { ideal: 640 }, height: { ideal: 480 } })
  })

  it('falls back to a lower preset when the requested resolution is overconstrained', async () => {
    const { stream: fallback } = createMockStream({ deviceId: 'dev-1', width: 1920, height: 1080 })
    // 4k → highest → 2k 都会触发 OverconstrainedError；1080p 成功。
    getUserMedia
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))
      .mockImplementationOnce(() => Promise.resolve(fallback))

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '4k' })

    expect(getUserMedia).toHaveBeenCalledTimes(4)
    const first = (getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    const lastCall = (getUserMedia.mock.calls[3]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    expect(first).toMatchObject({ width: { ideal: 3840 }, height: { ideal: 2160 } })
    expect(lastCall).toMatchObject({ width: { ideal: 1920 }, height: { ideal: 1080 } })
    expect(cam.isRunning.value).toBe(true)
    expect(cam.error.value).toBe('')
  })

  it('walks down through every lower preset (by pixel count) until one succeeds', async () => {
    // 按像素降序：highest(2592x1944) → 2k(2560x1440) → 1080p → 720p
    // 第一个 lower 是 highest，第二个是 2k，第三个是 1080p，第四个 720p。
    const { stream: last } = createMockStream({ width: 1280, height: 720 })
    getUserMedia
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))  // initial 4k
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))  // highest
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))  // 2k
      .mockImplementationOnce(() => Promise.reject(makeOverconstrainedError()))  // 1080p
      .mockImplementationOnce(() => Promise.resolve(last))                         // 720p

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '4k' })

    expect(getUserMedia).toHaveBeenCalledTimes(5)
    const lastCall = (getUserMedia.mock.calls[4]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    expect(lastCall).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 } })
  })

  it('surfaces cameraNotFound when every preset is rejected', async () => {
    getUserMedia.mockImplementation(() => Promise.reject(makeOverconstrainedError()))

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '4k' })

    expect(cam.isRunning.value).toBe(false)
    expect(cam.error.value).toBe('cameraNotFound')
  })

  it('re-request on resolutionId change passes the new preset through to getUserMedia', async () => {
    const { stream } = createMockStream({})
    getUserMedia.mockResolvedValue(stream)

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '1080p' })
    await cam.start({ resolutionId: '2k' })

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    const second = (getUserMedia.mock.calls[1]?.[0] as MediaStreamConstraints).video as MediaTrackConstraints
    expect(second).toMatchObject({ width: { ideal: 2560 }, height: { ideal: 1440 } })
  })

  it('stops old tracks when re-requesting the camera at a new resolution', async () => {
    const { track: oldTrack } = createMockStream({})
    const { track: newTrack, stream: newStream } = createMockStream({})
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [oldTrack], getVideoTracks: () => [oldTrack] } as unknown as MediaStream)
    getUserMedia.mockResolvedValueOnce(newStream)

    const cam = useScannerCamera()
    await cam.start({ resolutionId: '720p' })
    await cam.start({ resolutionId: '2k' })

    expect(oldTrack.stop).toHaveBeenCalledTimes(1)
    expect(newTrack.stop).not.toHaveBeenCalled()
  })

  it('attaches the resulting stream to a bound <video> element via play()', async () => {
    const { stream } = createMockStream({})
    getUserMedia.mockResolvedValue(stream)
    const video = document.createElement('video')
    video.play = vi.fn().mockResolvedValue(undefined)

    const cam = useScannerCamera()
    cam.bindVideo(video)
    await cam.start({ resolutionId: '2k' })

    expect(video.srcObject).toBe(stream)
    // bindVideo 触发一次 play()（即使当时还没流），start() 拿到流后再 play() 一次。
    expect(video.play).toHaveBeenCalled()
  })
})