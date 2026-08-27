// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WaveformCanvas from '@/components/hermes/meeting/WaveformCanvas.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

interface FakeAnalyser {
  frequencyBinCount: number
  getByteFrequencyData: (arr: Uint8Array) => void
}

/**
 * The waveform canvas is the first piece of MeetingView we split out. It owns
 * its own RAF lifecycle: starting when an AnalyserNode is provided, stopping
 * when it goes back to null or the component unmounts. We don't need to render
 * real audio frames — we just confirm the contract:
 *
 *   - analyser = null at mount: no draw loop, no crash
 *   - analyser flips null → instance: draw loop starts (RAF scheduled)
 *   - analyser flips instance → null: draw loop stops (RAF cancelled)
 *   - unmount: draw loop stops, no leaked frames
 */
describe('WaveformCanvas', () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let rafId = 1

  beforeEach(() => {
    rafCallbacks = []
    rafId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafId++
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafCallbacks = []
    })

    // Provide a getContext stub: jsdom's canvas returns null
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      createLinearGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn(),
      }),
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeAnalyser(): FakeAnalyser {
    return {
      frequencyBinCount: 32,
      getByteFrequencyData: vi.fn(),
    }
  }

  it('mounts with analyser=null without scheduling any RAF', () => {
    const wrapper = mount(WaveformCanvas, {
      props: { analyser: null, connecting: false },
    })
    expect(rafCallbacks).toHaveLength(0)
    expect(wrapper.find('canvas').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows connecting overlay when connecting=true', () => {
    const wrapper = mount(WaveformCanvas, {
      props: { analyser: null, connecting: true },
    })
    expect(wrapper.find('.connecting-overlay').exists()).toBe(true)
    wrapper.unmount()
  })

  it('starts a draw loop when analyser flips from null to an instance', async () => {
    const wrapper = mount(WaveformCanvas, {
      props: { analyser: null, connecting: false },
    })
    await flushPromises()
    expect(rafCallbacks).toHaveLength(0)

    const analyser = makeAnalyser() as unknown as AnalyserNode
    await wrapper.setProps({ analyser })
    await flushPromises()
    // At least one RAF should be scheduled for the draw loop.
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1)

    wrapper.unmount()
  })

  it('stops the draw loop when analyser flips back to null', async () => {
    const analyser = makeAnalyser() as unknown as AnalyserNode
    const wrapper = mount(WaveformCanvas, {
      props: { analyser, connecting: false },
    })
    await flushPromises()
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1)

    await wrapper.setProps({ analyser: null })
    await flushPromises()
    // After null, no new RAF chain should be active.
    expect(rafCallbacks).toHaveLength(0)

    wrapper.unmount()
  })

  it('cancels the RAF on unmount (no leaked frames)', async () => {
    const analyser = makeAnalyser() as unknown as AnalyserNode
    const wrapper = mount(WaveformCanvas, {
      props: { analyser, connecting: false },
    })
    await flushPromises()
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1)

    wrapper.unmount()
    await flushPromises()
    // After unmount, the cancelAnimationFrame stub cleared the tracked set.
    expect(rafCallbacks).toHaveLength(0)
  })
})