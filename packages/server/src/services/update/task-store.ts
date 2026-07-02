import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { config } from '../../config'
import type { UpdateTaskRecord, UpdateTaskStage, UpdateTaskStatus, UpdateTaskStatusResponse, UpdateStrategy } from './types'

export const INTERRUPTED_UPDATE_TASK_ERROR_PREFIX = 'Previous update task was interrupted'

type UpdateTaskPatch = Partial<Pick<
  UpdateTaskRecord,
  'status' | 'stage' | 'message' | 'targetVersion' | 'warning' | 'error' | 'logPath' | 'rollbackMessage' | 'healthcheckUrl' | 'finishedAt'
>>

interface PersistedUpdateTaskState {
  currentTask: UpdateTaskRecord | null
  lastTask: UpdateTaskRecord | null
}

function isTaskRecord(value: unknown): value is UpdateTaskRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.strategy === 'string'
    && typeof record.status === 'string'
    && typeof record.stage === 'string'
    && typeof record.message === 'string'
    && typeof record.targetVersion === 'string'
    && typeof record.warning === 'string'
    && typeof record.error === 'string'
    && typeof record.logPath === 'string'
    && typeof record.rollbackMessage === 'string'
    && typeof record.healthcheckUrl === 'string'
    && typeof record.startedAt === 'string'
    && (typeof record.finishedAt === 'string' || record.finishedAt === null)
}

function normalizePersistedState(payload: unknown): PersistedUpdateTaskState {
  if (!payload || typeof payload !== 'object') {
    return { currentTask: null, lastTask: null }
  }
  const candidate = payload as Record<string, unknown>
  return {
    currentTask: isTaskRecord(candidate.currentTask) ? candidate.currentTask : null,
    lastTask: isTaskRecord(candidate.lastTask) ? candidate.lastTask : null,
  }
}

function isRunningTask(task: UpdateTaskRecord | null): task is UpdateTaskRecord {
  return Boolean(task && (task.status === 'queued' || task.status === 'running'))
}

function interruptedTaskMessage(stage: UpdateTaskStage): string {
  return `Previous update task was interrupted during ${stage}.`
}

function isInterruptedTaskRecord(task: UpdateTaskRecord | null): task is UpdateTaskRecord {
  return Boolean(task && task.error.startsWith(INTERRUPTED_UPDATE_TASK_ERROR_PREFIX))
}

export class UpdateTaskStore {
  private currentTask: UpdateTaskRecord | null = null
  private lastTask: UpdateTaskRecord | null = null
  private readonly stateFilePath: string

  constructor(stateFilePath = config.update.stateFile) {
    this.stateFilePath = stateFilePath
    this.syncFromDisk()
  }

  getStateFilePath(): string {
    return this.stateFilePath
  }

