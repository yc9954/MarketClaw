import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { buildSiteCharacter, heuristicArchetypes, allocateCounts, sampleFromBundled, normalizeArchetypes, tokenize, behaviorPriors, siteFactors, filterWithRelaxation, sampleFromNemotron, validateCharacter } from '../src/simulation/personaGen.js'
import { updateVisitProb, computeKFactor, buildPeerNetwork, baseVisitProb, runFeedbackLoop, SIGNALS } from '../src/simulation/propagation.js'
import { rewriteHtml, rewriteCss, mirrorUrl } from '../src/simulation/mirror.js'
import { deriveFeedback } from '../src/simulation/feedback.js'
import { repairTruncatedJson, parseJsonLoose } from '../src/simulation/llm.js'
import { resolveVariants, validateSavedVariant } from '../src/simulation/variants.js'
import { buildReport } from '../src/simulation/report.js'

const launch = () => chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) })
const fakeRun = {
  id: 'r1', url: 'https://acme.example/',
  report: { pages: [
    { url: 'https://acme.example/', title: 'Acme — 팀 협업 워크스페이스', description: '흩어진 아이디어를 팀의 실행으로 연결하는 협업 솔루션', h1: ['팀의 다음 행동을 연결하세요'], headings: ['자동화된 대시보드', '연동 API'], ctas: [{ text: '무료 체험 시작', href: 'https://acme.example/pricing', aboveFold: true }, { text: '데모 요청', href: 'https://acme.example/contact', aboveFold: false }], links: [{ text: '기능', url: 'https://acme.example/features' }, { text: '가격', url: 'https://acme.example/pricing' }, { text: '문의', url: 'https://acme.example/contact' }], forms: [] },
    { url: 'https://acme.example/contact', title: '문의', description: '', h1: ['도입 문의'], headings: [], ctas: [{ text: '문의 보내기', href: '', aboveFold: true }], links: [], forms: [{ action: '/contact', fields: 6 }] }
  ] }
}

test('site character and archetypes are derived heuristically from the page inventory', () => {
  const c = buildSiteCharacter(fakeRun)
  assert.equal(c.industry, 'saas')
  assert.equal(c.businessType, 'B2B')
  assert.equal(c.serviceOneLiner, '흩어진 아이디어를 팀의 실행으로 연결하는 협업 솔루션')
  assert.deepEqual(c.conversionGoals, ['무료 체험 시작', '데모 요청', '문의 보내기'])
  assert.ok(c.mainNavigation.map(n => n.label).includes('가격'))
  assert.equal(c.signals.formFields, 6)
  assert.ok(c.keyTerms.length >= 5)
  assert.ok(tokenize('아이디어는 움직일 때 빛납니다 아이디어').find(([t]) => t === '아이디어')[1] === 2)
  const archetypes = heuristicArchetypes(c, 6)
  assert.equal(archetypes.length, 6)
  assert.ok(Math.abs(archetypes.reduce((s, a) => s + a.share, 0) - 1) < 0.01)
  assert.ok(archetypes.some(a => a.id === 'decision_maker') && archetypes.some(a => a.id === 'team_lead_evaluator'))
  assert.ok(archetypes.every(a => Object.keys(a.traits).length === 6 && a.conversionGoal && a.demographicFilters.age.length === 2))
  allocateCounts(archetypes, 25)
  assert.equal(archetypes.reduce((s, a) => s + a.sampleN, 0), 25)
  const normalized = normalizeArchetypes([{ id: 'Weird Id!', share: 3, traits: { patience: 9 } }, { id: 'b', share: 1 }, { id: 'b', share: 1 }])
  assert.deepEqual(normalized.map(a => [a.id, a.share, a.traits.patience]), [['weird_id', 0.75, 1], ['b', 0.25, 0.5]])
  const factors = siteFactors(c)
  const priors = behaviorPriors({ traits: archetypes[0].traits }, factors)
  assert.ok(priors.pConvert > 0 && priors.pConvert < 1 && priors.nps >= 0 && priors.nps <= 10 && priors.shareProb >= 0)
  const llmShape = validateCharacter({ service_one_liner: 'LLM 요약', business_type: 'b2c', main_navigation: ['홈', { label: '가격', purpose: '요금' }], audience_signals: { b2b_vs_b2c: 'b2c', key_interests: ['협업'] } }, c)
  assert.equal(llmShape.businessType, 'B2C'); assert.equal(llmShape.source, 'llm'); assert.equal(llmShape.mainNavigation[1].purpose, '요금')
  assert.throws(() => validateCharacter({}, c), /service_one_liner/)
})

