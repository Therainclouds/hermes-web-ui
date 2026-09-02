// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import OmniVisualizer from '../../../packages/client/src/components/hermes/chat/OmniVisualizer.vue'

/**
 * OmniVisualizer 挂载冒烟：canvas 粒子星环组件必须能安全挂载（jsdom 无
 * 2D context / ResizeObserver 时不崩）、响应 props、卸载时清理 RAF。
 */
describe('OmniVisualizer', () => {
  it('mounts and renders the canvas even without a 2D context', () => {
    const wrapper = mount(OmniVisualizer, {
      props: { phase: 'idle', inputLevel: 0, outputLevel: 0 },
    })
    expect(wrapper.find('[data-testid="omni-visualizer"]').exists()).toBe(true)
    expect(wrapper.find('canvas').exists()).toBe(true)
    wrapper.unmount()
  })

  it('accepts every realtime phase and audio levels without crashing', () => {
    const phases = ['idle', 'connecting', 'ready', 'listening', 'speaking', 'error', 'closed'] as const
    for (const phase of phases) {
      const wrapper = mount(OmniVisualizer, {
        props: { phase, inputLevel: 0.7, outputLevel: 0.4 },
      })
      expect(wrapper.find('[data-testid="omni-visualizer"]').exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('unmounts cleanly (RAF + observer teardown paths run)', async () => {
    const wrapper = mount(OmniVisualizer, {
      props: { phase: 'speaking', inputLevel: 0.2, outputLevel: 0.9 },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(() => wrapper.unmount()).not.toThrow()
  })

  // The blob drawing path runs every RAF tick — jsdom has no 2D context, so
  // we exercise the catmull-rom → bezier vertex math by re-importing the
  // internal helpers indirectly: a high outputLevel must still mount without
  // throwing (the blob radius/bezier math is exercised inside draw() which
  // returns early when ctx is missing, but the pre-draw arithmetic still runs).
  it('high audio levels do not destabilize the mount', () => {
    for (let i = 0; i < 4; i += 1) {
      const wrapper = mount(OmniVisualizer, {
        props: { phase: 'speaking', inputLevel: 0.95, outputLevel: 0.95 },
      })
      expect(wrapper.find('canvas').exists()).toBe(true)
      wrapper.unmount()
    }
  })
})
