// Design variants are lists of DOM patches applied inside the shadow browser after every page load.
// Patch types: css (inject a stylesheet), text (replace an element's text), hide (display:none),
// inject (insert HTML next to an element), reorder (move an element to the front of its parent).
// The default variants are generic: they refer to the run's own inventory through the
// placeholders {{cta}} (the primary above-the-fold CTA detected by the capture) and {{contactHref}}.

export const PATCH_TYPES = ['css', 'text', 'hide', 'inject', 'reorder']
const POSITIONS = ['beforebegin', 'afterbegin', 'beforeend', 'afterend']
const LIMITS = { variants: 8, patches: 12, selector: 300, text: 500, html: 4000, rule: 4000, name: 60, description: 200 }
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,30}$/
export const PRIMARY_CTA_SELECTOR = '[data-mc-primary-cta]'

const badgeStyle = 'display:inline-flex;align-items:center;gap:8px;margin:12px 0 0;padding:8px 14px;border:1px solid #d8dee9;border-radius:6px;background:#fff;color:#1f2937;font:600 13px/1.4 system-ui,sans-serif'
const barStyle = 'display:flex;justify-content:center;align-items:center;gap:18px;padding:12px 20px;background:#0f43f3;color:#fff;font:600 14px/1.4 system-ui,sans-serif'

export const defaultVariants = {
  control: { key: 'control', name: 'A · Control', description: '캡처한 사이트 그대로 (변형 없음)', color: '#8893a8', patches: [] },
  largeCTA: {
    key: 'largeCTA', name: 'B · 메인 CTA 강조', description: '첫 화면에서 감지한 주요 CTA의 크기·대비를 키워 시각적 현저성을 높입니다.', color: '#0f43f3',
    patches: [{ type: 'css', rule: '{{cta}}{font-size:1.25em!important;padding:18px 34px!important;font-weight:800!important;box-shadow:0 0 0 4px rgba(15,67,243,.28)!important;outline:2px solid #0f43f3!important;outline-offset:2px}' }]
  },
  trustBoost: {
    key: 'trustBoost', name: 'C · 신뢰 신호 추가', description: '주요 CTA 바로 아래에 중립적인 사회적 증거 배지를 추가합니다 (실제 수치로 교체해서 실험하세요).', color: '#f59e0b',
    patches: [{ type: 'inject', selector: '{{cta}}', position: 'afterend', html: `<div id="mc-trust-badge" style="${badgeStyle}"><span>★ 4.8/5 고객 만족도</span><span>·</span><span>1,000+ 팀 사용 중</span></div>` }]
  },
  contactFirst: {
    key: 'contactFirst', name: 'D · 문의 우선', description: '페이지 최상단에 문의 CTA 바를 삽입해 문의 경로를 한 단계 앞당깁니다.', color: '#a78bfa',
    patches: [{ type: 'inject', selector: 'body', position: 'afterbegin', html: `<div id="mc-contact-bar" style="${barStyle}"><span>도입 검토 중이신가요? 담당자가 바로 답변합니다.</span><a href="{{contactHref}}" style="color:#fff;text-decoration:underline;font-weight:800">문의하기 →</a></div>` }]
  }
}

