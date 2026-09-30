// Behaviour engine for one persona agent inside the shadow browser.
// Ported from the MiroFish-era OASIS web engine and generalized to any captured site:
//   observePage   – element extraction with a visual-salience score (fold decay, F-pattern position,
//                   visual hierarchy, Fitts's law, Itti-Koch approximation, Hick's law, Gestalt cues)
//   actions       – 4-layer taxonomy: navigation / DOM / micro-signal / intent
//   memory        – sentiment, engagement and information-scent bookkeeping per persona
//   goals         – conversion detection from the run's own inventory or request-supplied path patterns
//   policies      – `llm` (OpenAI-compatible chat completions) or `heuristic` (seeded, key-free)
import { seededRandom } from './random.js'
import { SHADOW_TITLE } from './shadow.js'

export const ACTIONS = ['goto', 'back', 'click', 'type', 'hover', 'scroll_down', 'scroll_up', 'key_press', 'select', 'dwell', 'read', 'viewport_focus', 'do_nothing', 'bounce', 'share_intent', 'save_intent', 'copy_text']
export const DEFAULT_GOAL_PATTERN = /contact|pricing|price|plans|signup|sign-up|register|estimate|quote|demo|문의|견적|가입|상담|요금|가격|구독|신청/i
export const CONVERSION_TEXT = /제출|신청|문의|견적|구독|상담|가입|시작하기|완료|보내기|submit|contact|sign ?up|get started|start (free|now)|quote|estimate|subscribe|request|book|try (it|now|free)/i

