export type TerminalRuntimeTransport = 'node-pty' | 'disabled'

export type TerminalRuntimeReason =
  | 'ready'
  | 'websocket_not_initialized'
  | 'node_pty_failed_to_load'

export type TerminalRuntimeStatus = {
  enabled: boolean
  ready: boolean
  transport: TerminalRuntimeTransport
  reason: TerminalRuntimeReason
  requiresSuperAdmin: boolean
}

let terminalRuntimeStatus: TerminalRuntimeStatus = {
  enabled: true,
  ready: false,
  transport: 'node-pty',
  reason: 'websocket_not_initialized',
  requiresSuperAdmin: true,
}

export function getTerminalRuntimeStatus(): TerminalRuntimeStatus {
  return { ...terminalRuntimeStatus }
}

export function markTerminalRuntimeReady(): void {
  terminalRuntimeStatus = {
    enabled: true,
    ready: true,
    transport: 'node-pty',
    reason: 'ready',
    requiresSuperAdmin: true,
  }
}

export function markTerminalRuntimeUnavailable(
  reason: Extract<TerminalRuntimeReason, 'websocket_not_initialized' | 'node_pty_failed_to_load'>,
): void {
  terminalRuntimeStatus = {
    enabled: false,
    ready: false,
    transport: 'disabled',
    reason,
    requiresSuperAdmin: true,
  }
}
