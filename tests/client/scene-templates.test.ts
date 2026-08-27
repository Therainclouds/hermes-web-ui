/**
 * Tests for the meeting scene-template metadata module.
 *
 * Guards:
 * - SCENE_IDS lists the five pickable templates (speech removed) in order
 * - DEFAULT_SCENE_ID = general
 * - isSceneId() accepts/rejects correctly
 * - normalizeSceneId() passes valid ids through, falls back for unknown
 *
 * Does NOT exercise Vue mounting — module is plain TypeScript.
 */

import { describe, expect, it } from 'vitest'
import {
  SCENE_IDS,
  DEFAULT_SCENE_ID,
  isSceneId,
  normalizeSceneId,
  type SceneId,
} from '../../packages/client/src/components/hermes/meeting/scene-templates'

describe('meeting scene templates', () => {
  it('exposes the five pickable scene ids (no speech)', () => {
    expect(SCENE_IDS).toEqual([
      'general',
      'business',
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

    it.each(['foo', '', 'GENERAL', null, undefined, 42, {}, 'speech'])(
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

    it.each(['foo', null, undefined, 42, '', 'speech'])(
      'falls back to DEFAULT_SCENE_ID for %p',
      (id) => {
        expect(normalizeSceneId(id)).toBe(DEFAULT_SCENE_ID)
      },
    )
  })

  it('SceneId type narrows to the five ids (compile-time guard)', () => {
    // If isSceneId is a proper type guard, assigning the narrowed value
    // to a SceneId-typed const must type-check.
    const sample: unknown = 'business'
    if (isSceneId(sample)) {
      const id: SceneId = sample
      expect(id).toBe('business')
    }
  })
})