// ── goals ──────────────────────────────────────────────────────────────────
export function compileGoals(goals) {
  const list = (Array.isArray(goals) ? goals : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 20)
  if (!list.length) return [DEFAULT_GOAL_PATTERN]
  return list.map(s => new RegExp(s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i'))
}

export function isGoalPage({ path = '', title = '' } = {}, goalRegexes = [DEFAULT_GOAL_PATTERN]) {
  if (!path || path === '/') return false
  if (title === SHADOW_TITLE) return false
  return goalRegexes.some(re => re.test(path) || re.test(title))
}

// ── observation (runs in the browser) ──────────────────────────────────────
function perceive({ ctaTexts, interests }) {
  const vw = innerWidth, vh = innerHeight
  const conversionText = /제출|신청|문의|견적|구독|상담|가입|시작하기|완료|보내기|submit|contact|sign ?up|get started|start (free|now)|quote|estimate|subscribe|request|book|try (it|now|free)/i
  const lum = (r, g, b) => { const c = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const rgb = s => { const m = (s || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : [128, 128, 128] }
  const contrast = (fg, bg) => { const a = lum(...fg), b = lum(...bg); const [l, d] = a > b ? [a, b] : [b, a]; return (l + 0.05) / (d + 0.05) }
  const sat = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); const l = (max + min) / 2; return max === min ? 0 : (max - min) / (l > 0.5 ? 2 - max - min : max + min) }
  const bodyBg = rgb(getComputedStyle(document.body).backgroundColor)
  const lums = [...document.querySelectorAll('h1,h2,h3,p,a,button')].slice(0, 50).map(el => lum(...rgb(getComputedStyle(el).color)))
  const median = lums.length ? lums.slice().sort((a, b) => a - b)[Math.floor(lums.length / 2)] : 0.5
  const salience = (el, rect, style) => {
    const fold = Math.exp(-0.7 * Math.max(0, rect.top / vh))
    const xr = (rect.left + rect.width / 2) / vw, yr = rect.top / vh
    const pos = xr < 0.5 && yr < 0.33 ? 1 : yr < 0.66 && xr < 0.5 ? 0.7 : xr >= 0.5 && yr < 0.33 ? 0.7 : 0.4
    const fg = rgb(style.color)
    const bg = style.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(style.backgroundColor) ? rgb(style.backgroundColor) : bodyBg
    const pad = ['Top', 'Bottom', 'Left', 'Right'].reduce((s, k) => s + (parseFloat(style['padding' + k]) || 0), 0)
    const hier = (parseFloat(style.fontSize) || 14) / 16 * 0.35 + (parseFloat(style.fontWeight) || 400) / 400 * 0.2 + Math.min(contrast(fg, bg), 21) / 21 * 0.5 + pad / 1000 * 0.1 + sat(fg) * 0.15
    const itti = (Math.abs(lum(...fg) - median) + Math.min(sat(bg), 1)) / 2
    const D = Math.hypot(rect.left + rect.width / 2 - vw / 2, rect.top + rect.height / 2 - vh / 2) + 1
    const fitts = 1 / Math.log2(1 + D / Math.max(Math.min(rect.width, rect.height), 44))
    const siblings = el.parentElement ? el.parentElement.querySelectorAll('a,button,input').length : 1
    const hicks = siblings > 1 ? 1 / Math.log2(siblings + 1) : 1
    const gestalt = 1 + (style.boxShadow && style.boxShadow !== 'none' ? 0.3 : 0) + (parseInt(style.zIndex) > 0 ? 0.2 : 0) + (parseFloat(style.borderRadius) > 4 ? 0.1 : 0) + (bg !== bodyBg ? 0.2 : 0)
    const banner = /ad|banner|sponsor|promo|popup/i.test((el.className || '') + (el.id || '')) ? 0.5 : style.position === 'fixed' && parseFloat(style.top) < 10 ? 0.6 : 1
    const idx = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0
    const serial = idx === 0 ? 0.25 : el.parentElement && idx === el.parentElement.children.length - 1 ? 0.2 : 0
    return Math.round((fold * pos * (1 + hier) * (1 + itti) * fitts * hicks * gestalt * banner + serial) * 100) / 100
  }
  const inVP = r => r.top < vh + 400 && r.bottom > -100 && r.width > 0 && r.height > 0
  const visible = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.01 }
  const norm = s => (s || '').replace(/\s+/g, ' ').trim()
  const ctaSet = (ctaTexts || []).map(t => norm(t).toLowerCase()).filter(Boolean)
  const looksCta = (el, text) => el.hasAttribute('data-mc-primary-cta') || /(^|\s)(btn|button|cta|primary)(\s|$)/i.test(el.className || '') || ctaSet.some(t => text.toLowerCase().startsWith(t.slice(0, 20)))
  const texts = [...document.querySelectorAll('h1,h2,h3,h4,p,span,li,strong,em,small')].filter(el => {
    const r = el.getBoundingClientRect(); const t = norm(el.textContent)
    return t.length > 4 && t.length < 250 && inVP(r) && visible(el) && [...el.childNodes].every(n => n.nodeType === 3 || ['BR', 'STRONG', 'EM', 'B', 'I', 'SPAN'].includes(n.nodeName))
  }).map(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { tag: el.tagName, text: norm(el.textContent).slice(0, 150), salience: salience(el, r, s), fontSize: Math.round(parseFloat(s.fontSize)), aboveFold: r.top < vh, posY: Math.round(r.top) } })
    .filter((t, i, arr) => arr.findIndex(x => x.text === t.text) === i).sort((a, b) => b.salience - a.salience).slice(0, 20)
  const links = [...document.querySelectorAll('a[href]')].filter(el => { const r = el.getBoundingClientRect(); const t = norm(el.textContent); return t.length > 0 && t.length < 80 && inVP(r) && r.width > 20 && visible(el) })
    .map(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const text = norm(el.textContent).slice(0, 60); let href = el.getAttribute('href') || ''; let internal = false, path = ''; try { const u = new URL(el.href, location.href); internal = u.origin === location.origin; path = u.pathname + u.search; href = internal ? path : u.href } catch { /* keep raw */ }
      return { text, href, path, salience: salience(el, r, s), isInternal: internal, isNav: !!el.closest('nav,header'), isCta: looksCta(el, text), isPrimary: el.hasAttribute('data-mc-primary-cta'), aboveFold: r.top < vh, inForm: !!el.closest('form') } })
    .filter(l => l.href && !/^(javascript:|mailto:|tel:)/.test(l.href)).sort((a, b) => b.salience - a.salience).slice(0, 25)
  const buttons = [...document.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(el => { const t = norm(el.textContent || el.value); const r = el.getBoundingClientRect(); return t.length > 0 && inVP(r) && r.width > 30 && visible(el) })
    .map(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const text = norm(el.textContent || el.value).slice(0, 50); const area = r.width * r.height
      return { text, id: el.id || '', salience: salience(el, r, s), isConversion: conversionText.test(text) || looksCta(el, text), inForm: !!el.closest('form'), isSubmit: el.type === 'submit' || (!!el.closest('form') && el.type !== 'reset'), aboveFold: r.top >= 0 && r.top < vh, size: area > 5000 ? 'large' : area > 1500 ? 'medium' : 'small' } })
    .sort((a, b) => b.salience - a.salience).slice(0, 15)
  const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),textarea,select')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 15 && visible(el) })
    .map((el, i) => { const id = el.id || ''; const name = el.getAttribute('name') || ''; const selector = id ? `#${CSS.escape(id)}` : name ? `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '')}"]` : `${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`
      return { selector, type: el.tagName === 'SELECT' ? 'select' : el.type || 'text', placeholder: el.placeholder || '', label: norm(el.closest('label')?.textContent || document.querySelector(`label[for="${id}"]`)?.textContent || '').slice(0, 40), inForm: !!el.closest('form'), value: el.value || '' } }).slice(0, 8)
  const interestSet = (interests || []).filter(Boolean)
  const socialProof = [...document.querySelectorAll('p,span,div,li,small,strong')].filter(el => { const t = norm(el.textContent); const r = el.getBoundingClientRect(); return r.width > 0 && t.length > 5 && t.length < 120 && el.children.length < 4 && (/\d[\d,.]*\s*[+개건년%배xX명팀]/.test(t) || /★|고객|리뷰|review|customers|teams|trusted/i.test(t)) })
    .map(el => norm(el.textContent).slice(0, 80)).filter((t, i, arr) => arr.indexOf(t) === i).slice(0, 8)
  const topCta = links.find(l => l.isCta && l.aboveFold && !l.isNav) || buttons.find(b => b.isConversion && b.aboveFold)
  const scrollMax = Math.max(0, document.documentElement.scrollHeight - vh)
  const pageText = (document.body.innerText || '').slice(0, 8000)
  return {
    url: location.href, path: location.pathname + location.search, title: document.title, placeholder: !!document.body.getAttribute('data-mc-placeholder'),
    scrollY: Math.round(scrollY), scrollMax, scrollRatio: scrollMax > 0 ? Math.round(scrollY / scrollMax * 100) : 100,
    texts, links, buttons, inputs, socialProof,
    interestHits: interestSet.filter(k => pageText.includes(k)).length,
    layout: { topCta: topCta ? topCta.text : null, navLinkCount: document.querySelectorAll('nav a,header a').length, aboveFoldTexts: texts.filter(t => t.aboveFold).length, hasForm: inputs.some(i => i.inForm) }
  }
}

