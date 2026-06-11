import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateError } from '../../packages/server/src/services/update/errors'
import { buildSourceDeployCommand } from '../../packages/server/src/services/update/strategies/source-deploy'

describe('source deploy strategy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the script command through a discovered bash executable on Linux', () => {
    expect(buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => '/bin/bash',
    )).toEqual({
      command: '/bin/bash',
      args: ['/opt/hermes-web-ui/scripts/update-source-deploy.sh', '--version', '0.6.13'],
    })
  })

  it('builds the script command through a discovered bash executable on Windows', () => {
    expect(buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => 'C:\\Program Files\\Git\\bin\\bash.exe',
    )).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['/opt/hermes-web-ui/scripts/update-source-deploy.sh', '--version', '0.6.13'],
    })
  })

  it('fails with UpdateError when bash is unavailable', () => {
    expect(() => buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => undefined,
    )).toThrow(UpdateError)
    expect(() => buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => undefined,
    )).toThrow(/requires bash, but no bash executable was found in PATH/)
  })
})
