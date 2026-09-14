import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('meeting TRPG cards, reference images and generated highlights persist separately', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/meeting-storage/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [] } }))
  await page.route('**/api/meeting-asr/status', route => route.fulfill({ json: { isRunning: false } }))
  await page.addInitScript(() => {
    localStorage.setItem('hermes.meeting.asrConfig', JSON.stringify({ llmApiKey: 'test-meeting-key', llmBaseUrl: 'https://meeting.invalid/v1', llmModel: 'meeting-model' }))
    if (!localStorage.getItem('hermes.meeting.sessions')) localStorage.setItem('hermes.meeting.sessions', JSON.stringify([{
      id: 'trpg-demo', title: 'TRPG Demo', createdAt: Date.now(), updatedAt: Date.now(), sentences: [{ text: '银月举起盾牌挡住箭矢。', timestamp: Date.now() }],
      speakers: [], speakerMap: {}, status: 'completed', sceneTemplate: 'trpg', analysisResult: null, htmlContent: '', analysisRounds: [],
      analysisMode: 'custom', analysisTriggerMode: 'sentences', analysisIntervalSentences: 10, analysisIntervalSeconds: 30,
      agentMessages: [], agentStatus: 'idle', agentConfig: { agentType: 'hermes' }, audioDuration: 0,
    }]))
  })
  await page.route('**/api/plugins/trpg/character-draft', async route => {
    const body = route.request().postDataJSON()
    expect(body.image).toMatch(/^data:application\/pdf;base64,/)
    expect(body.model).toBeUndefined()
    await route.fulfill({ json: { draft: { name: '银月', player: '', appearance: '银发精灵', card: '', sheet: { strength: '12' } }, trace: [] } })
  })
  let sent: any
  let imageRequest: any
  await page.route('**/api/hermes/media/apikey-image-generate', async route => {
    imageRequest = route.request().postDataJSON()
    await route.fulfill({ json: { images: ['iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg=='] } })
  })
  await page.route('**/api/plugins/trpg/highlight', async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { prompt: '【银月】：举盾挡箭，月光映照银发。', actions: [{ characterId: sent.characters[0].id, name: '【银月】', action: '举盾挡箭', evidence: sent.transcript }] } })
  })
  await page.goto('/#/hermes/meeting')
  await page.getByText('TRPG Demo', { exact: true }).click()
  const panel = page.getByTestId('trpg-panel')
  await panel.getByRole('button', { name: 'Add character' }).click()
  await panel.getByLabel('Character name', { exact: true }).fill('银月')
  await panel.getByLabel('Public visual appearance', { exact: true }).fill('银发精灵')
  await panel.locator('.portrait-tools input[type=file]').setInputFiles({ name: 'elf.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg==', 'base64') })
  await expect(panel.locator('img')).toBeVisible()
  await panel.getByText('AI character scribe', { exact: false }).click()
  const sourceFile = panel.locator('.ai-workshop input[type=file]')
  await sourceFile.setInputFiles({ name: 'sylvan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
  expect(await sourceFile.evaluate((el: HTMLInputElement) => el.files?.length)).toBe(1)
  await panel.getByRole('button', { name: 'Create AI draft', exact: true }).click()
  await expect(panel.getByText('Review character draft', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Apply reviewed fields', exact: true }).click()
  await panel.getByRole('button', { name: 'Add character' }).click()
  await panel.getByRole('button', { name: 'Generate image prompt' }).click()
  await expect(panel.locator('.highlight-card')).toHaveCount(1)
  await panel.getByRole('button', { name: 'Open scene details' }).click()
  await expect(page.getByLabel('Image prompt', { exact: true })).toHaveValue('【银月】：举盾挡箭，月光映照银发。')
  await page.keyboard.press('Escape')
  expect(sent.transcript).toContain('银月举起盾牌挡住箭矢。')
  expect(sent.characters[0].image).toBeUndefined()
  expect(sent.characters).toHaveLength(1)
  expect(sent.llmConfig.model).toBe('meeting-model')
  expect(imageRequest).toBeUndefined()
  await panel.evaluate(el => { el.scrollTop = 0 })
  await panel.screenshot({ path: '/tmp/trpg-panel.png', animations: 'disabled' })
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')
  await page.reload()
  await page.getByText('TRPG Demo', { exact: true }).click()
  await panel.locator('.character-card').filter({ hasText: '银月' }).locator('summary').first().click()
  await expect(panel.getByLabel('Character name', { exact: true }).first()).toHaveValue('银月')
  await expect(panel.locator('img')).toBeVisible()
  await expect(panel.locator('.highlight-card')).toHaveCount(1)
  await panel.getByText('Image generation settings', { exact: false }).click()
  await panel.getByLabel('Generate the image directly', { exact: true }).check()
  await panel.getByRole('button', { name: 'Generate scene image' }).click()
  await expect(panel.locator('.highlight-card img')).toBeVisible()
  expect(imageRequest.return_base64).toBe(true)
  expect(imageRequest.reference_images).toHaveLength(1)
  expect(imageRequest.prompt).toContain('【银月】')
  await expect(page.getByLabel('Image prompt', { exact: true })).toHaveCount(0)
  await panel.evaluate(el => { el.scrollTop = 0 })
  await panel.screenshot({ path: '/tmp/trpg-panel.png', animations: 'disabled' })
  await panel.locator('.highlight-card').first().getByRole('button', { name: 'Remove', exact: true }).click()
  await panel.locator('.highlight-card').first().getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(panel.locator('article')).toHaveCount(0)
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')
})

/**
 * The generation settings dialog narrows the highlight transcript to the
 * paragraphs the user ticks, so a scene request no longer always reads the last
 * 60 sentences.
 */
test('generation settings scope the highlight transcript to picked paragraphs', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/meeting-storage/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [] } }))
  await page.route('**/api/meeting-asr/status', route => route.fulfill({ json: { isRunning: false } }))
  await page.addInitScript(() => {
    localStorage.setItem('hermes.meeting.asrConfig', JSON.stringify({ llmApiKey: 'test-meeting-key', llmBaseUrl: 'https://meeting.invalid/v1', llmModel: 'meeting-model' }))
    if (!localStorage.getItem('hermes.meeting.sessions')) localStorage.setItem('hermes.meeting.sessions', JSON.stringify([{
      id: 'trpg-scope', title: 'TRPG Scope', createdAt: Date.now(), updatedAt: Date.now(),
      sentences: [
        { text: '主持人描述城门。', timestamp: Date.now(), speaker: 'GM' },
        { text: '主持人给出难度。', timestamp: Date.now() + 1000, speaker: 'GM' },
        { text: '银月举起盾牌。', timestamp: Date.now() + 200000, speaker: '银月' },
        { text: '银月挡住箭雨。', timestamp: Date.now() + 201000, speaker: '银月' },
      ],
      speakers: [], speakerMap: {}, status: 'completed', sceneTemplate: 'trpg', analysisResult: null, htmlContent: '', analysisRounds: [],
      analysisMode: 'custom', analysisTriggerMode: 'sentences', analysisIntervalSentences: 10, analysisIntervalSeconds: 30,
      agentMessages: [], agentStatus: 'idle', agentConfig: { agentType: 'hermes' }, audioDuration: 0,
    }]))
  })
  let sent: any
  await page.route('**/api/plugins/trpg/highlight', async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { prompt: '【银月】：举盾', actions: [{ characterId: sent.characters[0].id, name: '【银月】', action: '举盾', evidence: '银月举起盾牌。' }] } })
  })
  await page.goto('/#/hermes/meeting')
  await page.getByText('TRPG Scope', { exact: true }).click()
  const panel = page.getByTestId('trpg-panel')
  await panel.getByRole('button', { name: 'Add character' }).click()
  await panel.getByLabel('Character name', { exact: true }).fill('银月')

  await panel.getByTestId('trpg-settings-open').click()
  // Two scope pickers share these labels, so scope the radio to the highlight one.
  const highlightScope = page.locator('.scope-picker').first()
  await highlightScope.getByLabel('Pick paragraphs').check()
  await highlightScope.locator('.scope-paragraph input[type=checkbox]').first().check()
  await page.getByRole('button', { name: 'Done' }).click()

  await panel.getByRole('button', { name: 'Generate image prompt' }).click()
  await expect(panel.locator('.highlight-card')).toHaveCount(1)
  expect(sent.transcript).toContain('主持人描述城门。')
  expect(sent.transcript).not.toContain('银月举起盾牌。')
})

