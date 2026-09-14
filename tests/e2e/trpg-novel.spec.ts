import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('long novel starts in the recording panel and can resume a persisted job', async ({ page }) => {
  await authenticate(page); await mockHermesApi(page)
  await page.route('**/api/meeting-storage/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [] } }))
  await page.route('**/api/meeting-asr/status', route => route.fulfill({ json: { isRunning: false } }))
  await page.addInitScript(() => {
    localStorage.setItem('hermes.meeting.sessions', JSON.stringify([{
      id: 'novel-demo', title: 'Long Campaign', createdAt: Date.now(), updatedAt: Date.now(),
      sentences: Array.from({ length: 150 }, (_, i) => ({ text: `第${i}句：银月站在城堡门前。`, timestamp: i * 1000 })),
      speakers: [], speakerMap: {}, status: 'completed', sceneTemplate: 'trpg', analysisResult: null, htmlContent: '', analysisRounds: [],
      analysisMode: 'custom', analysisTriggerMode: 'sentences', analysisIntervalSentences: 10, analysisIntervalSeconds: 30,
      agentMessages: [], agentStatus: 'idle', agentConfig: { agentType: 'hermes' }, audioDuration: 21600,
    }]))
  })
  const job = { id: 'prepared-novel', status: 'running', stage: 'extracting', chunks: 3, extracted: 1, chapters: 0, planned: 0, scenes: 0, written: 0, reviewed: 0, outputChars: 0, processedSentences: 50, totalSentences: 150, warnings: [] }
  let started = false, resumed = false
  await page.route('**/api/plugins/trpg/recap', async route => {
    const input = route.request().postDataJSON()
    expect(input.mode).toBe('long_novel'); expect(input.sentences).toHaveLength(150)
    expect(input.targetChars).toBe(40000)
    await route.fulfill({ json: { requestId: job.id } })
  })
  await page.route('**/api/meeting-storage/*/novel-jobs', async route => {
    if (route.request().method() === 'POST') { started = true; await route.fulfill({ json: { job } }) }
    else await route.fulfill({ json: { jobs: started ? [job] : [] } })
  })
  await page.route('**/api/meeting-storage/*/novel-jobs/*/resume', async route => {
    resumed = true; job.status = 'running'; await route.fulfill({ json: { job } })
  })
  await page.goto('/#/hermes/meeting')
  await page.getByText('Long Campaign', { exact: true }).click()
  const panel = page.getByTestId('trpg-panel')
  await panel.getByRole('combobox', { name: 'Writing mode', exact: true }).selectOption('long_novel')
  await panel.getByRole('combobox', { name: 'Target length (Chinese characters)', exact: true }).selectOption('40000')
  const pages = page.context().pages().length
  await panel.getByRole('button', { name: 'Generate long-form novel', exact: true }).click()
  await expect(panel.getByTestId('novel-job')).toContainText('Running')
  expect(page.context().pages()).toHaveLength(pages)
  job.status = 'paused'
  await page.reload(); await page.getByText('Long Campaign', { exact: true }).click()
  await panel.getByRole('button', { name: 'Resume from checkpoint', exact: true }).click()
  await expect(panel.getByTestId('novel-job')).toContainText('Running')
  expect(resumed).toBe(true)
})

test('novel workbench protects edits while polling and exposes evidence, gates and model overrides', async ({ page }) => {
  await authenticate(page)
  const controls = { revision: 0, settings: { pauseAfterOutline: true }, chapters: {} as Record<string, unknown>, epochs: {}, approvedOutline: false, approvedChapters: [] }
  const job = { tokenUsage: { inputTokens: 1234, outputTokens: 321, estimatedCalls: 2, reportedCalls: 0, incompleteCalls: 0, untrackedCalls: 0 }, id: 'job', meetingId: 'demo', status: 'paused', stage: 'planning', pauseReason: 'outline', totalSentences: 3, processedSentences: 3, scenes: 1, reviewed: 0, outputChars: 0 }
  const artifacts: Record<string, any> = {
    'plan-0': { title: '井底回声', guide: '保留失败裁决和对白' },
    'canon-0': { events: [{ id: 's0-e0', kind: 'confirmed', fact: '银月跳跃失败，落井', evidence: [{ index: 1, quote: '跳跃失败' }] }], updates: [{ entity: '银月', attribute: 'location', value: '井底' }], omitted: [{ index: 2, reason: '场外点餐' }] },
    'check-0': { passed: false, coverage: [], issues: [{ detail: '正文遗漏了落井后的伤势' }], suggestions: [{ detail: '可补一笔井口光线，不影响事实验收' }] },
  }
  let latest: any, resumed = false
  await page.route('**/api/hermes/available-models*', route => route.fulfill({ json: { groups: [{ provider: 'custom', models: ['writer'] }] } }))
  await page.route('**/api/meeting-storage/demo/novel-jobs/job/**', async route => {
    expect(route.request().headers()['x-hermes-profile']).toBe('table')
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/workbench')) return route.fulfill({ json: { job, controls, liveOutputs: [{ step: "review-0", text: '{"body":"银月扶住井壁', updatedAt: 2 }], layout: [{ index: 0, scenes: [{ index: 0, from: 0, to: 2, title: '井底' }] }], artifacts: Object.keys(artifacts).map((name, i) => ({ name, createdAt: i + 1 })), events: [] } })
    if (url.pathname.includes('/artifacts/')) return route.fulfill({ json: { artifact: { name: url.pathname.split('/').at(-1), value: artifacts[url.pathname.split('/').at(-1)!], createdAt: 1, inputHash: 'hash' }, versions: [] } })
    if (url.pathname.endsWith('/evidence')) return route.fulfill({ json: { rows: [{ index: 1, text: 'GM：跳跃失败，落在井底。' }] } })
    if (url.pathname.endsWith('/visual-match')) { expect(route.request().postDataJSON().image).toMatch(/^data:image\/jpeg;base64,/); return route.fulfill({ json: { description: '井口光线照亮银发人物', uncertainties: ['无法仅凭图片确认伤势'], sceneCount: 1, candidateCount: 1, matches: [{ chapter: 0, scene: 0, title: '井底', score: 0.9, reason: '井底环境与原文相符', artifacts: { canon: { name: 'canon-0', version: 'a'.repeat(64) }, material: { name: 'extract-0', version: 'b'.repeat(64) } }, evidence: [{ index: 1, quote: '跳跃失败，落在井底。' }] }] } }) }
    if (url.pathname.endsWith('/resume')) { resumed = true; job.status = 'running'; return route.fulfill({ json: { job } }) }
    if (url.pathname.endsWith('/controls')) {
      latest = route.request().postDataJSON(); expect(latest.revision).toBe(controls.revision)
      if (latest.action === 'chapter') controls.chapters['0'] = latest.direction
      if (latest.action === 'settings') controls.settings = latest.settings
      if (latest.action === 'approve-outline') controls.approvedOutline = true
      controls.revision++; return route.fulfill({ json: { job, controls } })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto('/recap-book.html?workspace=novel&meetingId=demo&jobId=job&profile=table')
  await expect(page.getByRole('heading', { name: 'Novel workbench', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.getByTestId('novel-workbench')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.getByTestId('novel-workbench')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Night', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'AI output in progress', exact: true })).toBeVisible()
  await expect(page.locator('.live-output pre')).toContainText('银月扶住井壁')
  const title = page.getByRole('textbox', { name: 'Chapter title', exact: true })
  await title.fill('井底新章')
  await page.waitForResponse(r => r.url().endsWith('/workbench'))
  await expect(title).toHaveValue('井底新章')
  await page.getByRole('button', { name: 'Save chapter direction', exact: true }).click()
  await expect.poll(() => latest?.action).toBe('chapter')
  expect(latest.direction.title).toBe('井底新章')
  await page.getByRole('button', { name: 'Evidence ledger 1', exact: true }).click()
  await expect(page.getByText('银月跳跃失败，落井', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Transcript evidence', exact: true }).click()
  await expect(page.getByText('GM：跳跃失败，落在井底。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Content', exact: true }).click()
  await page.getByRole('button', { name: 'Consistency report 1', exact: true }).click()
  await expect(page.getByText('正文遗漏了落井后的伤势', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Optional editorial suggestions (not blocking)', exact: true })).toBeVisible()
  await expect(page.getByText('可补一笔井口光线，不影响事实验收', { exact: true })).toBeVisible()
  artifacts['write-0'] = { body: '井壁冰冷，银月扶着石头缓缓站起。' }
  await page.waitForResponse(r => r.url().endsWith('/workbench'))
  await expect(page.getByRole('checkbox', { name: 'Follow latest output', exact: true })).not.toBeChecked()
  await expect(page.getByText('正文遗漏了落井后的伤势', { exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Follow latest output', exact: true }).check()
  await expect(page.getByText('井壁冰冷，银月扶着石头缓缓站起。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load available models', exact: true }).click()
  await page.getByRole('combobox', { name: 'Prose writing', exact: true }).selectOption({ label: 'custom / writer' })
  await page.getByRole('checkbox', { name: 'Save tokens', exact: true }).check()
  await expect(page.locator('.token-usage')).toContainText('1,555')
  await page.getByRole('button', { name: 'Save writing settings', exact: true }).click()
  await expect.poll(() => latest?.action).toBe('settings')
  expect(latest.settings.economy).toBe(true)
  expect(latest.settings.stages.write).toEqual({ provider: 'custom', model: 'writer' })
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2)
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('hermes-plugin-trpg', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('campaigns')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('campaigns', 'readwrite')
        tx.objectStore('campaigns').put({ characters: [], setting: '', style: '', highlights: [{ id: 'photo', image, title: '井底照片', prompt: '井口微光', transcript: '跳跃失败，落在井底。', actions: [], createdAt: 1 }] }, JSON.stringify(['', 1, 'table', 'demo']))
        tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
      }
    })
  })
  await page.getByRole('button', { name: 'Highlights', exact: true }).click()
  await page.locator('.hw-card-actions button').filter({ hasText: 'Check relevance' }).click()
  await expect(page.getByText('井口光线照亮银发人物', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'ASR source', exact: true })).toHaveAttribute('href', /panel=evidence/)
  await expect(page.getByRole('link', { name: 'Verified fact block', exact: true })).toHaveAttribute('href', /artifact=canon-0.*version=a{64}/)
  await expect(page.getByRole('link', { name: 'Extracted source material', exact: true })).toHaveAttribute('href', /artifact=extract-0.*version=b{64}/)
  await page.getByRole('button', { name: 'Use photo notes for writing', exact: true }).click()
  await expect(page.locator('.visual-notes textarea')).toHaveValue('井口光线照亮银发人物')
  await page.getByRole('button', { name: 'Save chapter direction', exact: true }).click()
  await expect.poll(() => latest?.direction?.visualReferences?.[0]?.id).toBe('photo')
  await page.getByRole('button', { name: 'Approve outline', exact: true }).click()
  await expect.poll(() => controls.approvedOutline).toBe(true)
  await page.getByRole('button', { name: 'Resume from checkpoint', exact: true }).click()
  await expect.poll(() => resumed).toBe(true)
  await expect(title).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.locator('.direction-panel').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: test.info().outputPath('novel-workbench.png'), fullPage: true })
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await page.screenshot({ path: test.info().outputPath('novel-workbench-day.png'), fullPage: true })
})
