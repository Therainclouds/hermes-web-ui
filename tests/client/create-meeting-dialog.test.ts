// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

// NModal from naive-ui uses <Teleport> to render into document.body.
// We mount with attachTo so the modal mounts into a detached DOM node we can
// query via document.body.innerHTML.

import CreateMeetingDialog from '@/components/hermes/meeting/CreateMeetingDialog.vue'

function mountInDialog(props: Record<string, unknown>, slots?: Record<string, string>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(CreateMeetingDialog, {
    props,
    slots,
    attachTo: host,
  })
  return { wrapper, host }
}

describe('CreateMeetingDialog', () => {
  let host: HTMLDivElement | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function freshMount(props: Record<string, unknown>, slots?: Record<string, string>) {
    host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(CreateMeetingDialog, { props, slots, attachTo: host })
    return wrapper
  }

  it('renders the default slot inside the modal body', () => {
    freshMount(
      { visible: true, createDisabled: false },
      { default: '<p class="dialog-content">hello</p>' },
    )
    expect(document.body.innerHTML).toContain('hello')
    expect(document.body.innerHTML).toContain('dialog-content')
  })

  it('emits create when the create button is clicked and not disabled', async () => {
    const wrapper = freshMount({ visible: true, createDisabled: false })
    const buttons = document.body.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'meeting.create')
    expect(createBtn).toBeDefined()
    createBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('create')).toBeTruthy()
  })

  it('disables the create button when createDisabled is true', () => {
    freshMount({ visible: true, createDisabled: true })
    const buttons = document.body.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'meeting.create')
    expect(createBtn).toBeDefined()
    expect((createBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('emits update:visible=false when the cancel button is clicked', async () => {
    const wrapper = freshMount({ visible: true, createDisabled: false })
    const buttons = document.body.querySelectorAll('button')
    const cancelBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'common.cancel')
    expect(cancelBtn).toBeDefined()
    cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('update:visible')).toEqual([[false]])
  })

  it('does not render modal content when visible=false', () => {
    freshMount({ visible: false, createDisabled: false })
    // NModal hides its body when not visible; default button text "meeting.create"
    // should not appear in the DOM.
    const buttons = document.body.querySelectorAll('button')
    const visibleCreateBtn = Array.from(buttons).find(
      (b) => b.textContent?.trim() === 'meeting.create',
    )
    expect(visibleCreateBtn).toBeUndefined()
  })
})