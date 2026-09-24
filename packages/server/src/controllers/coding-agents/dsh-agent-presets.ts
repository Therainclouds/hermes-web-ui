import type { Context } from 'koa'
import { DshPluginError } from '../../services/coding-agents/dsh'
import { getDshHost } from '../../services/coding-agents'

async function respond(ctx: Context, operation: () => Promise<unknown>) {
  try {
    const host = await getDshHost()
    ctx.body = await operation.call(host.presets)
  } catch (error) {
    const err = error instanceof DshPluginError ? error : null
    ctx.status = err ? err.status : 500
    ctx.body = {
      code: err ? err.code : 'DSH_PRESET_OPERATION_FAILED',
      error: err ? err.message : 'Unable to access DSH presets',
    }
  }
}

export const choices = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.choices()
  })

export const list = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.list()
  })

export const read = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.read(ctx.params.presetId)
  })

export const copy = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.copy(ctx.request.body)
  })

export const remove = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.remove(ctx.params.presetId)
  })

export const makeDefault = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.makeDefault(ctx.params.presetId)
  })

export const openLocation = (ctx: Context) =>
  respond(ctx, function (this: any) {
    return this.openLocation(ctx.params.presetId)
  })
