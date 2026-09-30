import 'dotenv/config'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { inspect, validateTarget } from './browser.js'
import { poolSummary } from './simulation/personas.js'
import { defaultVariants, publicVariant } from './simulation/variants.js'
import { llmConfig, DEFAULT_GOAL_PATTERN } from './simulation/engine.js'
import { runSimulation, normalizeParams, publicParams, LIMITS as SIM_LIMITS } from './simulation/runner.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = process.env.DATA_DIR || path.join(root, 'data', 'runs')
const runs = new Map()
const simulations = new Map()
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

const llmStatus = () => { const cfg = llmConfig(); return { configured: cfg.configured, model: cfg.configured ? cfg.model : null, baseUrl: cfg.configured ? cfg.baseUrl : null, policy: cfg.configured ? 'llm' : 'heuristic' } }
const SESSION_ID = /^[A-Za-z0-9_-]{1,120}$/

function publicRun(run) { return { ...run, screenshotUrl: run.status === 'completed' ? `/api/runs/${run.id}/screenshot` : null } }

export async function createApp() {
  await loadRuns()
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'marketclaw', version: '1.1.0', llm: llmStatus() }))
  app.get('/api/personas', (_req, res) => {
    try {
      res.json({ ...poolSummary(), llm: llmStatus(), variants: Object.values(defaultVariants).map(publicVariant), limits: SIM_LIMITS, defaultGoalPattern: DEFAULT_GOAL_PATTERN.source, defaults: { personas: 20, concurrency: Number(process.env.SIM_CONCURRENCY) || 3, maxSteps: Number(process.env.SIM_MAX_STEPS) || 12 } })
    } catch (err) { res.status(500).json({ error: `페르소나 풀을 읽지 못했습니다: ${err.message}` }) }
  })
  app.get('/api/runs', (_req, res) => res.json([...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun)))
  app.get('/api/runs/:id', (req, res) => {
    const run = runs.get(req.params.id)
    if (!run) return res.status(404).json({ error: '분석을 찾을 수 없습니다.' })
    res.json(publicRun(run))
  })
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
      await save(run)
    })
    res.status(202).json(publicRun(run))
  })
  app.get('/api/runs/:id/simulation', (req, res) => {
    const sim = simulations.get(req.params.id)
    if (!sim) return res.status(404).json({ error: '이 분석에는 아직 시뮬레이션이 없습니다.' })
    res.json(sim)
  })
  app.post('/api/runs/:id/simulation', async (req, res) => {
    const run = runs.get(req.params.id)
    if (!run) return res.status(404).json({ error: '분석을 찾을 수 없습니다.' })
    if (run.status !== 'completed') return res.status(409).json({ error: '분석이 완료된 뒤에 시뮬레이션을 실행할 수 있습니다.' })
    const existing = simulations.get(run.id)
    if (existing && ['queued', 'running'].includes(existing.status)) return res.status(409).json({ error: '이 분석의 시뮬레이션이 이미 실행 중입니다.' })
    let params
    try { params = normalizeParams(req.body || {}) } catch (err) { return res.status(400).json({ error: err.message }) }
    const sim = { runId: run.id, status: 'queued', policy: params.policy, params: publicParams(params), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { done: 0, total: params.personas * params.variants.length, failed: 0 }, site: null, report: null, sessions: [], error: null }
    simulations.set(run.id, sim)
    await saveSimulation(sim)
    const touch = () => { sim.updatedAt = new Date().toISOString(); run.updatedAt = sim.updatedAt }
    const event = message => { run.events.push({ at: new Date().toISOString(), message }); touch() }
    work = work.catch(() => {}).then(async () => {
      sim.status = 'running'; touch()
      await saveSimulation(sim)
      try {
        const result = await runSimulation({ run, runDir: path.join(dataDir, run.id), params, onEvent: event, onProgress: progress => { sim.progress = progress; touch() } })
        Object.assign(sim, result, { status: 'completed' })
      } catch (err) { sim.status = 'failed'; sim.error = err.message; event(`시뮬레이션 실패: ${err.message}`) }
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
