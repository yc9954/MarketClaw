<template>
  <div class="detail-card pool-panel">
    <div class="card-heading">
      <span>사이트 매칭 페르소나 풀</span>
      <small v-if="pool">{{ pool.total }}명 · {{ pool.archetypes.length }}개 아키타입 · {{ pool.sampler === 'nemotron' ? 'Nemotron 로컬 샘플' : '번들 풀 샘플' }} · {{ date(pool.generatedAt) }}</small>
      <small v-else>아직 생성하지 않음</small>
    </div>
    <div class="source-bar">
      <span class="src-label">입력 소스</span>
      <span class="src-value">{{ host }}</span>
      <span class="src-meta">캡처한 페이지 {{ pageCount }}개 · CTA {{ ctaCount }}개 · 재크롤 없음</span>
      <span class="policy-pill" :class="{ llm: llm?.configured }"><span class="status-led" :class="{ on: llm?.configured }"></span>{{ llm?.configured ? 'LLM 사이트 분석 · ' + llm.model : '휴리스틱 사이트 분석 · API 키 없음' }}</span>
    </div>
    <div class="form-grid gen-form">
      <label><span>페르소나 수</span><input v-model.number="form.count" type="number" :min="limits?.count?.[0] || 5" :max="limits?.count?.[1] || 300" :disabled="busy" /></label>
      <label><span>아키타입 수</span><input v-model.number="form.archetypes" type="number" :min="limits?.archetypes?.[0] || 3" :max="limits?.archetypes?.[1] || 9" :disabled="busy" /></label>
      <label><span>시드</span><input v-model.trim="form.seed" type="text" placeholder="42" :disabled="busy" /></label>
      <label class="check"><input v-model="form.forceHeuristic" type="checkbox" :disabled="busy || !llm?.configured" /><span>LLM 없이 휴리스틱만 사용</span></label>
    </div>
    <div class="gen-actions">
      <button class="start-btn gen-btn" :disabled="busy || disabled" @click="generate">{{ busy ? stageLabel + '…' : pool ? '풀 다시 생성' : '페르소나 풀 생성' }}<span>→</span></button>
      <span class="form-note">사이트 캐릭터 → 아키타입 → {{ generation?.sampler === 'nemotron' ? 'Nemotron 로컬 내보내기' : '번들 928명 풀' }}에서 샘플링 → 행동 프라이어</span>
    </div>
    <div v-if="busy" class="progress-block">
      <div class="progress-meta"><span>{{ stageLabel }}</span><span>{{ job?.detail }}</span></div>
      <div class="progress-bar"><span :style="{ width: progress + '%' }"></span></div>
    </div>
    <div v-if="error" class="notice error">{{ error }}</div>
    <div v-if="pool?.warnings?.length" class="notice info">{{ pool.warnings.join(' · ') }}</div>

    <template v-if="pool">
      <div class="brief">
        <div class="brief-head"><span class="picker-label">사이트 브리프</span><span class="src-tag">{{ pool.siteCharacter.source === 'llm' ? 'LLM' : '휴리스틱' }} · 아키타입 {{ pool.policy.archetypes === 'llm' ? 'LLM' : '규칙 테이블' }}</span></div>
        <p class="one-liner">{{ pool.siteCharacter.serviceOneLiner }}</p>
        <div class="brief-grid">
          <div><span>비즈니스 유형</span><strong>{{ pool.siteCharacter.businessType }} · {{ pool.siteCharacter.industryLabel || pool.siteCharacter.industry }}</strong></div>
          <div><span>디자인 톤</span><strong>{{ pool.siteCharacter.designTone || '-' }}</strong></div>
          <div><span>주 연령대</span><strong>{{ pool.siteCharacter.audienceSignals?.ageSkew || '-' }}</strong></div>
          <div><span>네비게이션</span><strong>{{ (pool.siteCharacter.mainNavigation || []).map(n => n.label).join(' · ') || '-' }}</strong></div>
        </div>
        <p class="audience">{{ pool.siteCharacter.targetAudienceSummary }}</p>
        <div class="chip-row"><span class="chip-label">전환 목표</span><span v-for="g in pool.siteCharacter.conversionGoals" :key="g" class="chip on">{{ g }}</span></div>
        <div class="chip-row" style="margin-top:8px"><span class="chip-label">관심 키워드</span><span v-for="k in pool.siteCharacter.audienceSignals?.keyInterests || []" :key="k" class="chip">#{{ k }}</span></div>
      </div>

      <div class="pool-grid">
        <div class="archetypes">
          <div class="picker-label">아키타입 ({{ pool.archetypes.length }}) · 비중과 샘플 수</div>
          <div v-for="a in pool.archetypes" :key="a.id" class="archetype-row">
            <div class="arch-top"><strong>{{ a.label }}</strong><code>{{ a.id }}</code><span class="arch-share">{{ (a.share * 100).toFixed(0) }}% · {{ a.sampleN }}명<template v-if="stat(a.id)"> · 매칭 {{ stat(a.id).matched }}{{ stat(a.id).relaxed ? ' · 완화 L' + stat(a.id).relaxed : '' }}</template></span></div>
            <div class="dist-bar"><i :style="{ width: (a.share * 100) + '%' }"></i></div>
            <div class="arch-meta"><span>{{ a.demographicFilters?.age ? a.demographicFilters.age.join('–') + '세' : '연령 무관' }}</span><span v-if="a.demographicFilters?.sex">{{ a.demographicFilters.sex }}</span><span v-if="a.demographicFilters?.occupationKeywords?.length">직업 {{ a.demographicFilters.occupationKeywords.slice(0, 4).join('/') }}</span><span>목표 · {{ a.conversionGoal }}</span></div>
            <p class="arch-rationale">{{ a.rationale }}</p>
          </div>
        </div>
        <div class="distributions">
          <div class="dist-section">
            <div class="picker-label">세그먼트 ({{ segmentRows.length }})</div>
            <div v-for="row in segmentRows" :key="row.key" class="dist-row"><div class="dist-top"><span>{{ row.label }}</span><span>{{ row.count }} ({{ row.pct }}%)</span></div><div class="dist-bar"><i :style="{ width: row.pct + '%' }"></i></div></div>
          </div>
          <div class="dist-section">
            <div class="picker-label">연령대 · 평균 {{ pool.summary.avgAge }}세</div>
            <div v-for="row in ageRows" :key="row.key" class="dist-row"><div class="dist-top"><span>{{ row.label }}</span><span>{{ row.count }} ({{ row.pct }}%)</span></div><div class="dist-bar"><i class="age" :style="{ width: row.pct + '%' }"></i></div></div>
          </div>
          <div class="dist-section">
            <div class="picker-label">광역시·도 Top 8 · {{ sexText }}</div>
            <div v-for="row in provinceRows" :key="row.key" class="dist-row"><div class="dist-top"><span>{{ row.label }}</span><span>{{ row.count }} ({{ row.pct }}%)</span></div><div class="dist-bar"><i class="prov" :style="{ width: row.pct + '%' }"></i></div></div>
          </div>
        </div>
      </div>

      <div class="picker-label" style="margin-top:22px">샘플 페르소나 · {{ pool.personas.length }} / {{ pool.total }}</div>
      <div class="pcard-grid">
        <div v-for="p in sampleCards" :key="p.id" class="pcard">
          <div class="pcard-top"><code>{{ p.id }}</code><span class="pcard-sex" :class="p.demographics.sex === '남자' ? 'm' : 'f'">{{ p.demographics.sex || '-' }}</span></div>
          <div class="pcard-name">{{ (p.persona_name || p.description).split(' 씨는')[0].slice(0, 16) }} · {{ p.demographics.age }}세</div>
          <div class="pcard-seg">{{ p.name }}</div>
          <div class="pcard-meta"><span>{{ p.demographics.province }}</span><span>{{ p.demographics.occupation || '-' }}</span></div>
          <div class="pcard-priors"><span>전환 성향 {{ Math.round((p.priors?.pConvert || 0) * 100) }}%</span><span>NPS {{ p.priors?.nps ?? '-' }}</span><span>공유 {{ Math.round((p.priors?.shareProb || 0) * 100) }}%</span></div>
          <div class="pcard-interests"><span v-for="k in (p.goals?.interests || []).slice(0, 4)" :key="k">#{{ k }}</span></div>
        </div>
      </div>
      <p class="hint">이 풀은 사이트 캐릭터에 맞춘 아키타입별 샘플입니다. 시뮬레이션 실행 시 "페르소나 풀"에서 <strong>사이트 매칭 풀</strong>을 선택하면 이 집단으로 실행합니다. 행동 프라이어(전환 성향·NPS·공유)는 확률적 행동 모델의 기대값이며, 실제 세션 결과와 비교하는 용도입니다.</p>
    </template>
    <div v-else-if="!busy" class="empty">아직 생성된 풀이 없습니다. 분석한 사이트의 페이지 인벤토리에서 사이트 캐릭터와 방문자 아키타입을 도출해 페르소나 집단을 만듭니다.</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
