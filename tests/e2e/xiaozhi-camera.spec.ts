import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const id = '11111111-1111-4111-8111-111111111111'
test('connected XiaoZhi can capture, preview and download a photo', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  await page.route('**/api/xiaozhi/status', route => route.fulfill({ json: { configured: true, gatewayOnline: true, sessions: 1, deviceId: '68:ee:8f:5d:a6:9c', otaUrl: 'http://192.168.1.30:8647/api/xiaozhi/ota/test' } }))
  let captures = 0
  await page.route('**/api/xiaozhi/camera/capture', route => { captures++; return route.fulfill({ json: { id, url: `/api/xiaozhi/photos/${id}` } }) })
  await page.route(`**/api/xiaozhi/photos/${id}?format=json`, route => route.fulfill({ json: { base64: '/9j/2Q==' } }))
  await page.goto('/#/hermes/devices')
  const section = page.locator('section.connection')
  await expect(section).toBeVisible()
  await section.getByRole('button', { name: 'Take a photo with XiaoZhi' }).click()
  await expect(section.getByRole('img', { name: 'Photo from the XiaoZhi camera' })).toHaveAttribute('src', /^blob:/)
  await expect(section.getByRole('link', { name: 'Download photo' })).toHaveAttribute('download', 'xiaozhi-photo.jpg')
  expect(captures).toBe(1)
})
test('offline XiaoZhi cannot trigger a photo', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  await page.route('**/api/xiaozhi/status', route => route.fulfill({ json: { configured: true, gatewayOnline: true, sessions: 0 } }))
  await page.goto('/#/hermes/devices')
  await expect(page.locator('section.connection').getByRole('button', { name: 'Take a photo with XiaoZhi' })).toBeDisabled()
})
