import { isAbsolute, join, relative } from 'path'
import type { UpdatePreflightIssue, UpdatePreflightResult, UpdateRiskLevel, UpdateRuntimePaths, UpdateStrategy } from './types'

function normalizePath(value: string): string {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized
}

function isSameOrWithin(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const parentPath = normalizePath(parent)
  const childPath = normalizePath(child)
  if (parentPath === childPath) return true

  const rel = relative(parentPath, childPath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function buildIssue(
  level: UpdateRiskLevel,
  code: UpdatePreflightIssue['code'],
  path: string,
  message: string,
): UpdatePreflightIssue {
  return { level, code, path, message }
}

export function runUpdatePreflight(
  strategy: UpdateStrategy,
  paths: UpdateRuntimePaths,
): UpdatePreflightResult {
  const issues: UpdatePreflightIssue[] = []

  if (isSameOrWithin(paths.deployDir, paths.webUiHome)) {
    issues.push(buildIssue(
      'high',
      'webui-home-in-deploy-dir',
      paths.webUiHome,
      `Web UI data directory is inside the deploy directory and would be at risk during ${strategy} updates: ${paths.webUiHome}`,
    ))
  }

  if (isSameOrWithin(paths.deployDir, paths.uploadDir)) {
    issues.push(buildIssue(
      'high',
      'upload-dir-in-deploy-dir',
      paths.uploadDir,
      `Upload directory is inside the deploy directory and would be at risk during ${strategy} updates: ${paths.uploadDir}`,
    ))
  }

  if (paths.hermesHome && isSameOrWithin(paths.deployDir, paths.hermesHome)) {
    const compatibilityPath = join(paths.deployDir, 'hermes_data')
    const isCompatibilityLayout = normalizePath(paths.hermesHome) === normalizePath(compatibilityPath)
    issues.push(buildIssue(
      'medium',
      'hermes-home-in-deploy-dir',
      paths.hermesHome,
      isCompatibilityLayout
        ? `Hermes data directory is using the legacy compatibility layout inside the deploy directory and will be preserved during updates: ${paths.hermesHome}`
        : `Hermes data directory is inside the deploy directory. Updates will preserve it, but the layout should be reviewed: ${paths.hermesHome}`,
    ))
  }

  const riskLevel: UpdateRiskLevel = issues.some(issue => issue.level === 'high')
    ? 'high'
    : issues.some(issue => issue.level === 'medium')
      ? 'medium'
      : 'low'

  return {
    strategy,
    paths,
    riskLevel,
    issues,
    shouldBlock: riskLevel === 'high',
    warningText: issues
      .filter(issue => issue.level !== 'high')
      .map(issue => issue.message)
      .join(' '),
    blockingText: issues
      .filter(issue => issue.level === 'high')
      .map(issue => issue.message)
      .join(' '),
  }
}
