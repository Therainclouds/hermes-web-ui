import type { WritingModel } from './trpg-writing'
export interface NovelVisualMatch {
  chapter: number; scene: number; title: string; score: number; reason: string
  evidence: { index: number; quote: string }[]
  artifacts?: { canon?: { name: string; version: string }; material?: { name: string; version: string } }
  prose?: { quote: string; paragraph: number; version?: string }
}
export interface NovelVisualAnalysis {
  description: string; uncertainties: string[]; matches: NovelVisualMatch[]
  candidateCount: number; sceneCount: number; model?: WritingModel
}
