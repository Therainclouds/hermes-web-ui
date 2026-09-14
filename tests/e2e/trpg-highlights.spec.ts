import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

/**
 * The highlight manager is part of the standalone document
 * (`/recap-book.html?workspace=highlights`). This proves the panel's 30-card
 * view no longer discards earlier highlights, and that a highlight can be
 * created by hand on the novel side.
 */
test('standalone highlight page expands earlier cards and creates a new highlight', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)

  // Establish the origin, then seed the exact IndexedDB key the reader rebuilds
  // from the URL profile: ["", 1, "default", meetingId].
  await page.goto('/recap-book.html')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('hermes-plugin-trpg', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('campaigns')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const highlights = Array.from({ length: 31 }, (_, i) => ({
        id: `h${i}`, prompt: `prompt ${i}`, createdAt: 1000 + i, transcript: `第 ${i} 句原文。`, actions: [],
      }))
      const campaign = { setting: '', style: '', characters: [], highlights }
      const tx = db.transaction('campaigns', 'readwrite')
      tx.objectStore('campaigns').put(campaign, JSON.stringify(['', 1, 'default', 'trpg-demo']))
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }))

  await page.goto('/recap-book.html?workspace=highlights&meetingId=trpg-demo&profile=default')
  await expect(page.getByTestId('highlight-workbench')).toBeVisible()
  await expect(page.locator('.hw-card')).toHaveCount(30)

  await page.getByRole('button', { name: /earlier highlights/ }).click()
  await expect(page.locator('.hw-card')).toHaveCount(31)
  await expect(page.locator('.hw-card.older')).toHaveCount(1)

  await page.locator('.hw-create input').first().fill('断桥崩塌')
  await page.locator('.hw-create textarea').first().fill('你们来到断桥边，桥面已经塌了一半。')
  await page.getByRole('button', { name: 'Add highlight', exact: true }).click()

  await expect(page.locator('.hw-card')).toHaveCount(32)
  await expect(page.locator('.hw-card').first().locator('input').first()).toHaveValue('断桥崩塌')
})
