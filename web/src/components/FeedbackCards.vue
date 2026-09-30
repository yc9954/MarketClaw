<template>
  <div class="detail-card fb-panel">
    <div class="card-heading">
      <span>피드백 카드 · 시뮬레이션 근거 기반 제안</span>
      <div class="heading-actions">
        <small v-if="data">{{ data.cards.length }}개 제안 · {{ doneCount }}개 완료 · {{ data.llm?.refined ? 'LLM 다듬기 적용' : '규칙 기반' }}</small>
        <button v-if="data?.llm?.configured" class="ghost-btn" :disabled="loading" @click="load(true)">LLM으로 다듬기</button>
        <button class="ghost-btn" :disabled="loading" @click="load(false)">새로고침</button>
      </div>
    </div>
    <div v-if="error" class="notice error">{{ error }}</div>
    <div v-if="!data && !loading" class="empty">완료된 시뮬레이션이 있어야 카드를 만들 수 있습니다.</div>
    <template v-else-if="data">
      <div class="fb-body">
        <div class="feed">
          <div class="chip-row filters">
            <button class="chip" :class="{ on: filter === '' }" @click="filter = ''">전체 <small>{{ data.cards.length }}</small></button>
            <button v-for="(label, key) in data.categories" :key="key" class="chip" :class="{ on: filter === key }" @click="filter = key">{{ label }} <small>{{ data.summary?.categories?.[key] || 0 }}</small></button>
          </div>
          <div v-for="c in visible" :key="c.id" class="fb-card" :class="['cat-' + c.category, { done: !!data.actions[c.id] }]">
            <div class="fb-top"><span class="fb-cat">{{ data.categories[c.category] }}</span><span class="fb-conf">확신 {{ c.confidence }}%</span><span v-if="c.refined" class="fb-llm">LLM</span><label class="fb-check"><input type="checkbox" :checked="!!data.actions[c.id]" @change="toggle(c, $event.target.checked)" /><span>{{ data.actions[c.id] ? '완료' : '실행 큐에 담기' }}</span></label></div>
            <div class="fb-title">{{ c.title }}</div>
            <p class="fb-desc">{{ c.description }}</p>
            <div class="fb-evidence"><span class="ev-label">근거</span><span class="ev-chips"><span v-if="c.evidence.variant">변형 {{ c.evidence.variant }}</span><span v-if="c.evidence.segment">세그먼트 {{ segLabel(c.evidence.segment) }}</span><span v-if="c.evidence.page">페이지 {{ c.evidence.page }}</span><span>{{ c.evidence.metric }} = {{ c.evidence.value }}<template v-if="c.evidence.baseline !== undefined && c.evidence.baseline !== null"> (기준 {{ c.evidence.baseline }})</template></span><span v-if="c.evidence.pValue !== undefined">p = {{ c.evidence.pValue }}</span><span>n = {{ c.evidence.n }}</span></span></div>
            <div class="fb-action"><span class="ev-label">제안</span><span>{{ c.action }}</span></div>
          </div>
          <div v-if="!visible.length" class="empty">이 분류에는 카드가 없습니다.</div>
        </div>
        <aside class="side">
          <div class="side-section">
            <div class="picker-label">세션 요약</div>
            <div class="sum-grid">
              <div><strong>{{ data.summary.sessions }}</strong><span>세션</span></div>
              <div><strong>{{ data.summary.converted }}</strong><span>전환</span></div>
              <div><strong>{{ data.summary.bounced }}</strong><span>이탈</span></div>
              <div><strong>{{ data.summary.rounds }}</strong><span>라운드</span></div>
              <div><strong>{{ data.summary.controlCvr ?? '-' }}%</strong><span>Control CVR</span></div>
              <div><strong class="best">{{ data.summary.bestVariant?.name || '-' }}</strong><span>최고 변형 {{ data.summary.bestVariant?.cvr ?? '' }}%</span></div>
            </div>
          </div>
          <div class="side-section">
            <div class="picker-label">실행 큐 <small>({{ doneCount }})</small></div>
            <div v-if="doneCards.length" class="queue"><div v-for="c in doneCards" :key="c.id" class="queue-item"><span class="q-check">✓</span><span>{{ c.title }}</span><button class="q-undo" @click="toggle(c, false)">취소</button></div></div>
            <div v-else class="hist-empty">체크한 카드가 여기에 쌓입니다. 상태는 분석별로 저장됩니다.</div>
          </div>
          <div class="side-section">
            <div class="picker-label">정책</div>
            <p class="side-note">{{ data.summary.policy === 'llm' ? 'LLM' : '휴리스틱' }} 정책 세션 · {{ date(data.summary.generatedAt) }}<br />카드는 리포트 수치(가중 CVR, 이탈, 목표 도달, 드롭오프, 세그먼트, 라운드 K-factor)에서 규칙으로 도출됩니다.{{ data.llm?.configured ? ' LLM 다듬기는 제목·설명·제안 문구만 바꾸고 근거는 그대로 둡니다.' : '' }}</p>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
