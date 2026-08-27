/**
 * Tests for the meeting-scene registry.
 *
 * Guards:
 * - Every SceneId in SCENE_IDS has a registered component loader
 * - normalizeSceneId() falls back to DEFAULT_SCENE_ID for unknown / nullish values
 * - isSceneId() correctly accepts/rejects
 *
 * Does NOT exercise Vue mounting — registry is plain TypeScript.
 */

import { describe, expect, it } from 'vitest'
import {
  SCENE_IDS,
  DEFAULT_SCENE_ID,
  isSceneId,
  normalizeSceneId,
  resolveSceneComponent,
  type SceneId,
} from '../../packages/client/src/components/hermes/meeting/scenes'

describe('meeting scenes registry', () => {
  it('exposes the 6 documented scene ids', () => {
    expect(SCENE_IDS).toEqual([
      'general',
      'business',
      'speech',
      'medical',
      'legal',
      'interview',
    ])
  })

  it('has DEFAULT_SCENE_ID = general', () => {
    expect(DEFAULT_SCENE_ID).toBe('general')
  })

  describe('isSceneId', () => {
    it.each(SCENE_IDS)('accepts %s', (id) => {
      expect(isSceneId(id)).toBe(true)
    })

    it.each(['foo', '', 'GENERAL', null, undefined, 42, {}])(
      'rejects %p',
      (id) => {
        expect(isSceneId(id)).toBe(false)
      },
    )
  })

  describe('normalizeSceneId', () => {
    it('passes valid ids through', () => {
      for (const id of SCENE_IDS) {
        expect(normalizeSceneId(id)).toBe(id)
      }
    })

    it.each(['foo', null, undefined, 42, ''])(
      'falls back to DEFAULT_SCENE_ID for %p',
      (id) => {
        expect(normalizeSceneId(id)).toBe(DEFAULT_SCENE_ID)
      },
    )
  })

  describe('resolveSceneComponent', () => {
    it.each(SCENE_IDS)(
      'returns a component descriptor for %s (medical/legal/interview may alias general until implemented)',
      (id) => {
        const comp = resolveSceneComponent(id as SceneId)
        // defineAsyncComponent returns an object with a render/setup function
        expect(comp).toBeDefined()
        expect(typeof comp).toBe('object')
      },
    )
  })
})