export interface DesktopWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface HermesDesktopBridge {
  getToken: () => Promise<string>
  ensureAuth?: () => Promise<boolean>
  retryBootstrap: (source?: 'cf' | 'github') => Promise<void>
  notifyCompletion: (payload: { title: string; body?: string; icon?: string; tag?: string }) => Promise<boolean>
  getWindowState: () => Promise<{ isMaximized: boolean }>
  windowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<{ isMaximized: boolean }>
  platform: string
  isDesktop: boolean
  windowKind?: 'main'
}

export type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

export function desktopBridge(): HermesDesktopBridge | undefined {
  return (window as WindowWithHermesDesktop).hermesDesktop
}

export function isDesktopShell(): boolean {
  return desktopBridge()?.isDesktop === true
}
