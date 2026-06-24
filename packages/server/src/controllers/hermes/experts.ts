/**
 * 专家系统本地 controller
 * 入参校验 + 委托 service 层
 */
import type { Context } from 'koa'
import {
  getInstalledExpertRow,
  getLocalCatalog,
  getLocalDetail,
  getLocalManifest,
  getMarketplaceConfigSummary,
  installExpertFlow,
  listBindingProfiles,
  listLocalInstalled,
  summarizeBindings,
  uninstallExpertFlow,
  upgradeExpertFlow,
} from '../../services/hermes/experts/orchestrator'
import { loadExpertsMarketplaceConfig } from '../../services/hermes/experts/config'
import { InstallError } from '../../services/hermes/experts/installer'
import { clearCatalogCache, MarketplaceError } from '../../services/hermes/experts/marketplace-client'
import {
  getBindingByProfile,
  listInstalledExperts,
} from '../../db/hermes/experts-store'

function bad(ctx: Context, code: number, message: string, extras: Record<string, unknown> = {}) {
  ctx.status = code
  ctx.body = { code, message, ...extras }
}

function ok<T>(ctx: Context, data: T) {
  ctx.status = 200
  ctx.body = { code: 0, message: 'ok', data }
}

function getClientId(userId: string | undefined): string {
  const cfg = loadExpertsMarketplaceConfig()
  return cfg.clientIdTemplate
    .replace('{version}', '0.1.0')
    .replace('{userId}', userId ?? 'anonymous')
}

export async function getConfig(ctx: Context) {
  ok(ctx, getMarketplaceConfigSummary())
}

export async function getCatalog(ctx: Context) {
  try {
    const items = await getLocalCatalog()
    ok(ctx, items)
  } catch (err) {
    if (err instanceof MarketplaceError) {
      return bad(ctx, err.code || 502, err.message, { stage: err.stage })
    }
    return bad(ctx, 502, 'catalog 拉取失败')
  }
}

export async function refreshCatalog(ctx: Context) {
  clearCatalogCache()
  try {
    const items = await getLocalCatalog()
    ok(ctx, items)
  } catch (err) {
    if (err instanceof MarketplaceError) {
      return bad(ctx, err.code || 502, err.message, { stage: err.stage })
    }
    return bad(ctx, 502, 'catalog 刷新失败')
  }
}

export async function getDetail(ctx: Context) {
  const slug = ctx.params.slug
  if (!slug) return bad(ctx, 400, 'slug 必填')
  try {
    const data = await getLocalDetail(slug)
    ok(ctx, data)
  } catch (err) {
    if (err instanceof MarketplaceError) {
      return bad(ctx, err.code || 502, err.message, { stage: err.stage })
    }
    return bad(ctx, 502, 'detail 拉取失败')
  }
}

export async function getManifest(ctx: Context) {
  const slug = ctx.params.slug
  const version = ctx.params.version
  if (!slug || !version) return bad(ctx, 400, 'slug/version 必填')
  try {
    const data = await getLocalManifest(slug, version)
    ok(ctx, data)
  } catch (err) {
    if (err instanceof MarketplaceError) {
      return bad(ctx, err.code || 502, err.message, { stage: err.stage })
    }
    return bad(ctx, 502, 'manifest 拉取失败')
  }
}

export async function getInstalled(ctx: Context) {
  const installed = listInstalledExperts()
  const bindings = listBindingProfiles()
  const summary = summarizeBindings()
  ok(ctx, { installed, bindings, summary })
}

export async function installExpert(ctx: Context) {
  const body = (ctx.request.body ?? {}) as { slug?: string; version?: string; client_id?: string }
  const slug = body.slug
  const version = body.version
  if (!slug || !version) return bad(ctx, 400, 'slug/version 必填')
  const userId = (ctx.state?.user?.id || ctx.state?.userId) as string | undefined
  const clientId = body.client_id || getClientId(typeof userId === 'string' ? userId : undefined)
  try {
    const result = await installExpertFlow({ slug, version, clientId })
    ok(ctx, result)
  } catch (err) {
    if (err instanceof InstallError) {
      return bad(ctx, err.code || 500, err.message, { stage: err.stage })
    }
    if (err instanceof MarketplaceError) {
      return bad(ctx, err.code || 502, err.message, { stage: err.stage })
    }
    return bad(ctx, 500, err instanceof Error ? err.message : 'install failed')
  }
}

export async function upgradeExpert(ctx: Context) {
  const slug = ctx.params.slug
  if (!slug) return bad(ctx, 400, 'slug 必填')
  const body = (ctx.request.body ?? {}) as { client_id?: string }
  const userId = (ctx.state?.user?.id || ctx.state?.userId) as string | undefined
  const clientId = body.client_id || getClientId(typeof userId === 'string' ? userId : undefined)
  try {
    const result = await upgradeExpertFlow({ slug, clientId })
    ok(ctx, result)
  } catch (err) {
    if (err instanceof InstallError) {
      return bad(ctx, err.code || 500, err.message, { stage: err.stage })
    }
    if (err instanceof MarketplaceError) {
      return bad(ctx, err.code || 502, err.message, { stage: err.stage })
    }
    return bad(ctx, 500, err instanceof Error ? err.message : 'upgrade failed')
  }
}

export async function uninstallExpert(ctx: Context) {
  const slug = ctx.params.slug
  if (!slug) return bad(ctx, 400, 'slug 必填')
  try {
    const result = await uninstallExpertFlow({ slug })
    ok(ctx, result)
  } catch (err) {
    if (err instanceof InstallError) {
      return bad(ctx, err.code || 500, err.message, { stage: err.stage })
    }
    return bad(ctx, 500, err instanceof Error ? err.message : 'uninstall failed')
  }
}

export async function getStatus(ctx: Context) {
  const slug = ctx.params.slug
  if (!slug) return bad(ctx, 400, 'slug 必填')
  const row = getInstalledExpertRow(slug)
  if (!row) return bad(ctx, 404, '未安装')
  const bindings = listBindingProfiles().filter(b => b.expert_slug === slug)
  ok(ctx, { installed_expert: row, bindings })
}

export async function getBindingForProfile(ctx: Context) {
  const name = ctx.params.name
  if (!name) return bad(ctx, 400, 'name 必填')
  const binding = getBindingByProfile(name)
  if (!binding) return bad(ctx, 404, '未找到绑定')
  ok(ctx, binding)
}
