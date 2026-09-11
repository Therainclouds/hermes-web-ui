/**
 * Knowledge plugin — mode registry.
 *
 * Five user-facing modes share one route; the container swaps the active
 * mode view via `<component :is>`. Each view is an async component so the
 * first screen only ships the default (tasks) chunk — the device budget is
 * gzip < 500KB for the initial knowledge load.
 *
 * i18n contract: every mode id must have `knowledge.modes.<id>.label` and
 * `knowledge.modes.<id>.desc` in each locale file.
 */
import { defineAsyncComponent, type Component } from 'vue'

export type KnowledgeMode = 'tasks' | 'legal' | 'learning' | 'explorer' | 'batch'

export interface KnowledgeModeDefinition {
  id: KnowledgeMode
  /** Inline SVG path (24x24 viewBox) rendered by the container. */
  iconPath: string
}

export const DEFAULT_KNOWLEDGE_MODE: KnowledgeMode = 'tasks'

export const KNOWLEDGE_MODES: KnowledgeModeDefinition[] = [
  {
    id: 'tasks',
    // clipboard-check: task progress first.
    iconPath: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4',
  },
  {
    id: 'legal',
    // scales: compliance review.
    iconPath: 'M12 3v18m0-18-7 4m7-4 7 4M5 7l-3 7a3 3 0 0 0 6 0L5 7Zm14 0-3 7a3 3 0 0 0 6 0l-3-7ZM8 21h8',
  },
  {
    id: 'learning',
    // link: backlinks (round 2).
    iconPath: 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m9.86-3.179a4.5 4.5 0 0 0-1.242-7.244l-4.5-4.5a4.5 4.5 0 0 0-6.364 6.364l1.757 1.757',
  },
  {
    id: 'explorer',
    // share-nodes: graph + vec0 internals.
    iconPath: 'M7.5 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm9-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.7 16.1l4.6-2.6m0-3L9.7 7.9',
  },
  {
    id: 'batch',
    // squares-plus: bulk file labor.
    iconPath: 'M4 4h7v7H4V4Zm9 9h7v7h-7v-7Zm0-9h7v7h-7V4ZM4 13h7v7H4v-7Z',
  },
]

const MODE_COMPONENTS: Record<KnowledgeMode, Component> = {
  tasks: defineAsyncComponent(() => import('./components/modes/TasksModeView.vue')),
  legal: defineAsyncComponent(() => import('./components/modes/LegalModeView.vue')),
  learning: defineAsyncComponent(() => import('./components/modes/LearningModeView.vue')),
  explorer: defineAsyncComponent(() => import('./components/modes/ExplorerModeView.vue')),
  batch: defineAsyncComponent(() => import('./components/modes/BatchModeView.vue')),
}

export function isKnowledgeMode(value: unknown): value is KnowledgeMode {
  return typeof value === 'string' && KNOWLEDGE_MODES.some(m => m.id === value)
}

export function getModeComponent(mode: KnowledgeMode): Component {
  return MODE_COMPONENTS[mode]
}
