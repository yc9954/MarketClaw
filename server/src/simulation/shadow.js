// The shadow environment: a browser context that serves the target site from the run's own HAR.
// Nothing leaves the machine. Requests that are not in the HAR are answered locally:
// tracker hosts and foreign origins are aborted, POST/PUT/PATCH to the target origin get a mock
// JSON reply, unrecorded documents get a placeholder page, other unrecorded assets are aborted.
import { trackerHosts } from '../browser.js'

export const SHADOW_TITLE = '[SHADOW] 기록되지 않은 페이지'

export function placeholderHtml(requestedUrl, origin) {
  let pathname = '/'
  try { pathname = new URL(requestedUrl).pathname } catch { /* keep default */ }
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${SHADOW_TITLE}</title>
<style>body{margin:0;padding:48px;font-family:system-ui,sans-serif;background:#f8f8f8;color:#212121;text-align:center}h1{font-size:20px}code{background:#eee;padding:2px 8px}a{color:#0f43f3}</style></head>
<body data-mc-placeholder="1"><h1>이 페이지는 캡처에 기록되지 않았습니다</h1><p>요청 경로: <code>${esc(pathname)}</code></p><p>시뮬레이션은 저장된 HAR만 사용하며 실제 사이트에 접속하지 않습니다.</p><a href="${esc(origin)}/">← 첫 페이지로</a></body></html>`
}

// Runs in every page before any site script: intercept analytics calls and record clicks/submits.
function shadowInitScript() {
  window.__SHADOW_MODE__ = true
  window.__shadowEvents = []
  const record = (type, data) => window.__shadowEvents.push({ ts: Date.now(), type, ...data })
  Object.defineProperty(window, 'dataLayer', {
    configurable: true,
    get() { return this.__dl || (this.__dl = []) },
    set(v) {
      this.__dl = Array.isArray(v) ? v : []
      const push = this.__dl.push.bind(this.__dl)
      this.__dl.push = (...args) => { record('dataLayer', { data: args }); return push(...args) }
    }
  })
  window.dataLayer = window.dataLayer || []
  window.gtag = (...args) => record('gtag', { data: args })
  window.fbq = (...args) => record('fbq', { data: args })
  window.fbq.queue = []; window.fbq.loaded = true; window.fbq.version = '2.0'
  document.addEventListener('click', e => {
    const t = e.target.closest('a,button,[role="button"],input[type="submit"]')
    if (!t) return
    record('click', { text: (t.textContent || t.value || '').trim().slice(0, 60), href: t.getAttribute('href') || null, inForm: !!t.closest('form') })
  }, true)
  document.addEventListener('submit', e => { e.preventDefault(); record('submit', { action: e.target.getAttribute('action') || '' }) }, true)
}

export async function createShadowContext(browser, { harPath, origin }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', javaScriptEnabled: true })
  const stats = { blocked: 0, mocked: 0, placeholders: 0, aborted: 0 }
  const isBlocked = url => trackerHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) || url.origin !== origin
  // Handlers run last-registered-first. Order of consultation for a request:
  //   1. blocker: tracker hosts and foreign origins are aborted before the HAR router sees them
  //      (the HAR router leaves requests it recorded as failed hanging, which would stall `load`)
  //   2. routeFromHAR: everything the capture recorded for the target origin
  //   3. catch-all: target-origin requests missing from the HAR never reach the network
  await context.route('**/*', async route => {
    const req = route.request()
    let url
    try { url = new URL(req.url()) } catch { stats.aborted++; return route.abort() }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) { stats.mocked++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, shadow: true }) }) }
    if (req.resourceType() === 'document') { stats.placeholders++; return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: placeholderHtml(req.url(), origin) }) }
    stats.aborted++
    return route.abort()
  })
  await context.routeFromHAR(harPath, { notFound: 'fallback', update: false })
  await context.route('**/*', async route => {
    let url
    try { url = new URL(route.request().url()) } catch { stats.aborted++; return route.abort() }
    if (isBlocked(url)) { stats.blocked++; return route.abort() }
    return route.fallback()
  })
  await context.addInitScript(shadowInitScript)
  return { context, stats }
}
