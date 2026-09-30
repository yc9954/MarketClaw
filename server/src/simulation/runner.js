// Runs personas × variants over the run's HAR and writes one JSON per session plus optional
// per-step screenshots under data/runs/<id>/simulation/.
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { sample } from './personas.js'
import { resolveVariants, bindVariant, applyVariant, publicVariant } from './variants.js'
import { createShadowContext } from './shadow.js'
import { observePage, executeAction, createMemory, updateMemory, createPolicy, compileGoals, isGoalPage, llmConfig, DEFAULT_GOAL_PATTERN } from './engine.js'
import { buildReport } from './report.js'
import { hashSeed } from './random.js'

export const LIMITS = { personas: [1, 200], concurrency: [1, 6], maxSteps: [2, 30], screenshots: 8 }
const clamp = (value, [min, max], fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback }

export function normalizeParams(body = {}) {
  const params = {
    personas: clamp(body.personas, LIMITS.personas, 20),
    segments: Array.isArray(body.segments) ? body.segments.map(String).slice(0, 20) : [],
    variants: resolveVariants(body.variants),
    concurrency: clamp(body.concurrency, LIMITS.concurrency, clamp(process.env.SIM_CONCURRENCY, LIMITS.concurrency, 3)),
    maxSteps: clamp(body.maxSteps, LIMITS.maxSteps, clamp(process.env.SIM_MAX_STEPS, LIMITS.maxSteps, 12)),
    captureSteps: body.captureSteps === true || body.captureSteps === 'true',
    seed: body.seed === undefined || body.seed === null || body.seed === '' ? Date.now() % 100000 : String(body.seed).slice(0, 40),
    goals: Array.isArray(body.goals) ? body.goals.map(String).slice(0, 20) : [],
    policy: body.policy === 'heuristic' ? 'heuristic' : llmConfig().configured ? 'llm' : 'heuristic'
  }
  compileGoals(params.goals) // throws on an invalid pattern
  return params
}

export function publicParams(params) { return { ...params, variants: params.variants.map(publicVariant) } }

// What the capture learned about the site, used to bind generic variants and to detect CTAs.
export function siteContext(run) {
  const pages = run.report?.pages || []
  const home = pages[0] || {}
  const origin = new URL(run.url).origin
  const toPath = href => { try { const u = new URL(href, run.url); return u.origin === origin ? u.pathname + u.search : null } catch { return null } }
  const cta = home.ctas?.find(c => c.aboveFold && c.href) || home.ctas?.find(c => c.aboveFold) || home.ctas?.[0] || null
  const contactLink = [...(home.links || []), ...pages.flatMap(p => p.links || [])].find(l => /contact|문의|상담|demo|inquiry/i.test(`${l.text} ${l.url}`) && toPath(l.url))
  return {
    origin, host: new URL(run.url).hostname,
    pages: pages.filter(p => !p.error).map(p => ({ path: toPath(p.url) || '/', title: p.title })),
    ctaText: cta?.text || '', ctaHref: cta?.href ? toPath(cta.href) || '' : '',
    ctaTexts: pages.flatMap(p => (p.ctas || []).map(c => c.text)).filter(Boolean).slice(0, 40),
    contactHref: contactLink ? toPath(contactLink.url) : ''
  }
}

async function launchBrowser() {
  const channel = process.env.BROWSER_CHANNEL
  return chromium.launch({ headless: process.env.BROWSER_HEADLESS !== '0', ...(channel ? { channel } : {}) })
}

export function summarize(session) {
  const { steps, memory, shadowEvents, ...rest } = session
  return rest
}

