import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { isNodeVersionRangeSatisfied } from '../device-package-contract'
import { UpdateError } from '../errors'
import { fetchDevicePackageManifest } from '../manifest-client'
import { describeUpdateNetworkError, fetchUpdateBinary } from '../network-client'
import { compareSemver } from '../version-compare'
import type { DevicePackageManifest, UpdateConfig, UpdateRuntimePaths } from '../types'
import { buildShellScriptCommand, type CommandResolver } from './script-command'

function sanitizeVersionSegment(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '_')
}

function inferPackageFilename(manifest: DevicePackageManifest): string {
  try {
    const sourceUrl = manifest.packageUrls?.[0] || manifest.packageUrl
    const pathname = new URL(sourceUrl).pathname
    const fromUrl = basename(pathname)
    if (fromUrl) return fromUrl
  } catch {
    // Fall back to a deterministic filename when the URL is relative or invalid.
  }
  return `hermes-web-ui-device-v${sanitizeVersionSegment(manifest.version)}.tar.gz`
}

export function getDevicePackageExecutionMessage(): string {
  return 'Update source is not fully configured. Set WEBUI_UPDATE_MANIFEST_URL or WEBUI_UPDATE_MANIFEST_BASE_URL, WEBUI_UPDATE_INSTALLER_SCRIPT, and WEBUI_UPDATE_RUNNER_SERVICE.'
}

export function assertDevicePackageExecution(update: UpdateConfig): void {
  if (
    !(update.manifestUrl || update.manifestBaseUrl || update.manifestUrls?.length)
    || !update.installerScript
    || !update.runnerService
    || !update.runnerRequestFile
  ) {
    throw new UpdateError('update_execution_misconfigured', getDevicePackageExecutionMessage())
  }
}

export async function resolveDevicePackageManifest(update: UpdateConfig): Promise<DevicePackageManifest> {
  return fetchDevicePackageManifest(update)
}

export function assertDevicePackageCompatibility(manifest: DevicePackageManifest, currentVersion: string): void {
  if (!isNodeVersionRangeSatisfied(manifest.compatibleNodeRange, process.versions.node)) {
    throw new UpdateError(
      'update_incompatible_node',
      `Device package ${manifest.version} requires Node.js ${manifest.compatibleNodeRange}, current runtime is ${process.versions.node}.`,
      409,
    )
  }

  const minCompare = compareSemver(currentVersion, manifest.minCurrentVersion)
  if (minCompare == null) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Cannot compare current version ${currentVersion} with manifest minCurrentVersion ${manifest.minCurrentVersion}.`,
    )
  }
  if (minCompare < 0) {
    throw new UpdateError(
      'update_incompatible_current_version',
      `Current version ${currentVersion} is below the minimum supported update version ${manifest.minCurrentVersion}.`,
      409,
    )
  }
}

function computeSha256(filePath: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

export async function downloadAndVerifyDevicePackage(
  update: UpdateConfig,
  manifest: DevicePackageManifest,
): Promise<{ artifactPath: string }> {
  const versionSegment = sanitizeVersionSegment(manifest.version)
  const workDir = resolve(update.stagingDir, `device-package-${versionSegment}`)
  mkdirSync(workDir, { recursive: true })
  const artifactPath = resolve(workDir, inferPackageFilename(manifest))

  const packageUrls = [...new Set((manifest.packageUrls || [manifest.packageUrl]).filter(Boolean))]
  const failures: Array<Record<string, unknown>> = []
  let response: Awaited<ReturnType<typeof fetchUpdateBinary>> | null = null
  let resolvedPackageUrl = manifest.packageUrl

  for (const packageUrl of packageUrls) {
    try {
      const candidate = await fetchUpdateBinary(packageUrl, {
        timeoutMs: update.packageTimeoutMs,
        retries: update.downloadRetries,
        retryDelayMs: update.downloadRetryDelayMs,
      })
      if (!candidate.ok) {
        failures.push({
          packageUrl,
          status: candidate.status,
          transport: candidate.transport,
          attempts: candidate.attempts,
        })
        continue
      }
      response = candidate
      resolvedPackageUrl = packageUrl
      break
    } catch (err) {
      failures.push({
        packageUrl,
        ...describeUpdateNetworkError(err),
      })
    }
  }

  if (!response) {
    throw new UpdateError(
      'update_package_fetch_failed',
      `Failed to download device package ${manifest.version} from ${packageUrls[0] || manifest.packageUrl}.`,
      502,
      {
        packageUrl: packageUrls[0] || manifest.packageUrl,
        packageUrls,
        failures,
      },
    )
  }

  writeFileSync(artifactPath, response.buffer)

  const actualSha256 = computeSha256(artifactPath)
  if (actualSha256 !== manifest.sha256) {
    throw new UpdateError(
      'update_sha256_mismatch',
      `Downloaded device package checksum mismatch for ${manifest.version}.`,
      409,
      {
        expectedSha256: manifest.sha256,
        actualSha256,
        artifactPath,
        packageUrl: resolvedPackageUrl,
      },
    )
  }

  return { artifactPath }
}

export function buildDevicePackageInstallEnv(
  update: UpdateConfig,
  baseEnv: NodeJS.ProcessEnv,
  manifest: DevicePackageManifest,
  artifactPath: string,
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
    HERMES_WEB_UI_UPDATE_VERSION: manifest.version,
    HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: artifactPath,
    HERMES_WEB_UI_UPDATE_STAGING_DIR: update.stagingDir,
    HERMES_WEB_UI_UPDATE_BACKUP_DIR: update.backupDir,
    HERMES_WEB_UI_UPDATE_STATE_FILE: update.stateFile,
    HERMES_WEB_UI_UPDATE_LOG_DIR: update.logDir,
    HERMES_WEB_UI_UPDATE_TASK_ID: taskId,
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL: manifest.healthcheckUrl || update.healthcheckUrl,
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS: String(update.healthcheckTimeoutMs),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS: String(update.healthcheckIntervalMs),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES: String(update.healthcheckRetries),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS: String(update.healthcheckInitialDelayMs),
    HERMES_WEB_UI_UPDATE_EXPECTED_SHA256: manifest.sha256,
    HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: update.includeAgentUpgrade ? 'true' : 'false',
  }
}

export function buildDevicePackageInstallCommand(
  script: string,
  manifest: DevicePackageManifest,
  artifactPath: string,
  resolveCommand?: CommandResolver,
): { command: string; args: string[] } {
  return buildShellScriptCommand(
    script,
    [
    '--package', artifactPath,
    '--version', manifest.version,
    ],
    'Device package installer script',
    resolveCommand,
  )
}
