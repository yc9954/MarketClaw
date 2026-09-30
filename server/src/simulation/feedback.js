// Feedback cards derived from a finished simulation (the prototype's ClawFeedback stream, rebuilt on
// real report data): each card has a category (copy / cta / trust / navigation / friction), the
// evidence that produced it (segment, variant, page, numbers), a suggested action and a confidence.
// Rule-based and deterministic; optionally rewritten by the LLM when a key is configured.
import { llmConfig, DEFAULT_GOAL_PATTERN } from './engine.js'
import { llmJson } from './llm.js'

export const CATEGORIES = { copy: '카피', cta: 'CTA', trust: '신뢰', navigation: '탐색', friction: '마찰' }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const confidence = (n, effect = 0.5) => Math.round(clamp(40 + 10 * Math.log2(Math.max(1, n)) + 25 * clamp(effect, 0, 1), 40, 95))
const pct = v => `${v}%`

export function deriveFeedback(sim, run = {}) {
  const report = sim?.report
  if (!report || sim.status !== 'completed') return { summary: null, cards: [] }
  const variants = Object.values(report.variants || {})
  const control = report.variants?.control || variants[0]
  const cards = []
  const push = card => cards.push({ ...card, confidence: card.confidence ?? confidence(card.evidence?.n || 1) })
  const sessions = sim.sessions || []
  const goalRe = DEFAULT_GOAL_PATTERN
  const pages = run.report?.pages || []
  const site = sim.site || {}

  // 1. First impression: control bounce rate
  if (control && control.n >= 2 && control.bounceRate >= 35) {
    const seg = Object.values(control.bySegment || {}).filter(s => s.n >= 1).sort((a, b) => b.bounces / b.n - a.bounces / a.n)[0]
    push({ id: 'copy:first-impression', category: 'copy', title: '첫 화면에서 이탈이 많습니다', description: `Control에서 세션의 ${pct(control.bounceRate)}가 전환 없이 이탈했습니다${seg ? ` (가장 높은 세그먼트: ${seg.label} ${seg.bounces}/${seg.n})` : ''}. 첫 화면의 가치 제안이 방문 목적과 맞지 않을 때 나타나는 패턴입니다.`, evidence: { variant: 'control', segment: seg?.segment || null, page: '/', metric: 'bounceRate', value: control.bounceRate, n: control.n }, action: `히어로 카피를 ${seg ? seg.label + '의' : '주요 세그먼트의'} 방문 목적(${site.ctaText ? `현재 CTA "${site.ctaText}"` : '현재 CTA'} 주변)에 맞춰 다시 쓰고, 관심 키워드가 첫 화면 텍스트에 드러나게 하세요.`, confidence: confidence(control.n, control.bounceRate / 100) })
  }
  // 2. CTA-type variants (largeCTA or any custom variant that patches the primary CTA)
  for (const c of report.comparisons || []) {
    const v = report.variants[c.key]
    const params = sim.params?.variants?.find(x => x.key === c.key)
    const isCta = c.key === 'largeCTA' || /cta/i.test(c.key) || /cta/i.test(params?.name || '')
    const isTrust = c.key === 'trustBoost' || /trust|신뢰|증거|proof/i.test(`${c.key} ${params?.name || ''}`)
    const isNav = c.key === 'contactFirst' || /contact|문의|nav/i.test(`${c.key} ${params?.name || ''}`)
    const category = isCta ? 'cta' : isTrust ? 'trust' : isNav ? 'navigation' : 'copy'
    const ev = { variant: c.key, metric: 'cvrLift', value: c.cvrLift, baseline: c.controlCvr, variantCvr: c.variantCvr, pValue: c.pValue, n: c.variantN + c.controlN }
    if (c.cvrLift !== null && c.cvrLift > 0) push({ id: `${category}:variant-${c.key}`, category, title: `${v?.name || c.key}: 가중 CVR ${c.cvrLift > 0 ? '+' : ''}${c.cvrLift}%`, description: `Control ${pct(c.controlCvr)} → ${pct(c.variantCvr)} (n=${c.variantN}, Fisher p=${c.pValue}${c.significant ? ', 유의' : ', 미유의'}).${c.significant ? '' : ' 표본이 작아 방향만 참고하세요.'}`, evidence: ev, action: isCta ? '실제 사이트의 주요 CTA 크기·대비를 키운 버전으로 A/B 테스트를 열어 보세요.' : isTrust ? '실제 수치(고객 수, 평점, 사례)로 사회적 증거 요소를 CTA 근처에 배치해 실험하세요.' : isNav ? '문의·데모 경로를 첫 화면 상단에 노출하는 실험을 실제 트래픽으로 검증하세요.' : `"${v?.name || c.key}" 변형의 패치를 실제 사이트 실험으로 옮겨 검증하세요.`, confidence: confidence(ev.n, c.significant ? 1 : 0.4) })
    else if (c.cvrLift !== null && c.cvrLift < 0) push({ id: `${category}:variant-${c.key}-negative`, category, title: `${v?.name || c.key}: 효과 없음 (${c.cvrLift}%)`, description: `이 변형은 Control(${pct(c.controlCvr)})보다 낮은 ${pct(c.variantCvr)}를 기록했습니다 (p=${c.pValue}). 페르소나 집단에서 이 방향의 변화는 도움이 되지 않았습니다.`, evidence: ev, action: '이 패치는 우선순위를 낮추고, 다른 요소(카피, 경로)를 먼저 실험하세요.', confidence: confidence(ev.n, 0.3) })
  }
  // 3. Reached the goal page but did not convert
  if (control && control.goalRate - control.cvr >= 20 && control.goalReached >= 1) {
    const contact = pages.find(p => goalRe.test(p.url) || goalRe.test(p.title || ''))
    const fields = contact?.forms?.[0]?.fields
    push({ id: 'friction:goal-no-convert', category: 'friction', title: '목표 페이지에는 도달했지만 전환하지 않았습니다', description: `Control에서 목표 페이지 도달 ${pct(control.goalRate)} vs 전환 ${pct(control.cvr)} (n=${control.n}).${fields ? ` 목표 페이지 양식 필드 ${fields}개.` : ''} 도달 후 이탈은 양식 길이·제출 버튼 문구·가격 노출에서 자주 생깁니다.`, evidence: { variant: 'control', page: site.contactHref || site.ctaHref || null, metric: 'goalRate-cvr', value: Math.round((control.goalRate - control.cvr) * 10) / 10, n: control.n, formFields: fields ?? null }, action: fields > 5 ? `양식을 ${fields}개에서 3~4개 필드로 줄이고 제출 버튼 문구를 결과 중심으로 바꾸세요.` : '목표 페이지의 제출 버튼을 첫 화면에 보이게 하고, 제출 전 확인해야 할 정보를 줄이세요.', confidence: confidence(control.n, (control.goalRate - control.cvr) / 100) })
  }
  // 4. Exit concentration per path
  for (const row of (report.dropoffMap || []).filter(r => r.visits >= 3 && r.exitRate >= 50 && r.path !== '/' && !goalRe.test(r.path) && !/\[(SHADOW|MIRROR)\]/.test(r.title || '')).slice(0, 2)) {
    push({ id: `navigation:exit-${row.path}`, category: 'navigation', title: `${row.path}에서 세션 종료가 집중됩니다`, description: `방문 ${row.visits}회 중 ${pct(row.exitRate)}가 이 페이지에서 끝났고 ${pct(row.bounceRate)}는 이탈로 분류됐습니다${row.title ? ` (${row.title})` : ''}.`, evidence: { page: row.path, metric: 'exitRate', value: row.exitRate, n: row.visits, bounceRate: row.bounceRate }, action: `${row.path} 하단에 다음 단계(문의·가격·시작하기) CTA를 추가하고 본문 중간에 내부 링크를 넣으세요.`, confidence: confidence(row.visits, row.exitRate / 100) })
  }
  // 5. Segment gap
  const segRows = (report.segments || []).map(s => ({ ...s, cvr: s.byVariant?.control?.cvr ?? Object.values(s.byVariant || {})[0]?.cvr ?? 0, n: s.byVariant?.control?.n ?? s.n })).filter(s => s.n >= 2)
  if (segRows.length >= 2) {
    const sorted = segRows.slice().sort((a, b) => a.cvr - b.cvr)
    const low = sorted[0], high = sorted.at(-1)
    if (high.cvr - low.cvr >= 25) push({ id: `copy:segment-${low.segment}`, category: 'copy', title: `${low.label} 세그먼트의 전환이 저조합니다`, description: `Control 기준 ${low.label} ${pct(low.cvr)} (n=${low.n}) vs ${high.label} ${pct(high.cvr)} (n=${high.n}). 같은 페이지가 세그먼트에 따라 다르게 읽히고 있습니다.`, evidence: { segment: low.segment, variant: 'control', metric: 'cvr', value: low.cvr, baseline: high.cvr, n: low.n }, action: `${low.label}이(가) 찾는 정보(사례·가격·절차)를 첫 화면 또는 전용 섹션에 배치하고, 세그먼트별 랜딩을 검토하세요.`, confidence: confidence(low.n + high.n, (high.cvr - low.cvr) / 100) })
  }
  // 6. Agent errors (elements that could not be clicked or typed into)
  const steps = sessions.reduce((n, s) => n + (s.summary?.totalSteps || 0), 0)
  const errors = sessions.reduce((n, s) => n + (s.summary?.errorCount || 0), 0)
  if (steps >= 10 && errors / steps >= 0.1) push({ id: 'friction:agent-errors', category: 'friction', title: '에이전트가 상호작용에 실패한 요소가 있습니다', description: `${steps}스텝 중 ${errors}개(${Math.round(errors / steps * 100)}%)에서 클릭·입력이 실패했습니다. 겹치는 레이어, 지연 로딩, 화면 밖 요소가 원인일 수 있습니다.`, evidence: { metric: 'errorRate', value: Math.round(errors / steps * 100), n: steps }, action: '세션 스텝 로그에서 실패한 대상을 확인하고 해당 요소의 가시성과 클릭 영역을 점검하세요.', confidence: confidence(steps, errors / steps) })
  // 7. Long path to conversion
  if (control?.converts >= 2 && control.medianSteps >= 8) push({ id: 'navigation:long-path', category: 'navigation', title: '전환까지 경로가 깁니다', description: `Control 전환 세션의 중앙값 스텝 ${control.medianSteps}, 평균 페이지 ${control.avgPages}, 평균 전환 시간 ${control.avgTtcSec ?? '-'}초.`, evidence: { variant: 'control', metric: 'medianSteps', value: control.medianSteps, n: control.converts }, action: '첫 화면에서 목표 페이지로 바로 가는 링크를 추가하고 중간 페이지의 CTA를 통일하세요.', confidence: confidence(control.converts, 0.4) })
  // 8. Pricing hesitation
  const pricing = (report.dropoffMap || []).find(r => /pricing|price|plans|요금|가격/i.test(r.path + ' ' + r.title) && r.visits >= 3)
  if (pricing && pricing.bounceRate >= 40) push({ id: 'trust:pricing', category: 'trust', title: '가격 페이지에서 망설임이 큽니다', description: `${pricing.path} 방문 ${pricing.visits}회 중 ${pct(pricing.bounceRate)}가 이탈했습니다. 가격에 민감한 페르소나가 근거 없이 가격만 보면 나타나는 패턴입니다.`, evidence: { page: pricing.path, metric: 'bounceRate', value: pricing.bounceRate, n: pricing.visits }, action: '가격표 옆에 포함 항목·비교표·환불 조건과 고객 사례를 배치하고 무료 체험 경로를 명확히 하세요.', confidence: confidence(pricing.visits, pricing.bounceRate / 100) })
  // 9. Feedback loop: word-of-mouth potential
  const rounds = report.rounds || []
  if (rounds.length >= 2) {
    const last = rounds.at(-1)
    const bestKey = Object.entries(last.kFactor || {}).sort((a, b) => b[1] - a[1])[0]
    const segs = Object.entries(last.visitProbBySegment?.[bestKey?.[0]] || {})
    const gained = segs.map(([seg, p]) => ({ seg, p, base: report.baseVisitProb?.[seg] ?? p })).sort((a, b) => (b.p - b.base) - (a.p - a.base))[0]
    const label = report.segments?.find(s => s.segment === gained?.seg)?.label || gained?.seg
    if (bestKey && bestKey[1] >= 0.2) push({ id: 'trust:k-factor', category: 'trust', title: `${report.variants[bestKey[0]]?.name || bestKey[0]}의 구전 확산 잠재력 K=${bestKey[1]}`, description: `${rounds.length}라운드 피드백 루프에서 ${label} 세그먼트의 방문 확률이 ${Math.round((gained?.base || 0) * 100)}% → ${Math.round((gained?.p || 0) * 100)}%로 가장 많이 올랐습니다.`, evidence: { variant: bestKey[0], segment: gained?.seg || null, metric: 'kFactor', value: bestKey[1], n: last.n?.[bestKey[0]] || 0 }, action: `${label} 세그먼트가 공유할 수 있는 요소(추천 링크, 사례 페이지, 공유 버튼)를 전환 직후 화면에 두세요.`, confidence: confidence(last.n?.[bestKey[0]] || 1, bestKey[1] / 2) })
    else push({ id: 'trust:no-referral', category: 'trust', title: '구전 확산 신호가 약합니다', description: `${rounds.length}라운드 동안 모든 변형의 K-factor가 0.2 미만입니다. 전환자가 주변에 추천할 계기가 없거나 전환 자체가 적습니다.`, evidence: { metric: 'kFactor', value: bestKey?.[1] ?? 0, n: last.n?.[bestKey?.[0]] || 0 }, action: '전환 완료 화면에 공유·추천 요소를 추가하고, 사례 콘텐츠를 세그먼트별로 준비하세요.', confidence: confidence(last.n?.[bestKey?.[0]] || 1, 0.3) })
  }
  // 10. Nothing tripped
  if (!cards.length && control) push({ id: 'copy:baseline', category: 'copy', title: '뚜렷한 문제 신호가 없습니다', description: `Control 가중 CVR ${pct(control.cvr)}, 이탈 ${pct(control.bounceRate)}, 목표 도달 ${pct(control.goalRate)} (n=${control.n}). 표본을 늘리거나 다른 변형을 실험해 보세요.`, evidence: { variant: 'control', metric: 'cvr', value: control.cvr, n: control.n }, action: '페르소나 수를 늘리고 라운드를 2 이상으로 설정해 피드백 루프 효과를 확인하세요.', confidence: 40 })
  cards.sort((a, b) => b.confidence - a.confidence)
  const summary = { sessions: report.totalSessions, converted: report.converted, bounced: report.bounced, bestVariant: report.bestVariant, controlCvr: control?.cvr ?? null, rounds: rounds.length || 1, policy: sim.policy, generatedAt: report.generatedAt, categories: Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, cards.filter(c => c.category === k).length])) }
  return { summary, cards }
}