function assertString(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}은(는) 비어 있지 않은 문자열이어야 합니다.`)
  if (value.length > max) throw new Error(`${label}이(가) 너무 깁니다 (최대 ${max}자).`)
  return value
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('패치는 객체여야 합니다.')
  if (!PATCH_TYPES.includes(patch.type)) throw new Error(`지원하지 않는 패치 유형: ${patch.type}`)
  const out = { type: patch.type }
  if (patch.type === 'css') out.rule = assertString(patch.rule, LIMITS.rule, 'css.rule')
  else out.selector = assertString(patch.selector, LIMITS.selector, `${patch.type}.selector`)
  if (patch.type === 'text') out.text = assertString(patch.text, LIMITS.text, 'text.text')
  if (patch.type === 'inject') {
    out.html = assertString(patch.html, LIMITS.html, 'inject.html')
    if (/<script|javascript:|on[a-z]+\s*=/i.test(out.html)) throw new Error('inject.html에는 스크립트나 인라인 이벤트 핸들러를 넣을 수 없습니다.')
    out.position = POSITIONS.includes(patch.position) ? patch.position : 'beforeend'
  }
  return out
}

export function validateCustomVariant(v) {
  if (!v || typeof v !== 'object') throw new Error('변형은 키 문자열이거나 객체여야 합니다.')
  if (!KEY_PATTERN.test(String(v.key || ''))) throw new Error('변형 key는 영문 소문자로 시작하는 31자 이하의 식별자여야 합니다.')
  if (!Array.isArray(v.patches) || v.patches.length > LIMITS.patches) throw new Error(`변형 ${v.key}: patches는 최대 ${LIMITS.patches}개의 배열이어야 합니다.`)
  return {
    key: v.key,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.slice(0, LIMITS.name) : v.key,
    description: typeof v.description === 'string' ? v.description.slice(0, LIMITS.description) : '사용자 정의 변형',
    color: /^#[0-9a-fA-F]{6}$/.test(String(v.color || '')) ? v.color : '#10b981',
    custom: true,
    patches: v.patches.map(validatePatch)
  }
}

// requested: array of default keys and/or custom variant objects. Control is always included.
export function resolveVariants(requested) {
  const list = Array.isArray(requested) && requested.length ? requested : ['control', 'largeCTA', 'trustBoost', 'contactFirst']
  if (list.length > LIMITS.variants) throw new Error(`변형은 최대 ${LIMITS.variants}개까지 지정할 수 있습니다.`)
  const out = new Map()
  for (const item of list) {
    if (typeof item === 'string') {
      if (!defaultVariants[item]) throw new Error(`알 수 없는 변형: ${item}`)
      out.set(item, { ...defaultVariants[item] })
    } else {
      const v = validateCustomVariant(item)
      if (defaultVariants[v.key]) throw new Error(`변형 key ${v.key}는 기본 변형과 겹칩니다.`)
      out.set(v.key, v)
    }
  }
  if (!out.has('control')) out.set('control', { ...defaultVariants.control })
  return [out.get('control'), ...[...out.values()].filter(v => v.key !== 'control')]
}

// Fill the placeholders with what the capture found on the target site.
export function bindVariant(variant, site) {
  const contactHref = site.contactHref || site.ctaHref || '/'
  const replace = s => String(s).replaceAll('{{cta}}', PRIMARY_CTA_SELECTOR).replaceAll('{{contactHref}}', contactHref)
  return { ...variant, patches: variant.patches.map(p => ({ ...p, ...(p.rule ? { rule: replace(p.rule) } : {}), ...(p.selector ? { selector: replace(p.selector) } : {}), ...(p.html ? { html: replace(p.html) } : {}) })) }
}

// Run inside the page: tag the primary CTA so CSS/inject patches and the observer can find it.
function markPrimaryCta({ text, href }) {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const path = (() => { try { return href ? new URL(href, location.href).pathname : '' } catch { return '' } })()
  const candidates = [...document.querySelectorAll('a[href],button,[role="button"]')].filter(el => !el.closest('nav'))
  let el = path ? candidates.find(c => { try { return c.tagName === 'A' && new URL(c.href, location.href).pathname === path } catch { return false } }) : null
  if (!el && text) el = candidates.find(c => norm(c.textContent).startsWith(norm(text).slice(0, 20)))
  if (!el) el = candidates.find(c => c.getBoundingClientRect().top < innerHeight && /(^|\s)(btn|button|cta|primary)(\s|$)/i.test(c.className || ''))
  if (el) el.setAttribute('data-mc-primary-cta', '')
  return !!el
}

export async function applyVariant(page, variant, site = {}) {
  const applied = []
  try { await page.evaluate(markPrimaryCta, { text: site.ctaText || '', href: site.ctaHref || '' }) } catch { /* page may be mid-navigation */ }
  for (const patch of variant?.patches || []) {
    try {
      if (patch.type === 'css') await page.addStyleTag({ content: patch.rule })
      else if (patch.type === 'hide') await page.addStyleTag({ content: `${patch.selector}{display:none!important}` })
      else if (patch.type === 'text') {
        await page.evaluate(({ selector, text }) => {
          document.querySelectorAll(selector).forEach(el => {
            const node = [...el.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim())
            if (node) node.nodeValue = text; else el.textContent = text
          })
        }, patch)
      } else if (patch.type === 'inject') {
        await page.evaluate(({ selector, html, position }) => {
          const el = document.querySelector(selector)
          if (el) el.insertAdjacentHTML(position || 'beforeend', html)
        }, patch)
      } else if (patch.type === 'reorder') {
        await page.evaluate(({ selector }) => {
          const el = document.querySelector(selector)
          if (el?.parentElement) el.parentElement.prepend(el)
        }, patch)
      }
      applied.push(patch.type)
    } catch { /* patches are best-effort; a missing selector must not stop the session */ }
  }
  return applied
}

export function publicVariant(v) { return { key: v.key, name: v.name, description: v.description, color: v.color, custom: !!v.custom, patches: v.patches.length } }