test('bundled and Nemotron samplers are deterministic and honour archetype counts', () => {
  const c = buildSiteCharacter(fakeRun)
  const archetypes = allocateCounts(heuristicArchetypes(c, 5), 30)
  const a = sampleFromBundled(archetypes, { seed: 'gen' }), b = sampleFromBundled(archetypes, { seed: 'gen' }), d = sampleFromBundled(archetypes, { seed: 'other' })
  assert.deepEqual(a.personas.map(p => p.sourceId), b.personas.map(p => p.sourceId))
  assert.notDeepEqual(a.personas.map(p => p.sourceId), d.personas.map(p => p.sourceId))
  assert.equal(a.personas.length, 30)
  assert.equal(new Set(a.personas.map(p => p.sourceId)).size, 30)
  for (const arch of archetypes) assert.equal(a.personas.filter(p => p.segment === arch.id).length, arch.sampleN)
  const dm = a.personas.filter(p => p.segment === 'decision_maker')
  assert.ok(dm.every(p => p.demographics.age >= 28 && p.demographics.age <= 56), 'decision makers are age-matched')
  assert.ok(Math.abs(dm.reduce((s, p) => s + p.weight, 0) - archetypes.find(x => x.id === 'decision_maker').share) < 0.01, 'segment weight equals archetype share')
  const rows = Array.from({ length: 200 }, (_, i) => ({ i, uuid: `u${i}`, age: 20 + (i % 40), sex: i % 2 ? '남자' : '여자', education: '4년제 대학교', province: i % 3 ? '서울' : '부산', district: '', occupation: i % 5 ? '마케팅 담당자' : '연구원', hobbies: '등산, 독서', professional: `${i}번 인물의 직업 설명`, goals: '', marital: '' }))
  const relaxed = filterWithRelaxation(rows, { age: [90, 95], sex: '남자', occupationKeywords: ['없는직업'] }, 3)
  assert.ok(relaxed.relaxed >= 3 && relaxed.rows.length >= 3)
  const n1 = sampleFromNemotron(rows, archetypes, { seed: 7 }), n2 = sampleFromNemotron(rows, archetypes, { seed: 7 })
  assert.deepEqual(n1.personas.map(p => p.sourceId), n2.personas.map(p => p.sourceId))
  assert.equal(n1.personas.length, 30)
  assert.ok(n1.personas.every(p => p.sampler === 'nemotron' && p.persona_name && p.demographics.province))
  assert.ok(n1.stats.every(s => s.sampled === archetypes.find(a => a.id === s.id).sampleN))
})

