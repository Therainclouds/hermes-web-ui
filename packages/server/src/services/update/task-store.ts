import type { UpdateTaskRecord, UpdateTaskStage, UpdateTaskStatus, UpdateTaskStatusResponse, UpdateStrategy } from './types'

type UpdateTaskPatch = Partial<Pick<UpdateTaskRecord, 'status' | 'stage' | 'message' | 'targetVersion' | 'warning' | 'error' | 'finishedAt'>>

class UpdateTaskStore {
  private currentTask: UpdateTaskRecord | null = null
  private lastTask: UpdateTaskRecord | null = null

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
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    this.currentTask = task
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
    this.currentTask = {
      ...this.currentTask,
      ...patch,
    }
    return this.getCurrentTask()
  }

  updateCurrentStage(
    stage: UpdateTaskStage,
    message: string,
    overrides: Partial<Pick<UpdateTaskRecord, 'status' | 'targetVersion' | 'warning' | 'error'>> = {},
  ): UpdateTaskRecord | null {
    return this.patchCurrentTask({
      stage,
      message,
      status: overrides.status ?? 'running',
      targetVersion: overrides.targetVersion,
      warning: overrides.warning,
      error: overrides.error,
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
    return finishedTask
  }

  clear(): void {
    this.currentTask = null
    this.lastTask = null
  }
}

export const updateTaskStore = new UpdateTaskStore()
