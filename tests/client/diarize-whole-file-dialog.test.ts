// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { NInput } from 'naive-ui'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => `i18n:${key}` }),
}))

import DiarizeWholeFileDialog from '@/components/hermes/meeting/DiarizeWholeFileDialog.vue'

function mountDialog(overrides: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(DiarizeWholeFileDialog, {
    attachTo: host,
    props: {
      visible: true,
      defaultEngine: 'minimax',
      defaultSpeakerCount: 0,
      minimaxKeyAvailable: true,
      dashscopeKeyAvailable: true,
      oss: {},
      busy: false,
      ...overrides,
    },
  })
  return wrapper
}

/** The OSS block renders NInputs in a fixed order: bucket / id / secret / endpoint / prefix. */
function ossInputs(wrapper: ReturnType<typeof mountDialog>) {
  return wrapper.findAllComponents(NInput)
}

async function setOss(wrapper: ReturnType<typeof mountDialog>, bucket: string, id: string, secret: string) {
  const inputs = ossInputs(wrapper)
  expect(inputs.length).toBeGreaterThanOrEqual(3)
  await inputs[0].vm.$emit('update:value', bucket)
  await inputs[1].vm.$emit('update:value', id)
  await inputs[2].vm.$emit('update:value', secret)
}

/** NModal teleports its content to document.body, so query it directly. */
function bodyText(): string {
  return document.body.textContent || ''
}

function hasOssBlock(): boolean {
  return !!document.body.querySelector('.oss-config-details')
}

function startButton(): HTMLButtonElement {
  const btn = Array.from(document.body.querySelectorAll('button'))
    .find(b => b.textContent?.trim() === 'i18n:meeting.diarizeStart')
  if (!btn) throw new Error('start button not found')
  return btn as HTMLButtonElement
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DiarizeWholeFileDialog', () => {
  it('offers both engines and requires no OSS for MiniMax', () => {
    const wrapper = mountDialog()
    expect(bodyText()).toContain('i18n:meeting.asrProviderMinimax')
    expect(bodyText()).toContain('i18n:meeting.asrProviderDashscope')
    // no OSS block for MiniMax
    expect(hasOssBlock()).toBe(false)
    expect(startButton().disabled).toBe(false)
  })

  it('requires OSS credentials before starting the Qwen engine', async () => {
    const wrapper = mountDialog({ defaultEngine: 'qwen' })
    expect(hasOssBlock()).toBe(true)
    expect(bodyText()).toContain('i18n:meeting.diarizeQwenNeedsOss')
    expect(bodyText()).toContain('i18n:meeting.diarizeQwenOssRequired')
    expect(startButton().disabled).toBe(true)

    await setOss(wrapper, 'my-bucket', 'ak-id', 'ak-secret')
    expect(startButton().disabled).toBe(false)
  })

  it('emits the chosen engine, speaker count and OSS config', async () => {
    const wrapper = mountDialog({ defaultEngine: 'qwen' })
    await setOss(wrapper, 'my-bucket', 'ak-id', 'ak-secret')
    startButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('start')).toHaveLength(1)
    expect(wrapper.emitted('start')![0][0]).toEqual({
      engine: 'qwen',
      speakerCount: 0,
      oss: {
        bucket: 'my-bucket',
        accessKeyId: 'ak-id',
        accessKeySecret: 'ak-secret',
        endpoint: 'oss-cn-beijing.aliyuncs.com',
        pathPrefix: 'meeting-asr-uploads/',
      },
    })
  })

  it('pre-fills the OSS form from the stored config so a saved setup just works', () => {
    const wrapper = mountDialog({
      defaultEngine: 'qwen',
      oss: {
        bucket: 'saved-bucket',
        accessKeyId: 'saved-id',
        accessKeySecret: 'saved-secret',
        endpoint: 'oss-cn-shanghai.aliyuncs.com',
        pathPrefix: 'meetings/',
      },
    })
    expect(startButton().disabled).toBe(false)
    const values = ossInputs(wrapper).map(i => i.props('value'))
    expect(values.slice(0, 3)).toEqual(['saved-bucket', 'saved-id', 'saved-secret'])
  })

  it('blocks the engine whose API key is missing and explains why', () => {
    const wrapper = mountDialog({ minimaxKeyAvailable: false })
    expect(bodyText()).toContain('i18n:meeting.diarizeNoMinimaxKey')
    expect(startButton().disabled).toBe(true)
    expect(wrapper.emitted('start')).toBeUndefined()
  })

  it('disables starting while a transcription is already running', () => {
    mountDialog({ busy: true })
    expect(startButton().disabled).toBe(true)
  })

  it('only asks for a speaker count for the Qwen engine', async () => {
    const wrapper = mountDialog({ defaultEngine: 'qwen' })
    expect(bodyText()).toContain('i18n:meeting.speakerCount')
    await wrapper.setProps({ visible: false })
    await wrapper.setProps({ visible: true, defaultEngine: 'minimax' })
    expect(bodyText()).not.toContain('i18n:meeting.speakerCount')
  })
})
