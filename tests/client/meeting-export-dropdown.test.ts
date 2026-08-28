// @vitest-environment jsdom
/**
 * Tests for the MeetingExportDropdown component.
 *
 * Focus on what we can assert deterministically in jsdom:
 *   - the right label renders for each scope
 *   - the buttons reflect the markdown-enabled state
 *   - the label switches to "exporting" while isExporting is true
 *
 * Click-driven behaviors (emit/exportAs wiring) are covered by manual
 * browser verification, since naive-ui's NButton inside jsdom does not
 * always route the native click back through Vue's listener pipeline
 * in a way that @vue/test-utils can observe. Asserting the visible
 * state keeps the test useful without flakiness.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const exportApi = vi.hoisted(() => ({
  isExporting: { value: false },
  exportAs: vi.fn(),
  exportAsDocx: vi.fn(),
  exportAsHtml: vi.fn(),
  exportAsMarkdown: vi.fn(),
}))

vi.mock('@/composables/useMeetingReportExport', () => ({
  useMeetingReportExport: () => exportApi,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MeetingExportDropdown from '@/components/hermes/meeting/MeetingExportDropdown.vue'

describe('MeetingExportDropdown', () => {
  beforeEach(() => {
    exportApi.isExporting.value = false
    exportApi.exportAs.mockReset()
    exportApi.exportAs.mockResolvedValue(undefined)
  })

  it('renders the exportWord label for the reportPanel scope by default', () => {
    const wrapper = mount(MeetingExportDropdown, {
      props: { markdown: '# hi', title: 'Sprint', scope: 'reportPanel' },
    })
    expect(wrapper.html()).toContain('meeting.reportPanel.exportWord')
  })

  it('uses the speechEval scope keys when scope="speechEval"', () => {
    const wrapper = mount(MeetingExportDropdown, {
      props: { markdown: '# hi', title: 'Eval', scope: 'speechEval' },
    })
    expect(wrapper.html()).toContain('meeting.speechEval.exportWord')
  })

  it('disables both buttons when markdown is empty', () => {
    const wrapper = mount(MeetingExportDropdown, {
      props: { markdown: '', title: 'Empty', scope: 'reportPanel' },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    buttons.forEach(btn => {
      const disabledAttr = btn.attributes('disabled')
      const cls = btn.classes()
      // Naive UI uses either the disabled attribute or the n-button--disabled class.
      expect(disabledAttr !== undefined || cls.some(c => c.includes('disabled'))).toBe(true)
    })
  })

  it('renders two clickable buttons when markdown is present', () => {
    const wrapper = mount(MeetingExportDropdown, {
      props: { markdown: '# hi', title: 'Sprint', scope: 'reportPanel' },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    buttons.forEach(btn => {
      const disabledAttr = btn.attributes('disabled')
      const cls = btn.classes()
      expect(disabledAttr === undefined && !cls.some(c => c.includes('disabled'))).toBe(true)
    })
  })

  it('shows the exporting label when isExporting is true', () => {
    exportApi.isExporting.value = true
    const wrapper = mount(MeetingExportDropdown, {
      props: { markdown: '# hi', title: 'Sprint', scope: 'reportPanel' },
    })
    expect(wrapper.html()).toContain('meeting.reportPanel.exporting')
    expect(wrapper.html()).not.toContain('>meeting.reportPanel.exportWord<')
  })
})