/**
 * When generation fails or times out, the highlight image can be produced
 * elsewhere and uploaded by hand; the card then behaves like a generated one and
 * survives a reload.
 */
test('a highlight image can be uploaded by hand and persists', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/meeting-storage/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [] } }))
  await page.route('**/api/meeting-asr/status', route => route.fulfill({ json: { isRunning: false } }))
  await page.addInitScript(() => {
    localStorage.setItem('hermes.meeting.asrConfig', JSON.stringify({ llmApiKey: 'test-meeting-key', llmBaseUrl: 'https://meeting.invalid/v1', llmModel: 'meeting-model' }))
    if (!localStorage.getItem('hermes.meeting.sessions')) localStorage.setItem('hermes.meeting.sessions', JSON.stringify([{
      id: 'trpg-upload', title: 'TRPG Upload', createdAt: Date.now(), updatedAt: Date.now(),
      sentences: [{ text: '银月举起盾牌挡住箭矢。', timestamp: Date.now() }],
      speakers: [], speakerMap: {}, status: 'completed', sceneTemplate: 'trpg', analysisResult: null, htmlContent: '', analysisRounds: [],
      analysisMode: 'custom', analysisTriggerMode: 'sentences', analysisIntervalSentences: 10, analysisIntervalSeconds: 30,
      agentMessages: [], agentStatus: 'idle', agentConfig: { agentType: 'hermes' }, audioDuration: 0,
    }]))
  })
  await page.route('**/api/plugins/trpg/highlight', route => route.fulfill({
    json: { prompt: '【银月】：举盾挡箭', actions: [{ characterId: 'elf', name: '【银月】', action: '举盾挡箭', evidence: '银月举起盾牌挡住箭矢。' }] },
  }))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg==', 'base64')
  await page.goto('/#/hermes/meeting')
  await page.getByText('TRPG Upload', { exact: true }).click()
  const panel = page.getByTestId('trpg-panel')
  await panel.getByRole('button', { name: 'Add character' }).click()
  await panel.getByLabel('Character name', { exact: true }).fill('银月')
  await panel.getByRole('button', { name: 'Generate image prompt' }).click()
  await expect(panel.locator('.highlight-card')).toHaveCount(1)

  await panel.locator('.highlight-card .scene-upload input[type=file]').setInputFiles({ name: 'manual.png', mimeType: 'image/png', buffer: png })
  await expect(panel.locator('.highlight-card img')).toBeVisible()
  await expect(panel.locator('.highlight-card .scene-footer')).toContainText('manual.png')
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')

  await page.reload()
  await page.getByText('TRPG Upload', { exact: true }).click()
  await expect(panel.locator('.highlight-card img')).toBeVisible()
  await expect(panel.locator('.highlight-card .scene-footer')).toContainText('manual.png')
})
