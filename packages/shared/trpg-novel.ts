import type { WritingModel, HarnessControls } from './trpg-writing'
export type NovelStage = 'extracting' | 'planning' | 'writing' | 'reviewing' | 'assembling'
export type NovelStatus = 'running' | 'paused' | 'failed' | 'cancelled' | 'completed'
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