export async function observePage(page, { ctaTexts = [], interests = [] } = {}) {
  return page.evaluate(perceive, { ctaTexts, interests })
}

// ── cognitive profiles per segment (defaults for unknown segments) ──────────
const PROFILES = {
  brand_marketer_large: { scan: 'layer-cake', system: 'S2', bounceDepth: 0.45, load: 0.75, aesthetic: 0.4 },
  brand_marketer_startup: { scan: 'layer-cake', system: 'S2', bounceDepth: 0.5, load: 0.65, aesthetic: 0.5 },
  building_owner: { scan: 'spotted', system: 'S2', bounceDepth: 0.75, load: 0.9, aesthetic: 0.35 },
  retail_tenant: { scan: 'layer-cake', system: 'S2', bounceDepth: 0.6, load: 0.7, aesthetic: 0.45 },
  md_manager: { scan: 'spotted', system: 'S2', bounceDepth: 0.65, load: 0.8, aesthetic: 0.4 },
  popup_enthusiast: { scan: 'spotted', system: 'S1', bounceDepth: 0.65, load: 0.35, aesthetic: 0.85 },
  kpop_fan: { scan: 'commitment', system: 'S1', bounceDepth: 0.85, load: 0.2, aesthetic: 0.92 },
  retail_trend_watcher: { scan: 'layer-cake', system: 'S2', bounceDepth: 0.8, load: 0.85, aesthetic: 0.45 },
  franchise_explorer: { scan: 'spotted', system: 'S2', bounceDepth: 0.55, load: 0.6, aesthetic: 0.5 },
  jobseeker: { scan: 'f-pattern', system: 'S1', bounceDepth: 0.4, load: 0.4, aesthetic: 0.55 }
}
export function cognitiveProfile(persona) { return PROFILES[persona.segment] || { scan: 'layer-cake', system: 'S2', bounceDepth: 0.55, load: 0.6, aesthetic: 0.5 } }

export function createMemory() { return { visited: [], sentiment: 50, engagement: 0, consecutiveScrolls: 0, clickedHrefs: [], typed: [], readTexts: [], intentSignals: [], goalReached: false, converted: false, conversionType: null, simulatedMs: 0 } }

