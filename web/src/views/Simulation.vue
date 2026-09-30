<template>
  <section class="sim-panel">
    <div class="section-tag">STEP 06 · PERSONA SIMULATION</div>
    <div class="sim-heading">
      <div><h3>페르소나 시뮬레이션</h3><p class="detail-intro">사이트에 맞춘 페르소나 집단이 저장된 HAR 안에서 사이트를 탐색하며 디자인 변형을 비교하고, 라운드마다 결과가 다음 방문자를 바꾸는 피드백 루프를 돌립니다. 실제 사이트에는 접속하지 않습니다.</p></div>
      <span class="policy-pill" :class="{ llm: pool?.llm?.configured }"><span class="policy-led"></span>{{ pool?.llm?.configured ? 'LLM 정책 · ' + pool.llm.model : '휴리스틱 정책 · API 키 없음' }}</span>
    </div>
    <div v-if="error" class="notice error">{{ error }}</div>

    <PersonaPoolPanel :run-id="runId" :run="run" :llm="pool?.llm" :limits="pool?.limits?.generation" :generation="pool?.generation" :disabled="running" @generated="onGenerated" />

    <div class="detail-card">
      <div class="card-heading"><span>기본 페르소나 풀</span><small v-if="pool">{{ pool.total }}명 · {{ pool.segments.length }}개 세그먼트 · 사이트 매칭 풀을 쓰지 않을 때 사용</small></div>
      <p v-if="pool" class="pool-source">{{ pool.source }}</p>
      <div v-if="pool" class="chip-row">
        <button v-for="seg in pool.segments" :key="seg.id" class="seg-chip" :class="{ on: form.segments.includes(seg.id) }" :disabled="running || form.poolSource === 'generated'" @click="toggleSegment(seg.id)">
          <strong>{{ seg.label }}</strong><span>{{ seg.count }}명 · {{ (seg.share * 100).toFixed(0) }}%</span>
        </button>
      </div>
      <p class="hint">세그먼트를 고르지 않으면 전체 풀에서 비중대로 추출합니다. 사이트 매칭 풀을 선택하면 위에서 생성한 아키타입 집단으로 실행합니다.</p>
    </div>

    <MirrorEditor :run-id="runId" @saved="loadSavedVariants" />

    <div class="detail-card run-form">
      <div class="card-heading"><span>시뮬레이션 실행</span><small v-if="sim">마지막 실행 {{ date(sim.createdAt) }} · {{ statusText[sim.status] || sim.status }}</small></div>
      <div class="form-grid">
        <label><span>페르소나 풀</span><select v-model="form.poolSource" :disabled="running"><option value="default">기본 풀 (928명)</option><option value="generated" :disabled="!generated">사이트 매칭 풀{{ generated ? ` (${generated.total}명)` : ' · 먼저 생성' }}</option></select></label>
        <label><span>페르소나 수</span><input v-model.number="form.personas" type="number" min="1" :max="pool?.limits?.personas?.[1] || 200" :disabled="running" /></label>
        <label><span>최대 스텝</span><input v-model.number="form.maxSteps" type="number" min="2" max="30" :disabled="running" /></label>
        <label><span>시드</span><input v-model.trim="form.seed" type="text" placeholder="비우면 무작위" :disabled="running" /></label>
        <label><span>라운드 (피드백 루프)</span><input v-model.number="form.rounds" type="number" min="1" max="5" :disabled="running" /></label>
        <label><span>라운드당 방문자</span><input v-model.number="form.visitorsPerRound" type="number" min="1" :max="pool?.limits?.visitorsPerRound?.[1] || 200" :disabled="running || form.rounds < 2" /></label>
        <label class="check"><input v-model="form.captureSteps" type="checkbox" :disabled="running" /><span>스텝별 화면 캡처 (세션당 최대 8장)</span></label>
      </div>
      <div class="variant-picker">
        <div class="picker-label">디자인 변형 <small v-if="savedVariants.length">· 미러 편집기에서 저장한 변형 {{ savedVariants.length }}개 포함</small></div>
        <label v-for="v in allVariants" :key="v.key" class="variant-opt" :class="{ on: form.variants.includes(v.key) }">
          <input type="checkbox" :checked="form.variants.includes(v.key)" :disabled="running || v.key === 'control'" @change="toggleVariant(v.key)" />
          <span class="variant-dot" :style="{ background: v.color }"></span>
          <span class="variant-text"><strong>{{ v.name }}<span v-if="v.saved" class="saved-tag">저장된 변형 · {{ v.key }}</span></strong><small>{{ v.description }}</small></span>
        </label>
      </div>
      <div class="form-actions">
        <button class="start-btn" :disabled="running || starting" @click="start">{{ running ? '실행 중…' : starting ? '시작하는 중…' : '시뮬레이션 시작' }}<span>→</span></button>
        <span class="form-note">{{ form.personas || 0 }}명 × {{ form.variants.length }}개 변형 = {{ (form.personas || 0) * form.variants.length }}세션{{ form.rounds > 1 ? ` + ${form.rounds - 1}라운드 재방문` : '' }} · 저장된 HAR만 사용</span>
      </div>
      <div v-if="running" class="progress-block">
        <div class="progress-meta"><span>{{ sim.progress.done }} / {{ sim.progress.total }} 세션<template v-if="sim.progress.rounds > 1"> · 라운드 {{ sim.progress.round }} / {{ sim.progress.rounds }}</template></span><span v-if="sim.progress.failed">실패 {{ sim.progress.failed }}</span></div>
        <div class="progress-bar"><span :style="{ width: (sim.progress.total ? sim.progress.done / sim.progress.total * 100 : 0) + '%' }"></span></div>
        <div class="event-feed"><div v-for="(event, i) in recentEvents" :key="i"><time>{{ time(event.at) }}</time><span>{{ event.message }}</span></div></div>
      </div>
      <div v-else-if="sim && sim.status !== 'completed'" class="notice error">{{ sim.error || '시뮬레이션이 완료되지 않았습니다.' }}</div>
    </div>

    <AgentLiveView :run-id="runId" :running="!!running" />

    <template v-if="report">
      <div class="metric-grid">
        <div class="metric-card"><span>세션</span><strong>{{ report.totalSessions }}<small> sessions</small></strong></div>
        <div class="metric-card"><span>전환</span><strong>{{ report.converted }}<small> / {{ report.totalSessions }}</small></strong></div>
        <div class="metric-card"><span>이탈</span><strong>{{ report.bounced }}<small> bounced</small></strong></div>
        <div class="metric-card"><span>최고 변형</span><strong class="best">{{ report.bestVariant?.name || '-' }}<small> {{ report.bestVariant?.cvr }}%</small></strong></div>
      </div>

      <div class="variant-grid">
        <div v-for="v in variantList" :key="v.key" class="variant-card" :style="{ borderTopColor: v.color }">
          <div class="variant-name">{{ v.name }}<small>n={{ v.n }}</small></div>
          <div class="variant-cvr">{{ v.cvr }}%<small>가중 전환율</small></div>
          <div class="variant-stats"><span>이탈 {{ v.bounceRate }}%</span><span>목표 도달 {{ v.goalRate }}%</span><span>참여도 {{ v.avgEngagement }}</span><span>스텝 {{ v.avgSteps }}</span></div>
          <div v-if="comparison(v.key)" class="variant-lift" :class="liftClass(comparison(v.key))">{{ liftText(comparison(v.key)) }} · p={{ comparison(v.key).pValue }}</div>
          <div v-else class="variant-lift base">기준 (Control)</div>
        </div>
      </div>

      <div class="detail-card">
        <div class="card-heading"><span>통계적 비교 (vs Control · Fisher's exact test)</span><small v-if="sim.pool">{{ sim.pool.source === 'generated' ? '사이트 매칭 풀' : '기본 풀' }} · seed {{ sim.params.seed }}</small></div>
        <table class="sim-table">
          <thead><tr><th>변형</th><th>CVR</th><th>이탈</th><th>목표 도달</th><th>참여도</th><th>감정</th><th>평균 스텝</th><th>TTC(s)</th><th>Lift</th><th>p-value</th><th>판정</th></tr></thead>
          <tbody>
            <tr v-for="v in variantList" :key="v.key">
              <td><span class="variant-dot" :style="{ background: v.color }"></span>{{ v.name }}</td>
              <td class="num strong">{{ v.cvr }}%</td><td class="num">{{ v.bounceRate }}%</td><td class="num">{{ v.goalRate }}%</td><td class="num">{{ v.avgEngagement }}</td><td class="num">{{ v.avgSentiment }}</td><td class="num">{{ v.avgSteps }}</td><td class="num">{{ v.avgTtcSec ?? '-' }}</td>
              <td class="num" :class="liftClass(comparison(v.key))">{{ comparison(v.key) ? liftText(comparison(v.key)) : '-' }}</td>
              <td class="num">{{ comparison(v.key)?.pValue ?? '-' }}</td>
              <td>{{ comparison(v.key) ? (comparison(v.key).significant ? '유의' : '미유의') : '기준' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <FeedbackLoopPanel :report="report" :personas-per-round="sim.params.visitorsPerRound" />

      <div class="two-col">
        <div class="detail-card">
          <div class="card-heading"><span>드롭오프 맵</span></div>
          <table class="sim-table">
            <thead><tr><th>경로</th><th>방문</th><th>종료율</th><th>이탈율</th><th>전환율</th></tr></thead>
            <tbody><tr v-for="row in report.dropoffMap" :key="row.path"><td><strong>{{ row.path }}</strong><small>{{ row.title }}</small></td><td class="num">{{ row.visits }}</td><td class="num">{{ row.exitRate }}%</td><td class="num">{{ row.bounceRate }}%</td><td class="num">{{ row.convertRate }}%</td></tr></tbody>
          </table>
        </div>
        <div class="detail-card">
          <div class="card-heading"><span>세그먼트 × 변형 CVR</span></div>
          <table class="sim-table">
            <thead><tr><th>세그먼트</th><th>n</th><th v-for="v in variantList" :key="v.key">{{ v.key }}</th></tr></thead>
            <tbody><tr v-for="seg in report.segments" :key="seg.segment"><td><strong>{{ seg.label }}</strong><small>{{ seg.segment }}</small></td><td class="num">{{ seg.n }}</td><td v-for="v in variantList" :key="v.key" class="num">{{ seg.byVariant[v.key] ? seg.byVariant[v.key].cvr + '%' : '-' }}</td></tr></tbody>
          </table>
          <div v-if="report.propagation" class="propagation">
            <div class="picker-label">피어 전파 추정 · K-factor ({{ report.propagation.rounds }}라운드 재추출 모델)</div>
            <div class="chip-row"><span v-for="p in Object.values(report.propagation.results)" :key="p.key" class="k-chip"><strong>{{ p.key }}</strong><span>K {{ p.kFactor }} · 누적 전환 {{ p.rounds.at(-1)?.cumulativeConverters }}</span></span></div>
          </div>
        </div>
      </div>

      <div class="two-col sessions">
        <div class="detail-card">
          <div class="card-heading"><span>세션 ({{ sim.sessions.length }})</span><small>클릭하면 에이전트 시점의 스텝 로그를 봅니다</small></div>
          <div class="session-list">
            <button v-for="s in sim.sessions" :key="s.id" class="session-row" :class="{ on: selectedId === s.id }" @click="openSession(s.id)">
              <span class="variant-dot" :style="{ background: s.variantColor }"></span>
              <span class="session-info"><strong>{{ s.persona.name }}</strong><small>{{ s.persona.demographics.age }}세 · {{ s.persona.demographics.occupation }} · {{ s.variantKey }}<template v-if="s.round > 1"> · R{{ s.round }}</template></small></span>
              <span class="session-outcome" :class="s.summary.converted ? 'ok' : s.summary.bounced ? 'bounce' : ''">{{ s.summary.converted ? '전환' : s.summary.bounced ? '이탈' : '종료' }}</span>
              <span class="session-meta">{{ s.summary.totalSteps }}스텝 · 감정 {{ s.summary.finalSentiment }}</span>
            </button>
          </div>
        </div>
        <div class="detail-card session-detail">
          <div class="card-heading"><span>에이전트 시점</span><small v-if="session">{{ session.variantName }} · {{ session.policy }} · seed {{ session.seed }}</small></div>
          <div v-if="!session" class="empty">왼쪽 목록에서 세션을 선택하세요.</div>
          <template v-else>
            <div class="persona-box">
              <strong>{{ session.persona.name }}</strong>
              <p>{{ session.persona.description }}</p>
              <small>방문 목적: {{ session.persona.goal || '-' }} · 방문 경로: {{ session.memory.visited.map(v => v.path).join(' → ') }}<template v-if="session.persona.priors"> · 프라이어 전환 성향 {{ Math.round(session.persona.priors.pConvert * 100) }}% → 결과 {{ session.summary.converted ? '전환' : session.summary.bounced ? '이탈' : '종료' }}</template></small>
            </div>
            <div v-for="step in session.steps" :key="step.step" class="step-row">
              <div class="step-num">{{ String(step.step).padStart(2, '0') }}</div>
              <div class="step-body">
                <div class="step-head"><span class="step-action">{{ step.action }}</span><span v-if="step.target" class="step-target">{{ step.target }}</span><span class="step-page">{{ step.path }}</span><span v-if="step.converted" class="step-flag ok">전환</span><span v-else-if="step.goalReached" class="step-flag">목표 페이지</span><span v-if="step.error" class="step-flag err">{{ step.error }}</span></div>
                <p>{{ step.reason }}</p>
                <small>스크롤 {{ step.scrollRatio }}% · 감정 {{ step.sentiment }} · 참여도 {{ step.engagement }} · {{ ((step.elapsedMs || 0) / 1000).toFixed(1) }}s<span v-if="step.fallback"> · {{ step.fallback }}</span></small>
                <img v-if="step.screenshot" class="step-shot" :src="`/api/runs/${runId}/simulation/sessions/${session.id}/steps/${step.step}.png`" :alt="`step ${step.step}`" loading="lazy" />
              </div>
            </div>
          </template>
        </div>
      </div>

      <FeedbackCards :run-id="runId" :sim="sim" />
      <div class="method-note">시뮬레이션 수치는 페르소나 에이전트의 가상 행동에서 나온 값이며 실제 방문자·전환율·매출을 측정하거나 예측하지 않습니다. 기본 풀은 NVIDIA Nemotron-Personas-Korea(CC BY 4.0)에서 추출한 예시 모집단이고, 사이트 매칭 풀은 그 풀(또는 로컬 Nemotron 내보내기)에서 아키타입별로 다시 뽑은 집단입니다. 휴리스틱 정책은 API 키 없이 동일한 시드에서 같은 결과를 재현합니다.</div>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import PersonaPoolPanel from '../components/PersonaPoolPanel.vue'
import FeedbackLoopPanel from '../components/FeedbackLoopPanel.vue'
import AgentLiveView from '../components/AgentLiveView.vue'
import MirrorEditor from '../components/MirrorEditor.vue'
import FeedbackCards from '../components/FeedbackCards.vue'
const props = defineProps({ runId: String, run: Object })
const pool = ref(null)
const sim = ref(null)
const session = ref(null)
const selectedId = ref('')
const error = ref('')
const starting = ref(false)
const generated = ref(null)
const savedVariants = ref([])
const form = ref({ personas: 20, maxSteps: 12, seed: '', captureSteps: true, segments: [], variants: ['control', 'largeCTA', 'trustBoost', 'contactFirst'], rounds: 1, visitorsPerRound: 20, poolSource: 'default' })
const statusText = { completed: '완료', running: '실행 중', queued: '대기', failed: '실패', interrupted: '중단' }
let timer
const running = computed(() => sim.value && ['queued', 'running'].includes(sim.value.status))
const report = computed(() => sim.value?.status === 'completed' ? sim.value.report : null)
const variantList = computed(() => report.value ? Object.values(report.value.variants) : [])
const allVariants = computed(() => [...(pool.value?.variants || []), ...savedVariants.value.map(v => ({ key: v.key, name: v.name, description: v.description, color: v.color, saved: true }))])
const recentEvents = computed(() => (props.run?.events || []).slice(-6))
const comparison = key => report.value?.comparisons.find(c => c.key === key)
const liftText = c => c.cvrLift === null ? 'n/a' : `${c.cvrLift > 0 ? '+' : ''}${c.cvrLift}%`
const liftClass = c => !c ? '' : c.cvrLift > 0 ? 'up' : c.cvrLift < 0 ? 'down' : ''
const date = value => new Date(value).toLocaleString('ko-KR')
const time = value => new Date(value).toLocaleTimeString('ko-KR')
function toggleSegment(id) { const list = form.value.segments; const i = list.indexOf(id); i >= 0 ? list.splice(i, 1) : list.push(id) }
function toggleVariant(key) { const list = form.value.variants; const i = list.indexOf(key); i >= 0 ? list.splice(i, 1) : list.push(key) }
function onGenerated(poolData) { generated.value = poolData; if (poolData && !sim.value) form.value.poolSource = 'generated' }
async function loadPool() {
  try { const res = await fetch('/api/personas'); const body = await res.json(); if (!res.ok) throw new Error(body.error); pool.value = body; if (body.defaults) { form.value.personas = body.defaults.personas; form.value.maxSteps = body.defaults.maxSteps; form.value.visitorsPerRound = body.defaults.personas } } catch (err) { error.value = err.message }
}
async function loadSavedVariants() {
  try { const res = await fetch(`/api/runs/${props.runId}/variants`); const body = await res.json(); savedVariants.value = body.variants || []; form.value.variants = form.value.variants.filter(k => k === 'control' || allVariants.value.some(v => v.key === k)) } catch { savedVariants.value = [] }
}
async function refresh() {
  try {
    const res = await fetch(`/api/runs/${props.runId}/simulation`)
    if (res.status === 404) { sim.value = null; clearInterval(timer); return }
    const body = await res.json()
    if (!res.ok) throw new Error(body.error)
    sim.value = body
    if (body.params) { form.value.rounds = body.params.rounds || 1; form.value.visitorsPerRound = body.params.visitorsPerRound || form.value.visitorsPerRound; form.value.poolSource = body.params.poolSource || 'default' }
    if (!['queued', 'running'].includes(body.status)) { clearInterval(timer); timer = null; if (body.status === 'completed' && !selectedId.value && body.sessions.length) openSession(body.sessions[0].id) }
  } catch (err) { error.value = err.message; clearInterval(timer) }
}
async function start() {
  starting.value = true; error.value = ''; session.value = null; selectedId.value = ''
  try {
    const body = { personas: form.value.personas, maxSteps: form.value.maxSteps, captureSteps: form.value.captureSteps, segments: form.value.poolSource === 'generated' ? [] : form.value.segments, variants: form.value.variants, rounds: form.value.rounds, visitorsPerRound: form.value.visitorsPerRound, poolSource: form.value.poolSource, ...(form.value.seed ? { seed: form.value.seed } : {}) }
    const res = await fetch(`/api/runs/${props.runId}/simulation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || '시뮬레이션을 시작하지 못했습니다.')
    sim.value = json
    clearInterval(timer); timer = setInterval(refresh, 1500)
  } catch (err) { error.value = err.message } finally { starting.value = false }
}
async function openSession(id) {
  selectedId.value = id
  try { const res = await fetch(`/api/runs/${props.runId}/simulation/sessions/${id}`); const body = await res.json(); if (!res.ok) throw new Error(body.error); session.value = body } catch (err) { error.value = err.message }
}
watch(running, value => { if (value && !timer) timer = setInterval(refresh, 1500) })
watch(() => form.value.personas, n => { if (!sim.value || !running.value) form.value.visitorsPerRound = n })
onMounted(() => { loadPool(); loadSavedVariants(); refresh() })
onUnmounted(() => clearInterval(timer))
</script>

<style src="./simulation-shared.css"></style>
<style scoped>
.sim-panel{max-width:1100px;margin:0 auto}
.section-tag{display:inline-block;border:1px solid var(--ss-blue);color:var(--ss-blue);font:700 10px var(--mono);letter-spacing:1.6px;padding:4px 8px}
.sim-heading{display:flex;justify-content:space-between;align-items:start;gap:20px}
.sim-heading h3{font-size:24px;letter-spacing:-.7px;margin:13px 0 8px;color:#111}
.detail-intro{font-size:12px;color:var(--ss-sub);line-height:1.7;margin:0 0 24px;max-width:640px}
.policy-pill{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:7px 14px;border:1px solid var(--ss-border);font:700 11px var(--mono);color:var(--ss-sub);white-space:nowrap}
.policy-led{width:6px;height:6px;border-radius:50%;background:var(--ss-border-dark)}
.policy-pill.llm .policy-led{background:var(--ss-blue)}
.pool-source{font-size:11px;color:var(--ss-sub);margin:0 0 14px;line-height:1.6}
.variant-picker{margin-top:20px}
.variant-picker .picker-label small{font-weight:400;color:var(--ss-muted)}
.variant-opt{display:flex;align-items:start;gap:10px;padding:10px 12px;border:1px solid var(--ss-border);margin-bottom:6px;cursor:pointer}
.variant-opt.on{border-color:var(--ss-blue)}
.variant-opt input{margin-top:3px}
.variant-text{display:grid;gap:3px}
.variant-text strong{font-size:12px}
.variant-text small{font-size:11px;color:var(--ss-sub);line-height:1.5}
.saved-tag{margin-left:8px;font:700 9px var(--mono);color:var(--ss-blue);border:1px solid var(--ss-blue);padding:1px 5px}
.form-actions{display:flex;align-items:center;gap:18px;margin-top:20px;flex-wrap:wrap}
.form-note{margin:0}
.progress-block{margin-top:22px}
.progress-meta{display:flex;justify-content:space-between;font:700 11px var(--mono);color:var(--ss-sub);margin-bottom:8px}
.event-feed{padding:14px 18px;background:var(--ss-bg-sub);border:1px solid var(--ss-border);margin-top:16px}
.event-feed>div{display:flex;gap:16px;padding:6px 0;border-bottom:1px solid var(--ss-border);font-size:11px}
.event-feed>div:last-child{border-bottom:0}
.event-feed time{font:10px var(--mono);color:var(--ss-muted);white-space:nowrap}
.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0 0}
.metric-card{background:#fff;border:1px solid var(--ss-border);padding:22px;min-width:0}
.metric-card>span{font:700 10px var(--mono);color:var(--ss-sub);letter-spacing:.5px}
.metric-card strong{display:block;color:var(--ss-blue);font:800 30px var(--mono);margin-top:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.metric-card strong.best{font-size:18px;font-family:var(--sans);white-space:normal}
.metric-card strong.best small{display:block;margin-top:4px}
.metric-card small{font:11px var(--mono);color:var(--ss-muted)}
.variant-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:18px}
.variant-card{background:#fff;border:1px solid var(--ss-border);border-top:3px solid var(--ss-blue);padding:20px}
.variant-name{display:flex;justify-content:space-between;font-size:13px;font-weight:700}
.variant-name small{font:10px var(--mono);color:var(--ss-muted)}
.variant-cvr{font:800 34px var(--mono);color:var(--ss-blue);margin:14px 0 4px}
.variant-cvr small{display:block;font:700 10px var(--mono);color:var(--ss-sub);letter-spacing:.5px;margin-top:2px}
.variant-stats{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--ss-sub);margin-top:12px}
.variant-lift{margin-top:14px;font:700 11px var(--mono);color:var(--ss-sub)}
.variant-lift.up{color:#0a7a3f}
.variant-lift.down{color:#b42318}
.propagation{margin-top:22px}
.k-chip{display:grid;gap:3px;border:1px solid var(--ss-border);padding:8px 12px;font-size:11px}
.k-chip span{font:10px var(--mono);color:var(--ss-muted)}
.sessions{grid-template-columns:1fr 1.4fr}
.session-list{max-height:640px;overflow-y:auto}
.session-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--ss-border);padding:11px 4px;cursor:pointer;font-family:inherit;color:var(--ss-text)}
.session-row:hover{background:var(--ss-bg-sub)}
.session-row.on{background:#eef2ff}
.session-row .variant-dot{margin-top:0}
.session-info{flex:1;display:grid;gap:3px;min-width:0}
.session-info strong{font-size:12px}
.session-info small{font:10px var(--mono);color:var(--ss-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session-outcome{font:700 10px var(--mono);color:var(--ss-sub);border:1px solid var(--ss-border);padding:3px 6px}
.session-outcome.ok{color:#0a7a3f;border-color:#0a7a3f}
.session-outcome.bounce{color:#b42318;border-color:#b42318}
.session-meta{font:10px var(--mono);color:var(--ss-muted);white-space:nowrap}
.session-detail{max-height:640px;overflow-y:auto}
.persona-box{background:var(--ss-bg-sub);border:1px solid var(--ss-border);padding:16px;margin-bottom:18px}
.persona-box strong{font-size:13px}
.persona-box p{font-size:12px;color:var(--ss-sub);line-height:1.7;margin:8px 0}
.persona-box small{font:10px var(--mono);color:var(--ss-muted)}
.step-row{display:flex;gap:14px;padding:14px 0;border-top:1px solid var(--ss-border)}
.step-num{font:700 11px var(--mono);color:var(--ss-blue);border:1px solid var(--ss-blue);padding:4px 6px;align-self:start}
.step-body{flex:1;min-width:0}
.step-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px}
.step-action{font:800 11px var(--mono);color:var(--ss-text);text-transform:uppercase}
.step-target{font:11px var(--mono);color:var(--ss-blue);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.step-page{font:10px var(--mono);color:var(--ss-muted)}
.step-flag{font:700 9px var(--mono);border:1px solid var(--ss-border-dark);color:var(--ss-sub);padding:2px 5px;letter-spacing:.5px}
.step-flag.ok{color:#0a7a3f;border-color:#0a7a3f}
.step-flag.err{color:#b42318;border-color:#b42318}
.step-body p{font-size:12px;color:var(--ss-text);line-height:1.6;margin:7px 0 5px}
.step-body small{font:10px var(--mono);color:var(--ss-muted)}
.step-shot{display:block;width:100%;max-width:420px;border:1px solid var(--ss-border);margin-top:10px}
.method-note{font-size:11px;color:var(--ss-muted);padding:24px 0;line-height:1.7}
@media(max-width:1100px){.sessions{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:750px){.metric-grid{grid-template-columns:1fr}.sim-heading{flex-direction:column}}
</style>
