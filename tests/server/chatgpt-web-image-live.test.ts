import { describe, expect, it } from 'vitest'
import { ChatGptWebImageService } from '../../packages/server/src/services/chatgpt-web-image'

/**
 * Live browser-bridge check. Opt-in because it needs:
 *   - a Chrome exposing CDP (CHATGPT_WEB_CDP_PORT, default 9222) that is already
 *     signed in to the ChatGPT project, launched from the desktop session;
 *   - about three minutes per generation.
 *
 * Run it with:
 *   CHATGPT_WEB_LIVE=1 \
 *   CHATGPT_WEB_PROJECT_URL="https://chatgpt.com/g/g-p-<id>-<name>/project" \
 *   npx vitest run tests/server/chatgpt-web-image-live.test.ts
 *
 * It never launches Chrome itself: a missing browser fails fast instead of
 * silently starting a headless instance that Cloudflare would reject.
 */
const live = process.env.CHATGPT_WEB_LIVE === '1'

describe.skipIf(!live)('chatgpt-web live bridge', () => {
  it('generates a real image through the ChatGPT project', async () => {
    const service = ChatGptWebImageService.getInstance()

    const status = await service.status()
    expect(status.projectUrl, 'set CHATGPT_WEB_PROJECT_URL').toBeTruthy()
    expect(
      status.browser.reachable,
      `no Chrome on CDP port ${status.cdpPort}; start the bridge browser first`,
    ).toBe(true)

    const result = await service.generate({
      profile: 'default',
      prompt: '跑团高光插画：月光下的古老石桥，一名披斗篷的游侠独自驻足，奇幻写实风格，横构图，电影感打光。',
      returnBase64: true,
    })

    expect(result.provider).toBe('chatgpt-web')
    expect(result.images).toHaveLength(1)
    const bytes = Buffer.from(result.images[0], 'base64')
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(bytes.byteLength).toBeGreaterThan(10_000)
    expect(result.conversationId).toBeTruthy()
  }, 360_000)
})
