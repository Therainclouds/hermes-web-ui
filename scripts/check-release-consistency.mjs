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

const rootPackage = readJson('package.json')
const rootLockfile = readJson('package-lock.json')
const desktopPackage = readJson('packages/desktop/package.json')
const desktopLockfile = readJson('packages/desktop/package-lock.json')
const releaseConfig = readJson('.github/device-package-release.json')

const releaseVersion = String(rootPackage.version || '').trim()
if (!releaseVersion) {
  fail('package.json version is required')
}

expectVersion('package-lock.json', rootLockfile.version, releaseVersion)
expectVersion('package-lock.json packages[""]', rootLockfile.packages?.['']?.version, releaseVersion)
expectVersion('.github/device-package-release.json', releaseConfig.version, releaseVersion)
expectVersion('packages/desktop/package.json', desktopPackage.version, releaseVersion)
expectVersion('packages/desktop/package-lock.json', desktopLockfile.version, releaseVersion)
expectVersion('packages/desktop/package-lock.json packages[""]', desktopLockfile.packages?.['']?.version, releaseVersion)

console.log(`Release consistency OK for ${releaseVersion}`)
