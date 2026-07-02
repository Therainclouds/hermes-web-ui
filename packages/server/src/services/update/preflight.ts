import { accessSync, constants, existsSync, statfsSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { UpdatePreflightIssue, UpdatePreflightOptions, UpdatePreflightResult, UpdateRiskLevel, UpdateRuntimePaths, UpdateStrategy } from './types'

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

function nearestExistingPath(value: string): string {
  let current = resolve(value)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function pushWritableIssue(
  issues: UpdatePreflightIssue[],
  code: Extract<UpdatePreflightIssue['code'], 'update-state-dir-not-writable' | 'update-staging-dir-not-writable' | 'update-log-dir-not-writable'>,
  path: string | undefined,
  label: string,
) {
  const candidate = (path || '').trim()
  if (!candidate) return
  const target = nearestExistingPath(code === 'update-state-dir-not-writable' ? dirname(candidate) : candidate)
  try {
    accessSync(target, constants.W_OK)
  } catch {
    issues.push(buildIssue(
      'high',
      code,
      candidate,
      `${label} is not writable for update execution: ${candidate}`,
    ))
  }
}

function toSafeNumber(value: number | bigint | undefined): number | null {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : null
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getAvailableBytes(path: string): number | null {
  try {
    const stats = statfsSync(nearestExistingPath(path))
    const blockSize = toSafeNumber((stats as any).bsize)
    const availableBlocks = toSafeNumber((stats as any).bavail)
    if (blockSize == null || availableBlocks == null) return null
    return blockSize * availableBlocks
  } catch {
    return null
  }
}

function pushFreeSpaceIssue(
  issues: UpdatePreflightIssue[],
  deployDir: string,
  options: UpdatePreflightOptions,
) {
  const requiredBytes = Math.max(options.requiredFreeSpaceBytes || 0, options.minFreeSpaceBytes || 0)
  if (requiredBytes <= 0) return

  const candidates = [
    deployDir,
    options.stagingDir,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  let lowestFreeBytes: number | null = null
  let lowestPath = deployDir
  for (const candidate of candidates) {
    const availableBytes = getAvailableBytes(candidate)
    if (availableBytes == null) continue
    if (lowestFreeBytes == null || availableBytes < lowestFreeBytes) {
      lowestFreeBytes = availableBytes
      lowestPath = candidate
    }
  }

  if (lowestFreeBytes != null && lowestFreeBytes < requiredBytes) {
    issues.push(buildIssue(
      'high',
      'insufficient-disk-space',
      lowestPath,
      `Update requires at least ${requiredBytes} bytes of free space, but only ${lowestFreeBytes} bytes are available near ${lowestPath}.`,
    ))
  }
}

export function runUpdatePreflight(
  strategy: UpdateStrategy,
  paths: UpdateRuntimePaths,
  options: UpdatePreflightOptions = {},
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

  if (process.platform !== 'win32') {
    pushWritableIssue(issues, 'update-state-dir-not-writable', options.stateFile, 'Update state directory')
    pushWritableIssue(issues, 'update-staging-dir-not-writable', options.stagingDir, 'Update staging directory')
    pushWritableIssue(issues, 'update-log-dir-not-writable', options.logDir, 'Update log directory')
    pushFreeSpaceIssue(issues, paths.deployDir, options)
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
