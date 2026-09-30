// Site-matched persona generation, ported from the prototype's recon → site_context → archetypes →
// nemotron_sampler → behavior_model pipeline and generalized to any captured site:
//   1. site character   – what the site sells, for whom, in what tone, with which conversion goals.
//                         LLM (JSON, validated) when LLM_API_KEY is set, keyword/CTA/title heuristics otherwise.
//   2. archetypes       – visitor archetypes with shares, demographic filters, traits, interests, goal.
//                         LLM when configured, otherwise a rule table keyed on the detected industry.
//   3. sampling         – real people per archetype: from the bundled 928-persona pool by archetype→segment
//                         affinity + demographic match, or from a local Nemotron-Personas-Korea export
//                         (NEMOTRON_PERSONAS_PATH, JSONL) with progressive filter relaxation.
//   4. behaviour priors – per-persona conversion propensity, engagement, sentiment and NPS priors from the
//                         probabilistic behaviour model, plus a share propensity used for the K-factor.
// The recon step is the run's own page inventory; nothing is crawled again.
import fs from 'node:fs'
import readline from 'node:readline'
import { loadPool } from './personas.js'
import { seededRandom, hashSeed } from './random.js'
import { llmConfig } from './engine.js'
import { llmJson } from './llm.js'

export const GEN_LIMITS = { count: [5, 300], archetypes: [3, 9] }
export const TRAIT_KEYS = ['patience', 'visualSensitivity', 'copyImportance', 'ctaResponse', 'priceConsciousness', 'socialProofSensitivity']
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d
const clampInt = (value, [min, max], fallback) => { const n = Number(value); return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback }

export function normalizeGenParams(body = {}) {
  return {
    count: clampInt(body.count, GEN_LIMITS.count, 60),
    archetypes: clampInt(body.archetypes, GEN_LIMITS.archetypes, 6),
    seed: body.seed === undefined || body.seed === null || body.seed === '' ? 42 : String(body.seed).slice(0, 40),
    policy: body.policy === 'heuristic' ? 'heuristic' : llmConfig().configured ? 'llm' : 'heuristic'
  }
}

// ── 1. site character ───────────────────────────────────────────────────────
const STOP = new Set(['그리고', '또는', '하지만', '위해', '통해', '대한', '있는', '있습니다', '합니다', '됩니다', '하세요', '입니다', '이제', '지금', '바로', '모든', '가장', '함께', '여기', '그것', 'the', 'and', 'for', 'with', 'your', 'you', 'our', 'are', 'that', 'this', 'from', 'more', 'all', 'get', 'new', 'now', 'how', 'what', 'why', 'into', 'about', 'https', 'http', 'www', 'com'])
const PARTICLES = /(은|는|이|가|을|를|의|에|에서|로|으로|과|와|도|만|까지|부터|처럼)$/