test('feedback-loop propagation: visit-probability update, K-factor and rounds', async () => {
  assert.equal(updateVisitProb(0.2, { converted: true }, 1, 1), 0.2 + SIGNALS.strong)
  assert.equal(updateVisitProb(0.2, { converted: true }, 0.5, 1.5), 0.2 + SIGNALS.strong * 0.5 * 1.5)
  assert.ok(Math.abs(updateVisitProb(0.2, { bounced: true }, 1) - (0.2 + SIGNALS.negative)) < 1e-9)
  assert.ok(Math.abs(updateVisitProb(0.2, { engaged: true, shared: true }, 1) - (0.2 + SIGNALS.weak + SIGNALS.share)) < 1e-9)
  assert.equal(updateVisitProb(0.9, { converted: true }, 1, 1.5), 0.99)
  assert.equal(updateVisitProb(0.02, { bounced: true }, 1), 0.01)
  const personas = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, segment: ['a', 'b', 'c', 'd', 'e'][i % 5], weight: i === 0 ? 0.4 : 0.1 }))
  const base = baseVisitProb(personas)
  assert.ok(base.a > base.b && base.b > base.c && base.c === base.d, 'base visit probability follows segment weight share')
  const network = buildPeerNetwork(personas, { seed: 1, maxPeers: 3 })
  assert.ok(Object.values(network).every(peers => peers.length === 3 && peers.every(p => p.affinity >= 0.3)))
  const probs = Object.fromEntries(personas.map(p => [p.id, base[p.segment]]))
  const segmentOf = Object.fromEntries(personas.map(p => [p.id, p.segment]))
  const peers = network.p1.map(p => p.id)
  for (const id of peers) probs[id] = base[segmentOf[id]] + 0.2
  const outcomes = Object.fromEntries(peers.map((id, i) => [id, { converted: i === 0 }]))
  assert.equal(computeKFactor(['p1'], probs, base, network, segmentOf, outcomes), Math.round(3 * (1 / 3) * 1000) / 1000)
  assert.equal(computeKFactor([], probs, base, network, segmentOf, outcomes), 0)
  const calls = []
  const runSessions = async tasks => { calls.push(tasks.map(t => t.key)); return new Map(tasks.map(t => [t.key, { persona: t.persona, summary: { converted: t.persona.id === 'p0' || (t.variant.key === 'x' && t.persona.id === 'p3'), bounced: t.persona.id === 'p5', engagementScore: 70, intentSignals: [] } }])) }
  const loop = await runFeedbackLoop({ personas, variants: [{ key: 'control' }, { key: 'x' }], rounds: 3, visitorsPerRound: 4, seed: 'loop', runSessions })
  assert.equal(loop.rounds.length, 3)
  assert.deepEqual(loop.rounds[0].n, { control: 12, x: 12 })
  assert.deepEqual(loop.rounds[1].n, { control: 4, x: 4 })
  assert.equal(calls[0].length, 24, 'round 1 runs every persona × variant once')
  assert.ok(calls.slice(1).every(c => c.length === 0), 'repeat visitors reuse their cached session')
  assert.ok(loop.rounds[0].cvrByVariant.x > loop.rounds[0].cvrByVariant.control)
  assert.ok(Object.keys(loop.rounds[2].visitProbBySegment.control).length === 5 && loop.rounds[2].visitProbBySegment.control.a >= base.a)
  assert.ok(typeof loop.rounds[0].kFactor.control === 'number')
  const again = await runFeedbackLoop({ personas, variants: [{ key: 'control' }, { key: 'x' }], rounds: 3, visitorsPerRound: 4, seed: 'loop', runSessions })
  assert.deepEqual(again.rounds, loop.rounds, 'rounds are reproducible from the seed')
  const report = buildReport(loop.sessions.map(s => ({ ...s, id: `${s.persona.id}__control`, variantKey: 'control', memory: { visited: [{ path: '/' }] }, summary: { ...s.summary, goalReached: false, totalSteps: 3, pagesVisited: 1, finalSentiment: 50, actionBreakdown: {} } })), resolveVariants(['control']), { seed: 1, loop })
  assert.equal(report.rounds.length, 3)
  assert.deepEqual(report.baseVisitProb, base)
})

