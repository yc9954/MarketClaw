// Aggregation over simulated sessions: weighted CVR/bounce, engagement, steps, time-to-convert,
// drop-off map, Fisher's exact test against control with relative lift, per-segment breakdown,
// and a small peer-propagation model that estimates a K-factor per variant.
import { seededRandom } from './random.js'

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0
const median = list => { if (!list.length) return 0; const s = list.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

// Two-sided Fisher's exact test for the 2×2 table [[a, b], [c, d]] using the
// probability method (sum of all tables with probability ≤ the observed one).
export function fisherExact(a, b, c, d) {
  const logFact = n => { let r = 0; for (let i = 2; i <= n; i++) r += Math.log(i); return r }
  const K = a + c, n1 = a + b, n2 = c + d, N = n1 + n2
  if (!N) return 1
  const logP = k => logFact(K) + logFact(N - K) + logFact(n1) + logFact(n2) - logFact(k) - logFact(K - k) - logFact(n1 - k) - logFact(n2 - (K - k)) - logFact(N)
  const observed = logP(a)
  let p = 0
  for (let k = Math.max(0, K - n2); k <= Math.min(K, n1); k++) { const lp = logP(k); if (lp <= observed + 1e-9) p += Math.exp(lp) }
  return Math.min(1, p)
}

export function weightedRate(sessions, predicate) {
  const total = sessions.reduce((sum, s) => sum + (s.persona.weight || 1), 0)
  if (!total) return 0
  return round(sessions.reduce((sum, s) => sum + (predicate(s) ? s.persona.weight || 1 : 0), 0) / total * 100)
}

export function buildDropoffMap(sessions) {
  const map = new Map()
  for (const s of sessions) {
    for (const v of s.memory?.visited || []) {
      const row = map.get(v.path) || { path: v.path, title: v.title || '', visits: 0, bounces: 0, converts: 0, exits: 0 }
      row.visits++
      if (s.summary.bounced) row.bounces++
      if (s.summary.converted) row.converts++
      map.set(v.path, row)
    }
    const last = s.memory?.visited?.at(-1)
    if (last) map.get(last.path).exits++
  }
  return [...map.values()].map(r => ({ ...r, bounceRate: round(r.visits ? r.bounces / r.visits * 100 : 0, 1), convertRate: round(r.visits ? r.converts / r.visits * 100 : 0, 1), exitRate: round(r.visits ? r.exits / r.visits * 100 : 0, 1) })).sort((a, b) => b.visits - a.visits)
}

export function aggregateByVariant(sessions, variants) {
  const out = {}
  for (const v of variants) {
    const mine = sessions.filter(s => s.variantKey === v.key)
    const converted = mine.filter(s => s.summary.converted)
    const w = mine.reduce((sum, s) => sum + (s.persona.weight || 1), 0) || 1
    const bySegment = {}
    for (const s of mine) {
      const seg = bySegment[s.persona.segment] || { segment: s.persona.segment, label: s.persona.name, n: 0, converts: 0, bounces: 0, wSum: 0, wConverts: 0 }
      seg.n++; seg.wSum += s.persona.weight || 1
      if (s.summary.converted) { seg.converts++; seg.wConverts += s.persona.weight || 1 }
      if (s.summary.bounced) seg.bounces++
      bySegment[s.persona.segment] = seg
    }
    for (const seg of Object.values(bySegment)) seg.cvr = round(seg.wSum ? seg.wConverts / seg.wSum * 100 : 0, 1)
    const actions = {}
    for (const s of mine) for (const [k, n] of Object.entries(s.summary.actionBreakdown || {})) actions[k] = (actions[k] || 0) + n
    const ttc = converted.map(s => s.summary.timeToConvertMs).filter(v => v > 0)
    out[v.key] = {
      key: v.key, name: v.name, color: v.color, n: mine.length, converts: converted.length, bounces: mine.filter(s => s.summary.bounced).length, goalReached: mine.filter(s => s.summary.goalReached).length,
      cvr: weightedRate(mine, s => s.summary.converted), bounceRate: weightedRate(mine, s => s.summary.bounced), goalRate: weightedRate(mine, s => s.summary.goalReached),
      avgEngagement: round(mine.reduce((sum, s) => sum + (s.summary.engagementScore || 0) * (s.persona.weight || 1), 0) / w, 1),
      avgSentiment: round(mine.reduce((sum, s) => sum + (s.summary.finalSentiment || 0) * (s.persona.weight || 1), 0) / w, 1),
      avgSteps: round(mean(mine.map(s => s.summary.totalSteps)), 1), medianSteps: median(mine.map(s => s.summary.totalSteps)),
      avgPages: round(mean(mine.map(s => s.summary.pagesVisited)), 1),
      avgTtcSec: ttc.length ? round(mean(ttc) / 1000, 1) : null, medianTtcSec: ttc.length ? round(median(ttc) / 1000, 1) : null,
      conversionTypes: converted.reduce((acc, s) => { acc[s.summary.conversionType] = (acc[s.summary.conversionType] || 0) + 1; return acc }, {}),
      actions, bySegment
    }
  }
  return out
}

export function compareVariants(byVariant) {
  const control = byVariant.control
  if (!control) return []
  return Object.values(byVariant).filter(v => v.key !== 'control').map(v => {
    const pValue = fisherExact(control.converts, control.n - control.converts, v.converts, v.n - v.converts)
    const lift = control.cvr > 0 ? round((v.cvr - control.cvr) / control.cvr * 100, 1) : v.cvr > 0 ? null : 0
    const engagementLift = control.avgEngagement > 0 ? round((v.avgEngagement - control.avgEngagement) / control.avgEngagement * 100, 1) : null
    return { key: v.key, name: v.name, cvrLift: lift, engagementLift, pValue: round(pValue, 4), significant: pValue < 0.05, winner: pValue < 0.05 ? (v.cvr > control.cvr ? 'variant' : 'control') : 'no_diff', controlCvr: control.cvr, variantCvr: v.cvr, controlN: control.n, variantN: v.n }
  })
}

// Peer propagation: each persona has peers (mostly its own segment); a converted or engaged session
// raises the peers' visit probability, a bounce lowers it. Over a few rounds this yields a K-factor
// per variant. It is a toy word-of-mouth model, useful only to compare variants with each other.
export function simulatePropagation(sessions, variants, { rounds = 3, seed = 1 } = {}) {
  const personas = [...new Map(sessions.map(s => [s.persona.id, s.persona])).values()]
  if (personas.length < 2) return null
  const bySegment = {}
  for (const p of personas) (bySegment[p.segment] ||= []).push(p)
  const totalWeight = personas.reduce((sum, p) => sum + (p.weight || 1), 0)
  const baseProb = {}
  for (const [seg, list] of Object.entries(bySegment)) baseProb[seg] = Math.min(0.35, Math.max(0.05, list.reduce((sum, p) => sum + (p.weight || 1), 0) / totalWeight * 1.5))
  const rngNet = seededRandom(`${seed}:network`)
  const peers = {}
  for (const p of personas) {
    const same = rngNet.shuffle(bySegment[p.segment].filter(o => o.id !== p.id)).slice(0, 5).map(o => ({ id: o.id, affinity: 1 }))
    const others = rngNet.shuffle(personas.filter(o => o.segment !== p.segment)).slice(0, 2).map(o => ({ id: o.id, affinity: 0.3 }))
    peers[p.id] = [...same, ...others]
  }
  const results = {}
  for (const v of variants) {
    const sessionOf = Object.fromEntries(sessions.filter(s => s.variantKey === v.key).map(s => [s.persona.id, s]))
    const rng = seededRandom(`${seed}:${v.key}`)
    const prob = Object.fromEntries(personas.map(p => [p.id, baseProb[p.segment]]))
    const roundsOut = []
    const cumulative = new Set()
    for (let r = 1; r <= rounds; r++) {
      const visitors = personas.filter(p => rng() < prob[p.id])
      const converters = []
      let wConv = 0, wTotal = 0
      for (const p of visitors) {
        const s = sessionOf[p.id]
        if (!s) continue
        wTotal += p.weight || 1
        if (s.summary.converted) { converters.push(p.id); cumulative.add(p.id); wConv += p.weight || 1 }
        for (const peer of peers[p.id]) {
          let delta = 0
          if (s.summary.converted) delta += 0.35 * peer.affinity
          else if (s.summary.bounced) delta -= 0.05 * peer.affinity
          else if (s.summary.engagementScore > 60) delta += 0.12 * peer.affinity
          if (s.summary.intentSignals?.some(i => i.signal === 'share_intent')) delta += 0.18 * peer.affinity
          prob[peer.id] = Math.max(0.01, Math.min(0.99, prob[peer.id] + delta))
        }
      }
      let referred = 0, referredConverts = 0
      for (const id of converters) for (const peer of peers[id]) {
        const pSeg = personas.find(p => p.id === peer.id)?.segment
        if (prob[peer.id] > baseProb[pSeg] + 0.05) { referred++; if (sessionOf[peer.id]?.summary.converted) referredConverts++ }
      }
      const kFactor = converters.length && referred ? round(referred / converters.length * (referredConverts / referred), 3) : 0
      roundsOut.push({ round: r, visitors: visitors.length, converters: converters.length, weightedCvr: round(wTotal ? wConv / wTotal * 100 : 0), kFactor, cumulativeConverters: cumulative.size })
    }
    const segDelta = Object.fromEntries(Object.entries(bySegment).map(([seg, list]) => [seg, round(mean(list.map(p => prob[p.id] - baseProb[seg])) * 100, 1)]))
    results[v.key] = { key: v.key, name: v.name, rounds: roundsOut, kFactor: roundsOut.at(-1)?.kFactor ?? 0, avgKFactor: round(mean(roundsOut.map(r => r.kFactor)), 3), segmentVisitDeltaPct: segDelta }
  }
  return { rounds, results }
}

export function buildReport(sessions, variants, { seed = 1 } = {}) {
  const byVariant = aggregateByVariant(sessions, variants)
  const list = Object.values(byVariant)
  const best = list.slice().sort((a, b) => b.cvr - a.cvr || b.avgEngagement - a.avgEngagement)[0] || null
  const segments = {}
  for (const v of list) for (const seg of Object.values(v.bySegment)) {
    const row = segments[seg.segment] || { segment: seg.segment, label: seg.label, n: 0, byVariant: {} }
    row.n += seg.n
    row.byVariant[v.key] = { n: seg.n, converts: seg.converts, cvr: seg.cvr }
    segments[seg.segment] = row
  }
  return {
    generatedAt: new Date().toISOString(),
    totalSessions: sessions.length,
    converted: sessions.filter(s => s.summary.converted).length,
    bounced: sessions.filter(s => s.summary.bounced).length,
    bestVariant: best ? { key: best.key, name: best.name, cvr: best.cvr } : null,
    variants: byVariant,
    comparisons: compareVariants(byVariant),
    dropoffMap: buildDropoffMap(sessions),
    segments: Object.values(segments).sort((a, b) => b.n - a.n),
    propagation: simulatePropagation(sessions, variants, { seed })
  }
}
