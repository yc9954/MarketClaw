// Agent's-eye live view: while a simulation runs, the spotlighted session's page is streamed as
// CDP screencast frames (JPEG, quality 50, ≤960px wide, ≤5 fps) together with the persona, the
// current action and the action history, over server-sent events. Other sessions keep running
// headless; the client can move the spotlight to any running session.
export function createLiveHub({ fps = Number(process.env.LIVE_FPS) || 5, quality = Number(process.env.LIVE_JPEG_QUALITY) || 50, maxWidth = Number(process.env.LIVE_MAX_WIDTH) || 960 } = {}) {
  const sessions = new Map()
  const subscribers = new Set()
  const state = { running: true, spotlight: null, round: 1, startedAt: new Date().toISOString(), endedAt: null, frames: 0 }
  let lastFrame = null
  let screencast = null // { id, cdp }
  let lastSentAt = 0

  const publicSession = s => ({ id: s.id, persona: s.persona, variantKey: s.variantKey, variantName: s.variantName, variantColor: s.variantColor, round: s.round, startedAt: s.startedAt, step: s.step, action: s.action, target: s.target, reason: s.reason, path: s.path, sentiment: s.sentiment, engagement: s.engagement, history: s.history })
  const snapshot = () => ({ running: state.running, spotlight: state.spotlight, round: state.round, startedAt: state.startedAt, endedAt: state.endedAt, frames: state.frames, fps, agents: [...sessions.values()].map(publicSession), lastFrameAt: lastFrame?.at || null })
  const send = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { subscribers.delete(res) } }
  const broadcast = (event, data) => { for (const res of subscribers) send(res, event, data) }

  async function stopScreencast() {
    const current = screencast
    screencast = null
    if (!current) return
    try { await current.cdp.send('Page.stopScreencast') } catch { /* page gone */ }
    try { await current.cdp.detach() } catch { /* already detached */ }
  }

  async function startScreencast(id) {
    const s = sessions.get(id)
    if (!s?.page) return false
    await stopScreencast()
    let cdp
    try { cdp = await s.page.context().newCDPSession(s.page) } catch { return false }
    const mine = { id, cdp }
    screencast = mine
    cdp.on('Page.screencastFrame', async frame => {
      if (screencast !== mine) return
      const now = Date.now()
      if (now - lastSentAt >= 1000 / fps) {
        lastSentAt = now
        state.frames++
        lastFrame = { sessionId: id, data: frame.data, width: frame.metadata?.deviceWidth, height: frame.metadata?.deviceHeight, at: new Date(now).toISOString(), step: s.step, path: s.path }
        broadcast('frame', lastFrame)
      }
      try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }) } catch { /* detached */ }
    })
    try { await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight: Math.round(maxWidth * 900 / 1440), everyNthFrame: 1 }) } catch { screencast = null; return false }
    return true
  }

  const hub = {
    fps, quality, maxWidth,
    get spotlight() { return state.spotlight },
    snapshot,
    register(id, meta, page) {
      const s = { id, ...meta, page, startedAt: new Date().toISOString(), step: 0, action: 'visiting', target: null, reason: '방문 시작', path: '/', sentiment: 50, engagement: 0, history: [] }
      sessions.set(id, s)
      if (meta.round) state.round = meta.round
      const first = !state.spotlight
      if (first) state.spotlight = id
      broadcast('state', snapshot())
      if (first) startScreencast(id).then(() => broadcast('state', snapshot())).catch(() => {})
    },
    update(id, step) {
      const s = sessions.get(id)
      if (!s) return
      Object.assign(s, { step: step.step, action: step.action, target: step.target || null, reason: step.reason || '', path: step.path || s.path, sentiment: step.sentiment ?? s.sentiment, engagement: step.engagement ?? s.engagement })
      s.history.push({ step: step.step, action: step.action, target: step.target || null, path: step.path || '', reason: (step.reason || '').slice(0, 160), sentiment: s.sentiment, converted: !!step.converted, goalReached: !!step.goalReached, at: new Date().toISOString() })
      if (s.history.length > 40) s.history.shift()
      broadcast('step', { sessionId: id, ...publicSession(s) })
    },
    unregister(id, summary) {
      const s = sessions.get(id)
      if (!s) return
      sessions.delete(id)
      broadcast('done', { sessionId: id, persona: s.persona, variantKey: s.variantKey, summary })
      if (state.spotlight === id) {
        state.spotlight = null
        const next = sessions.keys().next().value
        if (next) hub.setSpotlight(next).catch(() => {}); else { stopScreencast().catch(() => {}); broadcast('state', snapshot()) }
      } else broadcast('state', snapshot())
    },
    async setSpotlight(id) {
      if (!sessions.has(id)) return false
      state.spotlight = id
      const ok = await startScreencast(id)
      broadcast('state', snapshot())
      return ok
    },
    subscribe(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      res.write(': live\n\n')
      subscribers.add(res)
      send(res, 'state', snapshot())
      if (lastFrame) send(res, 'frame', lastFrame)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 15000)
      res.on('close', () => { clearInterval(ping); subscribers.delete(res) })
    },
    async close() {
      state.running = false
      state.endedAt = new Date().toISOString()
      await stopScreencast()
      sessions.clear()
      broadcast('end', snapshot())
      for (const res of subscribers) { try { res.end() } catch { /* closed */ } }
      subscribers.clear()
    }
  }
  return hub
}

// Used when no simulation is running: one state event, then the stream ends.
export function writeIdleStream(res, snapshot) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
  res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`)
  res.write(`event: end\ndata: ${JSON.stringify(snapshot)}\n\n`)
  res.end()
}
