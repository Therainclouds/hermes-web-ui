export type UpdateStrategy = 'npm-package' | 'source-deploy' | 'device-package'

export type UpdatePackageType = 'device-package' | 'npm-package' | 'source-deploy'

export interface UpdateConfig {
  enabled: boolean
  strategy: UpdateStrategy
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

export type UpdateTaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'

export type UpdateTaskStage =
  | 'idle'
  | 'queued'
  | 'checking'
  | 'resolving_version'
  | 'downloading'
  | 'verifying'
  | 'backing_up'
  | 'starting'
  | 'installing'
  | 'restarting'
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
