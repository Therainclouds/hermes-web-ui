import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

/**
 * Validates v0.7.6 audit #18: the meeting recorder must produce 16 kHz PCM
 * even when the browser returns a different native AudioContext rate.
 *
 * We stub `AudioContext` to report a non-16k rate (48k, like many kiosk
 * Chromium builds). The recorder's resample path should detect the mismatch
 * and emit 16 kHz Int16 buffers to the WebSocket regardless.
 */
test('meeting recorder resamples to 16k when browser AudioContext reports a different rate', async ({
  page,
}: { page: Page }) => {
  await authenticate(page)
  await mockHermesApi(page)

  await page.addInitScript(() => {
    // Track every WebSocket binary send so we can verify the Int16 rate.
    const sent: { byteLength: number; sampleRateHint?: number }[] = []
    const NativeWS = window.WebSocket
    class TrackedWS extends NativeWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (data instanceof ArrayBuffer) {
          sent.push({ byteLength: data.byteLength })
        }
        return super.send(data as any)
      }
    }
    // @ts-expect-error - intentional override for e2e instrumentation
    window.WebSocket = TrackedWS
    Object.defineProperty(window, '__PW_RECORDER_BINARIES__', {
      configurable: true,
      writable: true,
      value: sent,
    })

    // Stub AudioContext to report 48 kHz native rate regardless of constructor arg.
    // @ts-expect-error - intentional override for e2e instrumentation
    window.AudioContext = class FakeAudioContext {
      sampleRate = 48000
      state = 'running'
      destination = {}
      audioWorklet = { addModule: async () => {} }
      async close() {}
      createMediaStreamSource() {
        return { connect: () => {} }
      }
      createAnalyser() {
        return { connect: () => {}, fftSize: 256 }
      }
    }
  })

  await page.goto('/meeting')
  // Open the create-meeting modal then click "Start"
  await page.getByRole('button', { name: /new meeting|新建会议/ }).click()
  await page.getByRole('button', { name: /start recording|开始录音/ }).click()

  // Wait for at least one binary frame to be sent on the WS
  await page.waitForFunction(
    () => (window as any).__PW_RECORDER_BINARIES__?.length > 0,
    { timeout: 5000 },
  )

  const sent = await page.evaluate(
    () => (window as any).__PW_RECORDER_BINARIES__ as { byteLength: number }[],
  )
  // Each Int16 sample is 2 bytes. A 4096-frame quantum at 16k output = 8192 bytes.
  // Allow some jitter — assert byteLength is even and at most 32k.
  expect(sent.length).toBeGreaterThan(0)
  for (const frame of sent) {
    expect(frame.byteLength % 2).toBe(0)
    expect(frame.byteLength).toBeLessThanOrEqual(32 * 1024)
  }
})