const props = defineProps({ runId: String, run: Object, llm: Object, limits: Object, generation: Object, disabled: Boolean })
const emit = defineEmits(['generated'])
const pool = ref(null)
const job = ref(null)
const error = ref('')
const busy = ref(false)
const form = ref({ count: 60, archetypes: 6, seed: '42', forceHeuristic: false })
const STAGES = { queued: '대기', site_context: '사이트 분석', archetypes: '아키타입 도출', sampling: '페르소나 샘플링', done: '완료' }
const ORDER = ['queued', 'site_context', 'archetypes', 'sampling', 'done']
let timer
const host = computed(() => { try { return new URL(props.run?.url).host } catch { return '-' } })
const pageCount = computed(() => (props.run?.report?.pages || []).filter(p => !p.error).length)
const ctaCount = computed(() => (props.run?.report?.pages || []).reduce((n, p) => n + (p.ctas || []).length, 0))
const stageLabel = computed(() => STAGES[job.value?.stage] || '생성 중')
const progress = computed(() => Math.max(8, (ORDER.indexOf(job.value?.stage) + 1) / ORDER.length * 100))
const date = v => v ? new Date(v).toLocaleString('ko-KR') : ''
const stat = id => pool.value?.sampleStats?.find(s => s.id === id)
const rows = (map, labels, topN) => { const total = pool.value?.total || 1; let list = Object.entries(map || {}).map(([k, c]) => ({ key: k, label: labels ? labels[k] || k : k, count: c, pct: Math.round(c / total * 100) })).sort((a, b) => b.count - a.count); if (topN) list = list.slice(0, topN); return list }
// Up to eight cards, round-robin over the archetypes so the sample shows the whole mix.
const sampleCards = computed(() => { const groups = new Map(); for (const p of pool.value?.personas || []) (groups.get(p.segment) || groups.set(p.segment, []).get(p.segment)).push(p); const out = []; for (let i = 0; out.length < 8 && [...groups.values()].some(g => g.length > i); i++) for (const g of groups.values()) if (g[i] && out.length < 8) out.push(g[i]); return out })
const segmentRows = computed(() => pool.value ? rows(pool.value.summary.bySegment, pool.value.summary.segmentLabels) : [])
const ageRows = computed(() => pool.value ? ['10s', '20s', '30s', '40s', '50s+'].map(k => ({ key: k, label: { '10s': '10대', '20s': '20대', '30s': '30대', '40s': '40대', '50s+': '50대+' }[k], count: pool.value.summary.byAge[k] || 0, pct: Math.round((pool.value.summary.byAge[k] || 0) / (pool.value.total || 1) * 100) })) : [])
const provinceRows = computed(() => pool.value ? rows(pool.value.summary.byProvince, null, 8) : [])
const sexText = computed(() => pool.value ? Object.entries(pool.value.summary.bySex).map(([k, v]) => `${k} ${v}`).join(' · ') : '')
async function load() {
  try {
    const res = await fetch(`/api/runs/${props.runId}/personas`)
    if (res.status === 404) { pool.value = null; return }
    const body = await res.json()
    if (!res.ok) throw new Error(body.error)
    pool.value = body
    if (body.seed) form.value.seed = String(body.seed)
    emit('generated', body)
  } catch (err) { error.value = err.message }
}
async function pollStatus() {
  try {
    const res = await fetch(`/api/runs/${props.runId}/personas/status`)
    job.value = await res.json()
    if (job.value.status !== 'running') { clearInterval(timer); timer = null; busy.value = false; if (job.value.status === 'failed') error.value = job.value.error; else await load() }
  } catch { /* keep polling */ }
}
async function generate() {
  error.value = ''; busy.value = true; job.value = { stage: 'queued' }
  try {
    const body = { count: form.value.count, archetypes: form.value.archetypes, seed: form.value.seed, ...(form.value.forceHeuristic ? { policy: 'heuristic' } : {}) }
    const res = await fetch(`/api/runs/${props.runId}/personas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || '생성을 시작하지 못했습니다.')
    job.value = json
    timer = setInterval(pollStatus, 800)
  } catch (err) { error.value = err.message; busy.value = false }
}
onMounted(async () => { await load(); const res = await fetch(`/api/runs/${props.runId}/personas/status`).catch(() => null); const s = res ? await res.json() : null; if (s?.status === 'running') { busy.value = true; job.value = s; timer = setInterval(pollStatus, 800) } })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.source-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 14px;border:1px solid var(--ss-border);background:var(--ss-bg-sub);margin-bottom:16px}
.src-label{font:700 10px var(--mono);color:var(--ss-sub);letter-spacing:.5px}
.src-value{font-size:13px;font-weight:700}
.src-meta{font:10px var(--mono);color:var(--ss-muted)}
.policy-pill{display:inline-flex;align-items:center;gap:8px;margin-left:auto;padding:5px 10px;border:1px solid var(--ss-border);background:#fff;font:700 10px var(--mono);color:var(--ss-sub);white-space:nowrap}
.gen-actions{display:flex;align-items:center;gap:18px;margin-top:16px;flex-wrap:wrap}
.gen-actions .form-note{margin:0}
.progress-block{margin-top:16px}
.progress-meta{display:flex;justify-content:space-between;font:700 11px var(--mono);color:var(--ss-sub);margin-bottom:8px}
.brief{margin-top:22px;padding:18px;border:1px solid var(--ss-border);background:var(--ss-bg-sub)}
.brief-head{display:flex;justify-content:space-between;align-items:baseline}
.src-tag{font:700 10px var(--mono);color:var(--ss-blue)}
.one-liner{font-size:15px;font-weight:700;letter-spacing:-.3px;margin:4px 0 12px;line-height:1.5}
.brief-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.brief-grid div{display:grid;gap:4px;min-width:0}
.brief-grid span{font:700 9px var(--mono);color:var(--ss-muted);letter-spacing:.5px}
.brief-grid strong{font-size:11px;line-height:1.5;overflow:hidden;text-overflow:ellipsis}
.audience{font-size:12px;color:var(--ss-sub);line-height:1.7;margin:0 0 12px}
.chip-label{font:700 10px var(--mono);color:var(--ss-sub);align-self:center;margin-right:4px}
.pool-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:22px;margin-top:22px}
.archetype-row{padding:10px 0;border-bottom:1px solid var(--ss-border)}
.archetype-row:last-child{border-bottom:0}
.arch-top{display:flex;align-items:baseline;gap:8px;font-size:12px;margin-bottom:6px}
.arch-top code{font:10px var(--mono);color:var(--ss-muted)}
.arch-share{margin-left:auto;font:10px var(--mono);color:var(--ss-sub);white-space:nowrap}
.arch-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font:10px var(--mono);color:var(--ss-muted);margin-top:6px}
.arch-rationale{font-size:11px;color:var(--ss-sub);line-height:1.6;margin:4px 0 0}
.dist-section{margin-bottom:18px}
.pcard-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.pcard{border:1px solid var(--ss-border);padding:12px;display:grid;gap:5px;min-width:0}
.pcard-top{display:flex;justify-content:space-between;align-items:center}
.pcard-top code{font:9px var(--mono);color:var(--ss-muted)}
.pcard-sex{font:700 9px var(--mono);padding:2px 5px;border:1px solid var(--ss-border)}
.pcard-sex.m{color:var(--ss-blue);border-color:var(--ss-blue)}
.pcard-sex.f{color:#a21caf;border-color:#a21caf}
.pcard-name{font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pcard-seg{font-size:11px;color:var(--ss-blue);font-weight:700}
.pcard-meta,.pcard-priors{display:flex;flex-wrap:wrap;gap:3px 8px;font:10px var(--mono);color:var(--ss-muted)}
.pcard-priors{color:var(--ss-sub)}
.pcard-interests{display:flex;flex-wrap:wrap;gap:4px;font:10px var(--mono);color:var(--ss-sub)}
@media(max-width:1100px){.pool-grid{grid-template-columns:1fr}.pcard-grid,.brief-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:750px){.pcard-grid,.brief-grid{grid-template-columns:1fr}.policy-pill{margin-left:0}}
</style>
