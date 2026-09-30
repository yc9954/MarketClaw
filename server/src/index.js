import 'dotenv/config'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { inspect, validateTarget } from './browser.js'
import { poolSummary, loadPool } from './simulation/personas.js'
import { defaultVariants, publicVariant, validateSavedVariant, SAVED_LIMIT } from './simulation/variants.js'
import { llmConfig, DEFAULT_GOAL_PATTERN } from './simulation/engine.js'
import { runSimulation, normalizeParams, publicParams, LIMITS as SIM_LIMITS, GENERATED_POOL_FILE } from './simulation/runner.js'
import { generatePersonaPool, normalizeGenParams, GEN_LIMITS, nemotronPath, siteBrief } from './simulation/personaGen.js'
import { createLiveHub, writeIdleStream } from './simulation/live.js'
import { loadMirror, serveMirror, invalidateMirror } from './simulation/mirror.js'
import { deriveFeedback, refineWithLlm, CATEGORIES as FEEDBACK_CATEGORIES } from './simulation/feedback.js'

export const VERSION = '1.2.0'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = process.env.DATA_DIR || path.join(root, 'data', 'runs')
const runs = new Map()
const simulations = new Map()
const personaJobs = new Map() // runId → { status, stage, detail, error, startedAt, finishedAt }
const liveHubs = new Map() // runId → hub of the running (or last) simulation
let work = Promise.resolve()

async function save(run) {
  await fs.mkdir(path.join(dataDir, run.id), { recursive: true })
  await fs.writeFile(path.join(dataDir, run.id, 'run.json'), JSON.stringify(run, null, 2))
}

async function saveSimulation(sim) {
  await fs.mkdir(path.join(dataDir, sim.runId), { recursive: true })
  await fs.writeFile(path.join(dataDir, sim.runId, 'simulation.json'), JSON.stringify(sim))
}

async function loadSimulation(id) {
  try {
    const sim = JSON.parse(await fs.readFile(path.join(dataDir, id, 'simulation.json'), 'utf8'))
    if (sim.status === 'queued' || sim.status === 'running') { sim.status = 'interrupted'; sim.error = '서버가 시뮬레이션 도중 재시작되었습니다. 다시 실행하세요.'; await saveSimulation(sim) }
    simulations.set(id, sim)
  } catch { /* no simulation for this run */ }
}

async function loadRuns() {
  await fs.mkdir(dataDir, { recursive: true })
  for (const id of await fs.readdir(dataDir)) {
    try {
      const run = JSON.parse(await fs.readFile(path.join(dataDir, id, 'run.json'), 'utf8'))
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'interrupted'
        run.error = '서버가 실행 도중 재시작되었습니다. 새 분석을 시작하세요.'
        await save(run)
      }
      runs.set(run.id, run)
      await loadSimulation(run.id)
    } catch { /* ignore unrelated files */ }
  }
}

const readJson = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback } }
const writeJson = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data, null, 2)) }
const variantsFile = id => path.join(dataDir, id, 'variants.json')
const actionsFile = id => path.join(dataDir, id, 'feedback-actions.json')
const poolFile = id => path.join(dataDir, id, GENERATED_POOL_FILE)
const savedVariantsOf = async id => readJson(variantsFile(id), {})

const llmStatus = () => { const cfg = llmConfig(); return { configured: cfg.configured, model: cfg.configured ? cfg.model : null, baseUrl: cfg.configured ? cfg.baseUrl : null, policy: cfg.configured ? 'llm' : 'heuristic' } }
const SESSION_ID = /^[A-Za-z0-9_-]{1,120}$/
const VARIANT_KEY = /^[a-z][a-zA-Z0-9_]{0,30}$/

function publicRun(run) { return { ...run, screenshotUrl: run.status === 'completed' ? `/api/runs/${run.id}/screenshot` : null } }