export function updateMemory(memory, obs, decision, result, persona) {
  const cog = cognitiveProfile(persona)
  if (!memory.visited.some(v => v.path === obs.path)) memory.visited.push({ path: obs.path, url: obs.url, title: obs.title })
  memory.consecutiveScrolls = decision.action === 'scroll_down' ? memory.consecutiveScrolls + 1 : ['dwell', 'do_nothing', 'read'].includes(decision.action) ? memory.consecutiveScrolls : 0
  const attention = Math.max(0, 1 - obs.scrollRatio / 100) ** 0.7 * ({ commitment: 1.3, spotted: 1, 'layer-cake': 0.9, 'f-pattern': 0.6 }[cog.scan] || 1)
  const text = obs.texts.map(t => t.text).join(' ')
  let delta = 0
  for (const kw of persona.goals.interests) if (text.includes(kw)) delta += 5 * attention * cog.load
  for (const kw of persona.goals.avoid) if (text.includes(kw)) delta -= 7
  if (obs.socialProof.length) delta += 4 * persona.traits.socialProofSensitivity
  if (obs.texts.some(t => t.salience > 0.5)) delta += 2 * cog.aesthetic
  if (obs.placeholder) delta -= 8
  const scent = Math.min(1, obs.interestHits * Math.exp(-0.3 * Math.max(0, memory.consecutiveScrolls - 2)))
  if (scent < 0.3 && memory.consecutiveScrolls > 2) delta -= 5
  if (result.goalReached) delta += 12
  if (result.error && ['click', 'type'].includes(decision.action)) delta -= 4
  memory.sentiment = Math.min(100, Math.max(0, memory.sentiment + delta))
  const weights = { dwell: 3, read: 4, viewport_focus: 2, scroll_down: 1, scroll_up: 0.5, click: 5, type: 8, hover: 2, key_press: 3, select: 3, do_nothing: 0.5, share_intent: 4, save_intent: 3, copy_text: 2, goto: 2, back: 1 }
  memory.engagement += (weights[decision.action] || 1) * (cog.system === 'S2' && ['read', 'dwell'].includes(decision.action) ? 1.5 : 1)
  if (result.intentSignal) memory.intentSignals.push({ signal: result.intentSignal, url: obs.url })
  if (result.clickedHref) memory.clickedHrefs.push(result.clickedHref)
  if (result.typed) memory.typed.push(result.typed.selector)
  memory.simulatedMs += result.simulatedMs || 0
  if (result.goalReached) memory.goalReached = true
  if (result.converted && !memory.converted) { memory.converted = true; memory.conversionType = result.conversionType; memory.convertedAtMs = memory.simulatedMs }
  return { sentiment: Math.round(memory.sentiment), engagement: Math.round(memory.engagement), scent: Math.round(scent * 100) }
}

// ── action execution ───────────────────────────────────────────────────────
const wait = (page, simulatedMs, pace) => page.waitForTimeout(Math.max(0, Math.round(simulatedMs * pace)))

const describeElement = el => {
  const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  let href = null
  try { if (el.tagName === 'A' && el.href) href = new URL(el.href, location.href).pathname } catch { /* ignore */ }
  const form = el.closest('form')
  return { text, href, inForm: !!form, isSubmit: el.type === 'submit' || (!!form && el.tagName === 'BUTTON' && el.type !== 'reset'), isCta: el.hasAttribute('data-mc-primary-cta') || /(^|\s)(btn|button|cta|primary)(\s|$)/i.test(el.className || '') }
}

