import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf-8'))
}

function fail(message) {
  throw new Error(message)
}

function expectVersion(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label} version mismatch: expected ${expected}, received ${actual}`)
  }
}

function expectNonEmptyString(label, value) {
  if (!String(value || '').trim()) {
    fail(`${label} is required`)
  }
}

const rootPackage = readJson('package.json')
const rootLockfile = readJson('package-lock.json')
const desktopPackage = readJson('packages/desktop/package.json')
const desktopLockfile = readJson('packages/desktop/package-lock.json')
const releaseConfig = readJson('.github/device-package-release.json')

const releaseVersion = String(rootPackage.version || '').trim()
if (!releaseVersion) {
  fail('package.json version is required')
}

expectNonEmptyString('.github/device-package-release.json hostDependenciesPath', releaseConfig.hostDependenciesPath)
const hostDependenciesPath = String(releaseConfig.hostDependenciesPath).trim()
const packageAllowlist = Array.isArray(releaseConfig.packageAllowlist) ? releaseConfig.packageAllowlist : []
if (!packageAllowlist.includes(hostDependenciesPath)) {
  fail(`packageAllowlist must include hostDependenciesPath: ${hostDependenciesPath}`)
}

const hostDependencies = readJson(hostDependenciesPath)
if (hostDependencies == null || typeof hostDependencies !== 'object' || Array.isArray(hostDependencies)) {
  fail(`Host dependency manifest must be a JSON object: ${hostDependenciesPath}`)
}
if (Number.parseInt(String(hostDependencies.schema ?? ''), 10) !== 1) {
  fail(`Host dependency manifest schema must be 1: ${hostDependenciesPath}`)
}
const aptPackages = Array.isArray(hostDependencies.aptPackages)
  ? [...new Set(hostDependencies.aptPackages.map(value => String(value || '').trim()).filter(Boolean))]
  : []
if (aptPackages.length === 0) {
  fail(`Host dependency manifest aptPackages must contain at least one package: ${hostDependenciesPath}`)
}

expectVersion('package-lock.json', rootLockfile.version, releaseVersion)
expectVersion('package-lock.json packages[""]', rootLockfile.packages?.['']?.version, releaseVersion)
expectVersion('.github/device-package-release.json', releaseConfig.version, releaseVersion)
expectVersion('packages/desktop/package.json', desktopPackage.version, releaseVersion)
expectVersion('packages/desktop/package-lock.json', desktopLockfile.version, releaseVersion)
expectVersion('packages/desktop/package-lock.json packages[""]', desktopLockfile.packages?.['']?.version, releaseVersion)

const changelogSource = readFileSync(resolve(ROOT, 'packages/client/src/data/changelog.ts'), 'utf-8')
const changelogVersionMatch = changelogSource.match(/version:\s*'([^']+)'/)
const changelogVersion = changelogVersionMatch ? changelogVersionMatch[1] : ''
if (!changelogVersion) {
  fail('packages/client/src/data/changelog.ts must define at least one version entry')
}
expectVersion('changelog.ts latest entry', changelogVersion, releaseVersion)

console.log(`Release consistency OK for ${releaseVersion}`)
