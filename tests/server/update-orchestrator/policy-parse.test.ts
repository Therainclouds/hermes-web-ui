/**
 * Seam tests for the local operator policy parser (schema 1).
 *
 * Covers scripts/policy-parse.sh. Master spec:
 * docs/harness/source-deploy-refactor.md (§ Trigger Model → policy.json).
 * Settled precedence: policy.json > env > default (no override).
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { makeTempHome, runBash, runSnippet, SCRIPTS } from './helpers'

function policyDir(home: string): string {
  return join(home, 'updates')
}

function writePolicy(home: string, doc: unknown): string {
  mkdirSync(policyDir(home), { recursive: true })
  const path = join(policyDir(home), 'policy.json')
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc))
  return path
}

describe('policy parser — file loading', () => {
  it('absent file means no override, but env pin still applies', () => {
    const home = makeTempHome()
    const res = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "pinned=[\${POLICY_PINNED_VERSION}] loaded=\${POLICY_LOADED}"`,
      {
        HERMES_WEB_UI_HOME: home,
        HERMES_WEB_UI_UPDATE_PINNED_VERSION: '0.7.20',
      },
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('pinned=[0.7.20]')
    expect(res.stdout).toContain('loaded=0')
  })

  it('absent file and absent env means empty override', () => {
    const home = makeTempHome()
    const res = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "pinned=[\${POLICY_PINNED_VERSION}]"`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(res.stdout).toContain('pinned=[]')
  })

  it('loads a valid schema-1 policy with all fields', () => {
    const home = makeTempHome()
    writePolicy(home, {
      schema: 1,
      pinned_version: '0.8.0',
      channel_overrides: { stable: '0.7.20' },
      pause_until: '2030-01-01T00:00:00Z',
      blocklist: ['0.8.1', '0.8.2'],
      notes: 'internal pilot',
    })
    const res = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load
       echo "pinned=\${POLICY_PINNED_VERSION}"
       echo "pause=\${POLICY_PAUSE_UNTIL}"
       echo "block=\${POLICY_BLOCKLIST}"
       echo "override=\${POLICY_CHANNEL_OVERRIDES}"
       echo "notes=\${POLICY_NOTES}"
       echo "loaded=\${POLICY_LOADED}"`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('pinned=0.8.0')
    expect(res.stdout).toContain('pause=2030-01-01T00:00:00Z')
    expect(res.stdout).toContain('block=0.8.1 0.8.2')
    expect(res.stdout).toContain('override=stable=0.7.20')
    expect(res.stdout).toContain('notes=internal pilot')
    expect(res.stdout).toContain('loaded=1')
  })

  it('refuses a wrong schema and warns update_policy_invalid', () => {
    const home = makeTempHome()
    writePolicy(home, { schema: 2, pinned_version: '9.9.9' })
    const res = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "pinned=\${POLICY_PINNED_VERSION} invalid=\${POLICY_INVALID}"`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('update_policy_invalid')
    // Refused file must not leak its values.
    expect(res.stdout).toContain('pinned= invalid=1')
  })

  it('refuses malformed JSON without crashing', () => {
    const home = makeTempHome()
    writePolicy(home, '{not json')
    const res = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "invalid=\${POLICY_INVALID} loaded=\${POLICY_LOADED}"`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('update_policy_invalid')
    expect(res.stdout).toContain('invalid=1')
  })

  it('file beats env on precedence', () => {
    const home = makeTempHome()
    writePolicy(home, { schema: 1, pinned_version: '0.8.0' })
    const res = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "pinned=\${POLICY_PINNED_VERSION}"`,
      {
        HERMES_WEB_UI_HOME: home,
        HERMES_WEB_UI_UPDATE_PINNED_VERSION: '0.7.20',
      },
    )
    expect(res.stdout).toContain('pinned=0.8.0')
  })
})

describe('policy helpers', () => {
  function loadWith(home: string, doc: unknown): void {
    writePolicy(home, doc)
  }

  it('policy_is_blocked hits and misses', () => {
    const home = makeTempHome()
    loadWith(home, { schema: 1, blocklist: ['0.8.1'] })
    const hit = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; if policy_is_blocked 0.8.1; then echo BLOCKED; else echo ALLOWED; fi`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(hit.stdout).toContain('BLOCKED')
    const miss = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; if policy_is_blocked 0.8.3; then echo BLOCKED; else echo ALLOWED; fi`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(miss.stdout).toContain('ALLOWED')
  })

  it('policy_channel_override resolves per channel', () => {
    const home = makeTempHome()
    loadWith(home, { schema: 1, channel_overrides: { stable: '0.7.20', beta: '0.8.0-rc1' } })
    const stable = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "v=\$(policy_channel_override stable)"`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(stable.stdout).toContain('v=0.7.20')
    const unknown = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; echo "v=\$(policy_channel_override canary)"`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(unknown.stdout).toContain('v=')
  })

  it('policy_is_paused respects a future timestamp and ignores a past one', () => {
    const home = makeTempHome()
    loadWith(home, { schema: 1, pause_until: '2030-01-01T00:00:00Z' })
    const paused = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; if policy_is_paused; then echo PAUSED; else echo ACTIVE; fi`,
      { HERMES_WEB_UI_HOME: home },
    )
    expect(paused.stdout).toContain('PAUSED')

    const home2 = makeTempHome()
    loadWith(home2, { schema: 1, pause_until: '2001-01-01T00:00:00Z' })
    const expired = runSnippet(
      `source '${SCRIPTS.policyParse}'; policy_load; if policy_is_paused; then echo PAUSED; else echo ACTIVE; fi`,
      { HERMES_WEB_UI_HOME: home2 },
    )
    expect(expired.stdout).toContain('ACTIVE')
  })

  it('CLI --pinned prints the pinned version', () => {
    const home = makeTempHome()
    writePolicy(home, { schema: 1, pinned_version: '0.8.0' })
    const res = runBash(SCRIPTS.policyParse, ['--pinned'], { HERMES_WEB_UI_HOME: home })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('0.8.0')
  })
})