function candidateSelectors(target) {
  const t = String(target || '').trim()
  if (!t) return []
  if (t.startsWith('#') || t.startsWith('[')) return [t]
  if (t.startsWith('/') || /^https?:/.test(t)) {
    let path = t
    try { path = t.startsWith('/') ? t : new URL(t).pathname } catch { /* keep */ }
    return [`a[href="${t}"]`, `a[href="${path}"]`, `a[href$="${path}"]`, `a[href*="${path.split('?')[0]}"]`]
  }
  const safe = t.replace(/"/g, '\\"').slice(0, 40)
  return [`a:has-text("${safe}")`, `button:has-text("${safe}")`, `[role="button"]:has-text("${safe}")`, `input[type="submit"][value*="${safe}"]`]
}

export async function executeAction(page, decision, { origin, pace = 0.1, goals, ctaTexts = [] } = {}) {
  const result = { action: decision.action, target: decision.target || decision.path || decision.selector || null, reason: decision.reason || '', ok: false, simulatedMs: 0 }
  const check = (regexes) => page.evaluate(() => ({ path: location.pathname + location.search, title: document.title })).then(info => { if (isGoalPage(info, regexes)) result.goalReached = true; return info }).catch(() => null)
  try {
    switch (decision.action) {
      case 'goto': {
        const raw = String(decision.path || '/')
        const url = /^https?:/.test(raw) ? raw : origin + (raw.startsWith('/') ? raw : '/' + raw)
        if (new URL(url).origin !== origin) throw new Error('외부 도메인으로는 이동하지 않습니다.')
        await page.goto(url, { waitUntil: 'load', timeout: 15000 })
        result.simulatedMs = 1200; await wait(page, 600, pace)
        result.ok = true; result.navigatedTo = raw
        await check(goals)
        break
      }
      case 'back':
        await page.goBack({ waitUntil: 'load', timeout: 10000 }).catch(() => {})
        result.simulatedMs = 800; await wait(page, 400, pace); result.ok = true
        break
      case 'click': {
        const onGoalPage = isGoalPage(await page.evaluate(() => ({ path: location.pathname + location.search, title: document.title })).catch(() => ({})), goals)
        const before = page.url()
        let clicked = null
        for (const sel of candidateSelectors(decision.target)) {
          try {
            const loc = page.locator(sel).first()
            if (!(await loc.count())) continue
            const info = await loc.evaluate(describeElement).catch(() => ({}))
            if (await loc.isVisible().catch(() => false)) { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {}); await loc.click({ timeout: 4000, noWaitAfter: true }) }
            else await loc.evaluate(el => el.click())
            clicked = { selector: sel, ...info }
            break
          } catch { /* try the next selector */ }
        }
        if (!clicked) throw new Error(`클릭할 요소를 찾지 못했습니다: "${decision.target}"`)
        // A link click navigates asynchronously: wait for the URL to change and the new page to load,
        // otherwise the next observation could race the navigation and make runs non-reproducible.
        if (clicked.href && clicked.href !== new URL(before).pathname) await page.waitForURL(u => u.toString() !== before, { waitUntil: 'load', timeout: 5000 }).catch(() => {})
        else await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
        result.simulatedMs = 900; await wait(page, 500, pace)
        result.ok = true; result.clicked = clicked.selector; result.clickedText = clicked.text; result.clickedHref = clicked.href
        const isCta = clicked.isCta || CONVERSION_TEXT.test(clicked.text || '') || ctaTexts.some(t => t && (clicked.text || '').toLowerCase().startsWith(String(t).toLowerCase().slice(0, 20)))
        await check(goals)
        if (clicked.inForm && clicked.isSubmit) { result.converted = true; result.conversionType = 'form_submit' }
        else if (isCta && onGoalPage) { result.converted = true; result.conversionType = 'cta_on_goal' }
        result.isCta = isCta
        break
      }
      case 'type': {
        const sel = String(decision.selector || 'input[type="text"],input[type="email"],textarea')
        const value = String(decision.value || '').slice(0, 120)
        const loc = page.locator(sel).first()
        if (!(await loc.count())) throw new Error(`입력창이 없습니다: ${sel}`)
        const tag = await loc.evaluate(el => el.tagName.toLowerCase())
        if (tag === 'select') await loc.selectOption({ index: 0 }).catch(() => {})
        else await loc.fill(value, { timeout: 4000 })
        result.simulatedMs = 600 + value.length * 120; await wait(page, 200, pace)
        result.ok = true; result.typed = { selector: sel, value }
        break
      }
      case 'select': {
        await page.selectOption(String(decision.selector || 'select'), decision.value ? { label: String(decision.value) } : { index: 0 }, { timeout: 3000 })
        result.simulatedMs = 900; result.ok = true
        break
      }
      case 'hover': {
        const loc = page.locator(`text=${String(decision.target || '').slice(0, 30)}`).first()
        if (await loc.count()) { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {}); await loc.hover({ timeout: 2000 }).catch(() => {}) }
        result.simulatedMs = 800; await wait(page, 300, pace); result.ok = true
        break
      }
      case 'scroll_down': case 'scroll_up': {
        const px = Math.min(Math.max(100, Number(decision.px) || 600), 1200) * (decision.action === 'scroll_up' ? -1 : 1)
        await page.evaluate(amount => scrollBy({ top: amount, behavior: 'instant' }), px)
        result.simulatedMs = 700; await wait(page, 300, pace); result.ok = true; result.scrolled = px
        break
      }
      case 'key_press': {
        const key = String(decision.key || 'Enter')
        await page.keyboard.press(key)
        result.simulatedMs = 500; await wait(page, 300, pace); result.ok = true
        if (key === 'Enter') { const focusInForm = await page.evaluate(() => !!document.activeElement?.closest('form')).catch(() => false); if (focusInForm) { result.converted = true; result.conversionType = 'form_submit' } }
        break
      }
      case 'dwell': result.simulatedMs = Math.min(Number(decision.ms) || 2000, 5000); await wait(page, result.simulatedMs, pace); result.ok = true; break
      case 'read': result.simulatedMs = Math.min(Math.max(String(decision.target || '').length * 200, 1500), 6000); await wait(page, result.simulatedMs, pace); result.ok = true; break
      case 'viewport_focus': {
        const loc = page.locator(`text=${String(decision.target || '').slice(0, 30)}`).first()
        if (await loc.count()) await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
        result.simulatedMs = 1200; await wait(page, 300, pace); result.ok = true
        break
      }
      case 'do_nothing': result.simulatedMs = 1500; await wait(page, 300, pace); result.ok = true; break
      case 'bounce': result.ok = true; result.bounced = true; break
      case 'share_intent': case 'save_intent': case 'copy_text': result.simulatedMs = 500; result.ok = true; result.intentSignal = decision.action; break
      default: throw new Error(`알 수 없는 액션: ${decision.action}`)
    }
  } catch (err) { result.error = String(err.message || err).slice(0, 160) }
  return result
}