  private snapshot(): PersistedUpdateTaskState {
    return {
      currentTask: this.getCurrentTask(),
      lastTask: this.getLastTask(),
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.stateFilePath), { recursive: true })
    const tempPath = `${this.stateFilePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(this.snapshot(), null, 2), 'utf-8')
    renameSync(tempPath, this.stateFilePath)
  }

  syncFromDisk(): void {
    if (!existsSync(this.stateFilePath)) {
      return
    }
    try {
      const payload = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'))
      const restored = normalizePersistedState(payload)
      this.currentTask = restored.currentTask
      this.lastTask = restored.lastTask
    } catch (error) {
      console.warn('[update] failed to load persisted task state:', error)
      this.currentTask = null
    }
  }

  recoverInterruptedTask(): UpdateTaskRecord | null {
    if (!isRunningTask(this.currentTask)) {
      return null
    }

    const message = interruptedTaskMessage(this.currentTask.stage)
    const recoveredTask: UpdateTaskRecord = {
      ...this.currentTask,
      status: 'failed',
      stage: 'failed',
      message,
      error: message,
      finishedAt: new Date().toISOString(),
    }
    this.lastTask = recoveredTask
    this.currentTask = null
    this.persist()
    return this.getLastTask()
  }

  clearRecoveredInterruptedTask(): UpdateTaskRecord | null {
    if (this.currentTask || !isInterruptedTaskRecord(this.lastTask)) {
      return null
    }

    const clearedTask = this.getLastTask()
    this.lastTask = null
    if (existsSync(this.stateFilePath)) {
      unlinkSync(this.stateFilePath)
    }
    return clearedTask
  }

  clearStaleFinishedTask(): UpdateTaskRecord | null {
    if (this.currentTask || !this.lastTask?.finishedAt) {
      return null
    }

    const clearedTask = this.getLastTask()
    this.lastTask = null
    if (existsSync(this.stateFilePath)) {
      unlinkSync(this.stateFilePath)
    }
    return clearedTask
  }

  createTask(strategy: UpdateStrategy, initialMessage: string): UpdateTaskRecord {
    const task: UpdateTaskRecord = {
      id: `update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      strategy,
      status: 'queued',
      stage: 'queued',
      message: initialMessage,
      targetVersion: '',
      warning: '',
      error: '',
      logPath: '',
      rollbackMessage: '',
      healthcheckUrl: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    this.currentTask = task
    this.persist()
    return task
  }

  getCurrentTask(): UpdateTaskRecord | null {
    return this.currentTask ? { ...this.currentTask } : null
  }

  getLastTask(): UpdateTaskRecord | null {
    return this.lastTask ? { ...this.lastTask } : null
  }

  getStatus(): UpdateTaskStatusResponse {
    return {
      currentTask: this.getCurrentTask(),
      lastTask: this.getLastTask(),
    }
  }

  patchCurrentTask(patch: UpdateTaskPatch): UpdateTaskRecord | null {
    if (!this.currentTask) return null
    const sanitizedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as UpdateTaskPatch
    this.currentTask = {
      ...this.currentTask,
      ...sanitizedPatch,
    }
    this.persist()
    return this.getCurrentTask()
  }

  updateCurrentStage(
    stage: UpdateTaskStage,
    message: string,
    overrides: Partial<Pick<UpdateTaskRecord, 'status' | 'targetVersion' | 'warning' | 'error' | 'logPath' | 'rollbackMessage' | 'healthcheckUrl'>> = {},
  ): UpdateTaskRecord | null {
    return this.patchCurrentTask({
      stage,
      message,
      status: overrides.status ?? 'running',
      targetVersion: overrides.targetVersion,
      warning: overrides.warning,
      error: overrides.error,
      logPath: overrides.logPath,
      rollbackMessage: overrides.rollbackMessage,
      healthcheckUrl: overrides.healthcheckUrl,
    })
  }

  completeCurrentTask(stage: Extract<UpdateTaskStage, 'succeeded' | 'failed'>, message: string, error = ''): UpdateTaskRecord | null {
    const status: UpdateTaskStatus = stage === 'succeeded' ? 'succeeded' : 'failed'
    const finishedTask = this.patchCurrentTask({
      status,
      stage,
      message,
      error,
      finishedAt: new Date().toISOString(),
    })
    if (!finishedTask) return null
    this.lastTask = finishedTask
    this.currentTask = null
    this.persist()
    return finishedTask
  }

  markRolledBack(message: string, rollbackMessage: string): UpdateTaskRecord | null {
    const finishedTask = this.patchCurrentTask({
      status: 'failed',
      stage: 'rolled_back',
      message,
      rollbackMessage,
      finishedAt: new Date().toISOString(),
    })
    if (!finishedTask) return null
    this.lastTask = finishedTask
    this.currentTask = null
    this.persist()
    return finishedTask
  }

  clear(): void {
    this.currentTask = null
    this.lastTask = null
    if (existsSync(this.stateFilePath)) {
      unlinkSync(this.stateFilePath)
    }
  }
}

export const updateTaskStore = new UpdateTaskStore()
