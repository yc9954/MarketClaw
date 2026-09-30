// Multi-round feedback loop, ported from the prototype's integrated_engine.js + social_propagation.js:
//   round r  →  browser sessions for the current visitor set
//            →  each outcome updates its peers' visit probability (Bayesian-style additive update:
//               conversion +0.35, high engagement +0.12, bounce −0.05, share intent +0.18, × segment
//               affinity × hub factor for heavier personas)
//            →  round r+1 visitors are drawn from the updated probabilities
// Per round and variant: weighted CVR, visit probability per segment, K-factor
// (K = referred peers per converter × conversion rate among referred peers).
import { seededRandom } from './random.js'

export const SIGNALS = { strong: 0.35, weak: 0.12, negative: -0.05, share: 0.18 }
export const PROB_RANGE = [0.01, 0.99]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d
const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0

// Segment-to-segment information flow for the bundled pool; other segments use 1 (same) / 0.3 (other).
export const SEGMENT_AFFINITY = {
  brand_marketer_large: { brand_marketer_startup: 0.5, md_manager: 0.4, popup_enthusiast: 0.2 },
  brand_marketer_startup: { brand_marketer_large: 0.4, popup_enthusiast: 0.3, retail_trend_watcher: 0.2 },
  building_owner: { retail_tenant: 0.5, md_manager: 0.3 },
  retail_tenant: { building_owner: 0.4, franchise_explorer: 0.4, md_manager: 0.3 },
  md_manager: { building_owner: 0.3, retail_tenant: 0.4, brand_marketer_large: 0.3 },
  popup_enthusiast: { kpop_fan: 0.6, brand_marketer_startup: 0.2 },
  kpop_fan: { popup_enthusiast: 0.5 },
  retail_trend_watcher: { brand_marketer_startup: 0.3, franchise_explorer: 0.3 },
  franchise_explorer: { retail_tenant: 0.4, retail_trend_watcher: 0.3 },
  jobseeker: {}
}
export function affinity(fromSegment, toSegment) {
  if (fromSegment === toSegment) return 1
  const row = SEGMENT_AFFINITY[fromSegment]
  return row ? (row[toSegment] ?? 0.1) : 0.3
}

// Base visit probability per segment from its share of the population weight (5–35%).
export function baseVisitProb(personas) {
  const total = personas.reduce((s, p) => s + (p.weight || 1), 0) || 1
  const bySegment = {}
  for (const p of personas) bySegment[p.segment] = (bySegment[p.segment] || 0) + (p.weight || 1)
  return Object.fromEntries(Object.entries(bySegment).map(([seg, w]) => [seg, round(clamp(w / total * 1.5, 0.05, 0.35))]))
}

// Heavier personas (hubs) carry more influence: 0.5–1.5 × relative to the mean weight.
export function hubFactor(persona, meanWeight) { return clamp((persona.weight || 1) / (meanWeight || 1), 0.5, 1.5) }

// Peers: up to maxPeers personas ranked by weight × affinity, seeded tie-breaking.
export function buildPeerNetwork(personas, { seed = 1, maxPeers = 5 } = {}) {
  const rng = seededRandom(`${seed}:network`)
  const network = {}
  for (const p of personas) {
    const scored = personas.filter(o => o.id !== p.id).map(o => ({ id: o.id, affinity: affinity(p.segment, o.segment), score: (o.weight || 1) * affinity(p.segment, o.segment) + rng() * 0.01 })).filter(o => o.affinity > 0.15)
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    network[p.id] = scored.slice(0, maxPeers).map(({ id, affinity: a }) => ({ id, affinity: a }))
  }
  return network
}

export function outcomeOf(session) {
  const s = session?.summary || session || {}
  return { converted: !!s.converted, bounced: !!s.bounced, engaged: (s.engagementScore || 0) > 60, shared: (s.intentSignals || []).some(i => (i.signal || i) === 'share_intent'), weight: session?.persona?.weight ?? s.weight ?? 1 }
}

export function updateVisitProb(prob, outcome, aff, hub = 1) {
  let delta = 0
  if (outcome.converted) delta += SIGNALS.strong * aff * hub
  else if (outcome.bounced) delta += SIGNALS.negative * aff
  else if (outcome.engaged) delta += SIGNALS.weak * aff
  if (outcome.shared) delta += SIGNALS.share * aff
  return clamp(prob + delta, PROB_RANGE[0], PROB_RANGE[1])
}

// K = referred peers per converter × conversion rate among referred peers, where a peer counts as
// referred when its visit probability rose more than 0.05 above its segment base.
export function computeKFactor(converters, probs, base, network, segmentOf, outcomes) {
  if (!converters.length) return 0
  let referred = 0, referredConverts = 0
  for (const id of converters) for (const peer of network[id] || []) {
    if ((probs[peer.id] ?? 0) > (base[segmentOf[peer.id]] ?? 0.1) + 0.05) { referred++; if (outcomes[peer.id]?.converted) referredConverts++ }
  }
  if (!referred) return 0
  return round((referred / converters.length) * (referredConverts / referred), 3)
}