test('mirror rewriting strips scripts and handlers and routes URLs through the mirror', () => {
  const index = new Map([['https://cdn.example/a.png', {}], ['https://acme.example/style.css', {}]])
  const ctx = { base: '/api/runs/r1/mirror/', origin: 'https://acme.example', index, pageUrl: 'https://acme.example/' }
  const html = rewriteHtml('<html><head><title>x</title><script src="/t.js"></script><link rel="stylesheet" href="/style.css"><link rel="preconnect" href="https://fonts.example"></head><body onload="evil()"><h1 onclick="a()" style="background:url(/bg.png)">Hi</h1><a href="javascript:void(0)">j</a><a href="/pricing.html?x=1">p</a><img src="https://cdn.example/a.png" srcset="https://cdn.example/a.png 1x, /b.png 2x"><img src="https://tracker.example/pixel.gif"><noscript><img src="https://tracker.example/ns.gif"></noscript><iframe src="https://x.example"></iframe><form action="/submit"><input></form><style>.a{background:url("/c.png")}</style></body></html>', ctx)
  assert.ok(!/<script|onload|onclick|<noscript|<iframe|javascript:/i.test(html))
  assert.ok(html.includes('<head><base href="/api/runs/r1/mirror/"><meta name="referrer" content="no-referrer"><title>'))
  assert.ok(html.includes('href="/api/runs/r1/mirror/style.css"') && html.includes('href="/api/runs/r1/mirror/pricing.html?x=1"'))
  assert.ok(html.includes('src="/api/runs/r1/mirror/__ext/https%3A%2F%2Fcdn.example%2Fa.png"'))
  assert.ok(html.includes('/api/runs/r1/mirror/b.png 2x'))
  assert.ok(html.includes('src="https://tracker.example/pixel.gif"'), 'unrecorded foreign assets are left to the CSP')
  assert.ok(html.includes('background:url(/api/runs/r1/mirror/bg.png)') && html.includes('url("/api/runs/r1/mirror/c.png")'))
  assert.ok(html.includes('action="#"') && !html.includes('preconnect'))
  assert.equal(rewriteCss('@import "/x.css"; a{background:url(../img/y.png)}', { ...ctx, pageUrl: 'https://acme.example/css/site.css' }), '@import "/api/runs/r1/mirror/x.css"; a{background:url(/api/runs/r1/mirror/img/y.png)}')
  assert.equal(mirrorUrl('mailto:a@b.c', ctx), 'mailto:a@b.c')
  assert.equal(mirrorUrl('data:image/png;base64,AAAA', ctx), 'data:image/png;base64,AAAA')
})

test('feedback cards are derived from report data and saved variants resolve', () => {
  const variant = (key, name, n, converts, bounces, goal) => ({ key, name, color: '#000', n, converts, bounces, goalReached: goal, cvr: Math.round(converts / n * 1000) / 10, bounceRate: Math.round(bounces / n * 1000) / 10, goalRate: Math.round(goal / n * 1000) / 10, avgEngagement: 30, avgSentiment: 50, avgSteps: 5, medianSteps: 9, avgPages: 2.5, avgTtcSec: 20, bySegment: { s1: { segment: 's1', label: '세그 1', n: n / 2, converts: converts, bounces: bounces, cvr: Math.round(converts / (n / 2) * 1000) / 10 }, s2: { segment: 's2', label: '세그 2', n: n / 2, converts: 0, bounces: 0, cvr: 0 } } })
  const report = { generatedAt: 'now', totalSessions: 40, converted: 8, bounced: 10, bestVariant: { key: 'largeCTA', name: 'B', cvr: 40 }, variants: { control: variant('control', 'A', 20, 4, 8, 12), largeCTA: variant('largeCTA', 'B', 20, 8, 2, 12) }, comparisons: [{ key: 'largeCTA', name: 'B', cvrLift: 100, pValue: 0.3, significant: false, controlCvr: 20, variantCvr: 40, controlN: 20, variantN: 20 }], dropoffMap: [{ path: '/', visits: 40, exitRate: 20, bounceRate: 20, convertRate: 20 }, { path: '/features.html', title: '기능', visits: 12, exitRate: 66.7, bounceRate: 41.7, convertRate: 0 }, { path: '/pricing.html', title: '가격', visits: 10, exitRate: 40, bounceRate: 50, convertRate: 10 }], segments: [{ segment: 's1', label: '세그 1', n: 20, byVariant: { control: { n: 10, converts: 4, cvr: 40 } } }, { segment: 's2', label: '세그 2', n: 20, byVariant: { control: { n: 10, converts: 0, cvr: 0 } } }], rounds: [{ round: 1, n: { control: 20 }, kFactor: { control: 0.1 }, visitProbBySegment: { control: { s1: 0.2, s2: 0.1 } } }, { round: 2, n: { control: 10 }, kFactor: { control: 0.45 }, visitProbBySegment: { control: { s1: 0.5, s2: 0.12 } } }], baseVisitProb: { s1: 0.2, s2: 0.1 } }
  const sessions = Array.from({ length: 40 }, () => ({ summary: { totalSteps: 5, errorCount: 1 } }))
  const { summary, cards } = deriveFeedback({ status: 'completed', policy: 'heuristic', report, sessions, site: { ctaText: '무료로 시작하기', contactHref: '/contact.html' }, params: { variants: [{ key: 'control' }, { key: 'largeCTA', name: 'B · 메인 CTA 강조' }] } }, fakeRun)
  const ids = cards.map(c => c.id)
  assert.ok(ids.includes('copy:first-impression') && ids.includes('cta:variant-largeCTA') && ids.includes('friction:goal-no-convert') && ids.includes('navigation:exit-/features.html') && ids.includes('copy:segment-s2') && ids.includes('friction:agent-errors') && ids.includes('navigation:long-path') && ids.includes('trust:pricing') && ids.includes('trust:k-factor'), ids.join(','))
  assert.ok(cards.every(c => ['copy', 'cta', 'trust', 'navigation', 'friction'].includes(c.category) && c.title && c.description && c.action && c.evidence && c.confidence >= 40 && c.confidence <= 95))
  assert.equal(cards.find(c => c.id === 'cta:variant-largeCTA').evidence.value, 100)
  assert.equal(cards.find(c => c.id === 'copy:segment-s2').evidence.segment, 's2')
  assert.equal(summary.categories.trust, 2)
  assert.deepEqual(cards.map(c => c.confidence), cards.map(c => c.confidence).slice().sort((a, b) => b - a))
  assert.deepEqual(deriveFeedback({ status: 'running' }), { summary: null, cards: [] })
  assert.equal(parseJsonLoose('```json\n{"a": [1, 2]').a.length, 2)
  assert.deepEqual(parseJsonLoose('{"a": ["x", "y'), { a: ['x'] })
  assert.equal(repairTruncatedJson('{"cards":[{"id":"x","title":"tr'), '{"cards":[{"id":"x"}]}')
  const saved = validateSavedVariant({ name: '미러 편집', patches: [{ type: 'text', selector: 'h1', text: '새 제목' }] }, {})
  assert.equal(saved.key, 'mirror_1'); assert.ok(saved.saved && saved.custom)
  assert.throws(() => validateSavedVariant({ key: 'control', patches: [{ type: 'hide', selector: 'p' }] }), /기본 변형/)
  assert.throws(() => validateSavedVariant({ name: 'x', patches: [] }), /패치가 없습니다/)
  const resolved = resolveVariants(['control', 'mirror_1'], { mirror_1: saved })
  assert.deepEqual(resolved.map(v => [v.key, v.saved]), [['control', undefined], ['mirror_1', true]])
  assert.throws(() => resolveVariants(['mirror_9'], {}), /알 수 없는 변형/)
})

