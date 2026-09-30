import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seededRandom } from './random.js'

const defaultPoolPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/personas.json')
const cache = new Map() // file → { mtimeMs, pool }; generated pools are rewritten in place, so the mtime is checked

function normalizePersona(p, index) {
  const goals = p.goals || {}
  return {
    id: String(p.id || `persona_${index + 1}`),
    segment: String(p.segment || 'general'),
    name: String(p.name || p.segment || '방문자'),
    persona_name: String(p.persona_name || ''),
    description: String(p.description || ''),
    weight: Number(p.weight) > 0 ? Number(p.weight) : 1,
    demographics: p.demographics || {},
    traits: {
      patience: 0.5, visualSensitivity: 0.5, copyImportance: 0.5, ctaResponse: 0.5, priceConsciousness: 0.5, socialProofSensitivity: 0.5,
      ...(p.traits || {})
    },
    goals: {
      conversion: String(goals.conversion || p.conversionGoal || ''),
      interests: (goals.interests || p.interestKeywords || []).map(String),
      avoid: (goals.avoid || p.avoidKeywords || []).map(String)
    },
    ...(p.archetype ? { archetype: String(p.archetype) } : {}),
    ...(p.priors ? { priors: p.priors } : {})
  }
}

export function poolPath() { return process.env.PERSONA_POOL_PATH || defaultPoolPath }

export function loadPool(file = poolPath()) {
  const mtimeMs = fs.statSync(file).mtimeMs
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.pool
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.personas) ? raw.personas : Object.values(raw)
  const personas = list.map(normalizePersona)
  if (!personas.length) throw new Error(`페르소나 풀이 비어 있습니다: ${file}`)
  const labels = new Map((raw.segments || []).map(s => [s.id, s.label]))
  const bySegment = new Map()
  for (const p of personas) {
    const seg = bySegment.get(p.segment) || { id: p.segment, label: labels.get(p.segment) || p.name, weight: 0, count: 0 }
    seg.weight += p.weight
    seg.count += 1
    bySegment.set(p.segment, seg)
  }
  const totalWeight = personas.reduce((sum, p) => sum + p.weight, 0)
  const segments = [...bySegment.values()].map(s => ({ ...s, weight: +s.weight.toFixed(3), share: +(s.weight / totalWeight).toFixed(4) })).sort((a, b) => b.weight - a.weight)
  const pool = { source: raw.source || '', file, segments, personas, totalWeight, generated: !!raw.archetypes, generatedAt: raw.generatedAt || null }
  cache.set(file, { mtimeMs, pool })
  return pool
}

export function poolSummary(file) {
  const pool = loadPool(file)
  const rng = seededRandom('pool-preview')
  const sample = rng.shuffle(pool.personas).slice(0, 6).map(p => publicPersona(p))
  return { source: pool.source, total: pool.personas.length, segments: pool.segments, sample }
}

export function publicPersona(p) {
  return { id: p.id, segment: p.segment, name: p.name, persona_name: p.persona_name, description: p.description, weight: p.weight, demographics: { age: p.demographics.age, sex: p.demographics.sex, occupation: p.demographics.occupation, province: p.demographics.province }, goals: p.goals, traits: p.traits }
}

// Deterministic weighted sampling without replacement: the count is split across the chosen segments
// in proportion to their weight (largest remainder), then personas are drawn inside each segment
// with a seeded shuffle. The same { count, segments, seed } always yields the same population.
export function sample({ count = 20, segments = [], seed = 1, file } = {}) {
  const pool = loadPool(file)
  const wanted = new Set((segments || []).filter(s => pool.segments.some(seg => seg.id === s)))
  const chosen = pool.segments.filter(seg => !wanted.size || wanted.has(seg.id))
  const available = chosen.reduce((sum, seg) => sum + seg.count, 0)
  const target = Math.max(0, Math.min(Number(count) || 0, available))
  const totalWeight = chosen.reduce((sum, seg) => sum + seg.weight, 0)
  const alloc = chosen.map(seg => { const exact = target * seg.weight / totalWeight; return { seg, n: Math.min(seg.count, Math.floor(exact)), frac: exact - Math.floor(exact) } })
  let remaining = target - alloc.reduce((sum, a) => sum + a.n, 0)
  const byRemainder = alloc.slice().sort((x, y) => y.frac - x.frac || y.seg.weight - x.seg.weight)
  while (remaining > 0) {
    let placed = false
    for (const a of byRemainder) { if (remaining > 0 && a.n < a.seg.count) { a.n++; remaining--; placed = true } }
    if (!placed) break
  }
  const out = []
  for (const { seg, n } of alloc) {
    if (!n) continue
    const rng = seededRandom(`${seed}:${seg.id}`)
    const members = pool.personas.filter(p => p.segment === seg.id).sort((a, b) => a.id.localeCompare(b.id))
    out.push(...rng.shuffle(members).slice(0, n))
  }
  return out
}
