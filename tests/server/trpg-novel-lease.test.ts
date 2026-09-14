import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PROCESS_OWNER, leaseHeldByLiveOwner, leaseIsFresh, pidAlive, readLease, reconcileNovelJobs,
  releaseLease, renewLease, writeLease, type NovelLease,
} from '../../packages/server/src/services/trpg/novel-lease'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'trpg-lease-')); vi.stubEnv('HERMES_WEB_UI_HOME', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

const jobDir = (meetingId: string, jobId: string) => join(home, 'meetings', meetingId, 'novel-jobs', jobId)
const jobId = '11111111-1111-4111-8111-111111111111'
const foreign = (over: Partial<NovelLease> = {}): NovelLease => ({ ownerId: 'another-process', pid: process.pid, jobId, startedAt: Date.now(), heartbeatAt: Date.now(), ...over })

describe('novel job lease', () => {
  it('claims, heartbeats and releases only its own lease', async () => {
    const dir = jobDir('m1', jobId)
    const lease = await writeLease(dir, jobId)
    expect(lease.ownerId).toBe(PROCESS_OWNER)
    expect(lease.pid).toBe(process.pid)
    const before = (await readLease(dir))!.heartbeatAt
    await new Promise(resolve => setTimeout(resolve, 5))
    await renewLease(dir, jobId)
    expect((await readLease(dir))!.heartbeatAt).toBeGreaterThan(before)
    expect((await readLease(dir))!.startedAt).toBe(lease.startedAt)
    await releaseLease(dir, jobId)
    expect(await readLease(dir)).toBeUndefined()
  })

  it('never releases a lease owned by another process', async () => {
    const dir = jobDir('m2', jobId)
    await writeLease(dir, jobId)
    await writeFile(join(dir, 'lease.json'), JSON.stringify(foreign()))
    await releaseLease(dir, jobId)
    expect((await readLease(dir))!.ownerId).toBe('another-process')
  })

  it('treats a foreign lease as live only while it is fresh and its process exists', () => {
    expect(leaseHeldByLiveOwner(foreign())).toBe(true)
    expect(leaseHeldByLiveOwner(foreign({ heartbeatAt: Date.now() - 60 * 60_000 }))).toBe(false)
    expect(leaseHeldByLiveOwner(foreign({ pid: 2_000_000_000 }))).toBe(false)
    // Our own lease is never "another live owner": this process knows its own workers.
    expect(leaseHeldByLiveOwner({ ...foreign(), ownerId: PROCESS_OWNER })).toBe(false)
    expect(leaseIsFresh(undefined)).toBe(false)
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('interrupts a running job with a dead owner and leaves a live foreign owner alone', async () => {
    const write = async (meetingId: string, id: string, job: unknown) => {
      await writeFile(join(home, 'meetings', meetingId, 'novel-jobs', id, 'job.json'), JSON.stringify(job))
    }
    const dead = '22222222-2222-4222-8222-222222222222'
    const aliveId = '33333333-3333-4333-8333-333333333333'
    const paused = '44444444-4444-4444-8444-444444444444'
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([
      mkdir(jobDir('m3', dead), { recursive: true }),
      mkdir(jobDir('m3', aliveId), { recursive: true }),
      mkdir(jobDir('m3', paused), { recursive: true }),
    ]))
    await write('m3', dead, { id: dead, meetingId: 'm3', profile: 'p', status: 'running', stage: 'writing', currentStep: { name: 'write-0' }, warnings: [], updatedAt: 1, createdAt: 1 })
    await write('m3', aliveId, { id: aliveId, meetingId: 'm3', profile: 'p', status: 'running', stage: 'writing', warnings: [], updatedAt: 1, createdAt: 1 })
    await write('m3', paused, { id: paused, meetingId: 'm3', profile: 'p', status: 'completed', stage: 'assembling', warnings: [], updatedAt: 1, createdAt: 1 })

    await writeFile(join(jobDir('m3', dead), 'lease.json'), JSON.stringify({ ...foreign(), pid: 2_000_000_000, jobId: dead }))
    await writeFile(join(jobDir('m3', aliveId), 'lease.json'), JSON.stringify({ ...foreign(), jobId: aliveId }))

    const result = await reconcileNovelJobs(home)
    expect(result).toMatchObject({ scanned: 2, interrupted: 1, live: 1 })
    expect(result.jobs).toEqual([{ meetingId: 'm3', jobId: dead, status: 'interrupted' }])

    const interrupted = JSON.parse(await readFile(join(jobDir('m3', dead), 'job.json'), 'utf8'))
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.interruptedAt).toBeGreaterThan(0)
    expect(interrupted.currentStep).toBeUndefined()
    expect(await readLease(jobDir('m3', dead))).toBeUndefined()
    // A live owner keeps running and its job is untouched.
    expect(JSON.parse(await readFile(join(jobDir('m3', aliveId), 'job.json'), 'utf8')).status).toBe('running')
    // A terminal job is never rescanned.
    expect(JSON.parse(await readFile(join(jobDir('m3', paused), 'job.json'), 'utf8')).status).toBe('completed')
  })

  it('is a no-op when the state directory does not exist yet', async () => {
    expect(await reconcileNovelJobs(join(home, 'missing'))).toEqual({ scanned: 0, interrupted: 0, live: 0, jobs: [] })
  })
})