// Reads server-sent events until `done(event, data)` returns true or the timeout passes.
async function readSse(url, done, timeoutMs = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const seen = []
  try {
    const res = await fetch(url, { signal: controller.signal })
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done: closed } = await reader.read()
      if (closed) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx); buffer = buffer.slice(idx + 2)
        const event = chunk.match(/^event: (.+)$/m)?.[1]
        const data = chunk.match(/^data: (.+)$/m)?.[1]
        if (!event || !data) continue
        const parsed = JSON.parse(data)
        seen.push({ event, data: parsed })
        if (done(event, parsed, seen)) { controller.abort(); return seen }
      }
    }
  } catch (err) { if (err.name !== 'AbortError') throw err } finally { clearTimeout(timer) }
  return seen
}

test('demo site: generated personas, mirror + saved variant, live view and feedback through the API', { timeout: 180000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketclaw-complete-'))
  process.env.DATA_DIR = temp
  process.env.ALLOW_PRIVATE_TARGETS = '1'
  process.env.BROWSER_CHANNEL ||= 'chrome'
  process.env.SIM_PACE = '0.05'
  delete process.env.LLM_API_KEY
  delete process.env.NEMOTRON_PERSONAS_PATH
  const { createDemoApp } = await import('../src/demo.js')
  const { createApp } = await import('../src/index.js')
  const demo = createDemoApp().listen(0, '127.0.0.1')
  await once(demo, 'listening')
  const api = (await createApp()).listen(0, '127.0.0.1')
  await once(api, 'listening')
  const demoUrl = `http://127.0.0.1:${demo.address().port}/`
  const apiUrl = `http://127.0.0.1:${api.address().port}`
  const post = (url, body, method = 'POST') => fetch(`${apiUrl}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const poll = async (url, done) => { let body; for (let i = 0; i < 240; i++) { body = await (await fetch(`${apiUrl}${url}`)).json(); if (done(body)) return body; await new Promise(r => setTimeout(r, 500)) } return body }
  try {
    const health = await (await fetch(`${apiUrl}/api/health`)).json()
    assert.equal(health.version, '1.2.0')
    assert.deepEqual(health.features, ['personas', 'feedback-loop', 'live-view', 'mirror-editor', 'feedback-cards'])
    let run = await (await post('/api/runs', { url: demoUrl })).json()
    assert.equal((await post(`/api/runs/${run.id}/personas`, {})).status, 409)
    run = await poll(`/api/runs/${run.id}`, r => ['completed', 'failed'].includes(r.status))
    assert.equal(run.status, 'completed', run.error)

    // A. site-matched personas (heuristic path)
    assert.equal((await fetch(`${apiUrl}/api/runs/${run.id}/personas`)).status, 404)
    assert.equal((await fetch(`${apiUrl}/api/runs/${run.id}/personas/status`)).status, 200)
    const started = await post(`/api/runs/${run.id}/personas`, { count: 12, archetypes: 4, seed: 'gen-seed' })
    assert.equal(started.status, 202)
    const job = await poll(`/api/runs/${run.id}/personas/status`, j => ['completed', 'failed'].includes(j.status))
    assert.equal(job.status, 'completed', job.error)
    assert.equal(job.stage, 'done')
    const pool = await (await fetch(`${apiUrl}/api/runs/${run.id}/personas`)).json()
    assert.equal(pool.total, 12)
    assert.equal(pool.archetypes.length, 4)
    assert.equal(pool.sampler, 'bundled')
    assert.equal(pool.policy.usedLlm, false)
    assert.equal(pool.siteCharacter.source, 'heuristic')
    assert.equal(pool.siteCharacter.industry, 'saas')
    assert.ok(pool.siteCharacter.conversionGoals.some(g => g.startsWith('무료로 시작하기')))
    assert.equal(Object.values(pool.summary.bySegment).reduce((a, b) => a + b, 0), 12)
    assert.ok(pool.personas.every(p => p.priors && p.traits && p.goals.conversion && p.demographics.province))
    assert.ok((await fs.stat(path.join(temp, run.id, 'personas.json'))).size > 5000)
    assert.equal((await post(`/api/runs/${run.id}/simulation`, { personas: 2, poolSource: 'generated', variants: ['control', 'mirror_1'] })).status, 400, 'unknown saved variant is rejected')

    // D. mirror page + saved variant
    const pages = await (await fetch(`${apiUrl}/api/runs/${run.id}/mirror-pages`)).json()
    assert.equal(pages.base, `/api/runs/${run.id}/mirror/`)
    assert.ok(pages.pages.some(p => p.path === '/pricing.html') && pages.assets >= 5)
    const mirror = await fetch(`${apiUrl}/api/runs/${run.id}/mirror/`)
    assert.equal(mirror.status, 200)
    assert.match(mirror.headers.get('content-security-policy'), /script-src 'none'/)
    const html = await mirror.text()
    assert.ok(html.includes('<base href="/api/runs/' + run.id + '/mirror/">') && !/<script/i.test(html) && html.includes('<h1>좋은 아이디어는'))
    assert.ok(html.includes(`href="/api/runs/${run.id}/mirror/style.css"`))
    const css = await fetch(`${apiUrl}/api/runs/${run.id}/mirror/style.css`)
    assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/)
    assert.ok((await fetch(`${apiUrl}/api/runs/${run.id}/mirror/__ext/${encodeURIComponent('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap')}`)).status === 200, 'recorded foreign asset is served from the HAR')
    assert.equal((await fetch(`${apiUrl}/api/runs/${run.id}/mirror/nope.png`)).status, 404)
    assert.ok((await (await fetch(`${apiUrl}/api/runs/${run.id}/mirror/unknown-page`)).text()).includes('기록되지 않은 페이지'))
    assert.equal((await post(`/api/runs/${run.id}/variants`, { name: 'bad', patches: [{ type: 'inject', selector: 'h1', html: '<script>1</script>' }] })).status, 400)
    const savedRes = await post(`/api/runs/${run.id}/variants`, { name: '미러 · 제목 교체', patches: [{ type: 'text', selector: 'h1', text: '미러에서 바꾼 제목' }, { type: 'css', rule: '.button{background:#000!important}' }] })
    assert.equal(savedRes.status, 201)
    const saved = await savedRes.json()
    assert.equal(saved.key, 'mirror_1')
    const list = await (await fetch(`${apiUrl}/api/runs/${run.id}/variants`)).json()
    assert.equal(list.variants.length, 1); assert.equal(list.variants[0].patches.length, 2)
    assert.equal((await post(`/api/runs/${run.id}/variants`, { key: 'mirror_1', name: 'dup', patches: [{ type: 'hide', selector: 'p' }] })).status, 409)

    // C + B. live view during a 2-persona, 2-round run on the generated pool with the saved variant
    const idle = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/live/state`)).json()
    assert.equal(idle.running, false)
    const idleStream = await readSse(`${apiUrl}/api/runs/${run.id}/simulation/live`, e => e === 'end')
    assert.equal(idleStream[0].event, 'state'); assert.equal(idleStream[0].data.running, false)
    const simStart = await post(`/api/runs/${run.id}/simulation`, { personas: 2, variants: ['control', 'mirror_1'], poolSource: 'generated', rounds: 2, visitorsPerRound: 2, seed: 'complete-seed', maxSteps: 6, concurrency: 2, captureSteps: true })
    assert.equal(simStart.status, 202)
    const startedSim = await simStart.json()
    assert.equal(startedSim.params.rounds, 2); assert.equal(startedSim.params.poolSource, 'generated')
    assert.deepEqual(startedSim.params.variants.map(v => [v.key, v.saved]), [['control', false], ['mirror_1', true]])
    // the hub exists as soon as the simulation is queued, so a client can subscribe before the first session starts
    const events = await readSse(`${apiUrl}/api/runs/${run.id}/simulation/live`, (e, d, seen) => e === 'frame' && seen.some(x => x.event === 'step'), 90000)
    const frames = events.filter(e => e.event === 'frame')
    assert.ok(frames.length >= 1, `expected a screencast frame, got events: ${events.map(e => e.event).join(',')}`)
    assert.ok(frames[0].data.data.length > 1000 && frames[0].data.sessionId)
    assert.ok(Buffer.from(frames[0].data.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'frame is a JPEG')
    const stateEvent = events.find(e => e.event === 'state' && e.data.agents.length)
    assert.ok(stateEvent && stateEvent.data.spotlight && stateEvent.data.agents.every(a => a.persona.name && a.variantKey))
    const stepEvent = events.find(e => e.event === 'step')
    assert.ok(stepEvent.data.history.length >= 1 && stepEvent.data.action)
    // switching the spotlight to any running session (or being told it already finished) is accepted
    const running = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/live/state`)).json()
    if (running.running && running.agents.length) { const target = running.agents.at(-1).id; const sw = await post(`/api/runs/${run.id}/simulation/live/spotlight`, { sessionId: target }); assert.ok([200, 404].includes(sw.status)) }
    assert.equal((await post(`/api/runs/${run.id}/simulation/live/spotlight`, { sessionId: '../x' })).status >= 400, true)
    const sim = await poll(`/api/runs/${run.id}/simulation`, s => ['completed', 'failed'].includes(s.status))
    assert.equal(sim.status, 'completed', sim.error)
    assert.equal(sim.pool.source, 'generated')
    assert.equal(sim.report.rounds.length, 2)
    assert.deepEqual(sim.report.rounds[0].n, { control: 2, mirror_1: 2 })
    assert.ok(sim.report.rounds[1].n.control >= 1 && sim.report.rounds[1].n.control <= 2)
    assert.ok(Object.keys(sim.report.rounds[1].visitProbBySegment.control).length >= 1)
    assert.ok(sim.report.rounds.every(r => typeof r.kFactor.control === 'number' && typeof r.cvrByVariant.mirror_1 === 'number'))
    assert.ok(Object.keys(sim.report.baseVisitProb).length >= 1)
    assert.equal(sim.progress.done, 4, 'two personas × two variants, repeat visitors reuse sessions')
    assert.equal(sim.sessions.length, 4)
    assert.ok(sim.sessions.every(s => s.persona.archetype && s.persona.priors && s.round === 1))
    const mirrored = sim.sessions.find(s => s.variantKey === 'mirror_1')
    const full = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/sessions/${mirrored.id}`)).json()
    assert.ok(full.steps[0].topElements.some(t => t.includes('미러에서 바꾼 제목')), `saved variant patch applied: ${JSON.stringify(full.steps[0].topElements)}`)
    const ended = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/live/state`)).json()
    assert.equal(ended.running, false); assert.equal(ended.simulation, 'completed'); assert.ok(ended.frames >= 1)
    const runAfter = await (await fetch(`${apiUrl}/api/runs/${run.id}`)).json()
    assert.ok(runAfter.events.some(e => e.message.includes('라운드 2')))

    // E. feedback cards + action queue
    const fb = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/feedback`)).json()
    assert.ok(fb.summary.sessions === 4 && fb.summary.rounds === 2)
    assert.ok(Array.isArray(fb.cards) && fb.cards.length >= 1)
    assert.ok(fb.cards.every(c => c.id && c.category && c.evidence && c.action && c.confidence))
    assert.equal(fb.llm.refined, false)
    const first = fb.cards[0]
    assert.equal((await post(`/api/runs/${run.id}/simulation/feedback/actions`, { id: first.id, done: true, note: '검토' })).status, 200)
    const fb2 = await (await fetch(`${apiUrl}/api/runs/${run.id}/simulation/feedback`)).json()
    assert.equal(fb2.actions[first.id].done, true)
    assert.equal((await post(`/api/runs/${run.id}/simulation/feedback/actions`, { id: 'bad id' })).status, 400)

    // UI: the simulation tab renders the five panels and the mirror iframe is editable
    const browser = await launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      const pageErrors = []
      page.on('pageerror', err => pageErrors.push(err.message))
      await page.goto(`${apiUrl}/runs/${run.id}`)
      await page.getByText('발견한 개선 지점').waitFor()
      await page.locator('.sub-tab', { hasText: '페르소나 시뮬레이션' }).click()
      await page.locator('.variant-card').first().waitFor({ timeout: 15000 })
      for (const text of ['사이트 매칭 페르소나 풀', '통합 시뮬레이션 · 피드백 루프', '에이전트 라이브 뷰', '미러 편집기', '피드백 카드']) assert.ok(await page.getByText(text, { exact: false }).first().isVisible(), text)
      assert.ok(await page.locator('.archetype-row').count() >= 4)
      assert.ok(await page.locator('.loop-svg path').count() >= 2)
      assert.ok(await page.locator('.heat-cell').count() >= 2)
      assert.ok(await page.locator('.fb-card').count() >= 1)
      await page.locator('.mirror-open').click()
      const frame = page.frameLocator('.mirror-frame')
      await frame.locator('h1').waitFor({ timeout: 15000 })
      await frame.locator('h1').click()
      await page.locator('.mirror-selector').waitFor()
      assert.equal(await page.locator('.mirror-selector').innerText(), 'main > section:nth-of-type(1) > div:nth-of-type(1) > h1')
      await page.locator('.mirror-tool', { hasText: '텍스트' }).click()
      await page.locator('.mirror-input').fill('편집기에서 바꾼 제목')
      await page.locator('.mirror-apply').click()
      assert.ok((await frame.locator('h1').innerText()).startsWith('편집기에서 바꾼 제목'), 'text patch replaces the first text node, like the server-side patch')
      assert.equal(await page.locator('.mirror-patch').count(), 1)
      await page.locator('.mirror-undo').click()
      assert.ok((await frame.locator('h1').innerText()).includes('좋은 아이디어'))
      assert.deepEqual(pageErrors, [])
    } finally { await browser.close() }
  } finally {
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => demo.close(resolve))])
    await fs.rm(temp, { recursive: true, force: true })
  }
})
