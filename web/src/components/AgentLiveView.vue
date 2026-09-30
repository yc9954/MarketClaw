<template>
  <div class="detail-card live-panel">
    <div class="card-heading">
      <span><span class="live-badge" :class="{ on: state.running }">LIVE</span>에이전트 라이브 뷰</span>
      <small>{{ state.running ? `실행 중 · 라운드 ${state.round || 1} · 활성 ${state.agents.length}명 · 프레임 ${state.frames}` : state.endedAt ? `종료 · 프레임 ${state.frames}` : '대기 중' }} · CDP 스크린캐스트 JPEG ≤{{ state.fps || 5 }}fps</small>
    </div>
    <div class="live-body">
      <div class="stage">
        <div class="stage-bar"><span class="stage-path">{{ spotlight?.path || frame?.path || '/' }}</span><span class="stage-meta" v-if="spotlight">{{ spotlight.variantName }} · 스텝 {{ spotlight.step }}</span><span class="stage-meta" v-else-if="frame">마지막 프레임 · {{ time(frame.at) }}</span></div>
        <div class="stage-frame">
          <img v-if="frame" :src="'data:image/jpeg;base64,' + frame.data" alt="에이전트 시점 화면" />
          <div v-else class="stage-empty">{{ state.running ? '첫 프레임을 기다리는 중…' : '실행 중인 세션이 없습니다. 시뮬레이션을 시작하면 첫 세션이 자동으로 스포트라이트되고, 다른 세션은 헤드리스로 계속 실행됩니다.' }}</div>
          <span v-if="frame && !state.running" class="stage-ended">종료된 세션의 마지막 화면</span>
        </div>
      </div>
      <div class="side">
        <div v-if="spotlight" class="persona-box">
          <strong>{{ shortName(spotlight.persona) }}<span class="seg-label">{{ spotlight.persona.name }}</span></strong>
          <p>{{ spotlight.persona.description }}</p>
          <small>{{ spotlight.persona.demographics?.age }}세 · {{ spotlight.persona.demographics?.occupation }} · {{ spotlight.persona.demographics?.province }} · {{ spotlight.variantKey }}</small>
        </div>
        <div v-else class="persona-box empty-box">{{ lastPersona ? `마지막 스포트라이트: ${shortName(lastPersona)} · ${lastPersona.name}` : '스포트라이트할 세션이 없습니다.' }}</div>
        <div class="action-box">
          <div class="picker-label">현재 행동</div>
          <div class="action-now"><span class="act" :style="{ color: color(spotlight?.action) }">{{ label(spotlight?.action) }}</span><span class="act-target">{{ spotlight?.target || '' }}</span></div>
          <p class="act-reason">{{ spotlight?.reason || (state.running ? '행동을 기다리는 중…' : '-') }}</p>
          <div class="stats"><div><strong>{{ spotlight?.sentiment ?? '-' }}</strong><span>감정</span></div><div><strong>{{ spotlight?.engagement ?? '-' }}</strong><span>참여도</span></div><div><strong>{{ spotlight?.step ?? '-' }}</strong><span>스텝</span></div><div><strong>{{ spotlight?.history?.filter(h => h.path).map(h => h.path).filter((p, i, a) => a.indexOf(p) === i).length ?? '-' }}</strong><span>페이지</span></div></div>
        </div>
        <div class="picker-label">행동 이력 <small>({{ history.length }})</small></div>
        <div class="history">
          <div v-for="(h, i) in history" :key="i" class="hist-row"><span class="hist-step">{{ String(h.step).padStart(2, '0') }}</span><span class="hist-act" :style="{ color: color(h.action) }">{{ label(h.action) }}</span><span class="hist-target">{{ h.target || h.path }}</span><span v-if="h.converted" class="hist-flag ok">전환</span><span v-else-if="h.goalReached" class="hist-flag">목표</span><span class="hist-ts">{{ time(h.at) }}</span></div>
          <div v-if="!history.length" class="hist-empty">아직 기록 없음</div>
        </div>
        <div class="picker-label">동시 실행 에이전트 <small>({{ state.agents.length }}) · 클릭하면 스포트라이트 전환</small></div>
        <div class="agents">
          <button v-for="a in state.agents" :key="a.id" class="agent-row" :class="{ on: a.id === state.spotlight }" @click="focus(a.id)"><span class="status-led on"></span><span class="agent-name">{{ shortName(a.persona) }}</span><span class="agent-seg">{{ a.persona.name }}</span><span class="agent-meta">{{ a.variantKey }} · 스텝 {{ a.step }} · {{ label(a.action) }}</span></button>
          <div v-if="!state.agents.length" class="hist-empty">{{ state.running ? '세션 시작 대기 중' : '실행 중인 에이전트가 없습니다' }}</div>
          <div v-for="d in finished.slice(0, 4)" :key="'d' + d.sessionId" class="agent-row done"><span class="status-led"></span><span class="agent-name">{{ shortName(d.persona) }}</span><span class="agent-seg">{{ d.persona.name }}</span><span class="agent-meta">{{ d.variantKey }} · {{ d.summary.converted ? '전환' : d.summary.bounced ? '이탈' : '종료' }} · {{ d.summary.totalSteps }}스텝</span></div>
        </div>
      </div>
    </div>
    <div v-if="error" class="notice error">{{ error }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
const props = defineProps({ runId: String, running: Boolean })
const state = ref({ running: false, spotlight: null, agents: [], frames: 0, round: 1 })
const frame = ref(null)
const error = ref('')
const finished = ref([])
const lastPersona = ref(null)
let source = null
const spotlight = computed(() => state.value.agents.find(a => a.id === state.value.spotlight) || null)
const history = computed(() => (spotlight.value?.history || []).slice().reverse())
const LABELS = { visiting: '방문', click: '클릭', type: '입력', scroll_down: '스크롤↓', scroll_up: '스크롤↑', read: '읽기', dwell: '머무름', hover: '호버', viewport_focus: '주시', goto: '이동', back: '뒤로', key_press: '키 입력', select: '선택', do_nothing: '대기', bounce: '이탈', share_intent: '공유 의도', save_intent: '저장 의도', copy_text: '복사', error: '오류' }
const label = a => LABELS[a] || a || '-'
const shortName = p => ((p?.persona_name || '').split(/ 씨는| 씨가|은 |는 /)[0].trim().slice(0, 14)) || p?.name || '-'
const color = a => a === 'bounce' || a === 'error' ? '#b42318' : ['click', 'type', 'key_press', 'select'].includes(a) ? '#000' : ['read', 'dwell', 'viewport_focus'].includes(a) ? '#555' : a === 'visiting' ? '#6d28d9' : '#0f43f3'
const time = v => v ? new Date(v).toLocaleTimeString('ko-KR') : ''
function connect() {
  disconnect()
  error.value = ''
  source = new EventSource(`/api/runs/${props.runId}/simulation/live`)
  source.addEventListener('state', e => { const s = JSON.parse(e.data); state.value = { ...state.value, ...s }; if (spotlight.value) lastPersona.value = spotlight.value.persona })
  source.addEventListener('frame', e => { frame.value = JSON.parse(e.data) })
  source.addEventListener('step', e => { const s = JSON.parse(e.data); const i = state.value.agents.findIndex(a => a.id === s.sessionId); if (i >= 0) state.value.agents[i] = { ...state.value.agents[i], ...s }; else state.value.agents.push({ ...s, id: s.sessionId }) })
  source.addEventListener('done', e => { const d = JSON.parse(e.data); finished.value.unshift(d); if (finished.value.length > 12) finished.value.pop(); state.value.agents = state.value.agents.filter(a => a.id !== d.sessionId) })
  source.addEventListener('end', e => { const s = JSON.parse(e.data); state.value = { ...state.value, ...s, running: false, agents: [] }; disconnect() })
  source.onerror = () => { if (state.value.running) error.value = '라이브 스트림 연결이 끊겼습니다. 다시 연결합니다…'; disconnect(); if (props.running) setTimeout(connect, 1500) }
}
function disconnect() { if (source) { source.close(); source = null } }
async function focus(id) {
  try { const res = await fetch(`/api/runs/${props.runId}/simulation/live/spotlight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }); const body = await res.json(); if (!res.ok) throw new Error(body.error) } catch (err) { error.value = err.message }
}
watch(() => props.running, on => { if (on) { frame.value = null; finished.value = []; connect() } })
onMounted(async () => { try { const s = await (await fetch(`/api/runs/${props.runId}/simulation/live/state`)).json(); state.value = { ...state.value, ...s }; if (s.running) connect() } catch { /* idle */ } })
onUnmounted(disconnect)
</script>

<style scoped>
.live-badge{display:inline-block;font:800 9px var(--mono);letter-spacing:1px;padding:2px 6px;border:1px solid var(--ss-border-dark);color:var(--ss-muted);margin-right:10px;vertical-align:middle}
.live-badge.on{border-color:#b42318;color:#b42318;animation:sim-pulse 1.2s infinite}
.live-body{display:grid;grid-template-columns:1.6fr 1fr;gap:20px}
.stage-bar{display:flex;justify-content:space-between;font:10px var(--mono);color:var(--ss-muted);padding:8px 12px;border:1px solid var(--ss-border);border-bottom:0;background:var(--ss-bg-sub)}
.stage-path{color:var(--ss-blue);font-weight:700}
.stage-frame{position:relative;aspect-ratio:16/10;border:1px solid var(--ss-border);background:#111;overflow:hidden}
.stage-frame img{display:block;width:100%;height:100%;object-fit:contain;background:#fff}
.stage-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;font-size:12px;color:#bbb;line-height:1.7}
.stage-ended{position:absolute;right:10px;bottom:10px;font:700 10px var(--mono);background:rgba(0,0,0,.7);color:#fff;padding:4px 8px}
.persona-box{background:var(--ss-bg-sub);border:1px solid var(--ss-border);padding:14px;margin-bottom:14px}
.persona-box strong{font-size:13px}
.seg-label{margin-left:8px;font:700 10px var(--mono);color:var(--ss-blue)}
.agent-seg{font:10px var(--mono);color:var(--ss-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.persona-box p{font-size:11px;color:var(--ss-sub);line-height:1.6;margin:6px 0;max-height:52px;overflow:hidden}
.persona-box small{font:10px var(--mono);color:var(--ss-muted)}
.empty-box{font-size:11px;color:var(--ss-muted)}
.action-box{margin-bottom:14px}
.action-now{display:flex;align-items:baseline;gap:10px}
.act{font:800 14px var(--mono);text-transform:uppercase}
.act-target{font:11px var(--mono);color:var(--ss-blue);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act-reason{font-size:11px;color:var(--ss-text);line-height:1.6;margin:6px 0 10px;min-height:18px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.stats div{border:1px solid var(--ss-border);padding:8px;text-align:center;display:grid;gap:2px}
.stats strong{font:800 15px var(--mono);color:var(--ss-blue)}
.stats span{font:9px var(--mono);color:var(--ss-muted)}
.history{max-height:180px;overflow-y:auto;border:1px solid var(--ss-border);margin-bottom:14px}
.hist-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--ss-border);font-size:11px}
.hist-row:last-child{border-bottom:0}
.hist-step{font:700 10px var(--mono);color:var(--ss-muted)}
.hist-act{font:800 10px var(--mono);text-transform:uppercase;min-width:52px}
.hist-target{flex:1;font:10px var(--mono);color:var(--ss-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hist-flag{font:700 9px var(--mono);border:1px solid var(--ss-border-dark);padding:1px 4px;color:var(--ss-sub)}
.hist-flag.ok{color:#0a7a3f;border-color:#0a7a3f}
.hist-ts{font:9px var(--mono);color:var(--ss-muted)}
.hist-empty{font-size:11px;color:var(--ss-muted);padding:12px;text-align:center}
.agents{max-height:200px;overflow-y:auto;border:1px solid var(--ss-border)}
.agent-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--ss-border);padding:8px 10px;cursor:pointer;font-family:inherit;color:var(--ss-text);font-size:11px}
.agent-row:hover{background:var(--ss-bg-sub)}
.agent-row.on{background:#eef2ff}
.agent-row.done{cursor:default;color:var(--ss-muted)}
.agent-name{font-weight:700;white-space:nowrap}
.agent-meta{margin-left:auto;font:10px var(--mono);color:var(--ss-muted);white-space:nowrap}
@media(max-width:1100px){.live-body{grid-template-columns:1fr}}
</style>
