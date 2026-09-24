import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg=='

/**
 * The chronicle reader is its own document (`/recap-book.html`), not a Hermes
 * SPA route. This test proves it loads without the app shell, shows the locally
 * stored cast (avatar + ability scores), and turns pages by dragging the paper.
 */
test('standalone chronicle page renders Markdown as a draggable ancient book with a cast drawer', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  const entry = {
    id: 'recap-1',
    meetingId: 'trpg-demo',
    title: '城门',
    mode: 'literary',
    tone: 'epic',
    setting: '',
    style: '',
    characters: [{ id: 'elf', name: '银月', player: '小林' }],
    chapters: [{ id: 'c1', title: '箭雨', startQuote: '', endQuote: '', body: '银月举起盾牌。', highlights: [] }],
    timeline: [],
    generatedAt: Date.UTC(2026, 0, 2),
    skillUsed: 'trpg-recap',
  }
  // Registered after mockHermesApi so these win over its broad /api catch-all.
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [entry] } }))
  const paragraph = '银月举起盾牌，箭雨落在城墙上。'.repeat(20)
  const chapters = Array.from({ length: 6 }, (_, i) => `## 第${i + 1}章 战事\n\n${paragraph}`)
  const markdown = ['# 城门', '', ...chapters, ''].join('\n\n')
  await page.route('**/api/meeting-storage/*/recaps/*/markdown', route => route.fulfill({
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    body: markdown,
  }))

  // Establish the origin, then seed the TRPG panel's IndexedDB record under the
  // same key the reader rebuilds from localStorage.
  await page.goto('/recap-book.html')
  await page.evaluate((imageBase64) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('hermes-plugin-trpg', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('campaigns')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const bytes = Uint8Array.from(atob(imageBase64), char => char.charCodeAt(0))
      const card = {
        id: 'elf', name: '银月', player: '小林', appearance: '银发精灵', card: '',
        image: new Blob([bytes], { type: 'image/png' }), imageName: 'elf.png',
        sheet: {
          strength: '14', dexterity: '16', constitution: '12', intelligence: '10', wisdom: '13', charisma: '8',
          classLevel: '游侠 3', race: '高等精灵', armorClass: '15', hpMax: '28', speed: '30', initiative: '+3', proficiencyBonus: '+2',
        },
      }
      const campaign = { setting: '', style: '', characters: [card], highlights: [] }
      const tx = db.transaction('campaigns', 'readwrite')
      for (const key of [
        JSON.stringify(['', 1, null, 'trpg-demo']),
        JSON.stringify(['', 1, 'default', 'trpg-demo']),
        JSON.stringify(['', null, null, 'trpg-demo']),
      ]) tx.objectStore('campaigns').put(campaign, key)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }), TINY_PNG)

  await page.goto('/recap-book.html?meetingId=trpg-demo&recapId=recap-1')

  await expect(page.locator('.cover-title')).toHaveText('城门')
  await expect(page.getByRole('heading', { name: '第1章 战事' }).first()).toBeVisible()
  // Independent page: the Hermes SPA mounting point does not exist here.
  await expect(page.locator('#app')).toHaveCount(0)
  // The bundled brush-handwriting face is declared locally by the reader CSS.
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check('16px "Ma Shan Zheng"')
  })).toBe(true)
  await page.screenshot({ path: '/tmp/trpg-recap-book.png', animations: 'disabled' })

  // Left button opens the cast drawer with the local avatar and ability scores.
  await page.getByRole('button', { name: 'Cast' }).click()
  await expect(page.locator('.roster-drawer')).toBeVisible()
  await expect(page.locator('.roster-card')).toHaveCount(1)
  await expect(page.locator('.roster-portrait img')).toBeVisible()
  await expect(page.locator('.roster-card')).toContainText('游侠 3')
  await expect(page.locator('.roster-abilities b').first()).toHaveText('14')
  await expect(page.locator('.roster-combat')).toContainText('15')
  await page.screenshot({ path: '/tmp/trpg-recap-book-cast.png', animations: 'disabled' })
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.roster-drawer')).toHaveCount(0)

  // Drag the right page leftwards: the paper follows the pointer, then settles.
  const box = (await page.locator('.book-stage').boundingBox())!
  const startX = box.x + box.width * 0.8
  const y = box.y + box.height * 0.5
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(startX - box.width * 0.28, y, { steps: 10 })
  await expect(page.locator('.leaf')).toBeVisible()
  const midTransform = await page.locator('.leaf').evaluate(el => getComputedStyle(el).transform)
  expect(midTransform).not.toBe('none')
  await page.screenshot({ path: '/tmp/trpg-recap-book-drag.png' })
  await page.mouse.up()
  await expect(page.locator('.leaf')).toHaveCount(0)
  await expect(page.locator('.book-position')).toContainText('2 /')
  await page.screenshot({ path: '/tmp/trpg-recap-book-turned.png', animations: 'disabled' })
})

/**
 * A saved chronicle illustration is fetched with auth headers and shown beside
 * the book; the toolbar button opens it full-screen.
 */
test('chronicle reader shows a saved illustration beside the book and enlarges it', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  const entry = {
    id: 'recap-1',
    meetingId: 'trpg-demo',
    title: '城门',
    mode: 'literary',
    tone: 'epic',
    setting: '',
    style: '',
    characters: [],
    chapters: [{ id: 'c1', title: '箭雨', startQuote: '', endQuote: '', body: '银月举起盾牌。', highlights: [] }],
    timeline: [],
    images: [{ kind: 'cover', mime: 'image/png', createdAt: Date.UTC(2026, 0, 2), model: 'test-model' }],
    generatedAt: Date.UTC(2026, 0, 2),
    skillUsed: 'trpg-recap',
  }
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [entry] } }))
  await page.route('**/api/meeting-storage/*/recaps/*/images/*', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(TINY_PNG, 'base64') }))
  await page.route('**/api/meeting-storage/*/recaps/*/markdown', route => route.fulfill({
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    body: ['# 城门', '', '## 箭雨', '', '银月举起盾牌。'].join('\n'),
  }))

  await page.goto('/recap-book.html?meetingId=trpg-demo&recapId=recap-1')
  await expect(page.locator('.cover-title')).toHaveText('城门')
  const visual = page.locator('[data-testid="book-visual"]')
  await expect(visual).toBeVisible()
  await expect(visual.locator('img')).toBeVisible()
  await page.screenshot({ path: '/tmp/trpg-recap-book-illustration.png', animations: 'disabled' })

  await page.locator('[data-testid="book-image-btn"]').click()
  await expect(page.locator('[data-testid="book-lightbox"]')).toBeVisible()
  await page.locator('.book-lightbox__close').click()
  await expect(page.locator('[data-testid="book-lightbox"]')).toHaveCount(0)
})
