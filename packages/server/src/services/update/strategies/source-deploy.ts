import type { UpdateConfig, UpdateRuntimePaths } from '../types'
import { UpdateError } from '../errors'
import { buildShellScriptCommand, type CommandResolver } from './script-command'

export function getSourceDeployExecutionMessage(): string {
  return 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, WEBUI_UPDATE_SCRIPT, and WEBUI_UPDATE_RUNNER_SERVICE.'
}

export function assertSourceDeployExecution(update: UpdateConfig): void {
  if (!update.packageName || !update.registry || !update.script || !update.runnerService || !update.runnerRequestFile) {
    throw new UpdateError('update_execution_misconfigured', getSourceDeployExecutionMessage())
  }
}

export function buildSourceDeployEnv(
  update: UpdateConfig,
  baseEnv: NodeJS.ProcessEnv,
  version: string,
  paths: UpdateRuntimePaths,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DEPLOY_DIR: paths.deployDir,
    HERMES_HOME: paths.hermesHome || baseEnv.HERMES_HOME || '',
    HERMES_HOME_DIR: paths.hermesHome || baseEnv.HERMES_HOME_DIR || '',
    HERMES_WEB_UI_HOME: paths.webUiHome,
    HERMES_WEBUI_STATE_DIR: paths.webUiHome,
    UPLOAD_DIR: paths.uploadDir,
    HERMES_WEB_UI_UPDATE_VERSION: version,
    HERMES_WEB_UI_UPDATE_PACKAGE: update.packageName || '',
    HERMES_WEB_UI_UPDATE_REGISTRY: update.registry || '',
    HERMES_WEB_UI_UPDATE_DIST_TAG: update.distTag || 'latest',
    HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: update.includeAgentUpgrade ? 'true' : 'false',
  }
}

export function buildSourceDeployCommand(
  script: string,
  version: string,
  resolveCommand?: CommandResolver,
): { command: string; args: string[] } {
  return buildShellScriptCommand(
    script,
    ['--version', version],
    'Source deployment update script',
    resolveCommand,
  )
}
