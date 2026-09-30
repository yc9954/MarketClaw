// Mirror: serves the captured site from the run's HAR, same-origin with the UI, so the mirror editor
// can load it in an iframe and touch its DOM directly. Scripts, inline handlers and <noscript>
// pixels are stripped, every URL is rewritten to the mirror, and a strict CSP blocks whatever the
// HAR does not contain (trackers, foreign scripts, live network).
import path from 'node:path'
import { loadHarIndex } from './har.js'

const cache = new Map()
const MAX_CACHED = 8

export async function loadMirror(run, runDir) {
  const key = run.id
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const index = await loadHarIndex(path.join(runDir, 'capture.har.zip'))
  const origin = new URL(run.url).origin
  const pages = (run.report?.pages || []).filter(p => !p.error).map(p => { try { const u = new URL(p.url); return u.origin === origin ? { path: u.pathname + u.search, title: p.title || '' } : null } catch { return null } }).filter(Boolean)
  const mirror = { runId: run.id, origin, entry: run.url, index, pages }
  cache.set(key, mirror)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
  return mirror
}

export function invalidateMirror(runId) { cache.delete(runId) }

// Resolves a URL the page refers to into a mirror path: same-origin → base + path,
// foreign but recorded → base + __ext/<encoded url>, otherwise unchanged (the CSP will block it).
export function mirrorUrl(raw, { base, origin, index, pageUrl }) {
  const value = String(raw || '').trim()
  if (!value || /^(data:|blob:|#|mailto:|tel:|about:)/i.test(value)) return value
  if (/^javascript:/i.test(value)) return '#'
  let abs
  try { abs = new URL(value, pageUrl || origin); abs.hash = '' } catch { return value }
  if (!/^https?:$/.test(abs.protocol)) return value
  if (abs.origin === origin) return base + abs.pathname.replace(/^\//, '') + abs.search
  if (index.has(abs.href)) return base + '__ext/' + encodeURIComponent(abs.href)
  return value
}

export function rewriteCss(css, ctx) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, q, u) => `url(${q}${mirrorUrl(u, ctx)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, u) => `@import ${q}${mirrorUrl(u, ctx)}${q}`)
}

function rewriteSrcset(value, ctx) {
  return String(value).split(',').map(part => { const [u, ...rest] = part.trim().split(/\s+/); return [mirrorUrl(u, ctx), ...rest].join(' ') }).join(', ')
}

export function rewriteHtml(html, ctx) {
  let out = String(html)
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '')
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
  out = out.replace(/<base\b[^>]*>/gi, '')
  out = out.replace(/<link\b[^>]*rel=["']?(preload|prefetch|modulepreload|dns-prefetch|preconnect)["']?[^>]*>/gi, '')
  out = out.replace(/<(?:iframe|embed|object)\b[^>]*>[\s\S]*?<\/(?:iframe|embed|object)\s*>/gi, '').replace(/<(?:iframe|embed)\b[^>]*\/?>/gi, '')
  // attributes: drop inline handlers, rewrite URLs, rewrite url() inside style=""
  out = out.replace(/<([a-zA-Z][\w:-]*)(\s[^>]*)?>/g, (tag, name, attrs) => {
    if (!attrs) return tag
    let a = attrs.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    a = a.replace(/(\s)(href|src|srcset|poster|action|data-src|data-srcset|xlink:href)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, sp, attr, eq, quoted, dq, sq, bare) => {
      const value = dq ?? sq ?? bare ?? ''
      const key = attr.toLowerCase()
      const next = key.endsWith('srcset') ? rewriteSrcset(value, ctx) : key === 'action' ? '#' : mirrorUrl(value, ctx)
      const q = dq != null ? '"' : sq != null ? "'" : '"'
      return `${sp}${attr}${eq}${q}${next.replace(/"/g, '&quot;')}${q}`
    })
    a = a.replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, pre, quoted, dq, sq) => { const v = dq ?? sq ?? ''; const q = dq != null ? '"' : "'"; return `${pre}${q}${rewriteCss(v, ctx)}${q}` })
    return `<${name}${a}>`
  })
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (m, attrs, css) => `<style${attrs}>${rewriteCss(css, ctx)}</style>`)
  const head = `<base href="${ctx.base}"><meta name="referrer" content="no-referrer">`
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head([^>]*)>/i, `<head$1>${head}`) : head + out
  return out
}

export function placeholder(requestedPath) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>[MIRROR] 기록되지 않은 페이지</title><style>body{margin:0;padding:48px;font-family:system-ui,sans-serif;background:#f8f8f8;color:#212121;text-align:center}h1{font-size:20px}code{background:#eee;padding:2px 8px}</style></head><body data-mc-placeholder="1"><h1>이 페이지는 캡처에 기록되지 않았습니다</h1><p>요청 경로: <code>${esc(requestedPath)}</code></p><p>미러는 저장된 HAR만 사용합니다.</p></body></html>`
}

function lookup(index, url, hops = 0) {
  let entry = index.get(url)
  if (!entry) { try { const u = new URL(url); if (u.pathname.endsWith('/')) entry = index.get(u.href.replace(/\/(\?|$)/, '$1')); else { u.pathname += '/'; entry = index.get(u.href) } } catch { /* ignore */ } }
  if (entry?.redirect && hops < 3) { try { return lookup(index, new URL(entry.redirect, url).href, hops + 1) } catch { return entry } }
  return entry
}

export const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'self'"

// Express handler for GET /api/runs/:id/mirror/*. `rest` is the path after /mirror/.
export function serveMirror(mirror, rest, query, res) {
  const base = `/api/runs/${mirror.runId}/mirror/`
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  let target
  if (rest.startsWith('__ext/')) { try { target = decodeURIComponent(rest.slice(6)) } catch { return res.sendStatus(404) } }
  else target = mirror.origin + '/' + rest + (query ? '?' + query : '')
  const entry = lookup(mirror.index, target)
  const wantsDocument = !rest.startsWith('__ext/') && (!/\.[a-z0-9]{2,5}$/i.test(rest) || /\.html?$/i.test(rest))
  if (!entry) {
    if (wantsDocument) return res.status(200).type('html').send(placeholder('/' + rest))
    return res.sendStatus(404)
  }
  const ctx = { base, origin: mirror.origin, index: mirror.index, pageUrl: entry.url }
  const mime = entry.mimeType.split(';')[0].trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return res.status(200).type('html').send(rewriteHtml(entry.body.toString('utf8'), ctx))
  if (mime === 'text/css') return res.status(200).type('css').send(rewriteCss(entry.body.toString('utf8'), ctx))
  if (/javascript|ecmascript/.test(mime)) return res.sendStatus(404)
  res.status(200).setHeader('Content-Type', entry.mimeType)
  return res.send(entry.body)
}