// ── heuristic policy: deterministic, key-free ──────────────────────────────
const fillValue = (input, persona) => {
  const hint = `${input.type} ${input.placeholder} ${input.label} ${input.selector}`.toLowerCase()
  if (input.type === 'email' || /email|이메일|메일/.test(hint)) return 'persona@example.com'
  if (input.type === 'tel' || /phone|tel|전화|연락처/.test(hint)) return '010-0000-0000'
  if (input.type === 'number' || /number|수량|평|인원|size|규모/.test(hint)) return '10'
  if (/company|회사|브랜드|brand|org/.test(hint)) return persona.demographics.occupation || '샘플 브랜드'
  if (/name|이름|성함/.test(hint)) return persona.persona_name.split(' ')[0].replace(/씨는$/, '') || '홍길동'
  if (input.type === 'textarea' || /message|내용|문의/.test(hint)) return `${persona.goals.conversion || '도입'} 관련 문의드립니다.`
  return persona.demographics.occupation || '문의'
}

export function heuristicPolicy({ persona, seed }) {
  const rng = seededRandom(seed)
  const cog = cognitiveProfile(persona)
  const t = persona.traits
  const decide = (obs, memory, step, maxSteps, ctx) => {
    const goalHere = isGoalPage(obs, ctx.goals)
    const late = step >= maxSteps - 2
    const options = []
    if (obs.placeholder) return { action: 'back', reason: '기록되지 않은 페이지라 되돌아갑니다.' }
    // Willingness to commit to a conversion action: persona CTA response × current sentiment,
    // plus a bonus when the page speaks to the persona's interests or shows social proof.
    const commit = Math.min(1, 0.15 + 0.5 * t.ctaResponse * (memory.sentiment / 100) + (obs.interestHits > 0 ? 0.2 : 0) + (obs.socialProof.length ? 0.15 * t.socialProofSensitivity : 0))
    // 1. conversion form on a goal page: fill inputs, then submit
    if (goalHere && obs.layout.hasForm) {
      const pending = obs.inputs.filter(i => i.inForm && !memory.typed.includes(i.selector) && i.type !== 'select')
      const started = memory.typed.length > 0
      if (pending.length && memory.typed.length < 4 && (started || rng() < commit)) { const input = pending[0]; return { action: 'type', selector: input.selector, value: fillValue(input, persona), reason: `${input.label || input.placeholder || input.type} 입력란을 채웁니다.` } }
      const submit = obs.buttons.find(b => b.inForm && (b.isSubmit || b.isConversion))
      if (started && submit && rng() < 0.55 + 0.45 * t.ctaResponse) return { action: 'click', target: submit.id ? `#${submit.id}` : submit.text, reason: `양식을 작성했으니 "${submit.text}" 버튼으로 제출합니다.` }
    }
    // 2. links and buttons, scored by salience × persona
    const seen = new Set([...memory.visited.map(v => v.path), ...memory.clickedHrefs])
    for (const link of obs.links) {
      if (!link.isInternal || seen.has(link.path)) continue
      const goalLink = isGoalPage({ path: link.path, title: link.text }, ctx.goals)
      const interest = persona.goals.interests.some(k => link.text.includes(k) || link.path.includes(k)) ? 1 : 0
      const avoid = persona.goals.avoid.some(k => link.text.includes(k)) ? 1 : 0
      const mentionsGoal = persona.goals.conversion && link.text.split(/\s+/).some(w => w.length > 1 && persona.goals.conversion.includes(w)) ? 0.5 : 0
      let weight = link.salience * (link.isCta ? 0.25 + 0.6 * t.ctaResponse : 0.3) * (link.aboveFold ? 1.15 : 0.85) * (link.isNav ? 0.7 : 1)
      weight *= 1 + interest * (0.6 + t.copyImportance) + mentionsGoal + (goalLink ? 0.3 + t.ctaResponse * 0.5 : 0)
      weight *= avoid ? 0.15 : 1
      if (step === 1) weight *= 0.5
      if (goalHere && (link.isCta || goalLink)) weight *= commit
      if (late && (link.isCta || goalLink)) weight *= 1.6
      options.push({ weight, action: 'click', target: link.path || link.text, reason: `${link.isCta ? 'CTA' : goalLink ? '목표 관련 링크' : interest ? '관심 키워드 링크' : '링크'} "${link.text}" (현저성 ${link.salience})` })
    }
    for (const b of obs.buttons) {
      if (b.inForm && !goalHere) continue
      const weight = b.salience * (b.isConversion ? 0.25 + 0.6 * t.ctaResponse : 0.3) * (b.aboveFold ? 1.1 : 0.8) * (late ? 1.4 : 1) * (step === 1 ? 0.5 : 1) * (goalHere && b.isConversion ? commit : 1)
      options.push({ weight, action: 'click', target: b.id ? `#${b.id}` : b.text, reason: `${b.isConversion ? '전환 버튼' : '버튼'} "${b.text}" (현저성 ${b.salience})` })
    }
    // 3. reading, scrolling, bouncing
    const depth = obs.scrollRatio / 100
    if (obs.scrollRatio < 90) options.push({ weight: 0.55 * (0.5 + t.patience) * (1 - depth * 0.6) * (memory.consecutiveScrolls > 3 ? 0.4 : 1), action: 'scroll_down', px: 500 + rng.int(500), reason: `아직 ${obs.scrollRatio}%만 봤으니 더 내려봅니다.` })
    const topText = obs.texts[0]
    if (topText && !memory.readTexts.includes(topText.text)) options.push({ weight: 0.4 * (0.5 + t.copyImportance) * (cog.system === 'S2' ? 1.2 : 0.8), action: 'read', target: topText.text.slice(0, 60), reason: `가장 눈에 띄는 문구를 읽습니다: "${topText.text.slice(0, 40)}"` })
    if (obs.socialProof.length && step > 1) options.push({ weight: 0.25 * t.socialProofSensitivity, action: 'viewport_focus', target: obs.socialProof[0].slice(0, 30), reason: `사회적 증거에 시선이 갑니다: "${obs.socialProof[0].slice(0, 40)}"` })
    options.push({ weight: 0.12, action: 'dwell', ms: 1500 + rng.int(2000), reason: '화면을 잠시 훑어봅니다.' })
    const noScent = obs.interestHits === 0 && !obs.links.some(l => l.isCta) ? 1 : 0
    const avoidHit = obs.texts.some(x => persona.goals.avoid.some(k => x.text.includes(k))) ? 1 : 0
    const priceHesitation = /pricing|price|plans|요금|가격/i.test(obs.path + ' ' + obs.title) ? t.priceConsciousness * 0.3 : 0
    let bounce = 0.04 + (1 - t.patience) * 0.12 + (memory.sentiment < 40 ? 0.35 : memory.sentiment < 50 ? 0.12 : 0) + (depth > cog.bounceDepth && noScent ? 0.3 : 0) + avoidHit * 0.25 + (memory.consecutiveScrolls > 3 ? 0.2 : 0) + priceHesitation + (goalHere && depth > 0.5 ? 0.12 : 0)
    if (memory.goalReached || memory.converted) bounce *= 0.5
    if (late) bounce *= 1.8
    if (step === 1) bounce *= 0.3
    options.push({ weight: bounce, action: 'bounce', reason: memory.sentiment < 40 ? '기대에 못 미쳐서 떠납니다.' : noScent && depth > cog.bounceDepth ? '관심 있는 내용을 찾지 못해 떠납니다.' : '충분히 봤다고 판단해 세션을 마칩니다.' })
    if (memory.goalReached && rng() < 0.15 * t.socialProofSensitivity) options.push({ weight: 0.2, action: rng() < 0.5 ? 'save_intent' : 'share_intent', target: obs.title, reason: '나중을 위해 저장하거나 공유할 만한 페이지입니다.' })
    const pick = rng.weighted(options.map(o => ({ ...o, weight: Math.max(0.001, o.weight) ** 1.6 })))
    if (pick.action === 'read') memory.readTexts.push(topText.text)
    const { weight, ...decision } = pick
    return decision
  }
  return { name: 'heuristic', decide }
}