export function tokenize(text) {
  const counts = new Map()
  for (const raw of String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+.'-]*/gu) || []) {
    let t = raw.replace(/^[.'-]+|[.'-]+$/g, '')
    if (t.length > 2 && /[가-힣]/.test(t)) t = t.replace(PARTICLES, '')
    if (t.length < 2 || t.length > 14 || STOP.has(t) || /^\d+$/.test(t)) continue
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export const INDUSTRIES = {
  saas: { label: 'SaaS · 소프트웨어', lean: 'B2B', age: '25–44', keywords: ['솔루션', '도입', '워크스페이스', '협업', '자동화', '대시보드', '데모', 'saas', 'software', 'platform', 'workspace', 'api', 'integration', '무료 체험', 'trial', '팀', '생산성', '연동', 'app', '앱'] },
  commerce: { label: '커머스 · 쇼핑', lean: 'B2C', age: '20–39', keywords: ['장바구니', '구매', '배송', '할인', '쇼핑', '상품', '세일', 'shop', 'cart', 'checkout', '무료배송', '주문', '리뷰', '베스트', '신상품', 'sale', 'buy'] },
  agency: { label: '에이전시 · 서비스', lean: 'B2B', age: '28–45', keywords: ['대행', '포트폴리오', '견적', '프로젝트', '클라이언트', '에이전시', '제작', 'agency', 'portfolio', 'quote', '캠페인', '컨설팅', '사례', '레퍼런스', '기획'] },
  education: { label: '교육 · 클래스', lean: 'B2C', age: '18–34', keywords: ['강의', '수강', '교육', '학습', '클래스', '커리큘럼', 'course', 'learn', '튜터', '부트캠프', '수업', '강사', '자격증'] },
  finance: { label: '금융 · 투자', lean: 'B2C', age: '30–54', keywords: ['투자', '대출', '보험', '금융', '계좌', '자산', '수익률', 'finance', 'loan', 'invest', '펀드', '적금', '카드'] },
  health: { label: '헬스케어 · 의료', lean: 'B2C', age: '30–59', keywords: ['병원', '진료', '건강', '클리닉', '시술', 'health', 'clinic', '의료', '검진', '치료', '피부'] },
  travel: { label: '여행 · 숙박', lean: 'B2C', age: '20–49', keywords: ['여행', '숙소', '호텔', '항공', 'travel', 'hotel', 'booking', '투어', '패키지', '출발'] },
  realestate: { label: '공간 · 부동산', lean: 'B2B', age: '30–59', keywords: ['부동산', '임대', '매물', '오피스', '공간', '매장', '상가', '팝업', 'property', 'lease', '입점', '건물', '평'] },
  media: { label: '미디어 · 커뮤니티', lean: 'B2C', age: '20–39', keywords: ['뉴스', '기사', '콘텐츠', '구독', '뉴스레터', '커뮤니티', '블로그', 'media', 'newsletter', 'blog', '매거진', '아티클', '에디터'] },
  recruiting: { label: '채용 · 커리어', lean: 'B2C', age: '20–34', keywords: ['채용', '공고', '이력서', '구직', '인재', '커리어', 'career', 'jobs', 'hiring', '지원하기', '포지션'] },
  general: { label: '일반 웹사이트', lean: 'B2B2C', age: '20–49', keywords: [] }
}
const B2B_WORDS = ['도입', '기업', '솔루션', '견적', '데모', '팀', '조직', '고객사', '파트너', '비즈니스', '담당자', '상담', 'enterprise', 'b2b', 'business', 'teams', 'demo', 'sales', 'api', '컨설팅', '대행']
const B2C_WORDS = ['구매', '할인', '배송', '회원가입', '앱', '리뷰', '쿠폰', '개인', '나만의', '취미', '일상', '무료 체험', 'download', 'shop', 'buy', 'personal', '이벤트', '추천']
const count = (blob, words) => words.reduce((n, w) => n + (blob.includes(w.toLowerCase()) ? 1 : 0), 0)

export function detectIndustry(blob) {
  const scored = Object.entries(INDUSTRIES).filter(([k]) => k !== 'general').map(([key, def]) => ({ key, score: count(blob, def.keywords) }))
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return scored[0]?.score >= 2 ? scored[0].key : 'general'
}

function pageBlob(run) {
  const pages = (run.report?.pages || []).filter(p => !p.error)
  const home = pages[0] || {}
  const text = pages.flatMap(p => [p.title, p.description, ...(p.h1 || []), ...(p.headings || []), ...(p.ctas || []).map(c => c.text), ...(p.links || []).map(l => l.text)]).filter(Boolean).join(' \n ')
  return { pages, home, blob: text.toLowerCase(), text }
}

export function buildSiteCharacter(run) {
  const { pages, home, blob, text } = pageBlob(run)
  const origin = (() => { try { return new URL(run.url).origin } catch { return '' } })()
  const industry = detectIndustry(blob)
  const b2b = count(blob, B2B_WORDS), b2c = count(blob, B2C_WORDS)
  const lean = INDUSTRIES[industry].lean
  const businessType = b2b > b2c + 1 ? 'B2B' : b2c > b2b + 1 ? 'B2C' : lean
  const ctaTexts = [...new Set(pages.flatMap(p => (p.ctas || []).map(c => c.text.trim())).filter(t => t && t.length <= 40))]
  const navLabels = [...new Set((home.links || []).map(l => l.text.trim()).filter(t => t && t.length <= 20 && !ctaTexts.includes(t)))].slice(0, 8)
  const headings = [...new Set(pages.flatMap(p => p.headings || []).map(h => h.trim()).filter(Boolean))].slice(0, 6)
  const tokens = tokenize(text)
  const keyTerms = tokens.slice(0, 12).map(([t]) => t)
  const paths = pages.map(p => { try { return new URL(p.url).pathname.toLowerCase() } catch { return '' } }).join(' ')
  const signals = {
    industry, pageCount: pages.length, ctaCount: ctaTexts.length, formCount: pages.reduce((n, p) => n + (p.forms || []).length, 0), formFields: Math.max(0, ...pages.flatMap(p => (p.forms || []).map(f => f.fields))),
    hasPricing: /pricing|price|plans|요금|가격/.test(paths + ' ' + blob), hasContact: /contact|문의|상담|demo/.test(paths + ' ' + blob), hasSignup: /signup|sign-up|register|가입|회원/.test(paths + ' ' + blob),
    hasSocialProof: /후기|리뷰|사례|고객사|testimonial|review|trusted|\d[\d,]*\s*(명|팀|개|건|\+)/.test(blob), hasVisuals: /비주얼|이미지|사진|영상|갤러리|포토|visual|gallery|photo|video/.test(blob), priceVisible: /무료|free|할인|₩|원\b|\$\d/.test(blob)
  }
  const oneLiner = (home.description || home.h1?.[0] || home.title || origin).replace(/\s+/g, ' ').trim().slice(0, 200)
  const tone = [signals.ctaCount >= 3 ? '행동 유도형' : '설명 중심', signals.hasVisuals ? '비주얼 강조' : '텍스트 중심', /지금|바로|무료|now|free|today/.test(blob) ? '직접적' : '차분한'].join(' · ')
  const audience = businessType === 'B2B' ? `${INDUSTRIES[industry].label} 분야에서 도입·구매를 검토하는 실무자와 의사결정자. 근거(사례, 가격, 절차)를 확인한 뒤 문의·데모·견적으로 이동합니다.`
    : businessType === 'B2C' ? `${INDUSTRIES[industry].label} 관심층인 개인 방문자. 첫 화면의 가치 제안과 가격·후기에 반응하고, 가입·구매·예약으로 이어집니다.`
    : `${INDUSTRIES[industry].label}에 관심 있는 개인과 팀 방문자. 사이트 설명과 CTA를 보고 목적에 맞는 경로를 찾습니다.`
  return {
    serviceOneLiner: oneLiner, businessType, industry, industryLabel: INDUSTRIES[industry].label,
    mainNavigation: navLabels.map(label => ({ label, purpose: '' })),
    contentTypes: headings.length ? headings : keyTerms.slice(0, 4),
    conversionGoals: ctaTexts.slice(0, 5).length ? ctaTexts.slice(0, 5) : ['사이트 방문'],
    designTone: tone, targetAudienceSummary: audience,
    audienceSignals: { b2bVsB2c: businessType === 'B2B' ? 'b2b' : businessType === 'B2C' ? 'b2c' : 'mixed', ageSkew: INDUSTRIES[industry].age, keyInterests: keyTerms.slice(0, 8) },
    glossary: {}, keyTerms, signals, source: 'heuristic'
  }
}

export function siteBrief(c) {
  if (!c) return ''
  const nav = (c.mainNavigation || []).slice(0, 6).map(n => n.label).join(' · ')
  return `${c.serviceOneLiner}\n비즈니스 유형: ${c.businessType} (${c.industryLabel || c.industry || ''}). 메인 네비: ${nav || '-'}. 핵심 콘텐츠: ${(c.contentTypes || []).slice(0, 4).join(', ') || '-'}. 핵심 전환 목표: ${(c.conversionGoals || []).join(', ')}. 타깃: ${c.targetAudienceSummary || ''} (성향 ${c.audienceSignals?.b2bVsB2c || ''}, 주 연령 ${c.audienceSignals?.ageSkew || ''}). 디자인 톤: ${c.designTone || ''}`.trim()
}

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max)
const strList = (v, max, n) => (Array.isArray(v) ? v : []).map(x => str(typeof x === 'object' && x ? x.label || x.name || '' : x, max)).filter(Boolean).slice(0, n)

// Accepts the LLM's site character only if it carries the required fields; everything else is
// normalized onto the heuristic version so downstream code always sees one shape.
export function validateCharacter(data, fallback) {
  if (!data || typeof data !== 'object' || !str(data.service_one_liner ?? data.serviceOneLiner, 200)) throw new Error('site character: service_one_liner 누락')
  const bt = str(data.business_type ?? data.businessType, 10).toUpperCase()
  const nav = (Array.isArray(data.main_navigation ?? data.mainNavigation) ? (data.main_navigation ?? data.mainNavigation) : []).map(n => typeof n === 'object' && n ? { label: str(n.label, 30), purpose: str(n.purpose, 60) } : { label: str(n, 30), purpose: '' }).filter(n => n.label).slice(0, 10)
  const sig = data.audience_signals ?? data.audienceSignals ?? {}
  const glossary = {}
  for (const [k, v] of Object.entries(data.glossary && typeof data.glossary === 'object' ? data.glossary : {}).slice(0, 12)) if (str(k, 30)) glossary[str(k, 30)] = str(v, 120)
  return {
    ...fallback,
    serviceOneLiner: str(data.service_one_liner ?? data.serviceOneLiner, 200),
    businessType: ['B2B', 'B2C', 'B2B2C'].includes(bt) ? bt : fallback.businessType,
    mainNavigation: nav.length ? nav : fallback.mainNavigation,
    contentTypes: strList(data.content_types ?? data.contentTypes, 40, 8).length ? strList(data.content_types ?? data.contentTypes, 40, 8) : fallback.contentTypes,
    conversionGoals: strList(data.conversion_goals ?? data.conversionGoals, 40, 6).length ? strList(data.conversion_goals ?? data.conversionGoals, 40, 6) : fallback.conversionGoals,
    designTone: str(data.design_tone ?? data.designTone, 80) || fallback.designTone,
    targetAudienceSummary: str(data.target_audience_summary ?? data.targetAudienceSummary, 400) || fallback.targetAudienceSummary,
    audienceSignals: { b2bVsB2c: ['b2b', 'b2c', 'mixed'].includes(String(sig.b2b_vs_b2c ?? sig.b2bVsB2c).toLowerCase()) ? String(sig.b2b_vs_b2c ?? sig.b2bVsB2c).toLowerCase() : fallback.audienceSignals.b2bVsB2c, ageSkew: str(sig.age_skew ?? sig.ageSkew, 20) || fallback.audienceSignals.ageSkew, keyInterests: strList(sig.key_interests ?? sig.keyInterests, 20, 10).length ? strList(sig.key_interests ?? sig.keyInterests, 20, 10) : fallback.audienceSignals.keyInterests },
    glossary, source: 'llm'
  }
}

function reconDigest(run, character) {
  const pages = (run.report?.pages || []).filter(p => !p.error).slice(0, 8)
  const lines = [`타깃: ${run.url}`, `페이지 수: ${pages.length}`, `발견된 CTA: ${character.conversionGoals.join(', ')}`]
  pages.forEach((p, i) => { lines.push(`[페이지 ${i + 1}] ${p.title || ''} (${p.url})`); if (p.description) lines.push(`  설명: ${p.description.slice(0, 200)}`); if (p.h1?.length) lines.push(`  H1: ${p.h1.slice(0, 3).join(' / ')}`); if (p.headings?.length) lines.push(`  H2: ${p.headings.slice(0, 6).join(' / ')}`); if (p.links?.length) lines.push(`  링크: ${[...new Set(p.links.map(l => l.text))].slice(0, 12).join(' · ')}`); if (p.forms?.length) lines.push(`  양식: ${p.forms.map(f => f.fields + '개 필드').join(', ')}`) })
  return lines.join('\n').slice(0, 6000)
}

export async function llmSiteCharacter(run, fallback, fetchImpl) {
  const data = await llmJson([
    { role: 'system', content: '당신은 디지털 마케팅 리서처입니다. 웹사이트 정찰(recon) 데이터를 분석해 그 사이트의 캐릭터(무슨 서비스인지, 누구를 위한 것인지, 어떤 행동을 유도하는지)를 구조화된 JSON으로 요약합니다. 추측보다 recon에서 실제로 관찰된 근거를 우선합니다. 반드시 유효한 JSON만 출력.' },
    { role: 'user', content: `다음은 실제 웹사이트 정찰 결과입니다.\n\n${reconDigest(run, fallback)}\n\n이 사이트의 캐릭터를 아래 JSON 스키마로 요약하세요. 모든 텍스트는 한국어로.\n{"service_one_liner":"한 줄 서비스 정의","business_type":"B2B | B2C | B2B2C","main_navigation":[{"label":"메뉴명","purpose":"역할"}],"content_types":["콘텐츠/서비스 종류"],"conversion_goals":["핵심 전환 행동"],"design_tone":"톤·무드 한 줄","target_audience_summary":"핵심 타깃 2~3문장","audience_signals":{"b2b_vs_b2c":"b2b|b2c|mixed","age_skew":"주 연령대","key_interests":["관심사 키워드"]},"glossary":{"핵심 용어":"의미"}}` }
  ], { temperature: 0.3, maxTokens: 2200, fetchImpl })
  return validateCharacter(data, fallback)
}

// ── 2. archetypes ───────────────────────────────────────────────────────────
const T = (patience, visual, copy, cta, price, social) => ({ patience, visualSensitivity: visual, copyImportance: copy, ctaResponse: cta, priceConsciousness: price, socialProofSensitivity: social })
const BASE_B2B = [
  { id: 'decision_maker', label: '의사결정자', share: 0.24, age: [32, 52], occupation: ['대표', '임원', '팀장', '매니저', '경영', '기획', '관리자'], traits: T(0.7, 0.5, 0.75, 0.55, 0.45, 0.7), goal: 0, rationale: '도입 여부를 결정하는 관리자. 근거와 사례, 비용 대비 효과를 본다.' },
  { id: 'practitioner', label: '실무 담당자', share: 0.34, age: [26, 42], occupation: ['마케팅', '운영', '기획', '영업', '디자인', '개발', '사무', '홍보'], traits: T(0.55, 0.65, 0.65, 0.6, 0.5, 0.6), goal: 0, rationale: '실제로 사용할 사람. 기능과 절차, 도입 난이도를 확인한다.' },
  { id: 'researcher', label: '리서처 · 검토자', share: 0.18, age: [24, 45], occupation: ['연구', '분석', '컨설팅', '리서치', '조사', '데이터'], traits: T(0.9, 0.4, 0.85, 0.35, 0.55, 0.5), goal: 0, rationale: '비교 자료를 모으는 단계. 문서·가격·레퍼런스를 꼼꼼히 읽는다.' },
  { id: 'budget_explorer', label: '예산 탐색자', share: 0.14, age: [28, 50], occupation: ['자영업', '창업', '소상공인', '사업', '점주', '프리랜서'], traits: T(0.5, 0.55, 0.55, 0.55, 0.85, 0.65), goal: 0, rationale: '한정된 예산으로 대안을 찾는 소규모 사업자. 가격에 민감하다.' },
  { id: 'returning_skeptic', label: '재방문 회의론자', share: 0.1, age: [30, 55], occupation: [], traits: T(0.45, 0.45, 0.7, 0.4, 0.6, 0.8), goal: 0, rationale: '이미 한 번 본 뒤 다시 온 방문자. 새 근거가 없으면 빠르게 떠난다.' }
]
const BASE_B2C = [
  { id: 'trend_seeker', label: '트렌드 탐색자', share: 0.26, age: [19, 32], sex: '여자', occupation: [], traits: T(0.45, 0.9, 0.5, 0.65, 0.5, 0.8), goal: 0, rationale: '새롭고 눈에 띄는 것을 찾는 젊은 방문자. 비주얼과 SNS 반응에 민감하다.' },
  { id: 'value_shopper', label: '가성비 소비자', share: 0.24, age: [25, 45], occupation: [], traits: T(0.6, 0.55, 0.65, 0.55, 0.9, 0.7), goal: 0, rationale: '가격 대비 가치를 따진다. 할인·비교 정보가 있어야 움직인다.' },
  { id: 'casual_visitor', label: '캐주얼 방문자', share: 0.22, age: [20, 40], occupation: [], traits: T(0.35, 0.7, 0.45, 0.45, 0.5, 0.55), goal: 0, rationale: '목적 없이 들른 방문자. 첫 화면에서 흥미를 못 느끼면 바로 떠난다.' },
  { id: 'loyal_fan', label: '충성 팬', share: 0.12, age: [16, 30], occupation: [], traits: T(0.75, 0.8, 0.5, 0.8, 0.3, 0.6), goal: 0, rationale: '브랜드나 주제에 이미 애착이 있어 전환 의지가 높다.' },
  { id: 'careful_comparer', label: '꼼꼼한 비교자', share: 0.16, age: [28, 50], occupation: [], traits: T(0.9, 0.45, 0.85, 0.4, 0.7, 0.75), goal: 0, rationale: '여러 대안을 비교한 뒤 결정한다. 후기와 상세 설명을 끝까지 읽는다.' }
]
const EXTRAS = {
  saas: [{ id: 'team_lead_evaluator', label: '팀 리드 평가자', share: 0.16, age: [29, 45], occupation: ['팀장', '리드', '매니저', 'pm', '개발', '기획'], traits: T(0.65, 0.6, 0.7, 0.6, 0.5, 0.65), goal: 0, rationale: '팀에 도입할 도구를 평가한다. 협업 기능과 연동, 무료 체험을 본다.' }],
  commerce: [{ id: 'gift_buyer', label: '선물 구매자', share: 0.12, age: [24, 45], occupation: [], traits: T(0.5, 0.75, 0.5, 0.7, 0.55, 0.7), goal: 0, rationale: '남에게 줄 것을 고른다. 배송과 포장, 후기를 본다.' }],
  agency: [{ id: 'brand_marketer', label: '브랜드 마케터', share: 0.22, age: [27, 42], occupation: ['마케팅', '브랜드', '홍보', '광고', '기획'], traits: T(0.6, 0.75, 0.7, 0.6, 0.45, 0.8), goal: 0, rationale: '캠페인 파트너를 찾는 마케터. 포트폴리오와 실적 수치를 본다.' }, { id: 'event_planner', label: '행사 기획자', share: 0.1, age: [26, 45], occupation: ['기획', '이벤트', '행사', '운영'], traits: T(0.55, 0.7, 0.6, 0.65, 0.6, 0.7), goal: 0, rationale: '정해진 일정과 예산 안에서 실행 파트너를 찾는다.' }],
  education: [{ id: 'career_switcher', label: '커리어 전환자', share: 0.2, age: [24, 38], occupation: [], traits: T(0.7, 0.5, 0.8, 0.6, 0.7, 0.75), goal: 0, rationale: '직무 전환을 위해 배우려는 사람. 커리큘럼과 수료 후 결과를 본다.' }, { id: 'parent', label: '학부모', share: 0.12, age: [35, 52], occupation: [], traits: T(0.7, 0.4, 0.75, 0.5, 0.65, 0.85), goal: 0, rationale: '자녀를 위해 알아본다. 안전성과 후기를 중시한다.' }],
  finance: [{ id: 'first_investor', label: '첫 투자자', share: 0.2, age: [24, 36], occupation: [], traits: T(0.6, 0.5, 0.8, 0.5, 0.75, 0.8), goal: 0, rationale: '처음 시작하는 사람. 쉬운 설명과 신뢰 신호가 필요하다.' }],
  health: [{ id: 'caregiver', label: '보호자', share: 0.18, age: [35, 60], occupation: [], traits: T(0.75, 0.4, 0.8, 0.55, 0.55, 0.85), goal: 0, rationale: '가족을 대신해 알아본다. 전문성과 후기, 예약 절차를 본다.' }],
  travel: [{ id: 'family_planner', label: '가족 여행 기획자', share: 0.18, age: [30, 50], occupation: [], traits: T(0.7, 0.7, 0.6, 0.55, 0.75, 0.75), goal: 0, rationale: '여러 사람의 일정과 예산을 맞춘다. 가격과 취소 규정을 본다.' }],
  realestate: [{ id: 'space_owner', label: '공간 · 건물 소유주', share: 0.16, age: [38, 62], occupation: ['임대', '부동산', '건물', '소유', '사업'], traits: T(0.75, 0.4, 0.7, 0.45, 0.6, 0.6), goal: 0, rationale: '공간을 채울 파트너를 찾는다. 조건과 절차, 실적을 본다.' }, { id: 'tenant_brand', label: '입점 검토 브랜드', share: 0.16, age: [27, 45], occupation: ['마케팅', '브랜드', '유통', 'md', '영업'], traits: T(0.6, 0.7, 0.65, 0.6, 0.6, 0.75), goal: 0, rationale: '매장이나 팝업을 낼 곳을 찾는다. 위치·비용·사례를 본다.' }],
  media: [{ id: 'newsletter_subscriber', label: '뉴스레터 구독 후보', share: 0.2, age: [22, 40], occupation: [], traits: T(0.55, 0.5, 0.85, 0.6, 0.35, 0.6), goal: 0, rationale: '읽을거리를 찾는다. 글의 질과 빈도를 보고 구독을 결정한다.' }],
  recruiting: [{ id: 'jobseeker', label: '구직자', share: 0.3, age: [22, 35], occupation: [], traits: T(0.6, 0.5, 0.8, 0.7, 0.4, 0.6), goal: 0, rationale: '지원할 곳을 찾는다. 직무 설명과 회사 정보, 지원 절차를 본다.' }],
  general: []
}

export function heuristicArchetypes(character, n = 6) {
  const b2b = character.audienceSignals?.b2bVsB2c === 'b2b' || (character.audienceSignals?.b2bVsB2c !== 'b2c' && character.businessType === 'B2B')
  const base = b2b ? BASE_B2B : BASE_B2C
  const extras = EXTRAS[character.industry] || []
  const list = [...extras, ...base].slice(0, n)
  const goals = character.conversionGoals?.length ? character.conversionGoals : ['사이트 전환']
  const interests = character.audienceSignals?.keyInterests?.length ? character.audienceSignals.keyInterests : character.keyTerms || []
  return normalizeArchetypes(list.map((a, i) => ({
    id: a.id, label: a.label, share: a.share,
    demographicFilters: { age: a.age, ...(a.sex ? { sex: a.sex } : {}), occupationKeywords: a.occupation, hobbiesKeywords: [] },
    traits: a.traits, interestKeywords: interests.slice(0, 8), avoidKeywords: b2b ? ['채용', '로그인'] : ['채용', 'B2B'],
    conversionGoal: goals[i % goals.length], rationale: a.rationale
  })))
}

export function normalizeArchetypes(list) {
  const cleaned = []
  for (const [i, a] of (Array.isArray(list) ? list : []).entries()) {
    if (!a || typeof a !== 'object') continue
    const id = str(a.id, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `archetype_${i + 1}`
    const traits = {}
    for (const k of TRAIT_KEYS) { const v = Number(a.traits?.[k]); traits[k] = Number.isFinite(v) ? clamp(v, 0, 1) : 0.5 }
    const f = a.demographicFilters ?? a.demographic_filters ?? {}
    const filters = {}
    if (Array.isArray(f.age) && f.age.length === 2 && f.age.every(x => Number.isFinite(Number(x)))) filters.age = [clamp(Math.round(Number(f.age[0])), 14, 90), clamp(Math.round(Number(f.age[1])), 14, 90)].sort((x, y) => x - y)
    if (['남자', '여자'].includes(f.sex)) filters.sex = f.sex
    filters.occupationKeywords = strList(f.occupationKeywords ?? f.occupation_keywords, 20, 10)
    filters.hobbiesKeywords = strList(f.hobbiesKeywords ?? f.hobbies_keywords, 20, 10)
    filters.provinces = strList(f.province ?? f.provinces, 10, 10)
    filters.educationLevels = strList(f.education_level ?? f.educationLevels, 20, 6)
    cleaned.push({ id, label: str(a.label, 60) || id, share: Math.max(0, Number(a.share) || 0), demographicFilters: filters, traits, interestKeywords: strList(a.interestKeywords ?? a.interest_keywords, 30, 12), avoidKeywords: strList(a.avoidKeywords ?? a.avoid_keywords, 30, 10), conversionGoal: str(a.conversionGoal ?? a.conversion_goal, 80), rationale: str(a.rationale, 160) })
  }
  const seen = new Set()
  const unique = cleaned.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true })
  const total = unique.reduce((s, a) => s + a.share, 0)
  for (const a of unique) a.share = round(total > 0 ? a.share / total : 1 / unique.length, 4)
  return unique
}

