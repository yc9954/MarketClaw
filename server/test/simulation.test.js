import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { fisherExact, weightedRate, buildReport } from '../src/simulation/report.js'
import { sample, poolSummary } from '../src/simulation/personas.js'
import { resolveVariants, bindVariant, applyVariant, validateCustomVariant, PRIMARY_CTA_SELECTOR } from '../src/simulation/variants.js'
import { compileGoals, isGoalPage, heuristicPolicy, createMemory } from '../src/simulation/engine.js'
import { seededRandom } from '../src/simulation/random.js'

const launch = () => chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) })
const session = (variantKey, personaId, segment, weight, converted, bounced = false) => ({ id: `${personaId}__${variantKey}`, variantKey, persona: { id: personaId, segment, name: segment, weight }, memory: { visited: [{ path: '/' }] }, summary: { converted, bounced, goalReached: converted, totalSteps: 3, pagesVisited: 1, engagementScore: 10, finalSentiment: 50, timeToConvertMs: converted ? 3000 : null, actionBreakdown: { click: 1 } } })

test("Fisher's exact test matches known 2×2 values", () => {
  assert.ok(Math.abs(fisherExact(3, 1, 1, 3) - 0.4857) < 0.001) // Fisher's tea-tasting table, two-sided
  assert.ok(Math.abs(fisherExact(10, 0, 0, 10) - 1.0825e-5) < 1e-7)
  assert.equal(fisherExact(5, 5, 5, 5), 1)
  assert.equal(fisherExact(0, 0, 0, 0), 1)
})

test('weighted CVR uses persona weights, and the report compares against control', () => {
  const sessions = [session('control', 'a', 's1', 1, true), session('control', 'b', 's1', 3, false), session('largeCTA', 'a', 's1', 1, true), session('largeCTA', 'b', 's1', 3, true)]
  assert.equal(weightedRate(sessions.filter(s => s.variantKey === 'control'), s => s.summary.converted), 25)
  const report = buildReport(sessions, resolveVariants(['control', 'largeCTA']), { seed: 1 })
  assert.equal(report.variants.control.cvr, 25)
  assert.equal(report.variants.largeCTA.cvr, 100)
  assert.equal(report.comparisons[0].key, 'largeCTA')
  assert.equal(report.comparisons[0].cvrLift, 300)
  assert.ok(report.comparisons[0].pValue > 0 && report.comparisons[0].pValue <= 1)
  assert.equal(report.bestVariant.key, 'largeCTA')
  assert.equal(report.dropoffMap[0].path, '/')
  assert.equal(report.segments[0].byVariant.control.cvr, 25)
})

test('persona sampling is deterministic, stratified and filterable', () => {
  const summary = poolSummary()
  assert.equal(summary.total, 928)
  assert.equal(summary.segments.length, 10)
  assert.ok(Math.abs(summary.segments.reduce((sum, s) => sum + s.share, 0) - 1) < 0.01)
  const a = sample({ count: 20, seed: 42 }), b = sample({ count: 20, seed: 42 }), c = sample({ count: 20, seed: 43 })
  assert.deepEqual(a.map(p => p.id), b.map(p => p.id))
  assert.notDeepEqual(a.map(p => p.id), c.map(p => p.id))
  assert.equal(new Set(a.map(p => p.id)).size, 20)
  assert.ok(new Set(a.map(p => p.segment)).size >= 8)
  const only = sample({ count: 5, segments: ['kpop_fan', 'jobseeker'], seed: 1 })
  assert.deepEqual([...new Set(only.map(p => p.segment))].sort(), ['jobseeker', 'kpop_fan'])
  const rng1 = seededRandom('x'), rng2 = seededRandom('x')
  assert.equal(rng1(), rng2())
})

test('goal detection uses the default pattern or request-supplied path patterns', () => {
  const goals = compileGoals([])
  assert.ok(isGoalPage({ path: '/contact.html', title: '문의' }, goals))
  assert.ok(isGoalPage({ path: '/plans', title: 'Pricing — Acme' }, goals))
  assert.ok(!isGoalPage({ path: '/', title: 'Home' }, goals))
  assert.ok(!isGoalPage({ path: '/features.html', title: '기능' }, goals))
  const custom = compileGoals(['/thank-you', '/checkout/*'])
  assert.ok(isGoalPage({ path: '/checkout/done', title: '' }, custom))
  assert.ok(!isGoalPage({ path: '/contact.html', title: '문의' }, custom))
})

