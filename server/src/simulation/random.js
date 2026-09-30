// Small deterministic PRNG so that persona sampling and the heuristic policy
// are reproducible from a seed (needed for tests and for comparing variants fairly).

export function hashSeed(...parts) {
  // FNV-1a over the joined string
  let h = 0x811c9dc5
  const text = parts.map(p => String(p)).join('|')
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

export function seededRandom(seed) {
  // mulberry32
  let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  next.int = max => Math.floor(next() * max)
  next.pick = list => list[Math.floor(next() * list.length)]
  next.shuffle = list => { const out = list.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] } return out }
  next.weighted = items => {
    // items: [{ weight, ... }] → one item, proportional to weight
    const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
    if (!(total > 0)) return items[0]
    let r = next() * total
    for (const item of items) { r -= Math.max(0, item.weight); if (r <= 0) return item }
    return items[items.length - 1]
  }
  return next
}
