export type UpdateStrategy = 'npm-package' | 'source-deploy' | 'device-package'

export type UpdatePackageType = 'device-package' | 'npm-package' | 'source-deploy'

export interface UpdateConfig {
  enabled: boolean
  strategy: UpdateStrategy
  includeAgentUpgrade: boolean
  autoInstallDependencies: boolean
  packageName: string
  registry: string
  sourceLabel: string
  distTag: string
  cliBin: string
  script: string
  runnerService: string
  runnerRequestFile: string
  channel: string
  manifestUrl: string
  manifestUrls?: string[]
  manifestBaseUrl: string
  packageType: UpdatePackageType
  installerScript: string
  stagingDir: string
  backupDir: string
  healthcheckUrl: string
  stateFile: string
  logDir: string
  manifestTimeoutMs: number
  packageTimeoutMs: number
  downloadRetries: number
  downloadRetryDelayMs: number
  healthcheckTimeoutMs: number
  healthcheckIntervalMs: number
  healthcheckRetries: number
  healthcheckInitialDelayMs: number
  minFreeSpaceBytes: number
}

export interface UpdateRuntimePaths {
  deployDir: string
  webUiHome: string
  uploadDir: string
  hermesHome: string
}

export type UpdateRiskLevel = 'low' | 'medium' | 'high'

export type UpdatePreflightIssueCode =
  | 'webui-home-in-deploy-dir'
  | 'upload-dir-in-deploy-dir'
  | 'hermes-home-in-deploy-dir'
  | 'update-state-dir-not-writable'
  | 'update-staging-dir-not-writable'
  | 'update-log-dir-not-writable'
  | 'insufficient-disk-space'

export interface UpdatePreflightIssue {
  code: UpdatePreflightIssueCode
  level: UpdateRiskLevel
  path: string
  message: string
}

export interface UpdatePreflightResult {
  strategy: UpdateStrategy
  paths: UpdateRuntimePaths
  riskLevel: UpdateRiskLevel
  issues: UpdatePreflightIssue[]
  shouldBlock: boolean
  warningText: string
  blockingText: string
}

export interface UpdatePreflightOptions {
  stagingDir?: string
  logDir?: string
  stateFile?: string
  minFreeSpaceBytes?: number
  requiredFreeSpaceBytes?: number
}

export type UpdateTaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'

export type UpdateTaskStage =
  | 'idle'
  | 'queued'
  | 'preflighting'
  | 'checking'
  | 'resolving_version'
  | 'downloading'
  | 'verifying'
  | 'backing_up'
  | 'starting'
  | 'installing_dependencies'
  | 'installing'
  | 'stopping_runtime'
  | 'restarting'
  | 'starting_runtime'
  | 'health_checking'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface UpdateTaskRecord {
  id: string
  strategy: UpdateStrategy
  status: UpdateTaskStatus
  stage: UpdateTaskStage
  message: string
  targetVersion: string
  warning: string
  error: string
  logPath: string
  rollbackMessage: string
  healthcheckUrl: string
  startedAt: string
  finishedAt: string | null
}

export interface UpdateTaskStatusResponse {
  currentTask: UpdateTaskRecord | null
  lastTask: UpdateTaskRecord | null
}

export interface ManifestUpdateInfo {
  version: string
  channel: string
  sourceLabel: string
  packageType: UpdatePackageType
  manifestUrl: string
}

export interface DevicePackageManifest extends ManifestUpdateInfo {
  artifactFormat: 'tar.gz'
  packageUrl: string
  packageUrls?: string[]
  sha256: string
  releasedAt: string
  compatibleNodeRange: string
  minCurrentVersion: string
  notesUrl: string
  size: number
  healthcheckUrl: string
}

export interface UpdateCheckResult {
  latestVersion: string
  sourceLabel: string
  channel: string
  packageType: UpdatePackageType
  strategy: UpdateStrategy
  detectionSource: 'manifest' | 'npm-registry'
}

export interface UpdateCapabilities {
  enabled: boolean
  strategy: UpdateStrategy
  packageType: UpdatePackageType
  channel: string
  sourceLabel: string
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  detectionSource: UpdateCheckResult['detectionSource'] | 'none'
  remoteError: string
  supports: {
    versionCheck: boolean
    fullPackage: boolean
    deltaPackage: boolean
    resumableDownload: boolean
    checksumVerification: boolean
    rollback: boolean
    healthcheck: boolean
    silentInstall: boolean
    promptedInstall: boolean
    crossPlatformShell: boolean
  }
  runtime: {
    manifestConfigured: boolean
    executionConfigured: boolean
    runnerManaged: boolean
    autoInstallDependencies: boolean
    includeAgentUpgrade: boolean
    stateFile: string
    logDir: string
    stagingDir: string
    backupDir: string
    minFreeSpaceBytes: number
  }
  preflight: UpdatePreflightResult
}
