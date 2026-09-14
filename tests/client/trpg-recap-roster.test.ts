// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ campaignStorage: vi.fn() }))
vi.mock('../../packages/client/src/plugins/trpg/storage', () => ({
  campaignStorage: mocks.campaignStorage,
}))
import { loadRoster } from '../../packages/client/src/plugins/trpg/roster'
import { campaignStorageKey } from '../../packages/client/src/plugins/trpg/bookApi'

beforeEach(() => {
  localStorage.clear()
  mocks.campaignStorage.mockReset()
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:avatar-1'), revokeObjectURL: vi.fn() })
})

describe('reader roster', () => {
  it('reads avatars and sheet stats from the panel campaign record', async () => {
    mocks.campaignStorage.mockResolvedValue({
      characters: [
        {
          id: 'elf',
          name: '银月',
          player: '小林',
          appearance: '银发精灵',
          image: new Blob(['avatar']),
          sheet: { strength: '14', dexterity: '16', classLevel: '游侠 3' },
        },
        { id: 'ghost', name: '  ', player: '', appearance: '', sheet: {} },
      ],
    })
    const roster = await loadRoster('meeting', [{ id: 'elf', name: '银月', player: '小林' }])
    expect(roster.members).toHaveLength(1)
    expect(roster.members[0]).toMatchObject({
      id: 'elf',
      name: '银月',
      player: '小林',
      appearance: '银发精灵',
      imageUrl: 'blob:avatar-1',
    })
    expect(roster.members[0].sheet).toMatchObject({ strength: '14', dexterity: '16', classLevel: '游侠 3' })
    roster.revoke()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1')
  })

  it('falls back to the recap roster when no local cards exist', async () => {
    mocks.campaignStorage.mockRejectedValue(new Error('indexeddb unavailable'))
    const roster = await loadRoster('meeting', [{ id: 'elf', name: '银月', player: '小林' }])
    expect(roster.members).toEqual([
      { id: 'elf', name: '银月', player: '小林', appearance: '', sheet: {}, imageUrl: null },
    ])
  })

  it('reproduces the exact IndexedDB key the TRPG panel writes', () => {
    localStorage.setItem('hermes_server_url', 'https://example.test')
    localStorage.setItem('hermes_active_profile_name', 'table')
    localStorage.setItem('hermes_api_key', `x.${btoa(JSON.stringify({ sub: 7 })).replace(/=+$/, '')}.y`)
    expect(campaignStorageKey('m1')).toBe(JSON.stringify(['https://example.test', 7, 'table', 'm1']))
  })
})
