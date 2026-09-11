/**
 * Knowledge plugin — mode selection composable.
 *
 * The active mode is persisted in localStorage and switched silently:
 * no toasts, no confirmations, and (critically) no data reload — the
 * container owns useKnowledgeData, so switching modes never clears
 * vaults/documents/health state.
 *
 * First-run onboarding is skippable; skipping keeps the default
 * (tasks) mode and never shows the picker again.
 */
import { ref } from 'vue'
import {
  DEFAULT_KNOWLEDGE_MODE,
  isKnowledgeMode,
  type KnowledgeMode,
} from '../modes'

const MODE_STORAGE_KEY = 'hermes.knowledge.mode'
const ONBOARDED_STORAGE_KEY = 'hermes.knowledge.modeOnboarded'

function loadStoredMode(): KnowledgeMode {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY)
    return isKnowledgeMode(raw) ? raw : DEFAULT_KNOWLEDGE_MODE
  } catch {
    return DEFAULT_KNOWLEDGE_MODE
  }
}

function loadOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function useKnowledgeMode() {
  const mode = ref<KnowledgeMode>(loadStoredMode())
  const onboarded = ref<boolean>(loadOnboarded())

  function persist(next: KnowledgeMode): void {
    mode.value = next
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next)
      localStorage.setItem(ONBOARDED_STORAGE_KEY, '1')
    } catch {
      // Storage unavailable (private mode) — session-only mode is fine.
    }
    onboarded.value = true
  }

  /** User picked a mode (from onboarding or the top-bar switcher). */
  function setMode(next: KnowledgeMode): void {
    persist(next)
  }

  /** User skipped onboarding — keep the default mode, stop asking. */
  function skipOnboarding(): void {
    persist(mode.value)
  }

  return { mode, onboarded, setMode, skipOnboarding }
}
