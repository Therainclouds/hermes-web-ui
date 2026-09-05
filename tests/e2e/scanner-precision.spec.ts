import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`scanner aligns a 4:3 camera and contour at viewport ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size)
    await authenticate(page)
    await mockHermesApi(page)
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 480
        const ctx = canvas.getContext('2d')!
        const draw = () => {
          ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 640, 480)
          if ((window as any).__scannerHidePaper) return
          ctx.fillStyle = '#eee'
          const dx = (window as any).__scannerOffset || 0
          ctx.beginPath(); ctx.moveTo(120 + dx, 65); ctx.lineTo(535 + dx, 110)
          ctx.lineTo(490 + dx, 415); ctx.lineTo(85 + dx, 360); ctx.closePath(); ctx.fill()
        }
        draw()
        const stream = canvas.captureStream(15)
        const timer = setInterval(draw, 60)
        const track = stream.getVideoTracks()[0]!
        const stop = track.stop.bind(track)
        track.stop = () => { clearInterval(timer); stop() }
        return stream
      } })
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] })
    })
    await page.goto('/#/hermes/jobs')
    await page.locator('a[href="#/hermes/scanner"]').evaluate((element: HTMLAnchorElement) => element.click())
    await page.getByRole('button', { name: 'Start Camera', exact: true }).first().click()
    await page.getByRole('button', { name: 'Smart Capture', exact: true }).click()
    await expect(page.locator('.scanner-quad-overlay')).toBeVisible({ timeout: 20000 })
    const geometry = await page.locator('.camera-frame').evaluate(element => {
      const video = element.querySelector('video')!
      const rect = element.getBoundingClientRect()
      return { ratio: rect.width / rect.height, videoRatio: video.videoWidth / video.videoHeight }
    })
    expect(geometry.videoRatio).toBeCloseTo(4 / 3, 3)
    expect(geometry.ratio).toBeCloseTo(geometry.videoRatio, 2)
    const points = (await page.locator('.quad-fill').getAttribute('points'))!
      .split(' ').map(p => p.split(',').map(Number))
    const expected = [[120 / 640, 65 / 480], [535 / 640, 110 / 480], [490 / 640, 415 / 480], [85 / 640, 360 / 480]]
    points.forEach((p, i) => {
      expect(Math.abs(p[0]! - expected[i]![0]!)).toBeLessThan(0.025)
      expect(Math.abs(p[1]! - expected[i]![1]!)).toBeLessThan(0.025)
    })
    // Missing paper used to remove the handles after a short miss sequence.
    await page.evaluate(() => { (window as any).__scannerHidePaper = true })
    await expect(page.getByText('Selection retained — adjust corners or reset', { exact: true })).toBeVisible()
    await expect(page.locator('.quad-fill')).toHaveAttribute('points', points.map(p => p.join(',')).join(' '))
    await page.waitForTimeout(1800)
    await expect(page.locator('.scanner-quad-overlay')).toBeVisible()
    await page.evaluate(() => { (window as any).__scannerHidePaper = false })
    // Automatic detection cannot move the crop during a drag.
    const handle = await page.locator('.quad-handle').first().boundingBox()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await expect(page.locator('.quad-fill')).toHaveAttribute('fill', '#ffb020')
    await page.waitForTimeout(600)
    await page.mouse.move(handle!.x + handle!.width / 2 + 20, handle!.y + handle!.height / 2 + 20)
    const manualPoints = await page.locator('.quad-fill').getAttribute('points')
    expect(manualPoints).not.toBe(points.map(p => p.join(',')).join(' '))
    await expect(page.locator('.quad-fill')).toHaveAttribute('fill', '#ffb020')
    await page.waitForTimeout(1800)
    await expect(page.locator('.quad-fill')).toHaveAttribute('points', manualPoints!)
    await page.mouse.up()
    await expect(page.locator('.quad-fill')).toHaveAttribute('fill', '#4a90d9')
    // Camera movement after release must move every corner without a reset.
    for (const dx of [25, 60, -35]) {
      await page.evaluate(value => { (window as any).__scannerOffset = value }, dx)
      await expect.poll(async () => {
        const current = (await page.locator('.quad-fill').getAttribute('points'))!
          .split(' ').map(p => p.split(',').map(Number))
        return Math.max(...current.map((p, i) => Math.abs(p[0]! - expected[i]![0]! - dx / 640)))
      }).toBeLessThan(0.025)
      await expect(page.locator('.scanner-quad-overlay')).toBeVisible()
    }
    await page.getByRole('button', { name: 'Stop Camera', exact: true }).click()
  })
}
