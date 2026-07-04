import { describe, expect, it } from 'vitest'
import { runUpdatePreflight } from '../../packages/server/src/services/update/preflight'

describe('update preflight', () => {
  it('allows low-risk layouts', () => {
    const result = runUpdatePreflight('source-deploy', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/home/hermesui/.hermes-web-ui',
      uploadDir: '/home/hermesui/.hermes-web-ui/upload',
      hermesHome: '/srv/hermes-data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: 1024,
    })

    expect(result.riskLevel).toBe('low')
    expect(result.shouldBlock).toBe(false)
    expect(result.issues).toHaveLength(0)
  })

  it('allows the default hermes_data layout without warnings', () => {
    const result = runUpdatePreflight('source-deploy', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/home/hermesui/.hermes-web-ui',
      uploadDir: '/home/hermesui/.hermes-web-ui/upload',
      hermesHome: '/opt/hermes-web-ui/hermes_data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: 1024,
    })

    expect(result.riskLevel).toBe('low')
    expect(result.shouldBlock).toBe(false)
    expect(result.warningText).toBe('')
    expect(result.issues).toHaveLength(0)
  })

  it('blocks when the web-ui data directory is inside the deploy directory', () => {
    const result = runUpdatePreflight('npm-package', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/opt/hermes-web-ui/state',
      uploadDir: '/opt/hermes-web-ui/state/upload',
      hermesHome: '/srv/hermes-data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: 1024,
    })

    expect(result.riskLevel).toBe('high')
    expect(result.shouldBlock).toBe(true)
    expect(result.blockingText).toContain('Web UI data directory is inside the deploy directory')
    expect(result.issues.some(issue => issue.code === 'upload-dir-in-deploy-dir')).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('blocks when the device does not meet the minimum free-space requirement', () => {
    const result = runUpdatePreflight('device-package', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/home/hermesui/.hermes-web-ui',
      uploadDir: '/home/hermesui/.hermes-web-ui/upload',
      hermesHome: '/srv/hermes-data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: Number.MAX_SAFE_INTEGER,
    })

    expect(result.riskLevel).toBe('high')
    expect(result.shouldBlock).toBe(true)
    expect(result.issues.some(issue => issue.code === 'insufficient-disk-space')).toBe(true)
  })
})
