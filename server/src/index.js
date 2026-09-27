import 'dotenv/config'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { inspect, validateTarget } from './browser.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = process.env.DATA_DIR || path.join(root, 'data', 'runs')
const runs = new Map()
let work = Promise.resolve()

async function save(run) {
  await fs.mkdir(path.join(dataDir, run.id), { recursive: true })
  await fs.writeFile(path.join(dataDir, run.id, 'run.json'), JSON.stringify(run, null, 2))
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
    } catch { /* ignore unrelated files */ }
  }
}

function publicRun(run) { return { ...run, screenshotUrl: run.status === 'completed' ? `/api/runs/${run.id}/screenshot` : null } }

export async function createApp() {
  await loadRuns()
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'marketclaw', version: '1.0.0' }))
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
