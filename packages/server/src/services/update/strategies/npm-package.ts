import { UpdateError } from '../errors'
import type { UpdateConfig } from '../types'

export function getNpmPackageExecutionMessage(): string {
  return 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, and WEBUI_UPDATE_CLI_BIN.'
}

export function assertNpmPackageExecution(update: UpdateConfig): void {
  if (!update.packageName || !update.registry || !update.cliBin) {
    throw new UpdateError('update_execution_misconfigured', getNpmPackageExecutionMessage())
  }
}

export function buildNpmPackageInstallArgs(update: UpdateConfig, versionOrTag: string): string[] {
  return [
    'install',
    '-g',
    `${update.packageName}@${versionOrTag}`,
    '--registry',
    update.registry,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]
}
