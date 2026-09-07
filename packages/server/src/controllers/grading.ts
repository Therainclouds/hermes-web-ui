import { requestClient, completeClientRequest } from '../services/grading/client-requests'
import type { Context } from 'koa'
import { catalog, createClass, createExam, fail, listSubmissions, readSettings, readSubmission, requiredText, saveSubmission, writeSettings } from '../services/grading/store'
import { capture, step, validateResults } from '../services/grading/pipeline'
import { summarize } from '../services/grading/annotation-engine'

function profileFor(ctx: Context) {
  if (!ctx.state.user && !ctx.state.serverTokenAuth) fail('Unauthorized', 401)
  const profile = String(ctx.state.profile?.name || ctx.get('x-hermes-profile') || ctx.query.profile || 'default')
  const user = ctx.state.user
  if (!ctx.state.serverTokenAuth && user?.role !== 'super_admin' && !user?.profiles?.includes(profile)) fail('Profile access denied', 403)
  return profile
}
export async function gradingRequest(ctx: Context) {
  try {
    const profile = profileFor(ctx)
    const action = ctx.params.action
    const args = (ctx.request as any).body || {}
    if (action === 'settings') { ctx.body = ctx.method === 'GET' ? readSettings(profile) : writeSettings(profile, args); return }
    if (!readSettings(profile).enabled) fail('Enable the scanner and paper-grading plugins first', 403)
    switch (action) {
      case 'catalog': case 'list_exams': ctx.body = catalog(profile); break
      case 'create_class': ctx.body = createClass(profile, args.name, args.year); break
      case 'create_exam': ctx.body = createExam(profile, args); break
      case 'list': ctx.body = listSubmissions(profile, requiredText(args.examId)); break
      case 'capture_scan': ctx.body = args.image ? await capture(profile, args) : await requestClient(profile, 'capture', { examId: args.examId, pageNumber: args.pageNumber }); break
      case 'client_complete': completeClientRequest(profile, requiredText(args.requestId), args.result); ctx.body = { ok: true }; break
      case 'get': ctx.body = readSubmission(profile, requiredText(args.scanId)); break
      case 'summary': {
        if (!Array.isArray(args.scanIds) || args.scanIds.length > 1000) fail('Invalid scan IDs')
        ctx.body = summarize([...new Set<string>(args.scanIds.map((id: unknown) => requiredText(id)))].map(id => readSubmission(profile, id))); break
      }
      case 'review': {
        const s = readSubmission(profile, requiredText(args.scanId))
        if (s.revision !== args.revision) fail('Submission changed; reload before reviewing', 409)
        s.results = validateResults(args.results, s.questions)
        s.status = 'done'; s.revision++; saveSubmission(profile, s); ctx.body = { revision: s.revision }; break
      }
      case 'save_annotations': {
        const s = readSubmission(profile, requiredText(args.scanId))
        if (args.revision !== s.revision) fail('Submission changed; reload before saving', 409)
        if (!Array.isArray(args.annotations) || args.annotations.length > 2000) fail('Invalid annotations')
        for (const a of args.annotations) {
          if (!a || typeof a.id !== 'string' || typeof a.content !== 'string' || a.content.length > 5000 || !['badge', 'comment', 'circle', 'cross', 'underline', 'pen'].includes(a.kind) || !Array.isArray(a.bbox) || a.bbox.length !== 4 || a.bbox.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)) || (a.points && (!Array.isArray(a.points) || a.points.length > 20000 || a.points.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n))))) fail('Invalid annotation')
        }
        s.annotations = args.annotations; s.revision++; saveSubmission(profile, s); ctx.body = { revision: s.revision }; break
      }
      case 'render': { const scanId = requiredText(args.scanId); readSubmission(profile, scanId); ctx.body = await requestClient(profile, 'render', { scanId, style: args.style === 'printed' ? 'printed' : 'rough' }); break }
      case 'ocr': case 'detect_questions': case 'grade': case 'apply_edits': ctx.body = await step(profile, requiredText(args.scanId), action, args); break
      default: fail('Unknown grading action', 404)
    }
  } catch (error: any) { ctx.status = error.status || 500; ctx.body = { error: error.message, code: 'grading_error' } }
}
