// 场景面板挂载助手：统一处理 store 种子与全局 mock 的装配。
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

export function mountPanel(
  component: any,
  sessionId: string,
  extraProps: Record<string, unknown> = {},
) {
  const wrapper = mount(component, {
    props: {
      sessionId,
      isRecording: false,
      ...extraProps,
    },
  })
  return wrapper
}

export async function flush(times = 2) {
  for (let i = 0; i < times; i++) await nextTick()
}