export function allocateCounts(archetypes, total) {
  const raw = archetypes.map(a => a.share * total)
  const floor = raw.map(Math.floor)
  let remaining = Math.max(0, total) - floor.reduce((s, n) => s + n, 0)
  const order = raw.map((v, i) => ({ i, frac: v - floor[i] })).sort((x, y) => y.frac - x.frac || x.i - y.i)
  for (let j = 0; j < remaining; j++) floor[order[j % order.length].i]++
  archetypes.forEach((a, i) => { a.sampleN = floor[i] })
  return archetypes
}

export async function llmArchetypes(character, n, fallback, fetchImpl) {
  const data = await llmJson([
    { role: 'system', content: '당신은 소비자 인사이트 전략가입니다. 한 웹사이트의 캐릭터가 주어지면 그 사이트를 실제로 방문할 법한 사용자층을 아키타입으로 세분화합니다. 각 아키타입은 한국 인구통계 데이터셋에서 인물을 필터링할 조건과 행동 성향 점수를 가집니다. 사이트의 비즈니스 유형과 전환 목표에 맞게 현실적으로 구성하세요. JSON만 출력.' },
    { role: 'user', content: `[사이트 캐릭터]\n${siteBrief(character)}\n\n[필터 값] sex: "남자"/"여자"/null; education_level: 고등학교/2~3년제 전문대학/4년제 대학교/대학원; province: 서울/경기/인천/부산/대구/대전/광주/울산/세종/강원/충북/충남/전북/전남/경북/경남/제주; occupation_keywords·hobbies_keywords는 자유 키워드(부분 문자열 매칭).\n\n위 사이트를 방문할 사용자층을 ${n}개 아키타입으로 도출하세요. share 합은 1.0. traits는 0~1.\n반드시 이 JSON 형태로만:\n{"archetypes":[{"id":"snake_case_영문","label":"한국어 라벨","share":0.15,"demographic_filters":{"age":[최소,최대],"sex":"남자|여자|null","education_level":["..."],"province":["..."],"occupation_keywords":["..."],"hobbies_keywords":["..."]},"traits":{"patience":0.6,"visualSensitivity":0.7,"copyImportance":0.6,"ctaResponse":0.5,"priceConsciousness":0.5,"socialProofSensitivity":0.6},"interest_keywords":["..."],"avoid_keywords":["..."],"conversion_goal":"핵심 전환 목표","rationale":"왜 이 사이트의 방문자인지 한 줄"}]}` }
  ], { temperature: 0.6, maxTokens: 4000, fetchImpl })
  const list = normalizeArchetypes(data?.archetypes)
  if (list.length < 2) throw new Error('archetypes: 아키타입이 2개 미만')
  return list.slice(0, GEN_LIMITS.archetypes[1])
}

