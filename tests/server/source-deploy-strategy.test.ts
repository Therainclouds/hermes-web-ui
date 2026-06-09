import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateError } from '../../packages/server/src/services/update/errors'
import { buildSourceDeployCommand } from '../../packages/server/src/services/update/strategies/source-deploy'

describe('source deploy strategy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the script command directly on non-Windows runtimes', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')

    expect(buildSourceDeployCommand('/opt/hermes-web-ui/scripts/update-source-deploy.sh', '0.6.13')).toEqual({
      command: '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      args: ['--version', '0.6.13'],
    })
  })

  it('builds the script command through a discovered bash executable on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    expect(buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => 'C:\\Program Files\\Git\\bin\\bash.exe',
    )).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['/opt/hermes-web-ui/scripts/update-source-deploy.sh', '--version', '0.6.13'],
    })
  })

  it('fails with UpdateError when bash is unavailable on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    expect(() => buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => undefined,
    )).toThrow(UpdateError)
    expect(() => buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => undefined,
    )).toThrow(/requires bash on Windows/)
  })
})
