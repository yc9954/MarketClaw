import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { validateTarget } from '../src/browser.js'

test('local demo: capture, replay, findings and screenshot', { timeout: 90000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketclaw-test-'))
  process.env.DATA_DIR = temp
  process.env.ALLOW_PRIVATE_TARGETS = '1'
  process.env.BROWSER_CHANNEL ||= 'chrome'
  const { createDemoApp } = await import('../src/demo.js')
  const { createApp } = await import('../src/index.js')
  const demo = createDemoApp().listen(0, '127.0.0.1')
  await once(demo, 'listening')
  const api = (await createApp()).listen(0, '127.0.0.1')
  await once(api, 'listening')
  const demoUrl = `http://127.0.0.1:${demo.address().port}/`
  const apiUrl = `http://127.0.0.1:${api.address().port}`
  try {
    await assert.rejects(validateTarget('http://127.0.0.1/', false), /사설/)
    await assert.rejects(validateTarget('http://169.254.169.254/', false), /사설/)
    const bad = await fetch(`${apiUrl}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'file:///etc/passwd' }) })
    assert.equal(bad.status, 400)
    const response = await fetch(`${apiUrl}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: demoUrl }) })
    assert.equal(response.status, 202)
    let run = await response.json()
    for (let i = 0; i < 90 && !['completed', 'failed'].includes(run.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      run = await (await fetch(`${apiUrl}/api/runs/${run.id}`)).json()
    }
    assert.equal(run.status, 'completed', run.error)
    assert.equal(run.report.pages.length, 4)
    assert.equal(run.report.journeys.filter(j => j.success).length, 3)
    assert.ok(run.report.network.blocked >= 1)
    assert.ok(run.report.summary.findings.some(f => f.title.includes('검색 결과 설명')))
    assert.ok(run.report.summary.findings.some(f => f.title.includes('긴 입력 양식')))
    assert.ok(run.report.summary.aboveFoldCtas >= 1)
    const screenshot = await fetch(`${apiUrl}${run.screenshotUrl}`)
    assert.equal(screenshot.status, 200)
    assert.match(screenshot.headers.get('content-type'), /image\/png/)
    assert.ok((await screenshot.arrayBuffer()).byteLength > 10000)
    assert.ok((await fs.stat(path.join(temp, run.id, 'capture.har.zip'))).size > 1000)
    const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) })
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', err => pageErrors.push(err.message))
      await page.goto(apiUrl)
      assert.equal(await page.locator('.left-col').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)')
      assert.equal(await page.locator('.right-col').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
      await page.locator('.run-row').first().waitFor()
      await page.locator('.run-row').first().click()
      await page.getByText('발견한 개선 지점').waitFor()
      assert.equal(await page.locator('.sidebar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)')
      assert.deepEqual(pageErrors, [])
      assert.match(await page.locator('.metric-grid').innerText(), /4 pages/)
      await page.goto(apiUrl)
      await page.locator('#target-url').fill(demoUrl)
      await page.locator('.start-btn').click()
      await page.locator('.modal-opt--primary').click()
      await page.waitForURL(/\/runs\//)
      await page.getByText('발견한 개선 지점').waitFor({ timeout: 30000 })
      assert.deepEqual(pageErrors, [])
    } finally { await browser.close() }
  } finally {
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => demo.close(resolve))])
    await fs.rm(temp, { recursive: true, force: true })
  }
})