// ── 3. sampling ─────────────────────────────────────────────────────────────
// Archetype → bundled segment affinity for the generic archetype ids; unknown ids match every segment weakly.
const SEGMENT_AFFINITY = {
  decision_maker: { brand_marketer_large: 1, md_manager: 0.6, building_owner: 0.5, brand_marketer_startup: 0.4 },
  practitioner: { brand_marketer_startup: 1, brand_marketer_large: 0.7, md_manager: 0.5, retail_tenant: 0.4 },
  researcher: { retail_trend_watcher: 1, brand_marketer_large: 0.4, md_manager: 0.3 },
  budget_explorer: { franchise_explorer: 1, retail_tenant: 0.5, brand_marketer_startup: 0.3 },
  returning_skeptic: { building_owner: 0.6, brand_marketer_large: 0.5, md_manager: 0.5, retail_tenant: 0.4 },
  team_lead_evaluator: { brand_marketer_startup: 1, brand_marketer_large: 0.6 },
  trend_seeker: { popup_enthusiast: 1, kpop_fan: 0.7, retail_trend_watcher: 0.3 },
  value_shopper: { popup_enthusiast: 0.6, franchise_explorer: 0.5, jobseeker: 0.3, kpop_fan: 0.3 },
  casual_visitor: { popup_enthusiast: 0.5, kpop_fan: 0.5, jobseeker: 0.4, retail_trend_watcher: 0.3 },
  loyal_fan: { kpop_fan: 1, popup_enthusiast: 0.6 },
  careful_comparer: { retail_trend_watcher: 0.8, building_owner: 0.5, franchise_explorer: 0.5 },
  gift_buyer: { popup_enthusiast: 0.8, kpop_fan: 0.5 },
  brand_marketer: { brand_marketer_large: 1, brand_marketer_startup: 1 },
  event_planner: { brand_marketer_startup: 0.8, md_manager: 0.6, popup_enthusiast: 0.3 },
  career_switcher: { jobseeker: 1, brand_marketer_startup: 0.3 },
  parent: { building_owner: 0.4, retail_tenant: 0.3, brand_marketer_large: 0.3 },
  first_investor: { jobseeker: 0.6, brand_marketer_startup: 0.5, popup_enthusiast: 0.3 },
  caregiver: { building_owner: 0.5, md_manager: 0.3, retail_tenant: 0.3 },
  family_planner: { building_owner: 0.5, brand_marketer_large: 0.4, md_manager: 0.4 },
  space_owner: { building_owner: 1, retail_tenant: 0.3 },
  tenant_brand: { retail_tenant: 1, brand_marketer_startup: 0.6, md_manager: 0.5 },
  newsletter_subscriber: { retail_trend_watcher: 0.8, brand_marketer_startup: 0.5, popup_enthusiast: 0.4 },
  jobseeker: { jobseeker: 1 }
}