const props = defineProps({ runId: String, sim: Object })
const data = ref(null)
const error = ref('')
const loading = ref(false)
const filter = ref('')
const labels = computed(() => Object.fromEntries((props.sim?.report?.segments || []).map(s => [s.segment, s.label])))
const segLabel = seg => labels.value[seg] || seg
const visible = computed(() => (data.value?.cards || []).filter(c => !filter.value || c.category === filter.value))
const doneCards = computed(() => (data.value?.cards || []).filter(c => data.value.actions[c.id]))
const doneCount = computed(() => doneCards.value.length)
const date = v => v ? new Date(v).toLocaleString('ko-KR') : ''
async function load(refine = false) {
  if (props.sim?.status !== 'completed') { data.value = null; return }
  loading.value = true; error.value = ''
  try { const res = await fetch(`/api/runs/${props.runId}/simulation/feedback${refine ? '?refine=1' : ''}`); const body = await res.json(); if (!res.ok) throw new Error(body.error); data.value = body } catch (err) { error.value = err.message } finally { loading.value = false }
}
async function toggle(card, done) {
  try { const res = await fetch(`/api/runs/${props.runId}/simulation/feedback/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: card.id, done }) }); const body = await res.json(); if (!res.ok) throw new Error(body.error); data.value.actions = body.actions } catch (err) { error.value = err.message }
}
watch(() => props.sim?.status === 'completed' && props.sim?.createdAt, v => { if (v) load() })
onMounted(() => load())
</script>

<style scoped>
.fb-body{display:grid;grid-template-columns:1.7fr 1fr;gap:22px}
.filters{margin-bottom:14px}
.filters .chip{cursor:pointer;font-family:inherit}
.fb-card{border:1px solid var(--ss-border);border-left:3px solid var(--ss-blue);padding:16px 18px;margin-bottom:10px;background:#fff}
.fb-card.cat-copy{border-left-color:#0f43f3}.fb-card.cat-cta{border-left-color:#000}.fb-card.cat-trust{border-left-color:#f59e0b}.fb-card.cat-navigation{border-left-color:#a78bfa}.fb-card.cat-friction{border-left-color:#b42318}
.fb-card.done{background:var(--ss-bg-sub);opacity:.75}
.fb-top{display:flex;align-items:center;gap:10px;font:700 10px var(--mono);color:var(--ss-sub)}
.fb-cat{border:1px solid var(--ss-border-dark);padding:2px 6px;letter-spacing:.5px}
.fb-llm{color:var(--ss-blue)}
.fb-check{margin-left:auto;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font:600 11px var(--sans);color:var(--ss-text)}
.fb-title{font-size:13px;font-weight:700;margin:10px 0 6px;letter-spacing:-.2px}
.fb-desc{font-size:12px;color:var(--ss-sub);line-height:1.7;margin:0 0 10px}
.fb-evidence,.fb-action{display:flex;gap:10px;align-items:baseline;font-size:11px;line-height:1.6;padding:8px 10px;background:var(--ss-bg-sub);border:1px solid var(--ss-border);margin-top:6px}
.ev-label{font:700 9px var(--mono);color:var(--ss-blue);letter-spacing:1px;white-space:nowrap}
.ev-chips{display:flex;flex-wrap:wrap;gap:4px 12px;font:10px var(--mono);color:var(--ss-sub)}
.side-section{margin-bottom:20px}
.sum-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.sum-grid div{border:1px solid var(--ss-border);padding:10px;text-align:center;display:grid;gap:3px;min-width:0}
.sum-grid strong{font:800 16px var(--mono);color:var(--ss-blue);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sum-grid strong.best{font:700 11px var(--sans);white-space:normal}
.sum-grid span{font:9px var(--mono);color:var(--ss-muted)}
.queue{border:1px solid var(--ss-border)}
.queue-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--ss-border);font-size:11px}
.queue-item:last-child{border-bottom:0}
.q-check{color:#0a7a3f;font-weight:800}
.q-undo{margin-left:auto;background:none;border:0;font:700 10px var(--mono);color:var(--ss-muted);cursor:pointer}
.hist-empty{font-size:11px;color:var(--ss-muted);padding:12px;border:1px dashed var(--ss-border);line-height:1.6}
.side-note{font-size:11px;color:var(--ss-muted);line-height:1.7;margin:0}
@media(max-width:1100px){.fb-body{grid-template-columns:1fr}}
</style>