export function snapshotSegments(probs, personas) {
  const acc = {}
  for (const p of personas) { (acc[p.segment] ||= []).push(probs[p.id]) }
  return Object.fromEntries(Object.entries(acc).map(([seg, list]) => [seg, round(mean(list))]))
}

// Draws `count` distinct visitors weighted by their current visit probability.
export function sampleVisitors(personas, probs, count, rng) {
  const pool = personas.map(p => ({ p, w: probs[p.id] ?? 0.1 }))
  const out = []
  while (out.length < Math.min(count, personas.length) && pool.length) {
    const pick = rng.weighted(pool.map(x => ({ ...x, weight: x.w })))
    out.push(pick.p)
    pool.splice(pool.findIndex(x => x.p.id === pick.p.id), 1)
  }
  return out
}

// Orchestrates the rounds for every variant. `runSessions(tasks)` receives the first-time
// persona × variant visits of a round ([{ key, persona, variant, round }]) and returns a Map
// key → session (with summary and persona.weight); it may run them in parallel. Sessions are cached
// per persona × variant so a repeat visitor reuses its own outcome (the heuristic policy is seeded per
// persona × variant anyway). Round 1 exposes the whole population; later rounds draw
// `visitorsPerRound` personas weighted by the updated visit probabilities.
export async function runFeedbackLoop({ personas, variants, rounds = 1, visitorsPerRound, seed = 1, runSessions, onRound = () => {} }) {
  const network = buildPeerNetwork(personas, { seed })
  const base = baseVisitProb(personas)
  const segmentOf = Object.fromEntries(personas.map(p => [p.id, p.segment]))
  const meanWeight = mean(personas.map(p => p.weight || 1))
  const perRound = Math.max(1, Math.min(personas.length, visitorsPerRound || personas.length))
  const cache = new Map()
  const roundsOut = []
  const finalProbs = {}
  const rows = variants.map(v => ({ variant: v, probs: Object.fromEntries(personas.map(p => [p.id, base[p.segment]])), outcomes: {}, rng: seededRandom(`${seed}:loop:${v.key}`), cumulative: new Set() }))
  for (let r = 1; r <= rounds; r++) {
    const entry = { round: r, n: {}, converters: {}, cumulativeConverters: {}, newSessions: {}, cvrByVariant: {}, bounceByVariant: {}, kFactor: {}, visitProbBySegment: {} }
    const visitorsOf = new Map(rows.map(row => [row.variant.key, r === 1 ? personas.slice() : sampleVisitors(personas, row.probs, perRound, row.rng)]))
    const tasks = []
    for (const row of rows) for (const persona of visitorsOf.get(row.variant.key)) { const key = `${persona.id}__${row.variant.key}`; if (!cache.has(key) && !tasks.some(t => t.key === key)) tasks.push({ key, persona, variant: row.variant, round: r }) }
    const results = tasks.length ? await runSessions(tasks) : new Map()
    for (const task of tasks) { const session = results.get(task.key); if (session) cache.set(task.key, session) }
    for (const row of rows) {
      const v = row.variant
      const visitors = visitorsOf.get(v.key)
      let wConv = 0, wTotal = 0, bounced = 0
      const fresh = tasks.filter(t => t.variant.key === v.key && results.get(t.key)).length
      const converters = []
      for (const persona of visitors) {
        const session = cache.get(`${persona.id}__${v.key}`)
        if (!session) continue
        const outcome = outcomeOf(session)
        row.outcomes[persona.id] = outcome
        const w = persona.weight || 1
        wTotal += w
        if (outcome.converted) { wConv += w; converters.push(persona.id); row.cumulative.add(persona.id) }
        if (outcome.bounced) bounced++
        const hub = hubFactor(persona, meanWeight)
        for (const peer of network[persona.id] || []) row.probs[peer.id] = updateVisitProb(row.probs[peer.id], outcome, peer.affinity, hub)
      }
      entry.n[v.key] = visitors.length
      entry.newSessions[v.key] = fresh
      entry.converters[v.key] = converters.length
      entry.cumulativeConverters[v.key] = row.cumulative.size
      entry.cvrByVariant[v.key] = round(wTotal ? wConv / wTotal * 100 : 0, 2)
      entry.bounceByVariant[v.key] = round(visitors.length ? bounced / visitors.length * 100 : 0, 2)
      entry.kFactor[v.key] = computeKFactor(converters, row.probs, base, network, segmentOf, row.outcomes)
      entry.visitProbBySegment[v.key] = snapshotSegments(row.probs, personas)
    }
    roundsOut.push(entry)
    onRound(entry)
  }
  for (const row of rows) finalProbs[row.variant.key] = row.probs
  const segmentDelta = Object.fromEntries(rows.map(row => [row.variant.key, Object.fromEntries(Object.entries(snapshotSegments(row.probs, personas)).map(([seg, p]) => [seg, round((p - base[seg]) / base[seg] * 100, 1)]))]))
  return { rounds: roundsOut, baseVisitProb: base, segmentDeltaPct: segmentDelta, peerStats: { avgPeers: round(mean(Object.values(network).map(l => l.length)), 1) }, sessions: [...cache.values()] }
}