export function matchScore(persona, archetype) {
  const f = archetype.demographicFilters || {}
  const d = persona.demographics || {}
  let score = 0
  if (f.age) { const age = Number(d.age); if (Number.isFinite(age)) score += age >= f.age[0] && age <= f.age[1] ? 1 : Math.max(0, 1 - Math.min(Math.abs(age - f.age[0]), Math.abs(age - f.age[1])) / 12) }
  if (f.sex) score += d.sex === f.sex ? 0.5 : 0
  const occ = `${d.occupation || ''} ${persona.description || ''}`.toLowerCase()
  if (f.occupationKeywords?.length) score += f.occupationKeywords.some(k => occ.includes(k.toLowerCase())) ? 1.5 : 0
  if (f.hobbiesKeywords?.length) score += f.hobbiesKeywords.some(k => occ.includes(k.toLowerCase())) ? 0.5 : 0
  if (f.provinces?.length) score += f.provinces.some(p => String(d.province || '').includes(p)) ? 0.5 : 0
  if (f.educationLevels?.length) score += f.educationLevels.some(e => String(d.education || '').includes(e)) ? 0.3 : 0
  const aff = SEGMENT_AFFINITY[archetype.id]
  score += aff ? (aff[persona.segment] || 0) * 1.5 : 0.3
  return score
}

