import { cpSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { getDeployDir, getWebUiHome } from '../../../config'
import { UpdateError } from '../errors'
import type { UpdateConfig } from '../types'

export function getNpmPackageExecutionMessage(): string {
  return 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, and WEBUI_UPDATE_CLI_BIN.'
}

export function assertNpmPackageExecution(update: UpdateConfig): void {
  if (!update.packageName || !update.registry || !update.cliBin) {
    throw new UpdateError('update_execution_misconfigured', getNpmPackageExecutionMessage())
  }
}

export function buildNpmPackageInstallArgs(update: UpdateConfig, versionOrTag: string): string[] {
  return [
    'install',
    '-g',
    `${update.packageName}@${versionOrTag}`,
    '--registry',
    update.registry,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]
}

/**
 * npm-package 更新通过 `npm install -g` 整体替换包目录，运行时生成在包目录
 * certs/ 下的 TLS 证书会随之被删除，导致更新后 HTTPS 回退为 HTTP。
 * 更新完成后把稳定位置的证书（部署目录或 Web UI 状态目录）恢复到新包目录，
 * 与 bootstrap 阶段的证书检测路径（resolve(__dirname, '../../certs')）保持一致，
 * 让升级后 HTTPS 无缝续用。
 */
export function restoreTlsCertificatesAfterNpmUpdate(targetCertsDir = resolve(__dirname, '../../certs')): void {
  const targetCerts = targetCertsDir
  if (existsSync(join(targetCerts, 'server.crt')) && existsSync(join(targetCerts, 'server.key'))) {
    return
  }
  const candidates = [
    join(getDeployDir(), 'certs'),
    join(getWebUiHome(), 'certs'),
  ]
  for (const source of candidates) {
    const crt = join(source, 'server.crt')
    const key = join(source, 'server.key')
    if (!existsSync(crt) || !existsSync(key)) continue
    try {
      mkdirSync(targetCerts, { recursive: true })
      cpSync(crt, join(targetCerts, 'server.crt'))
      cpSync(key, join(targetCerts, 'server.key'))
      console.log(`[update] restored TLS certificates from ${source} to ${targetCerts}`)
      return
    } catch (err) {
      console.warn(`[update] failed to restore TLS certificates from ${source}:`, err)
    }
  }
  console.warn('[update] no stable TLS certificates found; HTTPS may fall back to HTTP after update')
}
