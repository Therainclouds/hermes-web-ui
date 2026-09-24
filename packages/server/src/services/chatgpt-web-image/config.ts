import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { getWebUiHome } from '../../config'

/**
 * Configuration for the ChatGPT web image bridge.
 *
 * Precedence: explicit request override > environment > state file > defaults.
 * The state file lives at `$HERMES_WEB_UI_HOME/chatgpt-web/config.json` so a
 * device can be configured once without exporting env vars into the service.
 */

export const DEFAULT_CDP_PORT = 9222
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_CHROME_PROFILE_NAME = 'Default'

export interface ChatGptWebConfig {
  /** ChatGPT project page that new generations are started from. */
  projectUrl: string
  cdpPort: number
  chromeBin: string | null
  /** Chrome user-data-dir owned by the Web UI (persistent login lives here). */
  userDataDir: string
  /** Chrome user-data-dir to seed the first run from (usually the user's own). */
  chromeUserDataDir: string | null
  chromeProfileName: string
  seedFromChrome: boolean
  timeoutMs: number
}

export interface ChatGptWebConfigOverrides {
  projectUrl?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export function chatGptWebStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getWebUiHome(env), 'chatgpt-web')
}

export function chatGptWebConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(chatGptWebStateDir(env), 'config.json')
}

export function chatGptWebBrowserProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(chatGptWebStateDir(env), 'browser-profile')
}

function readStateConfig(env: NodeJS.ProcessEnv): Partial<ChatGptWebConfig> {
  const file = chatGptWebConfigFile(env)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A malformed state file must not take the endpoint down; env/defaults win.
    return {}
  }
}

function envString(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = envString(env, key)
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = envString(env, key).toLowerCase()
  if (!raw) return undefined
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return undefined
}

function firstString(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * The user's real Chrome profile directory, used to seed the bridge profile so
 * the first run arrives already logged in. Platform defaults mirror Chrome's own
 * layout; an explicit CHATGPT_WEB_CHROME_USER_DATA_DIR always wins.
 */
export function defaultChromeUserDataDir(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = envString(env, 'CHATGPT_WEB_CHROME_USER_DATA_DIR')
  if (override) return override
  if (platform === 'win32') {
    const local = envString(env, 'LOCALAPPDATA')
    return local ? join(local, 'Google', 'Chrome', 'User Data') : null
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  }
  return join(home, '.config', 'google-chrome')
}

function findOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathValue = envString(env, 'PATH')
  if (!pathValue) return null
  const extensions = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const CHROME_BINARY_NAMES: Record<string, string[]> = {
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'],
  darwin: ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge'],
  win32: ['chrome.exe', 'chromium.exe', 'brave.exe', 'msedge.exe'],
}

function platformChromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    const apps = ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge']
    return apps.flatMap(app => [
      `/Applications/${app}.app/Contents/MacOS/${app}`,
      join(homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app),
    ])
  }
  if (platform === 'win32') {
    const roots = [envString(env, 'PROGRAMFILES'), envString(env, 'PROGRAMFILES(X86)'), envString(env, 'LOCALAPPDATA')]
      .filter(Boolean)
    return roots.flatMap(root => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  }
  return [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}

/**
 * Chrome bundled with the Hermes desktop runtime, if any. Only used as a last
 * resort: it carries no user login state, so the system Chrome is preferred.
 */
function bundledChromeCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = envString(env, 'AGENT_BROWSER_HOME')
  if (!home) return []
  const names = CHROME_BINARY_NAMES[process.platform] || CHROME_BINARY_NAMES.linux
  return names.flatMap(name => [
    join(home, name),
    join(home, 'browsers', name),
    join(home, 'browsers', 'chrome-linux64', name),
    join(home, 'browsers', 'chrome-linux', name),
  ])
}

export function resolveChromeBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = envString(env, 'CHATGPT_WEB_CHROME_BIN')
  if (override) return existsSync(override) ? override : null

  for (const name of CHROME_BINARY_NAMES[platform] || CHROME_BINARY_NAMES.linux) {
    const found = findOnPath(name, env, platform)
    if (found) return found
  }
  for (const candidate of platformChromeCandidates(platform, env)) {
    if (candidate && existsSync(candidate)) return candidate
  }
  for (const candidate of bundledChromeCandidates(env)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function resolveChatGptWebConfig(overrides: ChatGptWebConfigOverrides = {}): ChatGptWebConfig {
  const env = overrides.env || process.env
  const state = readStateConfig(env)

  const projectUrl = firstString(
    overrides.projectUrl,
    envString(env, 'CHATGPT_WEB_PROJECT_URL'),
    typeof state.projectUrl === 'string' ? state.projectUrl : '',
  )

  const cdpPort = envNumber(env, 'CHATGPT_WEB_CDP_PORT')
    || (typeof state.cdpPort === 'number' && state.cdpPort > 0 ? state.cdpPort : DEFAULT_CDP_PORT)

  const timeoutMs = overrides.timeoutMs
    || envNumber(env, 'CHATGPT_WEB_TIMEOUT_MS')
    || (typeof state.timeoutMs === 'number' && state.timeoutMs > 0 ? state.timeoutMs : DEFAULT_TIMEOUT_MS)

  const seedFromChrome = envBool(env, 'CHATGPT_WEB_SEED_FROM_CHROME')
    ?? (typeof state.seedFromChrome === 'boolean' ? state.seedFromChrome : true)

  return {
    projectUrl,
    cdpPort,
    chromeBin: resolveChromeBinary(env),
    userDataDir: firstString(
      envString(env, 'CHATGPT_WEB_USER_DATA_DIR'),
      typeof state.userDataDir === 'string' ? state.userDataDir : '',
      chatGptWebBrowserProfileDir(env),
    ),
    chromeUserDataDir: defaultChromeUserDataDir(process.platform, homedir(), env),
    chromeProfileName: firstString(
      envString(env, 'CHATGPT_WEB_CHROME_PROFILE'),
      typeof state.chromeProfileName === 'string' ? state.chromeProfileName : '',
      DEFAULT_CHROME_PROFILE_NAME,
    ),
    seedFromChrome,
    timeoutMs,
  }
}