function jitterTraits(traits, rng) { const out = {}; for (const k of TRAIT_KEYS) out[k] = round(clamp((traits[k] ?? 0.5) + (rng() - 0.5) * 0.16, 0, 1)); return out }

function buildPersona(source, archetype, index, rng, sampler) {
  const n = archetype.sampleN || 1
  return {
    id: `${archetype.id}_${String(index + 1).padStart(3, '0')}`, segment: archetype.id, name: archetype.label, archetype: archetype.id,
    persona_name: source.persona_name || '', description: source.description || '', weight: round(archetype.share / n, 5) || 0.001,
    demographics: { age: source.demographics?.age, sex: source.demographics?.sex, occupation: source.demographics?.occupation || '', education: source.demographics?.education || '', province: source.demographics?.province || '', district: source.demographics?.district || '' },
    traits: jitterTraits(archetype.traits, rng),
    goals: { conversion: archetype.conversionGoal, interests: archetype.interestKeywords.slice(), avoid: archetype.avoidKeywords.slice() },
    sourceId: source.id, sampler
  }
}

export function sampleFromBundled(archetypes, { seed = 42, poolFile } = {}) {
  const pool = loadPool(poolFile)
  const taken = new Set()
  const personas = []
  const stats = []
  for (const arch of archetypes.slice().sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))) {
    const n = arch.sampleN || 0
    if (n < 1) { stats.push({ id: arch.id, label: arch.label, matched: 0, sampled: 0, relaxed: 0 }); continue }
    const rng = seededRandom(`${seed}:${arch.id}`)
    const scored = pool.personas.filter(p => !taken.has(p.id)).map(p => ({ p, score: matchScore(p, arch) + rng() * 0.5 })).sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
    const strong = scored.filter(s => s.score >= 1.5).length
    const chosen = scored.slice(0, n)
    chosen.forEach(({ p }, i) => { taken.add(p.id); personas.push(buildPersona(p, arch, i, seededRandom(hashSeed(seed, arch.id, i)), 'bundled')) })
    stats.push({ id: arch.id, label: arch.label, matched: strong, sampled: chosen.length, relaxed: strong >= n ? 0 : 1 })
  }
  return { personas, stats }
}

