import type { Context } from 'koa'
import {
  DshPluginError,
} from '../../services/coding-agents/dsh'
import { getDshHost } from '../../services/coding-agents'

function errorResponse(ctx: Context, error: unknown) {
  const err = error instanceof DshPluginError ? error : null
  ctx.status = err ? err.status : 500
  ctx.body = {
    code: err ? err.code : 'DSH_PLUGIN_OPERATION_FAILED',
    error: err ? err.message : 'Unable to access DSH plugin state',
  }
}

export async function inventory(ctx: Context) {
  try {
    const host = await getDshHost()
    ctx.body = await host.getNativeDshPluginInventory()
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function change(ctx: Context) {
  try {
    const revision = ctx.get('If-Match')
    if (!/^"[a-f0-9]{64}"$/.test(revision)) {
      throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Expected the Web profile revision in If-Match')
    }
    const host = await getDshHost()
    ctx.body = await host.changePlugins(ctx.request.body, revision.slice(1, -1))
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function openUi(ctx: Context) {
  try {
    const host = await getDshHost()
    ctx.body = await host.ui.create(ctx.get('Authorization').replace(/^Bearer /, ''))
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function closeUi(ctx: Context) {
  try {
    const host = await getDshHost()
    host.ui.remove(ctx.params.id, ctx.get('Authorization').replace(/^Bearer /, ''))
    ctx.status = 204
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function ping(ctx: Context) {
  ctx.status = 204
}