test('heuristic policy is reproducible from a seed and stays inside the action set', () => {
  const persona = sample({ count: 1, seed: 5 })[0]
  const obs = { url: 'http://x/', path: '/', title: 'Home', placeholder: false, scrollRatio: 0, texts: [{ text: '좋은 아이디어는 움직일 때 빛납니다', salience: 1.2, aboveFold: true }], links: [{ text: '무료로 시작하기', href: '/pricing.html', path: '/pricing.html', salience: 1.8, isInternal: true, isNav: false, isCta: true, aboveFold: true }, { text: '기능', href: '/features.html', path: '/features.html', salience: 0.5, isInternal: true, isNav: true, isCta: false, aboveFold: true }], buttons: [], inputs: [], socialProof: [], interestHits: 0, layout: { hasForm: false } }
  const ctx = { goals: compileGoals([]) }
  const run = seed => { const p = heuristicPolicy({ persona, seed }); const m = createMemory(); return Array.from({ length: 6 }, (_, i) => p.decide(obs, m, i + 1, 12, ctx).action) }
  assert.deepEqual(run(7), run(7))
  for (const action of run(7)) assert.ok(['click', 'scroll_down', 'read', 'dwell', 'bounce', 'viewport_focus'].includes(action), action)
})

test('variant patches are validated and applied to a static page', { timeout: 60000 }, async () => {
  assert.throws(() => validateCustomVariant({ key: 'Bad key', patches: [] }), /key/)
  assert.throws(() => validateCustomVariant({ key: 'evil', patches: [{ type: 'inject', selector: 'body', html: '<script>1</script>' }] }), /스크립트/)
  assert.throws(() => resolveVariants(['nope']), /알 수 없는 변형/)
  const variants = resolveVariants(['trustBoost', { key: 'custom1', name: 'Custom', patches: [{ type: 'text', selector: 'h1', text: '새 제목' }, { type: 'hide', selector: '.promo' }, { type: 'reorder', selector: '#second' }, { type: 'css', rule: 'h1{color:rgb(255, 0, 0)}' }] }])
  assert.deepEqual(variants.map(v => v.key), ['control', 'trustBoost', 'custom1'])
  const site = { ctaText: '무료로 시작하기', ctaHref: '/pricing.html', contactHref: '/contact.html' }
  const browser = await launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<h1>원래 제목</h1><div class="promo">배너</div><main><p id="first">1</p><p id="second">2</p></main><a class="button" href="/pricing.html">무료로 시작하기</a>')
    await applyVariant(page, bindVariant(variants[2], site), site)
    assert.equal(await page.locator('h1').innerText(), '새 제목')
    assert.equal(await page.locator('h1').evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)')
    assert.equal(await page.locator('.promo').evaluate(el => getComputedStyle(el).display), 'none')
    assert.equal(await page.locator('main > :first-child').getAttribute('id'), 'second')
    await applyVariant(page, bindVariant(variants[1], site), site)
    assert.equal(await page.locator(PRIMARY_CTA_SELECTOR).innerText(), '무료로 시작하기')
    assert.equal(await page.locator('#mc-trust-badge').count(), 1)
    assert.equal(await page.locator(`${PRIMARY_CTA_SELECTOR} + #mc-trust-badge`).count(), 1)
  } finally { await browser.close() }
})