// Nemotron-Personas-Korea export (JSONL, one row per line, or a JSON array). Rows are projected to the
// few fields the sampler needs while streaming, so large exports stay affordable.
const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '전']
const GIVEN_M = ['민준', '서준', '도윤', '예준', '시우', '주원', '하준', '지호', '준우', '건우', '현우', '도현', '우진', '선우', '유준', '민재', '정훈', '동현', '지환', '성민']
const GIVEN_F = ['서연', '지우', '서윤', '수아', '지유', '하윤', '민서', '윤서', '지민', '다은', '예린', '채원', '유진', '수빈', '예나', '유나', '다인', '소율', '시아', '은채']

export function nemotronPath() { return process.env.NEMOTRON_PERSONAS_PATH || '' }

export async function readNemotronRows(file, { maxRows = Number(process.env.NEMOTRON_MAX_ROWS) || 50000 } = {}) {
  if (/\.parquet$/i.test(file)) throw new Error('NEMOTRON_PERSONAS_PATH는 JSONL(또는 JSON 배열) 내보내기여야 합니다. parquet 변환 방법은 README를 참고하세요.')
  const project = (row, i) => ({ i, uuid: String(row.uuid || i), age: Number(row.age), sex: String(row.sex || ''), education: String(row.education_level || ''), province: String(row.province || ''), district: String(row.district || ''), occupation: String(row.occupation || ''), hobbies: String(row.hobbies_and_interests || '').slice(0, 300), professional: String(row.professional_persona || row.persona || '').slice(0, 300), goals: String(row.career_goals_and_ambitions || '').slice(0, 200), marital: String(row.marital_status || '') })
  const rows = []
  if (/\.json$/i.test(file)) { const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')); (Array.isArray(raw) ? raw : raw.rows || []).slice(0, maxRows).forEach((r, i) => rows.push(project(r, i))); return rows }
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  let i = 0
  for await (const line of rl) { const t = line.trim(); if (!t) continue; try { rows.push(project(JSON.parse(t), i++)) } catch { /* skip malformed line */ } if (rows.length >= maxRows) { rl.close(); break } }
  return rows
}

function filterRows(rows, f) {
  return rows.filter(r => {
    if (f.age && !(r.age >= f.age[0] && r.age <= f.age[1])) return false
    if (f.sex && !r.sex.startsWith(f.sex[0])) return false
    if (f.educationLevels?.length && !f.educationLevels.some(e => r.education.includes(e))) return false
    if (f.provinces?.length && !f.provinces.some(p => r.province.includes(p))) return false
    if (f.occupationKeywords?.length && !f.occupationKeywords.some(k => r.occupation.includes(k) || r.professional.includes(k))) return false
    if (f.hobbiesKeywords?.length && !f.hobbiesKeywords.some(k => r.hobbies.includes(k))) return false
    return true
  })
}

// Relaxation order (as in the prototype): hobbies → occupation → categories → sex → age → none.
export function filterWithRelaxation(rows, filters, need) {
  const f = filters || {}
  const levels = [f, { ...f, hobbiesKeywords: [] }, { ...f, hobbiesKeywords: [], occupationKeywords: [] }, { age: f.age, sex: f.sex }, { age: f.age }, {}]
  let last = rows
  for (const [level, spec] of levels.entries()) { const sub = filterRows(rows, spec); last = sub; if (sub.length >= need) return { rows: sub, relaxed: level } }
  return { rows: last, relaxed: levels.length - 1 }
}

export function sampleFromNemotron(rows, archetypes, { seed = 42 } = {}) {
  const taken = new Set()
  const personas = []
  const stats = []
  for (const arch of archetypes.slice().sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))) {
    const n = arch.sampleN || 0
    if (n < 1) { stats.push({ id: arch.id, label: arch.label, matched: 0, sampled: 0, relaxed: 0 }); continue }
    const { rows: matched, relaxed } = filterWithRelaxation(rows.filter(r => !taken.has(r.uuid)), arch.demographicFilters, n)
    const rng = seededRandom(`${seed}:${arch.id}`)
    const chosen = rng.shuffle(matched.slice().sort((a, b) => a.uuid.localeCompare(b.uuid))).slice(0, n)
    chosen.forEach((r, i) => {
      taken.add(r.uuid)
      const prng = seededRandom(hashSeed(seed, arch.id, i))
      const female = r.sex.startsWith('여')
      const name = prng.pick(SURNAMES) + prng.pick(female ? GIVEN_F : GIVEN_M)
      const source = { id: `nemotron:${r.uuid}`, persona_name: `${name} 씨는 ${r.professional.slice(0, 60)}`.trim(), description: `${r.province || ''} 거주, ${Number.isFinite(r.age) ? r.age : '?'}세 ${r.sex || ''}. 직업: ${r.occupation || '-'}. ${r.professional}`.replace(/\s+/g, ' ').trim().slice(0, 400), demographics: { age: Number.isFinite(r.age) ? r.age : undefined, sex: r.sex, occupation: r.occupation, education: r.education, province: r.province, district: r.district } }
      personas.push(buildPersona(source, arch, i, prng, 'nemotron'))
    })
    stats.push({ id: arch.id, label: arch.label, matched: matched.length, sampled: chosen.length, relaxed })
  }
  return { personas, stats }
}

// ── 4. behaviour priors (probabilistic behaviour model) ─────────────────────
const sig = x => 1 / (1 + Math.exp(-x))

export function siteFactors(character) {
  const f = { visualStrength: 0.55, copyStrength: 0.55, socialProof: 0.5, priceFriction: 0.5, ctaClarity: 0.55, goalAlignmentBase: 0.5 }
  if (!character) return f
  const s = character.signals || {}
  const blob = [character.designTone, character.serviceOneLiner, ...(character.contentTypes || []), ...(character.conversionGoals || [])].join(' ').toLowerCase()
  f.ctaClarity = round(Math.min(0.9, 0.4 + 0.12 * (character.conversionGoals || []).length))
  if (s.hasVisuals || /비주얼|이미지|사진|영상|디자인|visual|갤러리|포토/.test(blob)) f.visualStrength = 0.75
  if (s.hasSocialProof || /후기|리뷰|사례|실적|고객|testimonial|review/.test(blob)) f.socialProof = 0.75
  if (s.priceVisible || /가격|비용|견적|무료|할인|price|free|요금/.test(blob)) f.priceFriction = 0.4
  if (/리포트|인사이트|가이드|설명|상세|guide|docs/.test(blob)) f.copyStrength = 0.72
  if (s.formFields > 5) f.priceFriction = round(Math.min(0.8, f.priceFriction + 0.15))
  return f
}