// ── llm policy: OpenAI-compatible chat completions ─────────────────────────
export function llmConfig() {
  const apiKey = process.env.LLM_API_KEY || ''
  return { configured: !!apiKey, baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model: process.env.LLM_MODEL || 'gpt-4o-mini', apiKey }
}

function systemPrompt(persona, ctx) {
  const cog = cognitiveProfile(persona)
  const pages = (ctx.pages || []).slice(0, 8).map(p => `- ${p.path}: ${p.title || ''}`).join('\n')
  return `당신은 ${ctx.host} 사이트를 방문한 실제 사람입니다. 아래 페르소나를 연기하며 매 스텝 JSON 하나로 다음 행동을 정합니다.
페르소나: ${persona.name} · ${persona.demographics.age || ''}세 ${persona.demographics.occupation || ''}
배경: ${persona.description.slice(0, 160)}
방문 목적: ${persona.goals.conversion || '사이트가 나에게 맞는지 확인'}
관심 키워드: ${persona.goals.interests.slice(0, 8).join(', ') || '없음'} / 기피: ${persona.goals.avoid.join(', ') || '없음'}
인지 프로파일: 스캔 ${cog.scan}, ${cog.system === 'S1' ? '직관·감성 반응' : '분석·목표 지향'}, 스크롤 ${Math.round(cog.bounceDepth * 100)}% 전까지 관심 신호가 없으면 이탈 고려
사이트에서 기록된 페이지:
${pages || '- / 만 기록됨'}
목표 페이지 패턴: ${ctx.goalPatterns.join(', ')}
행동 원칙: 현저성이 높은 요소에 먼저 반응하고, 이미 방문한 경로는 반복하지 않으며, 양식이 있으면 type으로 채운 뒤 제출 버튼을 click 합니다. 링크 클릭은 target에 href 경로를, 버튼은 텍스트를 넣습니다.`
}

