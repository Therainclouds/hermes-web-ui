export type UpdateStrategy = 'npm-package' | 'source-deploy'

export interface UpdateConfig {
  enabled: boolean
  strategy: UpdateStrategy
  packageName: string
  registry: string
  sourceLabel: string
  distTag: string
  cliBin: string
  script: string
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