// Expected values of the behaviour model's conditional distributions (no random draws), so the
// priors are stable per persona and can be compared with what the browser sessions actually did.
export function behaviorPriors(persona, site) {
  const t = { patience: 0.5, visualSensitivity: 0.5, copyImportance: 0.5, ctaResponse: 0.5, priceConsciousness: 0.5, socialProofSensitivity: 0.5, ...(persona.traits || {}) }
  const contentMatch = (t.visualSensitivity * site.visualStrength + t.copyImportance * site.copyStrength + t.socialProofSensitivity * site.socialProof) / 3
  const engagement = clamp(0.26 + 0.28 * t.patience + 0.52 * contentMatch, 0, 1)
  const goalAlignment = site.goalAlignmentBase + 0.25 * (t.ctaResponse - 0.5) * 2
  const z = -3.4 + 2 * engagement + 1.5 * t.ctaResponse * site.ctaClarity + 1 * (goalAlignment - 0.5) * 2 - 1.2 * t.priceConsciousness * site.priceFriction
  const pConvert = sig(z)
  const steps = Math.max(1, Math.round(2 + 10 * engagement * (0.5 + t.patience)))
  const sentiment = clamp((engagement - 0.5) * 1.6 + (pConvert * 0.5 - 0.1), -1, 1)
  const nps = clamp(Math.round(6.9 + sentiment * 2.8 + (pConvert * 1.6 - 0.4)), 0, 10)
  const shareProb = round(clamp(0.05 + 0.5 * t.socialProofSensitivity * pConvert + 0.1 * Math.max(0, sentiment), 0, 0.9))
  return { pConvert: round(pConvert, 4), engagement: round(engagement, 4), sentiment: round(sentiment, 4), nps, expectedSteps: steps, bounceRisk: round(clamp(1 - engagement - 0.1 * t.patience, 0, 1)), shareProb }
}

export function summarizePool(personas) {
  const bySegment = {}, segmentLabels = {}, byAge = { '10s': 0, '20s': 0, '30s': 0, '40s': 0, '50s+': 0 }, bySex = {}, byProvince = {}
  for (const p of personas) {
    bySegment[p.segment] = (bySegment[p.segment] || 0) + 1
    segmentLabels[p.segment] = p.name
    const a = Number(p.demographics?.age) || 0
    byAge[a < 20 ? '10s' : a < 30 ? '20s' : a < 40 ? '30s' : a < 50 ? '40s' : '50s+']++
    const sex = p.demographics?.sex || '미상'
    bySex[sex] = (bySex[sex] || 0) + 1
    const prov = p.demographics?.province || '기타'
    byProvince[prov] = (byProvince[prov] || 0) + 1
  }
  const avgAge = personas.length ? Math.round(personas.reduce((s, p) => s + (Number(p.demographics?.age) || 0), 0) / personas.length) : 0
  return { bySegment, segmentLabels, byAge, bySex, byProvince, avgAge }
}

export async function generatePersonaPool({ run, params, onStage = () => {}, fetchImpl = fetch }) {
  const { count, seed, policy } = params
  let usedLlm = false
  const warnings = []
  onStage('site_context', `${(run.report?.pages || []).length}페이지 분석`)
  let character = buildSiteCharacter(run)
  if (policy === 'llm') { try { character = await llmSiteCharacter(run, character, fetchImpl); usedLlm = true } catch (err) { warnings.push(`site character LLM 실패 → 휴리스틱: ${String(err.message || err).slice(0, 80)}`) } }
  onStage('archetypes', '사이트 매칭 아키타입 도출')
  let archetypes = heuristicArchetypes(character, params.archetypes)
  let archetypeSource = 'heuristic'
  if (policy === 'llm') { try { archetypes = await llmArchetypes(character, params.archetypes, archetypes, fetchImpl); archetypeSource = 'llm'; usedLlm = true } catch (err) { warnings.push(`archetypes LLM 실패 → 규칙 테이블: ${String(err.message || err).slice(0, 80)}`) } }
  allocateCounts(archetypes, count)
  const nemotron = nemotronPath()
  let sampled, sampler = 'bundled'
  if (nemotron) {
    onStage('sampling', `Nemotron-Personas-Korea 로컬 내보내기에서 ${archetypes.length}개 아키타입 샘플링`)
    try { const rows = await readNemotronRows(nemotron); if (!rows.length) throw new Error('행이 없습니다'); sampled = sampleFromNemotron(rows, archetypes, { seed }); sampler = 'nemotron' } catch (err) { warnings.push(`Nemotron 샘플러 실패 → 번들 풀: ${String(err.message || err).slice(0, 100)}`) }
  }
  if (!sampled) { onStage('sampling', `번들 풀에서 ${archetypes.length}개 아키타입 샘플링`); sampled = sampleFromBundled(archetypes, { seed }) }
  const factors = siteFactors(character)
  for (const p of sampled.personas) p.priors = behaviorPriors(p, factors)
  onStage('done', `${sampled.personas.length}명 생성 완료`)
  const cfg = llmConfig()
  return {
    version: 'site-matched-v1', source: sampler === 'nemotron' ? 'Nemotron-Personas-Korea 로컬 내보내기 · 사이트 매칭 샘플' : '번들 Nemotron-Personas-Korea 풀(928명) · 아키타입 매칭 샘플',
    runId: run.id, target: run.url, generatedAt: new Date().toISOString(), seed, count: sampled.personas.length,
    policy: { requested: policy, siteCharacter: character.source, archetypes: archetypeSource, usedLlm, model: usedLlm ? cfg.model : null }, warnings,
    siteCharacter: character, siteFactors: factors, archetypes, sampleStats: sampled.stats, sampler,
    segments: archetypes.map(a => ({ id: a.id, label: a.label })),
    summary: summarizePool(sampled.personas), personas: sampled.personas
  }
}
