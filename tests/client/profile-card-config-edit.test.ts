// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'

const routerPush = vi.hoisted(() => vi.fn())

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: routerPush }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" type="button" @click="$emit(\'click\')"><slot /></button>',
  }),
  NTag: defineComponent({
    template: '<span><slot /></span>',
  }),
  NSpin: defineComponent({
    template: '<div><slot /></div>',
  }),
  NModal: { template: '<div class="n-modal-stub"><slot /></div>' },
  NForm: { template: '<form class="n-form-stub"><slot /></form>' },
  NFormItem: { template: '<div class="n-form-item-stub"><slot /></div>' },
  NInput: { template: '<input class="n-input-stub" />', emits: ['update:value'] },
  NText: { template: '<span class="n-text-stub"><slot /></span>' },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

import ProfileCard from '@/components/hermes/profiles/ProfileCard.vue'

describe('ProfileCard config edit affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes to the scoped config editor for that profile', async () => {
    const wrapper = mount(ProfileCard, {
      props: {
        profile: {
          name: 'reviewer',
          active: false,
          model: 'gpt-5.4',
          alias: 'reviewer',
          avatar: null,
        },
      },
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs: {
          ProfileAvatar: { template: '<span class="profile-avatar-stub" />' },
        },
      },
    })

    await wrapper.get('.card-actions .n-button-stub').trigger('click')

    expect(routerPush).toHaveBeenCalledWith({
      name: 'hermes.files',
      query: {
        profile: 'reviewer',
        file: 'config.yaml',
      },
    })
  })
})
