import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getWebUiHome } from '../../config'
import { writeHarnessJson } from './novel-harness'

/** Identity of *this* backend process. Every lease carries it so a job can tell "the worker
 *  that owns me is still alive here" from "the worker that owned me is gone". A PID is not
 *  enough: a dev server, a second `dsh web`, and a restarted process can all look alike. */
export const PROCESS_OWNER = randomUUID()
/** Longest time a live worker may go without a heartbeat. One model call is capped at 240s
 *  and every attempt checkpoints afterwards, so 10 minutes is comfortably above the real
 *  worst-case gap while still reclaiming a crashed job quickly. */
export const LEASE_TTL_MS = 10 * 60_000
/** Written every 30s while a worker is running; it is a separate file from job.json so a
 *  heartbeat can never clobber a concurrent checkpoint write. */
export const LEASE_HEARTBEAT_MS = 30_000

export interface NovelLease {
  ownerId: string
  pid: number
  jobId: string
  /** When this worker first claimed the job; survives heartbeats. */
  startedAt: number
  heartbeatAt: number
}

export const leasePath = (dir: string) => join(dir, 'lease.json')

export async function readLease(dir: string): Promise<NovelLease | undefined> {
  try {
    const lease = JSON.parse(await readFile(leasePath(dir), 'utf8')) as NovelLease
    return lease && typeof lease.ownerId === 'string' ? lease : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // An unreadable/corrupt lease is treated as absent: the job can be reclaimed, which is
    // the safe direction (a stale lock would otherwise wedge the job forever).
    return undefined
  }
}

export function leaseIsFresh(lease: NovelLease | undefined, now = Date.now()): boolean {
  return !!lease && Number.isFinite(lease.heartbeatAt) && now - lease.heartbeatAt < LEASE_TTL_MS
}

/** `process.kill(pid, 0)` is the portable liveness probe: it returns without signalling. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A different process is running this job right now and is still heartbeating. */
export function leaseHeldByLiveOwner(lease: NovelLease | undefined, now = Date.now()): boolean {
  return !!lease && lease.ownerId !== PROCESS_OWNER && leaseIsFresh(lease, now) && pidAlive(lease.pid)
}

async function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}

export async function writeLease(dir: string, jobId: string): Promise<NovelLease> {
  await mkdir(dir, { recursive: true })
  const previous = await readLease(dir)
  const lease: NovelLease = {
    ownerId: PROCESS_OWNER,
    pid: process.pid,
    jobId,
    startedAt: previous?.jobId === jobId && previous.ownerId === PROCESS_OWNER ? previous.startedAt : Date.now(),
    heartbeatAt: Date.now(),
  }
  await atomicJson(leasePath(dir), lease)
  return lease
}

export async function renewLease(dir: string, jobId: string): Promise<void> {
  const lease = await readLease(dir)
  if (lease?.ownerId !== PROCESS_OWNER || lease.jobId !== jobId) return
  await atomicJson(leasePath(dir), { ...lease, heartbeatAt: Date.now() })
}

/** Only the owner releases; a worker that lost its lease must never delete the new owner's. */
export async function releaseLease(dir: string, jobId: string): Promise<void> {
  const lease = await readLease(dir)
  if (lease?.ownerId !== PROCESS_OWNER || lease.jobId !== jobId) return
  await rm(leasePath(dir), { force: true })
}

/** Unconditional removal, for reconcile only: it removes a lease whose owner it has already
 *  proved is not a live process, so no live worker can lose its claim. */
export async function clearLease(dir: string): Promise<void> {
  await rm(leasePath(dir), { force: true })
}

/** Cross-process mutual exclusion for every mutation (start/resume/edit/reset). The in-process
 *  `active` map only guards one Node process. There is still a narrow check-then-write window;
 *  the lease plus the single-writer directory convention close the realistic cases. */
export async function assertJobAvailable(dir: string, jobId: string): Promise<void> {
  const lease = await readLease(dir)
  if (!leaseHeldByLiveOwner(lease)) return
  throw Object.assign(new Error('novel_busy'), { status: 409, detail: `novel job ${jobId} is owned by another server process (pid ${lease!.pid})` })
}

const MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const JOB_ID = /^[0-9a-f-]{36}$/

export interface ReconcileResult { scanned: number; interrupted: number; live: number; jobs: { meetingId: string; jobId: string; status: string }[] }

/** Startup reconcile for the whole state directory.
 *
 *  A job whose persisted status is `running` but whose lease is absent, expired, owned by a
 *  dead PID, or owned by a previous boot of this process is not running: it is `interrupted`.
 *  Writing that to job.json is what removes the old lie where a crashed/restarted server left
 *  `running` on disk and relied on the in-memory worker map to silently render `paused`.
 *
 *  A foreign lease that is fresh *and* whose PID is alive is left alone, so two servers that
 *  share a state directory do not interrupt each other's live work. Jobs are never auto-started
 *  here: recovering an interrupted job stays an explicit, consent-gated user action. */
export async function reconcileNovelJobs(home = getWebUiHome()): Promise<ReconcileResult> {
  const result: ReconcileResult = { scanned: 0, interrupted: 0, live: 0, jobs: [] }
  const meetingsDir = join(home, 'meetings')
  let meetings: string[]
  try { meetings = await readdir(meetingsDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  for (const meetingId of meetings.filter(id => MEETING_ID.test(id))) {
    const jobsDir = join(meetingsDir, meetingId, 'novel-jobs')
    let jobIds: string[]
    try { jobIds = (await readdir(jobsDir)).filter(id => JOB_ID.test(id)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    for (const jobId of jobIds) {
      const dir = join(jobsDir, jobId)
      let job: any
      try { job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) } catch { continue }
      if (job?.status !== 'running') continue
      result.scanned++
      const lease = await readLease(dir)
      if (leaseHeldByLiveOwner(lease)) { result.live++; continue }
      job.status = 'interrupted'
      job.interruptedAt = Date.now()
      job.updatedAt = Date.now()
      delete job.currentStep
      delete job.activeSteps
      delete job.error
      await writeHarnessJson(join(dir, 'job.json'), job)
      await clearLease(dir).catch(() => {})
      await writeHarnessJson(join(dir, 'events.json'), [
        ...(await readHarnessEvents(dir)),
        { at: Date.now(), type: 'interrupted' },
      ].slice(-200))
      result.interrupted++
      result.jobs.push({ meetingId, jobId, status: 'interrupted' })
    }
  }
  return result
}

async function readHarnessEvents(dir: string): Promise<any[]> {
  try { return JSON.parse(await readFile(join(dir, 'events.json'), 'utf8')) as any[] } catch { return [] }
}
