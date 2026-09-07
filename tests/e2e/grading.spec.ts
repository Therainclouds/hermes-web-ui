import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('grading depends on scanner and can be enabled from plugin management', async ({ page }) => {
  await authenticate(page); await mockHermesApi(page)
  await page.addInitScript(() => localStorage.setItem('hermes.plugins.enabled', JSON.stringify({ scanner: false, 'paper-grading': false })))
  await page.route('**/api/scanner/grading/settings', route => route.fulfill({ json: { enabled: false } }))
  await page.goto('/#/hermes/client-plugins')
  const card = page.locator('.plugin-card').filter({ hasText: 'paper-grading' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('switch')).toBeDisabled()
  await page.locator('.plugin-card').filter({ has: page.locator('.plugin-card-id', { hasText: /^scanner$/ }) }).getByRole('switch').click()
  await expect(card.getByRole('switch')).toBeEnabled()
  await card.getByRole('switch').click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugins.enabled') || '{}')['paper-grading'])).toBe(true)
})

test('grading workspace creates class and exam and accepts image upload', async ({ page }) => {
  await authenticate(page); await mockHermesApi(page)
  await page.addInitScript(() => localStorage.setItem('hermes.plugins.enabled', JSON.stringify({ scanner: true, 'paper-grading': true })))
  const classes: any[] = []; const exams: any[] = []; const submissions: any[] = []
  await page.route('**/api/scanner/grading/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').pop()
    const body = route.request().postDataJSON() || {}
    let result: any = {}
    if (action === 'settings') result = { enabled:true, model:'qwen3.8-plus', ocrModel:'qwen3.5-ocr', threshold:.7 }
    if (action === 'catalog') result = { classes, exams }
    if (action === 'create_class') { classes.push({ id:'class1', name:body.name }); result = { classId:'class1' } }
    if (action === 'create_exam') { exams.push({ id:'exam1', name:body.name, class_id:'class1' }); result = { examId:'exam1' } }
    if (action === 'list') result = submissions
    if (action === 'capture_scan') { submissions.push({ id:'scan1', studentName:body.studentName, status:'pending', results:[], annotations:[] }); result = { scanId:'scan1' } }
    if (action === 'summary') result = { total:0, average:0, max:0, min:0, passRate:0, wrongRank:[] }
    await route.fulfill({ json:result })
  })
  await page.goto('/#/hermes/jobs')
  await page.locator('a[href="#/hermes/grading-batch"]').click()
  await expect(page.getByRole('heading', { name:'Grading center' })).toBeVisible()
  await page.getByPlaceholder('New class', { exact:true }).fill('Year 1')
  await page.getByRole('button', { name:'Create', exact:true }).first().click()
  await page.getByPlaceholder('New exam', { exact:true }).fill('Math')
  await page.getByRole('button', { name:'Create', exact:true }).nth(1).click()
  await expect(page.getByRole('button', { name:'Add images', exact:true })).toBeEnabled()
  await page.locator('input[type=file]').first().setInputFiles({ name:'Student.png', mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6A7sAAAAASUVORK5CYII=', 'base64') })
  await expect(page.locator('.queue')).toContainText('Student')
  await expect(page.locator('.queue')).toContainText('Pending')
  await page.getByRole('button', { name:'Start grading', exact:true }).click()
  await expect(page.getByText('Enter an answer key and scoring rubric first.')).toBeVisible()
})
