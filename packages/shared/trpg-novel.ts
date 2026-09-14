import type { WritingModel, HarnessControls } from './trpg-writing'
export type NovelStage = 'extracting' | 'planning' | 'writing' | 'reviewing' | 'assembling'
/** `interrupted` is a durable, disk-owned state: the worker that owned the job is gone
 *  (server restart or crash). It is written by startup reconcile, never inferred from the
 *  lifetime of the in-process worker map, so a second backend process cannot make a live
 *  job look paused. */
export type NovelStatus = 'running' | 'paused' | 'interrupted' | 'failed' | 'cancelled' | 'completed'
export interface NovelJob {
  id: string
  meetingId: string
  status: NovelStatus
  stage: NovelStage
  totalSentences: number
  totalChars: number
  processedSentences: number
  chunks: number
  extracted: number
  chapters: number
  planned: number
  scenes: number
  written: number
  reviewed: number
  outputChars: number
  targetChars: number
  tokenUsage?: { inputTokens: number; outputTokens: number; reportedCalls: number; estimatedCalls: number; incompleteCalls: number; untrackedCalls: number }
  calls: number
  createdAt: number
  updatedAt: number
  recapId?: string
  error?: string
  pauseRequested?: boolean
  preparedChunks?: number
  preparedScenes?: number
  canonized?: number
  failure?: { step: string; detail: string; attempt: number }
  /** Set by startup reconcile when the owning worker disappeared mid-run. */
  interruptedAt?: number
  /** Durable record of a step that exhausted its attempts with unchanged inputs. A later
   *  resume does not call the model again until the model route, direction, harness policy
   *  or the artifact itself changes. */
  blocked?: { step: string; detail: string; attempts: number; at: number }
  /** How many model calls had their input compacted to fit the context budget. */
  compactedCalls?: number
  /** Estimated tokens removed by context compaction (sum over calls). */
  compactedTokens?: number
  /** Compacted rolling-memory summaries reused from checkpoint (no model call). */
  compactedReused?: number
  activeSteps?: { name: string; startedAt: number; model?: WritingModel; attempt: number }[]
  currentStep?: { name: string; startedAt: number; model?: WritingModel }
  pauseReason?: 'manual' | 'outline' | 'chapter'
  waitingChapter?: number
  warnings: string[]
}

export interface NovelArtifact {
  name: string
  createdAt: number
  version: string
  inputHash: string
  model?: WritingModel
  value: unknown
}
export interface NovelLayoutChapter { index: number; scenes: { index: number; from: number; to: number; title: string }[] }
export interface NovelWorkbench {
  liveOutputs?: { step: string; text: string; updatedAt: number }[]
  job: NovelJob
  controls: HarnessControls
  layout: NovelLayoutChapter[]
  artifacts: { name: string; createdAt: number; model?: WritingModel }[]
  events: { at: number; type: string; step?: string; revision?: number }[]
}
