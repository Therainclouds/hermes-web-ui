// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WritingSettingsEditor from '../../packages/client/src/plugins/trpg/WritingSettingsEditor.vue'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
import { parseWritingSettings, selectWritingModel } from '../../packages/shared/trpg-writing'
import { snapshotCampaign, emptyCampaign } from '../../packages/client/src/plugins/trpg/storage'
import { writingCatalog } from '../../packages/client/src/plugins/trpg/writing-catalog'
describe('shared writing model settings', () => {
  it('stores only identities and uses stage override then shared default', () => {
    const settings = parseWritingSettings({ defaultModel: { model: 'writer', provider: 'custom', apiKey: 'SECRET' }, stages: { review: { model: 'judge', provider: 'custom', baseUrl: 'SECRET' } }, apiKey: 'SECRET' })
    expect(JSON.stringify(settings)).not.toContain('SECRET')
    expect(selectWritingModel(settings, 'write')?.model).toBe('writer')
    expect(selectWritingModel(settings, 'review')?.model).toBe('judge')
    expect(selectWritingModel({}, 'extract')).toBeUndefined()
    expect(snapshotCampaign({ ...emptyCampaign(), writingSettings: settings }).writingSettings).toEqual(settings)
  })
  it('rejects broken models and unknown stages; catalog excludes disabled entries', () => {
    expect(() => parseWritingSettings({ stages: { invented: {} } })).toThrow()
    expect(() => parseWritingSettings({ defaultModel: { model: 'writer' } })).toThrow()
    expect(writingCatalog({ groups: [{ provider: 'custom', apiKey: 'SECRET', models: ['writer', 'disabled', 'writer'], model_meta: { disabled: { disabled: true } } }] })).toEqual([{ provider: 'custom', model: 'writer' }])
  })
})

it('renders saved models regardless of JSON object key order', async () => {
  const wrapper = mount(WritingSettingsEditor, { props: { modelValue: { defaultModel: { model: 'writer', provider: 'custom' } }, catalog: [{ provider: 'custom', model: 'writer' }] } })
  expect(wrapper.get('select').element.value).toBe(JSON.stringify(['custom', 'writer']))
  await wrapper.get('select').setValue('')
  expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({ defaultModel: undefined })
  wrapper.unmount()
})
it('exposes economy mode in both simple and advanced settings and persists it', async () => {
  expect(() => parseWritingSettings({ economy: 'yes' })).toThrow()
  expect(snapshotCampaign({ ...emptyCampaign(), writingSettings: { economy: true } }).writingSettings?.economy).toBe(true)
  for (const advanced of [false, true]) {
    const wrapper = mount(WritingSettingsEditor, { props: { modelValue: {}, advanced } })
    await wrapper.get('input[type=checkbox]').setValue(true)
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({ economy: true })
    wrapper.unmount()
  }
})