test('demo site: capture, then a small persona simulation through the API', { timeout: 150000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketclaw-sim-'))
  process.env.DATA_DIR = temp
  process.env.ALLOW_PRIVATE_TARGETS = '1'
  process.env.BROWSER_CHANNEL ||= 'chrome'
  process.env.SIM_PACE = '0.02'
  delete process.env.LLM_API_KEY
  const { createDemoApp } = await import('../src/demo.js')
  const { createApp } = await import('../src/index.js')
  const demo = createDemoApp().listen(0, '127.0.0.1')
  await once(demo, 'listening')
  const api = (await createApp()).listen(0, '127.0.0.1')
  await once(api, 'listening')
  const demoUrl = `http://127.0.0.1:${demo.address().port}/`
  const apiUrl = `http://127.0.0.1:${api.address().port}`
  const post = (url, body) => fetch(`${apiUrl}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const poll = async (url, done) => { let body; for (let i = 0; i < 240; i++) { body = await (await fetch(`${apiUrl}${url}`)).json(); if (done(body)) return body; await new Promise(r => setTimeout(r, 500)) } return body }
  try {
    const health = await (await fetch(`${apiUrl}/api/health`)).json()
    assert.equal(health.llm.configured, false)
    assert.equal(health.llm.policy, 'heuristic')
    const pool = await (await fetch(`${apiUrl}/api/personas`)).json()
    assert.equal(pool.total, 928)
    assert.equal(pool.variants.length, 4)
    let run = await (await post('/api/runs', { url: demoUrl })).json()
    assert.equal((await post(`/api/runs/${run.id}/simulation`, { personas: 3 })).status, 409)
    run = await poll(`/api/runs/${run.id}`, r => ['completed', 'failed'].includes(r.status))
    assert.equal(run.status, 'completed', run.error)
    assert.equal((await fetch(`${apiUrl}/api/runs/${run.id}/simulation`)).status, 404)
    assert.equal((await post(`/api/runs/${run.id}/simulation`, { personas: 3, variants: ['nope'] })).status, 400)
    const started = await post(`/api/runs/${run.id}/simulation`, { personas: 3, variants: ['control', 'largeCTA'], seed: 'ci-seed', captureSteps: true, maxSteps: 8, concurrency: 2 })
    assert.equal(started.status, 202)
    assert.equal((await post(`/api/runs/${run.id}/simulation`, { personas: 3 })).status, 409)
    const sim = await poll(`/api/runs/${run.id}/simulation`, s => ['completed', 'failed'].includes(s.status))
    assert.equal(sim.status, 'completed', sim.error)
    assert.equal(sim.policy, 'heuristic')
    assert.deepEqual(sim.progress, { done: 6, total: 6, failed: 0, round: 1, rounds: 1 })
    assert.equal(sim.sessions.length, 6)
    assert.equal(new Set(sim.sessions.map(s => s.persona.id)).size, 3)
    assert.ok(sim.sessions.every(s => s.policy === 'heuristic' && s.summary.totalSteps >= 1 && s.summary.totalSteps <= 8 && !('steps' in s)))
    assert.equal(sim.site.ctaText, '무료로 시작하기 ↗')
    assert.equal(sim.site.contactHref, '/contact.html')
    assert.ok(sim.report.variants.control.n === 3 && sim.report.variants.largeCTA.n === 3)
    assert.equal(sim.report.comparisons.length, 1)
    assert.ok(sim.report.comparisons[0].pValue >= 0 && sim.report.comparisons[0].pValue <= 1)
    assert.ok(sim.report.dropoffMap.some(row => row.path === '/'))
    assert.ok(sim.report.segments.length >= 1)
    const runAfter = await (await fetch(`${apiUrl}/api/runs/${run.id}`)).json()
    assert.ok(runAfter.events.some(e => e.message.includes('시뮬레이션 완료')))
    const first = sim.sessions[0]
    const full = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/sessions/${first.id}`)).json()
    assert.equal(full.id, first.id)
    assert.ok(full.steps.length >= 1)
    assert.ok(full.steps.every(s => s.action && typeof s.reason === 'string'))
    assert.equal(full.steps[0].screenshot, 'step_01.png')
    assert.equal(full.network.blocked + full.network.aborted + full.network.mocked + full.network.placeholders >= 0, true)
    const png = await fetch(`${apiUrl}/api/runs/${run.id}/simulation/sessions/${first.id}/steps/1.png`)
    assert.equal(png.status, 200)
    assert.match(png.headers.get('content-type'), /image\/png/)
    assert.ok((await png.arrayBuffer()).byteLength > 5000)
    assert.equal((await fetch(`${apiUrl}/api/runs/${run.id}/simulation/sessions/${first.id}/steps/99.png`)).status, 404)
    assert.equal((await fetch(`${apiUrl}/api/runs/${run.id}/simulation/sessions/..%2F..%2Frun/steps/1.png`)).status, 404)
    assert.ok((await fs.stat(path.join(temp, run.id, 'simulation.json'))).size > 1000)
    // A second run with the same seed and population reproduces the same decisions.
    const again = await post(`/api/runs/${run.id}/simulation`, { personas: 3, variants: ['control', 'largeCTA'], seed: 'ci-seed', maxSteps: 8, concurrency: 2 })
    assert.equal(again.status, 202)
    const sim2 = await poll(`/api/runs/${run.id}/simulation`, s => ['completed', 'failed'].includes(s.status) && s.createdAt !== sim.createdAt)
    assert.equal(sim2.status, 'completed', sim2.error)
    const full2 = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/sessions/${first.id}`)).json()
    assert.deepEqual(full2.steps.map(s => [s.action, s.target]), full.steps.map(s => [s.action, s.target]))
    // The UI renders the simulation tab with results.
    const browser = await launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', err => pageErrors.push(err.message))
      await page.goto(`${apiUrl}/runs/${run.id}`)
      await page.getByText('발견한 개선 지점').waitFor()
      await page.locator('.sub-tab', { hasText: '페르소나 시뮬레이션' }).click()
      await page.locator('.variant-card').first().waitFor({ timeout: 15000 })
      assert.equal(await page.locator('.variant-card').count(), 2)
      await page.locator('.session-row').first().click()
      await page.locator('.step-row').first().waitFor()
      assert.ok(await page.locator('.step-row').count() >= 1)
      assert.deepEqual(pageErrors, [])
    } finally { await browser.close() }
  } finally {
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => demo.close(resolve))])
    await fs.rm(temp, { recursive: true, force: true })
  }
})
