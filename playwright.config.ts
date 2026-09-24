/// <reference types="node" />
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173)
// vite.config.ts serves HTTPS whenever the local dev certs exist, so the e2e
// webServer health check must follow the same protocol or it times out waiting
// for an HTTP URL that never answers. CI has no certs, so it stays on HTTP.
const HAS_TLS = existsSync(resolve('packages/certs/server.crt')) && existsSync(resolve('packages/certs/server.key'))
const BASE_URL = `${HAS_TLS ? 'https' : 'http'}://127.0.0.1:${PORT}`
// Allow environments without managed Playwright Chromium to use a local browser.
// Example: PLAYWRIGHT_CHANNEL=chrome npx playwright test
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL as 'chrome' | 'msedge' | undefined

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: HAS_TLS,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Managed ffmpeg is not always available when using a system browser channel.
    video: BROWSER_CHANNEL ? 'off' : 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    ignoreHTTPSErrors: HAS_TLS,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
        ignoreHTTPSErrors: HAS_TLS,
      },
    },
  ],
})
