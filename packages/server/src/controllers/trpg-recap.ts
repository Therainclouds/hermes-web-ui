import type { Context } from 'koa'
import * as service from '../services/trpg/recap'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { userCanAccessProfile } from '../db/hermes/users-store'
function profile(ctx: Context) {
  const name = ctx.state.profile?.name || ctx.get('x-hermes-profile') || getActiveProfileName() || 'default'
  if (ctx.state.user && ctx.state.user.role !== 'super_admin' && !ctx.state.serverTokenAuth && !userCanAccessProfile(ctx.state.user.id, name)) ctx.throw(403, 'profile_forbidden')
  return name
}
async function handle(ctx: Context, fn: (profile: string) => Promise<unknown>) {
  try { ctx.body = await fn(profile(ctx)) }
  catch (e) {
    const err = e as { status?: number; code?: string; detail?: string }
    ctx.status = err.status || (err.code === 'ENOENT' ? 404 : 500)
    const code = ctx.status === 400 ? 'invalid_recap' : ctx.status === 403 ? 'profile_forbidden' : 'recap_failed'
    // detail is only a validation message, so it is safe to return and it stops the agent retrying blind.
    ctx.body = ctx.status === 400 && typeof err.detail === 'string' ? { code, detail: err.detail } : { code }
  }
}
export const prepare = (ctx: Context) => handle(ctx, p => service.prepareRecap(ctx.request.body, p))
export const list = (ctx: Context) => handle(ctx, async p => ({ recaps: await service.listRecaps(ctx.params.meetingId, p) }))
export const save = (ctx: Context) => handle(ctx, p => service.saveRecap(ctx.params.meetingId, ctx.request.body, p))
export const remove = (ctx: Context) => handle(ctx, async p => { await service.deleteRecap(ctx.params.meetingId, ctx.params.recapId, p); return { ok: true } })
export const transcript = (ctx: Context) => handle(ctx, p => service.recapTranscript(ctx.params.meetingId, String(ctx.query.requestId || ''), p, Number(ctx.query.cursor || 0)))
export const saveImage = (ctx: Context) => handle(ctx, p => service.saveRecapImage(ctx.params.meetingId, ctx.params.recapId, ctx.request.body, p).then(image => ({ image })))
export const image = (ctx: Context) => handle(ctx, async p => {
  const { buffer, mime } = await service.readRecapImage(ctx.params.meetingId, ctx.params.recapId, ctx.params.kind, String(ctx.query.chapterId || ''), p)
  // Cache briefly: the reader fetches once per open, and regeneration rewrites the slot.
  ctx.set('Content-Type', mime)
  ctx.set('Cache-Control', 'private, max-age=60')
  return buffer
})
export const markdown = (ctx: Context) => handle(ctx, async p => {
  const { markdown, title } = await service.readRecapMarkdown(ctx.params.meetingId, ctx.params.recapId, p)
  // Set the header before returning the string so Koa does not downgrade it to text/plain.
  ctx.set('Content-Type', 'text/markdown; charset=utf-8')
  if (String(ctx.query.download || '') === '1') {
    ctx.set('Content-Disposition', `attachment; filename="${ctx.params.recapId}.md"; filename*=UTF-8''${encodeURIComponent(title || ctx.params.recapId)}.md`)
  }
  return markdown
})

// Long novels run independently of the browser/chat tab. Profile checks match recaps.
import * as novel from '../services/trpg/novel'
export const novelJobs = (ctx: Context) => handle(ctx, async p => ({ jobs: await novel.listNovelJobs(ctx.params.meetingId, p) }))
export const novelStart = (ctx: Context) => handle(ctx, async p => ({ job: await novel.startNovelJob(ctx.params.meetingId, String((ctx.request.body as any)?.requestId || ''), p) }))
export const novelGet = (ctx: Context) => handle(ctx, async p => ({ job: await novel.getNovelJob(ctx.params.meetingId, ctx.params.jobId, p) }))
export const novelResume = (ctx: Context) => handle(ctx, async p => ({ job: await novel.resumeNovelJob(ctx.params.meetingId, ctx.params.jobId, p) }))
export const novelCancel = (ctx: Context) => handle(ctx, async p => ({ job: await novel.cancelNovelJob(ctx.params.meetingId, ctx.params.jobId, p) }))

export const novelWorkbench = (ctx: Context) => handle(ctx, p => novel.getNovelWorkbench(ctx.params.meetingId, ctx.params.jobId, p))
export const novelArtifact = (ctx: Context) => handle(ctx, p => novel.getNovelArtifact(ctx.params.meetingId, ctx.params.jobId, p, ctx.params.artifact, ctx.query.version ? String(ctx.query.version) : undefined))
export const novelEvidence = (ctx: Context) => handle(ctx, p => novel.getNovelEvidence(ctx.params.meetingId, ctx.params.jobId, p, Number(ctx.query.from), Number(ctx.query.to)))
export const novelPause = (ctx: Context) => handle(ctx, async p => ({ job: await novel.pauseNovelJob(ctx.params.meetingId, ctx.params.jobId, p) }))
export const novelConfigure = (ctx: Context) => handle(ctx, p => novel.updateNovelHarness(ctx.params.meetingId, ctx.params.jobId, p, ctx.request.body))

export const novelVisual = (ctx: Context) => handle(ctx, p => novel.matchNovelVisual(ctx.params.meetingId, ctx.params.jobId, p, ctx.request.body))
