import { spawn } from 'child_process'
import { cpSync, existsSync, mkdirSync } from 'fs'
import net from 'net'
import { dirname, join } from 'path'
import { logger } from '../logger'
import type { ChatGptWebConfig } from './config'

/**
 * Browser host management for the ChatGPT web bridge.
 *
 * The bridge needs a *headed, non-automation* Chrome running inside the user's
 * desktop session:
 *
 *  - headed, because Cloudflare challenges cannot be solved headlessly;
 *  - not launched through an automation library, so `navigator.webdriver` stays
 *    false and both Cloudflare and Google sign-in treat it as a normal browser;
 *  - inside the desktop session, because Chrome decrypts its cookie store with
 *    a key from the OS keyring. A Chrome started from a sandboxed service gets
 *    the wrong key, treats every cookie as corrupt and purges them.
 *
 * That is why this module seeds the user's existing login into a dedicated
 * profile and then launches Chrome directly instead of re-authenticating.
 */

export class ChatGptWebBrowserError extends Error {
  readonly code = 'chatgpt_web_browser_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'ChatGptWebBrowserError'
  }
}

export interface BrowserStatus {
  reachable: boolean
  port: number
  webSocketDebuggerUrl: string | null
  browserVersion: string | null
}

const CDP_PROBE_TIMEOUT_MS = 2_000
const LAUNCH_TIMEOUT_MS = 40_000
const PORT_SCAN_RANGE = 20

export async function probeCdp(port: number, timeoutMs = CDP_PROBE_TIMEOUT_MS): Promise<BrowserStatus> {
  const empty: BrowserStatus = { reachable: false, port, webSocketDebuggerUrl: null, browserVersion: null }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return empty
    const body: any = await res.json()
    if (typeof body?.webSocketDebuggerUrl !== 'string') return empty
    return {
      reachable: true,
      port,
      webSocketDebuggerUrl: body.webSocketDebuggerUrl,
      browserVersion: typeof body.Browser === 'string' ? body.Browser : null,
    }
  } catch {
    return empty
  }
}

function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })
    const done = (value: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1_000, () => done(false))
  })
}

/** First free CDP port at or after `preferred`, so a busy port never blocks. */
export async function pickCdpPort(preferred: number): Promise<number> {
  for (let candidate = preferred; candidate < preferred + PORT_SCAN_RANGE; candidate++) {
    if (!(await isPortInUse(candidate))) return candidate
  }
  throw new ChatGptWebBrowserError(`no free CDP port in range ${preferred}..${preferred + PORT_SCAN_RANGE}`)
}

export interface SeedResult {
  seeded: boolean
  sourceProfileDir: string | null
  copied: string[]
  reason?: string
}

/**
 * Seed the bridge profile from the user's own Chrome profile. Runs once: an
 * existing Cookies file in the bridge profile means the user already logged in
 * (or was seeded before), and we must never overwrite a live session.
 */
export function seedProfileFromChrome(config: ChatGptWebConfig, platform = process.platform): SeedResult {
  const destProfileDir = join(config.userDataDir, config.chromeProfileName)
  const destCookies = join(destProfileDir, 'Cookies')
  const destNetworkCookies = join(destProfileDir, 'Network', 'Cookies')
  if (existsSync(destCookies) || existsSync(destNetworkCookies)) {
    return { seeded: false, sourceProfileDir: null, copied: [], reason: 'bridge profile already has cookies' }
  }
  if (!config.seedFromChrome) {
    return { seeded: false, sourceProfileDir: null, copied: [], reason: 'seeding disabled' }
  }
  if (!config.chromeUserDataDir) {
    return { seeded: false, sourceProfileDir: null, copied: [], reason: 'no source Chrome profile detected' }
  }

  const sourceProfileDir = join(config.chromeUserDataDir, config.chromeProfileName)
  if (!existsSync(sourceProfileDir)) {
    return { seeded: false, sourceProfileDir, copied: [], reason: `source profile not found: ${sourceProfileDir}` }
  }

  mkdirSync(destProfileDir, { recursive: true })
  const copied: string[] = []
  const copyFile = (from: string, to: string) => {
    if (!existsSync(from)) return
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { force: true })
    copied.push(to)
  }

  // Cookies carry the login; Preferences/Local Storage carry site prefs that
  // ChatGPT reads on boot. IndexedDB is deliberately skipped (hundreds of MB).
  copyFile(join(sourceProfileDir, 'Cookies'), join(destProfileDir, 'Cookies'))
  copyFile(join(sourceProfileDir, 'Network', 'Cookies'), join(destProfileDir, 'Network', 'Cookies'))
  copyFile(join(sourceProfileDir, 'Preferences'), join(destProfileDir, 'Preferences'))
  copyFile(join(sourceProfileDir, 'Secure Preferences'), join(destProfileDir, 'Secure Preferences'))
  if (existsSync(join(sourceProfileDir, 'Local Storage'))) {
    cpSync(join(sourceProfileDir, 'Local Storage'), join(destProfileDir, 'Local Storage'), { recursive: true, force: true })
    copied.push(join(destProfileDir, 'Local Storage'))
  }
  // Linux Chrome keeps the keyring marker here; harmless when absent.
  if (config.chromeUserDataDir) {
    copyFile(join(config.chromeUserDataDir, 'Local State'), join(config.userDataDir, 'Local State'))
  }

  return { seeded: true, sourceProfileDir, copied }
}

export interface EnsureBrowserResult extends BrowserStatus {
  launched: boolean
  chromeBin: string | null
  seed: SeedResult | null
}

export interface EnsureBrowserOptions {
  config: ChatGptWebConfig
  /** Page to open on launch; the project page is opened by the driver anyway. */
  initialUrl?: string
  launchTimeoutMs?: number
  platform?: NodeJS.Platform
}

export async function ensureBrowser(options: EnsureBrowserOptions): Promise<EnsureBrowserResult> {
  const { config } = options
  const existing = await probeCdp(config.cdpPort)
  if (existing.reachable) {
    return { ...existing, launched: false, chromeBin: null, seed: null }
  }

  if (!config.chromeBin) {
    throw new ChatGptWebBrowserError(
      'Chrome/Chromium not found. Install Chrome, or set CHATGPT_WEB_CHROME_BIN to the executable path.',
    )
  }

  const port = await pickCdpPort(config.cdpPort)
  const seed = seedProfileFromChrome(config, options.platform || process.platform)
  if (seed.seeded) {
    logger.info(`[chatgpt-web] seeded bridge profile from ${seed.sourceProfileDir} (${seed.copied.length} paths)`)
  } else if (seed.reason) {
    logger.info(`[chatgpt-web] profile seeding skipped: ${seed.reason}`)
  }

  mkdirSync(config.userDataDir, { recursive: true })
  const args = [
    `--user-data-dir=${config.userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.initialUrl ? [options.initialUrl] : []),
  ]
  const child = spawn(config.chromeBin, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  logger.info(`[chatgpt-web] launched Chrome pid=${child.pid} port=${port} profile=${config.userDataDir}`)

  const deadline = Date.now() + (options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS)
  for (;;) {
    const status = await probeCdp(port, 1_500)
    if (status.reachable) return { ...status, launched: true, chromeBin: config.chromeBin, seed }
    if (Date.now() >= deadline) {
      throw new ChatGptWebBrowserError(
        `Chrome started but CDP did not come up on port ${port}. A visible desktop session is required: `
        + 'Chrome cannot render headlessly here, and Cloudflare challenges need a human. '
        + `Check that the Web UI service runs in the logged-in desktop session (profile: ${config.userDataDir}).`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}
