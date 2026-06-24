/**
 * 专家市场 - 安装器
 * 状态机：downloading -> verifying -> extracting -> installing_profile -> installed
 * 失败：status=failed, last_error + last_error_stage
 */
import { createHash } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import { join, resolve as resolvePath, sep } from 'path'
import { pipeline } from 'stream/promises'
import { tmpdir } from 'os'

import { loadExpertsMarketplaceConfig } from './config'
import { MarketplaceError, requestDownload, type ExpertManifest } from './marketplace-client'
import {
  getInstalledExpert,
  upsertInstalledExpert,
  type InstalledExpertStatus,
} from '../../../db/hermes/experts-store'

export type InstallStage =
  | 'download'
  | 'verify'
  | 'extract'
  | 'activate'

export class InstallError extends Error {
  constructor(
    public readonly stage: InstallStage,
    message: string,
    public readonly code = 500,
  ) {
    super(message)
  }
}

function safeJoin(root: string, rel: string): string {
  const abs = resolvePath(root, rel)
  if (!abs.startsWith(resolvePath(root) + sep) && abs !== resolvePath(root)) {
    throw new InstallError('extract', `path traversal detected: ${rel}`, 400)
  }
  return abs
}

async function downloadToFile(
  url: string,
  outPath: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const cfg = loadExpertsMarketplaceConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let resp: Response
  try {
    resp = await fetch(url, { signal: controller.signal })
  } catch (err) {
    throw new InstallError('download', err instanceof Error ? err.message : 'fetch failed')
  } finally {
    clearTimeout(timer)
  }
  if (!resp.ok || !resp.body) {
    throw new InstallError('download', `HTTP ${resp.status}`)
  }

  await fs.mkdir(join(outPath, '..'), { recursive: true })
  const hash = createHash('sha256')
  const fileStream = createWriteStream(outPath)
  let bytes = 0
  const reader = resp.body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        throw new InstallError('download', `超过 maxBytes=${maxBytes}`)
      }
      hash.update(value)
      if (!fileStream.write(value)) {
        await new Promise<void>((resolve) => fileStream.once('drain', () => resolve()))
      }
    }
  } finally {
    await new Promise<void>((resolve) => fileStream.end(() => resolve()))
  }
  void cfg
  return { bytes, sha256: hash.digest('hex') }
}

interface ExtractedManifest {
  manifest: ExpertManifest
  installDir: string
  systemPromptAbs: string
  avatarAbs: string
}

async function readManifestFromDir(installDir: string): Promise<ExtractedManifest> {
  const manifestPath = safeJoin(installDir, 'manifest.json')
  const raw = await fs.readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as ExpertManifest
  if (!manifest.expert || !manifest.version || !manifest.profileTemplate) {
    throw new InstallError('extract', 'manifest 字段不完整')
  }
  return {
    manifest,
    installDir,
    systemPromptAbs: safeJoin(installDir, manifest.profileTemplate.systemPromptPath),
    avatarAbs: safeJoin(installDir, manifest.profileTemplate.avatarPath),
  }
}

export interface InstallResult {
  slug: string
  version: string
  status: 'installed' | 'failed'
  installDir: string
  manifest: ExpertManifest
}

/**
 * 安装/激活专家包（处理单专家；专家团递归由 caller 处理）
 */
export async function installExpertPackage(
  slug: string,
  version: string,
  clientId: string,
  onStatus?: (status: InstalledExpertStatus) => void,
): Promise<InstallResult> {
  const cfg = loadExpertsMarketplaceConfig()
  const tmpDir = await fs.mkdtemp(join(tmpdir(), 'hermes-expert-'))
  const tmpZip = join(tmpDir, 'package.zip')
  const pkgRoot = cfg.localPackagesRoot
  const installDir = join(pkgRoot, slug, version)
  let manifestForReturn: ExpertManifest | null = null

  const fail = async (stage: InstallStage, message: string): Promise<never> => {
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'failed',
      last_error: message.slice(0, 500),
      last_error_stage: stage,
    })
    try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw new InstallError(stage, message)
  }

  try {
    // 1) downloading
    onStatus?.('downloading')
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'downloading',
      last_error: '',
      last_error_stage: '',
    })
    let grant
    try {
      grant = await requestDownload(slug, version, clientId)
    } catch (err) {
      const msg = err instanceof MarketplaceError ? err.message : '下载授权失败'
      return await fail('download', msg)
    }

    let downloaded: { bytes: number; sha256: string }
    try {
      downloaded = await downloadToFile(
        grant.download_url,
        tmpZip,
        cfg.downloadTimeoutMs,
        cfg.maxPackageBytes,
      )
    } catch (err) {
      return await fail('download', err instanceof Error ? err.message : '下载失败')
    }

    // 2) verifying
    onStatus?.('verifying')
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'verifying',
    })
    if (downloaded.sha256.toLowerCase() !== grant.sha256.toLowerCase()) {
      return await fail(
        'verify',
        `SHA256 mismatch: expected ${grant.sha256}, got ${downloaded.sha256}`,
      )
    }

    // 3) extracting
    onStatus?.('extracting')
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'extracting',
    })
    await fs.mkdir(installDir, { recursive: true })
    const { extractZip } = await import('./zip-extract')
    try {
      await extractZip(tmpZip, installDir, cfg.maxPackageBytes)
    } catch (err) {
      return await fail('extract', err instanceof Error ? err.message : '解压失败')
    }

    // 4) 解析 manifest
    let extracted: ExtractedManifest
    try {
      extracted = await readManifestFromDir(installDir)
    } catch (err) {
      return await fail('extract', err instanceof Error ? err.message : 'manifest 解析失败')
    }
    manifestForReturn = extracted.manifest

    // 5) installing_profile（实际激活由 activator 步骤处理）
    onStatus?.('installing_profile')
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'installing_profile',
      local_path: installDir,
      manifest_json: JSON.stringify(extracted.manifest),
    })

    onStatus?.('installed')
    upsertInstalledExpert({
      expert_slug: slug,
      expert_name: extracted.manifest.expert.name,
      kind: extracted.manifest.expert.kind,
      category: extracted.manifest.expert.category,
      installed_version: version,
      status: 'installed',
      local_path: installDir,
      manifest_json: JSON.stringify(extracted.manifest),
      last_error: '',
      last_error_stage: '',
    })

    return {
      slug,
      version,
      status: 'installed',
      installDir,
      manifest: extracted.manifest,
    }
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    void manifestForReturn
  }
}

export async function uninstallExpertPackage(slug: string): Promise<{
  removed: boolean
  installDir: string | null
}> {
  const cfg = loadExpertsMarketplaceConfig()
  const row = getInstalledExpert(slug)
  if (!row) return { removed: false, installDir: null }
  const installDir = row.local_path || join(cfg.localPackagesRoot, slug)
  try {
    await fs.rm(installDir, { recursive: true, force: true })
  } catch { /* ignore */ }
  // 兼容旧版本：删除 slug/<version>/*
  try {
    await fs.rm(join(cfg.localPackagesRoot, slug), { recursive: true, force: true })
  } catch { /* ignore */ }
  return { removed: true, installDir }
}

// 重导出 stream pipeline 给到 zip-extract 使用
export { pipeline }
