import { beforeEach, describe, expect, it } from 'vitest'
import { updateTaskStore } from '../../packages/server/src/services/update/task-store'

describe('update task store', () => {
  beforeEach(() => {
    updateTaskStore.clear()
  })

  it('creates a queued task and exposes it as the current task', () => {
    const task = updateTaskStore.createTask('source-deploy', 'accepted')

    expect(task.id).toContain('update-')
    expect(updateTaskStore.getStatus()).toEqual({
      currentTask: expect.objectContaining({
        id: task.id,
        status: 'queued',
        stage: 'queued',
        message: 'accepted',
      }),
      lastTask: null,
    })
  })

  it('updates the current task stage and keeps the task active', () => {
    updateTaskStore.createTask('npm-package', 'accepted')
    updateTaskStore.updateCurrentStage('installing', 'installing package', {
      targetVersion: '0.6.13',
      warning: 'compat layout',
    })

    expect(updateTaskStore.getStatus().currentTask).toEqual(expect.objectContaining({
      status: 'running',
      stage: 'installing',
      targetVersion: '0.6.13',
      warning: 'compat layout',
    }))
  })

  it('moves the task into lastTask when it completes', () => {
    updateTaskStore.createTask('source-deploy', 'accepted')
    updateTaskStore.completeCurrentTask('failed', 'update failed', 'engine mismatch')

    expect(updateTaskStore.getStatus()).toEqual({
      currentTask: null,
      lastTask: expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        message: 'update failed',
        error: 'engine mismatch',
        finishedAt: expect.any(String),
      }),
    })
  })
})