async function runSession({ browser, harPath, run, site, persona, variant, params, goals, simDir, pace }) {
  const id = `${persona.id}__${variant.key}`
  const seed = hashSeed(params.seed, persona.id, variant.key)
  const policy = createPolicy({ persona, seed, policy: params.policy })
  const { context, stats } = await createShadowContext(browser, { harPath, origin: site.origin })
  const page = await context.newPage()
  const shotDir = path.join(simDir, 'screenshots', id)
  if (params.captureSteps) await fs.mkdir(shotDir, { recursive: true })
  const memory = createMemory()
  const steps = []
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  let bounced = false
  const ctx = { origin: site.origin, host: site.host, pages: site.pages, goals, goalPatterns: params.goals.length ? params.goals : [DEFAULT_GOAL_PATTERN.source], pace, ctaTexts: site.ctaTexts }
  try {
    page.on('load', () => applyVariant(page, variant, site).catch(() => {}))
    await page.goto(run.url, { waitUntil: 'load', timeout: 20000 })
    await page.waitForTimeout(Math.round(400 * pace) + 50)
    await applyVariant(page, variant, site)
    for (let step = 1; step <= params.maxSteps; step++) {
      const obs = await observePage(page, { ctaTexts: site.ctaTexts, interests: persona.goals.interests })
      let screenshot = null
      if (params.captureSteps && step <= LIMITS.screenshots) {
        screenshot = `step_${String(step).padStart(2, '0')}.png`
        await page.screenshot({ path: path.join(shotDir, screenshot), fullPage: false, animations: 'disabled' }).catch(() => { screenshot = null })
      }
      const decision = await policy.decide(obs, memory, step, params.maxSteps, ctx)
      const result = await executeAction(page, decision, ctx)
      if (isGoalPage(obs, goals)) result.goalReached = true
      const state = updateMemory(memory, obs, decision, result, persona)
      steps.push({ step, url: obs.url, path: obs.path, title: obs.title, scrollRatio: obs.scrollRatio, action: decision.action, target: result.target, value: decision.value ? String(decision.value).slice(0, 60) : undefined, reason: decision.reason || '', fallback: decision.fallback, ok: result.ok, error: result.error, clickedText: result.clickedText, clickedHref: result.clickedHref, simulatedMs: result.simulatedMs, elapsedMs: memory.simulatedMs, sentiment: state.sentiment, engagement: state.engagement, scent: state.scent, goalReached: !!result.goalReached, converted: !!result.converted, conversionType: result.conversionType, screenshot, topElements: obs.texts.slice(0, 3).map(t => t.text.slice(0, 60)) })
      if (result.bounced) { bounced = true; break }
      if (result.converted) break
    }
  } catch (err) {
    steps.push({ step: steps.length + 1, action: 'error', error: String(err.message || err).slice(0, 200), ok: false, sentiment: Math.round(memory.sentiment), engagement: Math.round(memory.engagement) })
  }
  const shadowEvents = await page.evaluate(() => window.__shadowEvents || []).catch(() => [])
  await context.close().catch(() => {})
  const session = {
    id, runId: run.id, persona: { id: persona.id, segment: persona.segment, name: persona.name, persona_name: persona.persona_name, description: persona.description, weight: persona.weight, demographics: { age: persona.demographics.age, occupation: persona.demographics.occupation, province: persona.demographics.province }, goal: persona.goals.conversion },
    variantKey: variant.key, variantName: variant.name, variantColor: variant.color, policy: policy.name, seed, startedAt, finishedAt: new Date().toISOString(), wallMs: Date.now() - t0,
    network: stats, steps, memory: { visited: memory.visited, intentSignals: memory.intentSignals, typed: memory.typed }, shadowEvents: shadowEvents.slice(0, 60),
    summary: {
      totalSteps: steps.length, pagesVisited: memory.visited.length, converted: memory.converted, conversionType: memory.conversionType, goalReached: memory.goalReached, bounced,
      finalSentiment: Math.round(memory.sentiment), engagementScore: Math.round(memory.engagement), simulatedMs: memory.simulatedMs, timeToConvertMs: memory.converted ? memory.convertedAtMs : null,
      errorCount: steps.filter(s => s.error).length, fallbackSteps: steps.filter(s => s.fallback).length, intentSignals: memory.intentSignals,
      actionBreakdown: steps.reduce((acc, s) => { acc[s.action] = (acc[s.action] || 0) + 1; return acc }, {}),
      screenshots: steps.filter(s => s.screenshot).length
    }
  }
  await fs.mkdir(path.join(simDir, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(simDir, 'sessions', `${id}.json`), JSON.stringify(session))
  return session
}

export async function runSimulation({ run, runDir, params, onEvent = () => {}, onProgress = () => {} }) {
  const harPath = path.join(runDir, 'capture.har.zip')
  await fs.access(harPath)
  const simDir = path.join(runDir, 'simulation')
  await fs.rm(simDir, { recursive: true, force: true })
  await fs.mkdir(simDir, { recursive: true })
  const site = siteContext(run)
  const personas = sample({ count: params.personas, segments: params.segments, seed: params.seed })
  if (!personas.length) throw new Error('선택한 세그먼트에 페르소나가 없습니다.')
  const variants = params.variants.map(v => bindVariant(v, site))
  const goals = compileGoals(params.goals)
  const pace = Math.max(0, Math.min(1, Number(process.env.SIM_PACE ?? 0.1)))
  const tasks = variants.flatMap(variant => personas.map(persona => ({ persona, variant })))
  const progress = { done: 0, total: tasks.length, failed: 0 }
  onEvent(`페르소나 시뮬레이션 시작: ${personas.length}명 × ${variants.length}개 변형 = ${tasks.length}세션 (${params.policy === 'llm' ? 'LLM' : '휴리스틱'} 정책, seed ${params.seed})`)
  const browser = await launchBrowser()
  const sessions = []
  try {
    let cursor = 0
    const worker = async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++]
        try {
          const session = await runSession({ browser, harPath, run, site, persona: task.persona, variant: task.variant, params, goals, simDir, pace })
          sessions.push(session)
          onEvent(`${task.persona.name.slice(0, 18)} × ${task.variant.key}: ${session.summary.converted ? '전환' : session.summary.bounced ? '이탈' : '종료'} · ${session.summary.totalSteps}스텝 · 감정 ${session.summary.finalSentiment}`)
        } catch (err) {
          progress.failed++
          onEvent(`세션 실패 ${task.persona.id} × ${task.variant.key}: ${String(err.message || err).slice(0, 80)}`)
        }
        progress.done++
        onProgress({ ...progress })
      }
    }
    await Promise.all(Array.from({ length: Math.min(params.concurrency, tasks.length) }, worker))
  } finally { await browser.close().catch(() => {}) }
  const order = new Map(variants.map((v, i) => [v.key, i]))
  sessions.sort((a, b) => order.get(a.variantKey) - order.get(b.variantKey) || a.persona.id.localeCompare(b.persona.id))
  const report = buildReport(sessions, variants, { seed: params.seed })
  onEvent(`시뮬레이션 완료: ${sessions.length}세션, 최고 변형 ${report.bestVariant?.name || '-'} (가중 CVR ${report.bestVariant?.cvr ?? 0}%)`)
  const result = { site: { origin: site.origin, ctaText: site.ctaText, ctaHref: site.ctaHref, contactHref: site.contactHref, pages: site.pages }, personas: personas.map(p => p.id), report, sessions: sessions.map(summarize) }
  await fs.writeFile(path.join(simDir, 'report.json'), JSON.stringify(report, null, 2))
  return result
}
