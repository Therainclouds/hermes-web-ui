import { readFileSync } from 'node:fs'

const REQUIRED_TERMINAL_RUNTIME_MARKERS = [
  '/api/hermes/terminal',
  'node-pty failed to load, terminal feature disabled',
  'WebSocket ready at /terminal',
]

export function assertTerminalRuntimeBundle(filePath, label = filePath) {
  const contents = readFileSync(filePath, 'utf-8')
  const missingMarkers = REQUIRED_TERMINAL_RUNTIME_MARKERS.filter(marker => !contents.includes(marker))
  if (missingMarkers.length > 0) {
    throw new Error(
      `Terminal runtime verification failed for ${label}. Missing markers: ${missingMarkers.join(', ')}`,
    )
  }
}