// Rewrites title/description/action with the LLM; the evidence and ids stay as derived.
export async function refineWithLlm(cards, context, fetchImpl = fetch) {
  if (!llmConfig().configured || !cards.length) return { cards, refined: false }
  const data = await llmJson([
    { role: 'system', content: '당신은 CRO 컨설턴트입니다. 시뮬레이션 근거로 만든 피드백 카드의 제목·설명·제안을 더 구체적이고 실행 가능하게 다듬습니다. 숫자와 근거는 바꾸지 마세요. JSON만 출력.' },
    { role: 'user', content: `사이트: ${context.url || ''}\n${context.brief || ''}\n\n카드:\n${JSON.stringify(cards.map(c => ({ id: c.id, category: c.category, title: c.title, description: c.description, action: c.action })), null, 0)}\n\n{"cards":[{"id":"...","title":"...","description":"...","action":"..."}]} 형태로 같은 id를 유지해 답하세요.` }
  ], { temperature: 0.4, maxTokens: 3000, fetchImpl })
  const byId = new Map((Array.isArray(data?.cards) ? data.cards : []).filter(c => c && typeof c.id === 'string').map(c => [c.id, c]))
  if (!byId.size) return { cards, refined: false }
  const str = (v, max, fallback) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback
  return { refined: true, cards: cards.map(c => { const r = byId.get(c.id); return r ? { ...c, title: str(r.title, 120, c.title), description: str(r.description, 600, c.description), action: str(r.action, 400, c.action), refined: true } : c }) }
}
