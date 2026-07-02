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
  taskId: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    APP_USER: baseEnv.APP_USER || 'hermesui',
    DEPLOY_DIR: paths.deployDir,
    HERMES_HOME: paths.hermesHome || baseEnv.HERMES_HOME || '',
    HERMES_HOME_DIR: paths.hermesHome || baseEnv.HERMES_HOME_DIR || '',
    HERMES_WEB_UI_HOME: paths.webUiHome,
    HERMES_WEBUI_STATE_DIR: paths.webUiHome,
    UPLOAD_DIR: paths.uploadDir,
    HERMES_WEB_UI_UPDATE_VERSION: version,
    HERMES_WEB_UI_UPDATE_STAGING_DIR: update.stagingDir,
    HERMES_WEB_UI_UPDATE_BACKUP_DIR: update.backupDir,
    HERMES_WEB_UI_UPDATE_STATE_FILE: update.stateFile,
    HERMES_WEB_UI_UPDATE_LOG_DIR: update.logDir,
    HERMES_WEB_UI_UPDATE_TASK_ID: taskId,
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL: update.healthcheckUrl,
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS: String(update.healthcheckTimeoutMs),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS: String(update.healthcheckIntervalMs),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES: String(update.healthcheckRetries),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS: String(update.healthcheckInitialDelayMs),
    HERMES_WEB_UI_UPDATE_PACKAGE: update.packageName || '',
    HERMES_WEB_UI_UPDATE_REGISTRY: update.registry || '',
    HERMES_WEB_UI_UPDATE_DIST_TAG: update.distTag || 'latest',
    HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES: update.autoInstallDependencies ? 'true' : 'false',
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
