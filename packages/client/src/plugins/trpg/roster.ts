import { cleanSheet, type CharacterSheet } from '../../../../shared/trpg'
import { campaignStorage, type CharacterCard } from './storage'
import { campaignStorageKey } from './bookApi'

/**
 * Character roster for the standalone reader.
 *
 * Avatars and sheet stats live only in the TRPG panel's per-meeting IndexedDB
 * record (they are never uploaded). The reader runs on the same origin, so it
 * can read that record with the exact key the panel wrote and show the same
 * faces and basic attributes. The recap's own roster (id + name + player) is the
 * fallback when the record is missing (different browser/device) or the recap
 * predates character cards.
 */
export interface RosterMember {
  id: string
  name: string
  player: string
  appearance: string
  sheet: CharacterSheet
  imageUrl: string | null
}

export interface Roster {
  members: RosterMember[]
  /** Release the created object URLs when the reader unmounts. */
  revoke(): void
}

export async function loadRoster(meetingId: string, roster: { id: string; name: string; player?: string }[]): Promise<Roster> {
  let cards: CharacterCard[] = []
  try {
    const campaign = await campaignStorage(campaignStorageKey(meetingId))
    cards = campaign.characters || []
  } catch {
    // IndexedDB unavailable (private mode / unsupported): fall back to the roster.
    cards = []
  }
  const byId = new Map(cards.map(card => [card.id, card]))
  const ids = roster.length ? roster.map(member => member.id) : cards.map(card => card.id)
  const urls: string[] = []
  const members: RosterMember[] = []
  for (const id of ids) {
    const card = byId.get(id)
    const fallback = roster.find(member => member.id === id)
    const name = (card?.name || fallback?.name || '').trim()
    const image = card?.image
    const imageUrl = typeof Blob !== 'undefined' && image instanceof Blob ? URL.createObjectURL(image) : null
    if (imageUrl) urls.push(imageUrl)
    if (!name && !imageUrl) continue
    members.push({
      id,
      name,
      player: (card?.player || fallback?.player || '').trim(),
      appearance: (card?.appearance || '').trim(),
      sheet: cleanSheet(card?.sheet),
      imageUrl,
    })
  }
  return { members, revoke: () => urls.forEach(url => URL.revokeObjectURL(url)) }
}