// The generated pool without the full persona list: what the UI panel renders, plus a sample.
function publicPool(pool, limit = 60) {
  const { personas, ...rest } = pool
  return { ...rest, total: personas.length, personas: personas.slice(0, limit).map(p => ({ id: p.id, segment: p.segment, name: p.name, archetype: p.archetype, persona_name: p.persona_name, description: p.description, weight: p.weight, demographics: p.demographics, traits: p.traits, goals: p.goals, priors: p.priors, sampler: p.sampler })) }
}

export async function createApp() {
  await loadRuns()
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '256kb' }))
  const getRun = (req, res) => { const run = runs.get(req.params.id); if (!run) res.status(404).json({ error: '분석을 찾을 수 없습니다.' }); return run }
  const completedRun = (req, res) => { const run = getRun(req, res); if (!run) return null; if (run.status !== 'completed') { res.status(409).json({ error: '분석이 완료된 뒤에 사용할 수 있습니다.' }); return null } return run }

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'marketclaw', version: VERSION, llm: llmStatus(), features: ['personas', 'feedback-loop', 'live-view', 'mirror-editor', 'feedback-cards'] }))
  app.get('/api/personas', (_req, res) => {
    try {
      res.json({ ...poolSummary(), llm: llmStatus(), variants: Object.values(defaultVariants).map(publicVariant), limits: { ...SIM_LIMITS, generation: GEN_LIMITS }, defaultGoalPattern: DEFAULT_GOAL_PATTERN.source, defaults: { personas: 20, concurrency: Number(process.env.SIM_CONCURRENCY) || 3, maxSteps: Number(process.env.SIM_MAX_STEPS) || 12, rounds: 1 }, generation: { sampler: nemotronPath() ? 'nemotron' : 'bundled', nemotronPath: nemotronPath() ? path.basename(nemotronPath()) : null, defaults: { count: 60, archetypes: 6, seed: 42 } } })
    } catch (err) { res.status(500).json({ error: `페르소나 풀을 읽지 못했습니다: ${err.message}` }) }
  })
  app.get('/api/runs', (_req, res) => res.json([...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun)))
  app.get('/api/runs/:id', (req, res) => { const run = getRun(req, res); if (run) res.json(publicRun(run)) })
  app.get('/api/runs/:id/screenshot', async (req, res) => {
    const run = runs.get(req.params.id)
    if (!run || run.status !== 'completed') return res.sendStatus(404)
    res.sendFile(path.join(dataDir, run.id, 'home.png'))
  })
  app.post('/api/runs', async (req, res) => {
    let target
    try { target = await validateTarget(req.body?.url) } catch (err) { return res.status(400).json({ error: err.message }) }
    const run = { id: randomUUID(), url: target.href, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [{ at: new Date().toISOString(), message: '분석 대기 중' }], report: null, error: null }
    runs.set(run.id, run)
    await save(run)
    work = work.catch(() => {}).then(async () => {
      run.status = 'running'
      run.updatedAt = new Date().toISOString()
      await save(run)
      try {
        run.report = await inspect(target, path.join(dataDir, run.id), message => {
          run.events.push({ at: new Date().toISOString(), message })
          run.updatedAt = new Date().toISOString()
        })
        run.status = 'completed'
      } catch (err) { run.status = 'failed'; run.error = err.message; run.events.push({ at: new Date().toISOString(), message: `분석 실패: ${err.message}` }) }
      run.updatedAt = new Date().toISOString()
      invalidateMirror(run.id)
      await save(run)
    })
    res.status(202).json(publicRun(run))
  })

  // ── A. site-matched persona generation ────────────────────────────────────
  app.get('/api/runs/:id/personas/status', (req, res) => {
    if (!getRun(req, res)) return
    res.json(personaJobs.get(req.params.id) || { status: 'idle', stage: null, detail: null, error: null })
  })
  app.get('/api/runs/:id/personas', async (req, res) => {
    const run = getRun(req, res)
    if (!run) return
    const pool = await readJson(poolFile(run.id), null)
    if (!pool) return res.status(404).json({ error: '이 분석에는 아직 생성된 페르소나 풀이 없습니다.', job: personaJobs.get(run.id) || null })
    res.json({ ...publicPool(pool, Math.min(300, Number(req.query.limit) || 60)), job: personaJobs.get(run.id) || null })
  })
  app.post('/api/runs/:id/personas', async (req, res) => {
    const run = completedRun(req, res)
    if (!run) return
    const current = personaJobs.get(run.id)
    if (current?.status === 'running') return res.status(409).json({ error: '이 분석의 페르소나 생성이 이미 진행 중입니다.' })
    const params = normalizeGenParams(req.body || {})
    const job = { status: 'running', stage: 'queued', detail: '', error: null, params, startedAt: new Date().toISOString(), finishedAt: null }
    personaJobs.set(run.id, job)
    const event = message => { run.events.push({ at: new Date().toISOString(), message }); run.updatedAt = new Date().toISOString() }
    event(`페르소나 풀 생성 시작: ${params.count}명 · ${params.archetypes}개 아키타입 · ${params.policy === 'llm' ? 'LLM' : '휴리스틱'} · seed ${params.seed}`)
    ;(async () => {
      try {
        const pool = await generatePersonaPool({ run, params, onStage: (stage, detail) => { job.stage = stage; job.detail = detail; event(`페르소나 생성 · ${stage}: ${detail}`) } })
        await writeJson(poolFile(run.id), pool)
        job.status = 'completed'; job.summary = { total: pool.count, archetypes: pool.archetypes.length, sampler: pool.sampler, usedLlm: pool.policy.usedLlm, warnings: pool.warnings }
        event(`페르소나 풀 생성 완료: ${pool.count}명, ${pool.archetypes.length}개 아키타입 (${pool.sampler === 'nemotron' ? 'Nemotron 로컬 샘플' : '번들 풀'})`)
      } catch (err) { job.status = 'failed'; job.error = String(err.message || err); event(`페르소나 풀 생성 실패: ${job.error}`) }
      job.finishedAt = new Date().toISOString()
      await save(run)
    })()
    res.status(202).json(job)
  })

  // ── simulation ────────────────────────────────────────────────────────────
  app.get('/api/runs/:id/simulation', (req, res) => {
    const sim = simulations.get(req.params.id)
    if (!sim) return res.status(404).json({ error: '이 분석에는 아직 시뮬레이션이 없습니다.' })
    res.json(sim)
  })
  app.post('/api/runs/:id/simulation', async (req, res) => {
    const run = completedRun(req, res)
    if (!run) return
    const existing = simulations.get(run.id)
    if (existing && ['queued', 'running'].includes(existing.status)) return res.status(409).json({ error: '이 분석의 시뮬레이션이 이미 실행 중입니다.' })
    let params
    try { params = normalizeParams(req.body || {}, { savedVariants: await savedVariantsOf(run.id) }) } catch (err) { return res.status(400).json({ error: err.message }) }
    if (params.poolSource === 'generated') { try { loadPool(poolFile(run.id)) } catch { return res.status(409).json({ error: '이 분석에는 생성된 페르소나 풀이 없습니다. 먼저 페르소나 풀을 생성하세요.' }) } }
    const sim = { runId: run.id, status: 'queued', policy: params.policy, params: publicParams(params), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { done: 0, total: params.personas * params.variants.length, failed: 0, round: 1, rounds: params.rounds }, site: null, pool: null, report: null, sessions: [], error: null }
    simulations.set(run.id, sim)
    await saveSimulation(sim)
    const touch = () => { sim.updatedAt = new Date().toISOString(); run.updatedAt = sim.updatedAt }
    const event = message => { run.events.push({ at: new Date().toISOString(), message }); touch() }
    // The live hub exists from the moment the simulation is queued, so viewers can subscribe early.
    const previous = liveHubs.get(run.id)
    if (previous) await previous.close().catch(() => {})
    const live = createLiveHub()
    liveHubs.set(run.id, live)
    work = work.catch(() => {}).then(async () => {
      sim.status = 'running'; touch()
      await saveSimulation(sim)
      try {
        const result = await runSimulation({ run, runDir: path.join(dataDir, run.id), params, live, onEvent: event, onProgress: progress => { sim.progress = progress; touch() } })
        Object.assign(sim, result, { status: 'completed' })
      } catch (err) { sim.status = 'failed'; sim.error = err.message; event(`시뮬레이션 실패: ${err.message}`) }
      await live.close().catch(() => {})
      touch()
      await saveSimulation(sim)
      await save(run)
    })
    res.status(202).json(sim)
  })
  app.get('/api/runs/:id/simulation/sessions/:sid', async (req, res) => {
    const sim = simulations.get(req.params.id)
    if (!sim || !SESSION_ID.test(req.params.sid)) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' })
    try { res.type('json').send(await fs.readFile(path.join(dataDir, req.params.id, 'simulation', 'sessions', `${req.params.sid}.json`))) } catch { res.status(404).json({ error: '세션을 찾을 수 없습니다.' }) }
  })
  app.get('/api/runs/:id/simulation/sessions/:sid/steps/:n.png', (req, res) => {
    const n = Number(req.params.n)
    if (!simulations.has(req.params.id) || !SESSION_ID.test(req.params.sid) || !Number.isInteger(n) || n < 1 || n > SIM_LIMITS.screenshots) return res.sendStatus(404)
    res.sendFile(path.join(dataDir, req.params.id, 'simulation', 'screenshots', req.params.sid, `step_${String(n).padStart(2, '0')}.png`), err => { if (err && !res.headersSent) res.sendStatus(404) })
  })

  // ── C. live agent's-eye view (server-sent events) ─────────────────────────
  const idle = id => ({ running: false, spotlight: null, agents: [], frames: 0, lastFrameAt: null, simulation: simulations.get(id)?.status || null })
  app.get('/api/runs/:id/simulation/live', (req, res) => {
    if (!getRun(req, res)) return
    const hub = liveHubs.get(req.params.id)
    if (!hub || !hub.snapshot().running) return writeIdleStream(res, hub ? { ...hub.snapshot(), simulation: simulations.get(req.params.id)?.status || null } : idle(req.params.id))
    hub.subscribe(res)
  })
  app.get('/api/runs/:id/simulation/live/state', (req, res) => {
    if (!getRun(req, res)) return
    const hub = liveHubs.get(req.params.id)
    res.json(hub ? { ...hub.snapshot(), simulation: simulations.get(req.params.id)?.status || null } : idle(req.params.id))
  })
  app.post('/api/runs/:id/simulation/live/spotlight', async (req, res) => {
    if (!getRun(req, res)) return
    const hub = liveHubs.get(req.params.id)
    const sessionId = String(req.body?.sessionId || '')
    if (!hub || !hub.snapshot().running) return res.status(409).json({ error: '실행 중인 시뮬레이션이 없습니다.' })
    if (!SESSION_ID.test(sessionId)) return res.status(400).json({ error: '세션 id가 필요합니다.' })
    const ok = await hub.setSpotlight(sessionId)
    if (!ok && hub.spotlight !== sessionId) return res.status(404).json({ error: '실행 중인 세션이 아닙니다.' })
    res.json({ ok, spotlight: hub.spotlight })
  })

  // ── D. mirror + saved variants ────────────────────────────────────────────
  app.get('/api/runs/:id/mirror-pages', async (req, res) => {
    const run = completedRun(req, res)
    if (!run) return
    try { const mirror = await loadMirror(run, path.join(dataDir, run.id)); res.json({ origin: mirror.origin, base: `/api/runs/${run.id}/mirror/`, pages: mirror.pages, assets: mirror.index.size }) } catch (err) { res.status(500).json({ error: `HAR을 읽지 못했습니다: ${err.message}` }) }
  })
  app.get(/^\/api\/runs\/([^/]+)\/mirror(?:\/(.*))?$/, async (req, res) => {
    const run = runs.get(req.params[0])
    if (!run || run.status !== 'completed') return res.sendStatus(404)
    if (req.params[1] === undefined) return res.redirect(`/api/runs/${run.id}/mirror/`)
    try {
      const mirror = await loadMirror(run, path.join(dataDir, run.id))
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : ''
      serveMirror(mirror, req.params[1] || '', query, res)
    } catch (err) { res.status(500).type('text').send(`mirror error: ${err.message}`) }
  })
  app.get('/api/runs/:id/variants', async (req, res) => {
    if (!getRun(req, res)) return
    const saved = await savedVariantsOf(req.params.id)
    res.json({ variants: Object.values(saved), defaults: Object.values(defaultVariants).map(publicVariant), limit: SAVED_LIMIT })
  })
  app.post('/api/runs/:id/variants', async (req, res) => {
    const run = completedRun(req, res)
    if (!run) return
    const saved = await savedVariantsOf(run.id)
    if (Object.keys(saved).length >= SAVED_LIMIT) return res.status(400).json({ error: `저장 변형은 최대 ${SAVED_LIMIT}개입니다.` })
    let variant
    try { variant = validateSavedVariant(req.body || {}, saved) } catch (err) { return res.status(400).json({ error: err.message }) }
    if (saved[variant.key] && req.body?.replace !== true) return res.status(409).json({ error: `변형 key ${variant.key}가 이미 있습니다.` })
    saved[variant.key] = variant
    await writeJson(variantsFile(run.id), saved)
    run.events.push({ at: new Date().toISOString(), message: `변형 저장: ${variant.name} (${variant.key}, 패치 ${variant.patches.length}개)` })
    await save(run)
    res.status(201).json(variant)
  })
  app.delete('/api/runs/:id/variants/:key', async (req, res) => {
    const run = getRun(req, res)
    if (!run) return
    if (!VARIANT_KEY.test(req.params.key)) return res.status(400).json({ error: '잘못된 변형 key입니다.' })
    const saved = await savedVariantsOf(run.id)
    if (!saved[req.params.key]) return res.status(404).json({ error: '변형을 찾을 수 없습니다.' })
    delete saved[req.params.key]
    await writeJson(variantsFile(run.id), saved)
    res.json({ ok: true, variants: Object.values(saved) })
  })

  // ── E. feedback cards + action queue ──────────────────────────────────────
  app.get('/api/runs/:id/simulation/feedback', async (req, res) => {
    const run = getRun(req, res)
    if (!run) return
    const sim = simulations.get(run.id)
    if (!sim || sim.status !== 'completed') return res.status(404).json({ error: '완료된 시뮬레이션이 없습니다.' })
    let { summary, cards } = deriveFeedback(sim, run)
    let refined = false
    if (req.query.refine === '1' && llmConfig().configured) {
      const pool = await readJson(poolFile(run.id), null)
      try { const out = await refineWithLlm(cards, { url: run.url, brief: siteBrief(pool?.siteCharacter) }); cards = out.cards; refined = out.refined } catch { refined = false }
    }
    const actions = await readJson(actionsFile(run.id), {})
    res.json({ summary, cards, actions, categories: FEEDBACK_CATEGORIES, llm: { ...llmStatus(), refined } })
  })
  app.post('/api/runs/:id/simulation/feedback/actions', async (req, res) => {
    const run = getRun(req, res)
    if (!run) return
    const id = String(req.body?.id || '')
    if (!/^[a-z]+:[A-Za-z0-9_./:-]{1,120}$/.test(id)) return res.status(400).json({ error: '카드 id가 필요합니다.' })
    const actions = await readJson(actionsFile(run.id), {})
    if (req.body?.done) actions[id] = { done: true, at: new Date().toISOString(), note: typeof req.body.note === 'string' ? req.body.note.slice(0, 200) : '' }
    else delete actions[id]
    await writeJson(actionsFile(run.id), actions)
    res.json({ ok: true, actions })
  })

  const dist = path.join(root, 'web', 'dist')
  app.use(express.static(dist))
  app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api/')) return res.sendStatus(404)
    try { await fs.access(path.join(dist, 'index.html')); res.sendFile(path.join(dist, 'index.html')) } catch { next() }
  })
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp()
  const port = Number(process.env.PORT || 4000)
  const host = process.env.HOST || '127.0.0.1'
  app.listen(port, host, () => console.log(`MarketClaw API: http://${host}:${port}`))
}
