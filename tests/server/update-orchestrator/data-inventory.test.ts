/**
 * Tests for scripts/_lib/data-inventory.sh — inventory and verification
 * of hermes_data across swap. R1-3 of the fleet spec.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSnippet } from './helpers'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const DATA_INVENTORY = join(REPO_ROOT, 'scripts', '_lib', 'data-inventory.sh')

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hermes-data-inv-'))
}

describe('data-inventory.sh', () => {
  describe('inventory_hermes_data', () => {
    it('returns all zeros when hermes_data does not exist', () => {
      const dir = makeTempDir()
      try {
        const res = runSnippet(
          `source '${DATA_INVENTORY}'\ninventory_hermes_data '${dir}'`,
        )
        expect(res.status).toBe(0)
        const json = JSON.parse(res.stdout.trim())
        expect(json.entry_count).toBe(0)
        expect(json.state_db_bytes).toBe(0)
        expect(json.profiles_count).toBe(0)
        expect(json.total_bytes).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('counts entries, state.db size, and profiles', () => {
      const dir = makeTempDir()
      try {
        const hd = join(dir, 'hermes_data')
        mkdirSync(join(hd, 'profiles', 'p1'), { recursive: true })
        mkdirSync(join(hd, 'profiles', 'p2'), { recursive: true })
        mkdirSync(join(hd, 'sessions'), { recursive: true })
        writeFileSync(join(hd, 'state.db'), 'x'.repeat(2048))

        const res = runSnippet(
          `source '${DATA_INVENTORY}'\ninventory_hermes_data '${dir}'`,
        )
        expect(res.status).toBe(0)
        const json = JSON.parse(res.stdout.trim())
        expect(json.entry_count).toBe(3) // profiles, sessions, state.db
        expect(json.state_db_bytes).toBe(2048)
        expect(json.profiles_count).toBe(2)
        expect(json.total_bytes).toBeGreaterThanOrEqual(2048)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('verify_hermes_data_preserved', () => {
    it('passes when pre-swap data is negligible (≤2 entries)', () => {
      const pre = '{"entry_count":1,"state_db_bytes":0,"profiles_count":0,"total_bytes":0}'
      const post = '{"entry_count":0,"state_db_bytes":0,"profiles_count":0,"total_bytes":0}'
      const res = runSnippet(
        `source '${DATA_INVENTORY}'\nverify_hermes_data_preserved '${pre}' '${post}' && echo OK || echo FAIL`,
      )
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('OK')
    })

    it('passes when state.db and entries are healthy', () => {
      const pre = '{"entry_count":5,"state_db_bytes":2000000,"profiles_count":3,"total_bytes":5000000}'
      const post = '{"entry_count":5,"state_db_bytes":1990000,"profiles_count":3,"total_bytes":4980000}'
      const res = runSnippet(
        `source '${DATA_INVENTORY}'\nverify_hermes_data_preserved '${pre}' '${post}' && echo OK || echo FAIL`,
      )
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('OK')
      expect(res.stdout).toContain('verified')
    })

    it('fails when state.db shrank below 90% and original was >1MB', () => {
      // Pre: 2MB state.db. Post: 100KB (way below 90% of 2MB = 1.8MB).
      const pre = '{"entry_count":5,"state_db_bytes":2097152,"profiles_count":3,"total_bytes":5000000}'
      const post = '{"entry_count":5,"state_db_bytes":102400,"profiles_count":3,"total_bytes":200000}'
      const res = runSnippet(
        `source '${DATA_INVENTORY}'\nverify_hermes_data_preserved '${pre}' '${post}' && echo OK || echo FAIL`,
      )
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('FAIL')
      expect(res.stdout).toContain('state.db shrank')
    })

    it('fails when entry count halved', () => {
      // Pre: 10 entries. Post: 3 entries (< half of 10).
      const pre = '{"entry_count":10,"state_db_bytes":2000000,"profiles_count":5,"total_bytes":5000000}'
      const post = '{"entry_count":3,"state_db_bytes":1900000,"profiles_count":1,"total_bytes":2000000}'
      const res = runSnippet(
        `source '${DATA_INVENTORY}'\nverify_hermes_data_preserved '${pre}' '${post}' && echo OK || echo FAIL`,
      )
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('FAIL')
      expect(res.stdout).toContain('entries dropped')
    })

    it('allows state.db to shrink up to 10% without triggering failure', () => {
      // Pre: 2MB. Post: 1.85MB (92.5% — above 90% threshold).
      const pre = '{"entry_count":5,"state_db_bytes":2097152,"profiles_count":3,"total_bytes":5000000}'
      const post = '{"entry_count":5,"state_db_bytes":1943101,"profiles_count":3,"total_bytes":4800000}'
      const res = runSnippet(
        `source '${DATA_INVENTORY}'\nverify_hermes_data_preserved '${pre}' '${post}' && echo OK || echo FAIL`,
      )
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('OK')
    })
  })
})
