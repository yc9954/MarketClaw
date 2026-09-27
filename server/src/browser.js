import { chromium } from 'playwright'
import dns from 'node:dns/promises'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs/promises'
import { analyzeRun } from './analyze.js'

const trackerHosts = ['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'facebook.net', 'connect.facebook.net', 'hotjar.com', 'clarity.ms', 'segment.io', 'mixpanel.com']
const trackingParams = /^(utm_|gclid$|fbclid$|msclkid$|mc_cid$|mc_eid$)/i
const privateV4 = ip => {
  const [a, b, c] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
}
const privateV6 = ip => ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('::ffff:') || ip.startsWith('2001:db8:')

export async function validateTarget(raw, allowPrivate = process.env.ALLOW_PRIVATE_TARGETS === '1') {
  let url
  try { url = new URL(raw) } catch { throw new Error('올바른 http(s) URL을 입력하세요.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('인증 정보가 없는 http(s) URL만 허용합니다.')
  if (!allowPrivate) {
    const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true })
    if (!addresses.length || addresses.some(({ address }) => net.isIP(address) === 4 ? privateV4(address) : privateV6(address))) throw new Error('로컬 또는 사설 네트워크 주소는 분석할 수 없습니다.')
  }
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (trackingParams.test(key)) url.searchParams.delete(key)
  return url
}

function extractPage() {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const text = el => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 130)
  return {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    h1: [...document.querySelectorAll('h1')].map(text).filter(Boolean).slice(0, 5),
    headings: [...document.querySelectorAll('h2')].map(text).filter(Boolean).slice(0, 10),
    ctas: [...document.querySelectorAll('a,button,textarea,[contenteditable="true"]')]
      .filter(el => visible(el) && !el.closest('nav') && (
        ((el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true') && !el.closest('form')) ||
        el.tagName === 'BUTTON' ||
        /(^|\s)(btn|button|cta|primary)(\s|$)/i.test(el.className || '') ||
        /start|try|demo|contact|pricing|시작|체험|문의|가격/i.test(text(el))
      ))
      .map(el => ({ text: text(el) || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '', href: el instanceof HTMLAnchorElement ? el.href : '', aboveFold: el.getBoundingClientRect().top < innerHeight }))
      .filter(x => x.text).slice(0, 30),
    links: [...document.querySelectorAll('a[href]')].filter(visible).map(el => ({ text: text(el), url: el.href })).filter(x => x.text).slice(0, 60),
    forms: [...document.forms].map(f => ({ action: f.action, fields: f.querySelectorAll('input:not([type="hidden"]),select,textarea').length })),
    viewport: { width: innerWidth, height: innerHeight }
  }
}

async function launchBrowser() {
  const channel = process.env.BROWSER_CHANNEL
  return chromium.launch({ headless: process.env.BROWSER_HEADLESS !== '0', ...(channel ? { channel } : {}) })
}

export async function inspect(target, runDir, onEvent = () => {}) {
  await fs.mkdir(runDir, { recursive: true })
  const browser = await launchBrowser()
  try {
  const origin = target.origin
  const network = { requests: 0, blocked: 0, failed: 0 }
  const pages = []
  const journeys = []
  const harPath = path.join(runDir, 'capture.har.zip')
  let context
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordHar: { path: harPath, mode: 'full', content: 'embed' }, serviceWorkers: 'block' })
    await context.route('**/*', async route => {
      const req = route.request()
      let url
      try { url = new URL(req.url()) } catch { return route.abort() }
      if (!['http:', 'https:'].includes(url.protocol)) return route.abort()
      if (trackerHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) { network.blocked++; return route.abort() }
      if (req.isNavigationRequest() && url.origin !== origin) return route.abort()
      try { await validateTarget(url.href) } catch { network.blocked++; return route.abort() }
      network.requests++
      for (const key of [...url.searchParams.keys()]) if (trackingParams.test(key)) url.searchParams.delete(key)
      try { await route.continue(url.href !== req.url() ? { url: url.href } : undefined) } catch { network.failed++ }
    })
    const queue = [target.href]
    const visited = new Set()
    const maxPages = Math.max(1, Math.min(8, Number(process.env.MAX_PAGES) || 4))
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()
      if (visited.has(url)) continue
      visited.add(url)
      onEvent(`페이지 탐색 중: ${url}`)
      const page = await context.newPage()
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        const settleMs = Math.max(0, Math.min(10000, Number(process.env.PAGE_SETTLE_MS) || 750))
        await page.waitForTimeout(settleMs)
        const finalUrl = page.url()
        if (new URL(finalUrl).origin !== origin) throw new Error('다른 도메인으로 이동했습니다.')
        const detail = await page.evaluate(extractPage)
        const record = { url: finalUrl, status: response?.status() || 0, ...detail }
        pages.push(record)
        if (pages.length === 1) await page.screenshot({ path: path.join(runDir, 'home.png'), fullPage: true, animations: 'disabled' })
        for (const link of detail.links) {
          try { const next = new URL(link.url); next.hash = ''; if (next.origin === origin && ['http:', 'https:'].includes(next.protocol) && !visited.has(next.href) && !queue.includes(next.href)) queue.push(next.href) } catch { /* skip invalid links */ }
        }
        onEvent(`${response?.status() || 0} · ${detail.title || finalUrl} · CTA ${detail.ctas.length}개`)
      } catch (err) {
        pages.push({ url, error: err.message, title: '', description: '', h1: [], headings: [], ctas: [], links: [], forms: [] })
        onEvent(`탐색 실패: ${err.message}`)
      } finally { await page.close() }
    }
    if (!pages.length || pages[0].error) throw new Error('첫 페이지를 열지 못했습니다. URL과 사이트 상태를 확인하세요.')
  } finally { if (context) await context.close() }

    const replay = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    try {
      await replay.routeFromHAR(harPath, { notFound: 'abort' })
      for (const profile of [
        { name: '첫 방문자', hint: /about|소개|story|features|기능/i },
        { name: '가격 검토자', hint: /pricing|price|plans|요금|가격/i },
        { name: '문의 준비자', hint: /contact|demo|문의|상담/i }
      ]) {
        onEvent(`오프라인 경로 확인: ${profile.name}`)
        const page = await replay.newPage()
        const journey = { profile: profile.name, steps: [], success: false }
        try {
          await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15000 })
          journey.steps.push({ url: page.url(), title: await page.title() })
          const link = pages[0].links.find(x => profile.hint.test(x.text + ' ' + x.url) && new URL(x.url).origin === origin)
          if (link) {
            await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
            journey.steps.push({ url: page.url(), title: await page.title() })
            journey.success = true
          } else journey.note = '해당 목적의 내부 링크를 첫 화면에서 찾지 못했습니다.'
        } catch (err) { journey.note = `저장된 네트워크 기록으로 재생 실패: ${err.message}` }
        journeys.push(journey)
        await page.close()
      }
    } finally { await replay.close() }
  onEvent('근거 기반 진단 작성 완료')
  return { pages, journeys, network, summary: analyzeRun(pages, journeys, network) }
  } finally { await browser.close() }
}