function decisionPrompt(obs, memory, step, maxSteps) {
  const texts = obs.texts.slice(0, 10).map(t => `  [${t.salience}${t.aboveFold ? ' ★' : ''}] ${t.text}`).join('\n')
  const links = obs.links.slice(0, 14).map(l => `  [${l.salience}] "${l.text}" → ${l.href}${l.isNav ? ' [nav]' : ''}${l.isCta ? ' [CTA]' : ''}`).join('\n')
  const buttons = obs.buttons.map(b => `  [${b.salience}] "${b.text}"${b.isConversion ? ' [전환]' : ''}${b.inForm ? ' [form]' : ''}`).join('\n')
  const inputs = obs.inputs.map(i => `  ${i.selector} (${i.label || i.placeholder || i.type})`).join('\n')
  return `=== 스텝 ${step}/${maxSteps} ===
URL: ${obs.url} | 제목: ${obs.title}${obs.placeholder ? ' | 기록되지 않은 페이지' : ''}
스크롤 ${obs.scrollRatio}% | 감정 ${Math.round(memory.sentiment)}/100 | 방문: ${memory.visited.map(v => v.path).join(' → ') || '/'}
사회적 증거: ${obs.socialProof.join(' | ') || '없음'}
텍스트(현저성 순):\n${texts || '  없음'}
링크:\n${links || '  없음'}
버튼:\n${buttons || '  없음'}
입력란:\n${inputs || '  없음'}
다음 중 하나를 JSON으로만 답하세요:
{"action":"click","target":"/href 또는 텍스트","reason":"..."} {"action":"type","selector":"#id","value":"...","reason":"..."} {"action":"scroll_down","px":600,"reason":"..."} {"action":"scroll_up","px":400,"reason":"..."} {"action":"goto","path":"/path","reason":"..."} {"action":"back","reason":"..."} {"action":"hover","target":"텍스트","reason":"..."} {"action":"read","target":"문구","reason":"..."} {"action":"dwell","ms":2000,"reason":"..."} {"action":"viewport_focus","target":"요소","reason":"..."} {"action":"do_nothing","reason":"..."} {"action":"bounce","reason":"..."} {"action":"share_intent","target":"...","reason":"..."} {"action":"save_intent","target":"...","reason":"..."} {"action":"copy_text","target":"...","reason":"..."}
힌트: scroll_down은 스크롤 85% 미만일 때만. 스텝 ${maxSteps - 2} 이후에는 전환 시도 또는 bounce.`
}

export function llmPolicy({ persona, seed, fetchImpl = fetch }) {
  const cfg = llmConfig()
  const fallback = heuristicPolicy({ persona, seed })
  let messages = null
  const decide = async (obs, memory, step, maxSteps, ctx) => {
    if (!messages) messages = [{ role: 'system', content: systemPrompt(persona, ctx) }]
    messages.push({ role: 'user', content: decisionPrompt(obs, memory, step, maxSteps) })
    if (messages.length > 14) messages = [messages[0], ...messages.slice(-12)]
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 25000)
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: cfg.model, messages, temperature: 0.7, max_tokens: 300, response_format: { type: 'json_object' } }) }).finally(() => clearTimeout(timer))
      if (!res.ok) throw new Error(`LLM ${res.status}`)
      const body = await res.json()
      const content = body.choices?.[0]?.message?.content || '{}'
      const decision = JSON.parse(content.replace(/^```(json)?|```$/g, '').trim())
      if (!ACTIONS.includes(decision.action)) throw new Error(`알 수 없는 액션 ${decision.action}`)
      messages.push({ role: 'assistant', content: JSON.stringify(decision) })
      return decision
    } catch (err) {
      const decision = fallback.decide(obs, memory, step, maxSteps, ctx)
      messages.push({ role: 'assistant', content: JSON.stringify(decision) })
      return { ...decision, fallback: `LLM 실패 (${String(err.message || err).slice(0, 60)}) → 휴리스틱` }
    }
  }
  return { name: 'llm', decide }
}

export function createPolicy({ persona, seed, policy }) {
  if (policy === 'llm' && llmConfig().configured) return llmPolicy({ persona, seed })
  return heuristicPolicy({ persona, seed })
}
