import { beforeEach, expect, it, vi } from 'vitest'
const config = vi.hoisted(() => vi.fn())
const runtime = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/services/config-helpers', () => ({ readConfigYamlForProfile: config }))
vi.mock('../../packages/server/src/services/ekko-agent/provider-runtime', () => ({ resolveEkkoProviderRuntimeConfig: runtime }))
import { resolveMcuModelFields } from '../../packages/server/src/services/global-agent/mcu-agent-runtime'
beforeEach(() => { config.mockReset(); runtime.mockReset() })
it('selects the MCU profile model explicitly without putting credentials into the event', async () => {
  config.mockResolvedValue({ model: { provider: 'minimax-cn', default: 'MiniMax-M3' } })
  runtime.mockResolvedValue({ apiMode: 'anthropic_messages', apiKey: 'secret' })
  expect(await resolveMcuModelFields('research', 'ekko')).toEqual({ provider: 'minimax-cn', model: 'MiniMax-M3', apiMode: 'anthropic_messages' })
  expect(config).toHaveBeenCalledWith('research')
})
it('fails an unconfigured model rather than issuing an incomplete run', async () => {
  config.mockResolvedValue({})
  runtime.mockResolvedValue({})
  await expect(resolveMcuModelFields('empty', 'ekko')).rejects.toThrow(/required/)
})
it('leaves Hermes runtime selection to its own pipeline', async () => {
  expect(await resolveMcuModelFields('research', 'hermes')).toEqual({})
  expect(config).not.toHaveBeenCalled()
})
