<template>
  <div class="workspace">
    <aside class="sidebar">
      <div class="sidebar-brand" @click="router.push('/')">
        <span class="brand-dot"></span><span class="brand-name">MarketClaw</span><span class="brand-predict">Analyze</span>
      </div>
      <div class="sidebar-target">
        <div class="target-label">분석 대상</div>
        <div class="target-url">{{ host || '불러오는 중' }}</div>
        <div class="target-meta">{{ run ? 'RUN ' + run.id.slice(0, 8).toUpperCase() : '브라우저 분석' }}</div>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section-label">PIPELINE · 7 STEPS</div>
        <button v-for="(tab, i) in tabs" :key="tab.id" class="nav-item" :class="{ active: currentTab === tab.id, done: run?.status === 'completed' }" @click="currentTab = tab.id">
          <span class="step-num">{{ String(i).padStart(2, '0') }}</span>
          <component :is="tab.icon" class="nav-icon" :size="15" weight="regular" />
          <span class="nav-body"><span class="nav-title">{{ tab.title }}</span><span class="nav-desc">{{ tab.desc }}</span></span>
          <span v-if="run?.status === 'running' && tab.id === 'log'" class="live-pip"></span>
        </button>
      </nav>
      <div class="sidebar-flow">
        <div class="flow-section-label">ANALYSIS FLOW</div>
        <div class="flow-track">
          <div v-for="(step, i) in tabs" :key="step.id" class="fsm-step" :class="{ done: run?.status === 'completed', active: currentTab === step.id }">
            <div class="fsm-left"><div class="fsm-node" :class="{ done: run?.status === 'completed', active: currentTab === step.id }"></div><div v-if="i < tabs.length - 1" class="fsm-edge"></div></div>
            <div class="fsm-info"><component :is="step.icon" class="fsm-icon" :size="13" weight="regular" /><span class="fsm-text">{{ step.title }}</span></div>
          </div>
        </div>
      </div>
      <div class="sidebar-bottom"><span class="sidebar-language">한국어 ▾</span><span class="sidebar-version">v1.2</span></div>
    </aside>

    <div class="main-area">
      <div class="context-bar">
        <div class="context-left">
          <div class="context-crumb"><span class="crumb-root">pipeline</span><span class="crumb-sep">/</span><span class="crumb-step">STEP {{ String(stepIndex).padStart(2, '0') }}</span><span class="crumb-sep">/</span><span class="crumb-cur">{{ activeTab.breadcrumb }}</span></div>
          <h2 class="context-title">{{ activeTab.title }}</h2>
        </div>
        <div class="context-right"><div class="status-pill" :class="{ running: run?.status === 'running', done: run?.status === 'completed' }"><span class="status-led"></span><span class="status-label">{{ statusLabel }}</span><span class="status-url">{{ host }}</span></div></div>
      </div>
      <div class="sub-tabs">
        <button v-for="sub in quickTabs" :key="sub.id" class="sub-tab" :class="{ active: currentTab === sub.id }" @click="currentTab = sub.id"><component :is="sub.icon" :size="13" weight="regular" /><span>{{ sub.label }}</span></button>
        <div class="sub-tab-spacer"></div><span class="sub-tab-hint">캡처 → 경로 재생 → 근거 확인 → 페르소나 시뮬레이션</span>
      </div>
      <div class="panel-body">
        <div class="work-panel">
          <div v-if="error" class="notice error">{{ error }}</div>
          <template v-if="run">
            <div v-if="run.status !== 'completed'" class="pending-card">
              <div class="section-tag">PIPELINE STATUS</div>
              <h3>{{ run.status === 'failed' || run.status === 'interrupted' ? '분석을 완료하지 못했습니다' : '웹사이트를 분석하고 있습니다' }}</h3>
              <p>{{ run.error || '실제 브라우저에서 페이지를 열고 HAR을 저장한 뒤 경로를 재생합니다.' }}</p>
              <div v-if="run.status === 'running' || run.status === 'queued'" class="progress-track"><span></span></div>
              <div class="event-feed"><div v-for="(event, i) in run.events" :key="i"><time>{{ time(event.at) }}</time><span>{{ event.message }}</span></div></div>
            </div>
            <template v-else>
              <section v-if="currentTab === 'report'" class="overview-panel">
                <div class="report-heading"><div><div class="section-tag">INTEGRATED REPORT</div><h3>{{ host }} 분석 결과</h3><p>실제 페이지 탐색과 저장된 네트워크 기록에서 확인한 결과입니다.</p></div><span class="report-date">{{ date(run.createdAt) }}</span></div>
                <div class="pipeline-box"><div class="pipeline-label">EVIDENCE FLOW</div><div class="pipeline-stages"><div><PhGlobe :size="21" /><strong>브라우저 탐색</strong><small>동일 출처 페이지</small></div><span>→</span><div><PhRecord :size="21" /><strong>HAR 녹화</strong><small>화면·요청 기록</small></div><span>→</span><div><PhUsersThree :size="21" /><strong>경로 재생</strong><small>방문 목적별 이동</small></div><span>→</span><div><PhRobot :size="21" /><strong>개선 피드백</strong><small>근거와 다음 행동</small></div></div></div>
                <div class="metric-grid">
                  <div class="metric-card"><span>확인한 페이지</span><strong>{{ summary.pagesInspected }}<small> pages</small></strong></div>
                  <div class="metric-card"><span>재생한 경로</span><strong>{{ summary.journeysCompleted }}<small> / {{ summary.journeysAttempted }}</small></strong></div>
                  <div class="metric-card"><span>첫 화면 CTA</span><strong>{{ summary.aboveFoldCtas }}<small> visible</small></strong></div>
                  <div class="metric-card"><span>차단한 추적 요청</span><strong>{{ summary.requestsBlocked }}<small> requests</small></strong></div>
                </div>
                <div class="result-grid">
                  <div class="result-card"><div class="card-heading"><span>실제로 본 화면</span><button @click="currentTab = 'capture'">전체 화면 보기 →</button></div><img class="preview-image" :src="run.screenshotUrl" :alt="host + ' 첫 페이지 캡처'" /></div>
                  <div class="result-card"><div class="card-heading"><span>발견한 개선 지점</span><button @click="currentTab = 'feedback'">모두 보기 →</button></div><div v-for="(item, i) in summary.findings.slice(0, 4)" :key="i" class="finding-preview"><span>{{ String(i + 1).padStart(2, '0') }}</span><div><strong>{{ item.title }}</strong><p>{{ item.evidence }}</p></div></div></div>
                </div>
                <div class="method-note">이 결과는 페이지 구조와 읽기 전용 탐색 기록입니다. 실제 방문자 행동·전환율·매출을 측정하거나 예측하지 않습니다.</div>
              </section>
              <section v-else-if="currentTab === 'target'" class="detail-panel">
                <div class="section-tag">STEP 00 · TARGET</div><h3>분석 대상</h3><div class="detail-card"><div class="detail-url">{{ run.url }}</div><p>동일 출처 내부 링크를 따라 최대 4개 페이지를 탐색했습니다. 브라우저 컨텍스트는 분석마다 분리됩니다.</p><a :href="run.url" target="_blank" rel="noreferrer">원본 사이트 열기 ↗</a></div>
              </section>
              <section v-else-if="currentTab === 'capture'" class="detail-panel">
                <div class="section-tag">STEP 01 · BROWSER CAPTURE</div><h3>실제로 본 화면</h3><p class="detail-intro">첫 페이지 전체 화면 캡처와 탐색한 페이지 목록입니다.</p><div class="browser-frame"><div class="browser-bar">● ● ● <span>{{ run.url }}</span></div><img :src="run.screenshotUrl" :alt="host + ' 캡처'" /></div>
                <div class="detail-card page-inventory"><h4>탐색한 페이지</h4><div v-for="page in run.report.pages" :key="page.url" class="page-row"><div><strong>{{ page.title || '제목 없음' }}</strong><small>{{ page.url }}</small></div><span>{{ page.error ? '오류' : 'HTTP ' + page.status }}</span><span>CTA {{ page.ctas.length }}</span></div></div>
              </section>
              <section v-else-if="currentTab === 'replay'" class="detail-panel">
                <div class="section-tag">STEP 02 · OFFLINE REPLAY</div><h3>방문자 경로 재생</h3><p class="detail-intro">저장된 HAR에서 읽기 전용 이동을 확인했습니다. 폼 제출은 수행하지 않습니다.</p><div class="journey-grid"><div v-for="journey in run.report.journeys" :key="journey.profile" class="detail-card journey-card"><div class="journey-title"><strong>{{ journey.profile }}</strong><span>{{ journey.success ? '경로 확인' : '확인 필요' }}</span></div><div v-for="(step, i) in journey.steps" :key="i" class="journey-step"><b>{{ i + 1 }}</b><div><strong>{{ step.title || '제목 없음' }}</strong><small>{{ step.url }}</small></div></div><p v-if="journey.note">{{ journey.note }}</p></div></div>
              </section>
              <section v-else-if="currentTab === 'log'" class="detail-panel"><div class="section-tag">STEP 04 · ACTIVITY LOG</div><h3>실행 기록</h3><div class="detail-card event-feed"><div v-for="(event, i) in run.events" :key="i"><time>{{ time(event.at) }}</time><span>{{ event.message }}</span></div></div></section>
              <section v-else-if="currentTab === 'simulation'" class="detail-panel"><Simulation :run-id="run.id" :run="run" /></section>
              <section v-else-if="currentTab === 'feedback'" class="detail-panel"><div class="section-tag">STEP 05 · FEEDBACK</div><h3>발견한 개선 지점</h3><p class="detail-intro">관찰 근거와 실행 가능한 다음 단계를 함께 표시합니다.</p><div v-for="(item, i) in summary.findings" :key="i" class="detail-card feedback-card"><span class="feedback-index">{{ String(i + 1).padStart(2, '0') }}</span><div><span class="feedback-level">{{ item.level === 'high' ? '우선 확인' : item.level === 'medium' ? '개선 기회' : '확인 결과' }}</span><h4>{{ item.title }}</h4><p><b>근거</b> {{ item.evidence }}</p><p><b>제안</b> {{ item.action }}</p></div></div></section>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { PhGlobe, PhRecord, PhUsersThree, PhUsersFour, PhTerminal, PhRobot, PhChartBar } from '@phosphor-icons/vue'
import Simulation from './Simulation.vue'
const props = defineProps({ id: String })
const router = useRouter()
const run = ref(null)
const error = ref('')
const currentTab = ref('report')
let timer
const tabs = [
  { id: 'target', title: 'URL 입력', desc: '대상 사이트 · 분석 범위', breadcrumb: 'Target', icon: PhGlobe },
  { id: 'capture', title: 'HAR 녹화', desc: '실제 페이지 · 요청 기록', breadcrumb: 'Capture', icon: PhRecord },
  { id: 'replay', title: '경로 재생', desc: '저장된 HAR · 읽기 전용', breadcrumb: 'Replay', icon: PhUsersThree },
  { id: 'report', title: '통합 리포트', desc: '수집 결과 · 핵심 지표', breadcrumb: 'Report', icon: PhChartBar },
  { id: 'log', title: '실시간 로그', desc: '탐색 · 재생 이벤트', breadcrumb: 'Activity', icon: PhTerminal },
  { id: 'feedback', title: '개선 피드백', desc: '근거 기반 제안', breadcrumb: 'Feedback', icon: PhRobot },
  { id: 'simulation', title: '페르소나 시뮬레이션', desc: '가상 방문자 · 변형 비교', breadcrumb: 'Simulation', icon: PhUsersFour },
]
const quickTabs = [
  { id: 'report', label: '통합 리포트', icon: PhChartBar },
  { id: 'capture', label: '화면 캡처', icon: PhRecord },
  { id: 'replay', label: '경로 재생', icon: PhUsersThree },
  { id: 'feedback', label: '개선안', icon: PhRobot },
  { id: 'simulation', label: '페르소나 시뮬레이션', icon: PhUsersFour },
]
const activeTab = computed(() => tabs.find(tab => tab.id === currentTab.value) || tabs[3])
const stepIndex = computed(() => Math.max(0, tabs.findIndex(tab => tab.id === currentTab.value)))
const summary = computed(() => run.value?.report?.summary || {})
const host = computed(() => { try { return new URL(run.value?.url).hostname } catch { return '' } })
const statusLabel = computed(() => ({ completed: '완료', running: '실행 중', queued: '대기', failed: '실패', interrupted: '중단' })[run.value?.status] || '불러오는 중')
const date = value => new Date(value).toLocaleString('ko-KR')
const time = value => new Date(value).toLocaleTimeString('ko-KR')
async function refresh() {
  try {
    const response = await fetch('/api/runs/' + props.id)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || '분석을 찾을 수 없습니다.')
    run.value = body
    if (['completed', 'failed', 'interrupted'].includes(body.status)) clearInterval(timer)
  } catch (err) { error.value = err.message; clearInterval(timer) }
}
onMounted(() => { refresh(); timer = setInterval(refresh, 1500) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped src="./Report.css"></style>
<style scoped>
.sidebar-language{font-size:11px;color:#555;border:1px solid #555;padding:4px 9px}
.work-panel{flex:1;min-height:0;overflow-y:auto;background:var(--ss-bg-sub);padding:38px 42px 80px}
.section-tag{display:inline-block;border:1px solid var(--ss-blue);color:var(--ss-blue);font:700 10px var(--mono);letter-spacing:1.6px;padding:4px 8px}
.overview-panel,.detail-panel{max-width:1100px;margin:0 auto}
.report-heading{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:26px}
.report-heading h3,.detail-panel h3{font-size:24px;letter-spacing:-.7px;margin:13px 0 8px;color:#111}
.report-heading p,.detail-intro{font-size:12px;color:var(--ss-sub);line-height:1.7}
.report-date{font:10px var(--mono);color:var(--ss-muted)}
.pipeline-box{max-width:760px;margin:30px auto;background:#fff;border:1px solid var(--ss-border);padding:26px 30px}
.pipeline-label{display:inline-block;border:1px solid var(--ss-border);color:var(--ss-muted);font:700 9px var(--mono);letter-spacing:2px;padding:4px 9px;margin-bottom:18px}
.pipeline-stages{display:flex;align-items:center;justify-content:space-between;gap:10px}
.pipeline-stages>div{display:grid;place-items:center;gap:8px;text-align:center;background:var(--ss-bg-sub);border:1px solid var(--ss-border);width:140px;min-height:92px;padding:10px}
.pipeline-stages svg{color:var(--ss-blue)}
.pipeline-stages strong{font-size:11px}
.pipeline-stages small{color:var(--ss-muted);font-size:9px}
.pipeline-stages>span{font-size:20px;color:var(--ss-border-dark)}
.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}
.metric-card{background:#fff;border:1px solid var(--ss-border);padding:22px}
.metric-card>span{font:700 10px var(--mono);color:var(--ss-sub);letter-spacing:.5px}
.metric-card strong{display:block;color:var(--ss-blue);font:800 30px var(--mono);margin-top:12px}
.metric-card small{font:11px var(--mono);color:var(--ss-muted)}
.result-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:14px}
.result-card,.detail-card{background:#fff;border:1px solid var(--ss-border);padding:24px}
.card-heading{display:flex;justify-content:space-between;border-bottom:1px solid var(--ss-border);padding-bottom:14px;margin-bottom:18px;font-size:13px;font-weight:700}
.card-heading button{border:0;background:none;color:var(--ss-blue);cursor:pointer;font-size:11px}
.preview-image{width:100%;max-height:290px;object-fit:cover;object-position:top;border:1px solid var(--ss-border)}
.finding-preview{display:flex;gap:16px;padding:13px 0;border-bottom:1px solid var(--ss-border);font-size:12px}
.finding-preview:last-child{border-bottom:0}
.finding-preview>span{font:700 11px var(--mono);color:var(--ss-blue)}
.finding-preview strong{font-size:12px}
.finding-preview p{color:var(--ss-sub);font-size:11px;margin:5px 0 0;line-height:1.5}
.method-note{font-size:11px;color:var(--ss-muted);padding:24px 0;line-height:1.7}
.detail-intro{margin:0 0 24px}
.detail-card{margin-top:18px}
.detail-card h4{margin:0 0 16px;font-size:14px}
.detail-url{font:700 17px var(--mono);word-break:break-all}
.detail-card p{font-size:12px;color:var(--ss-sub);line-height:1.7}
.detail-card a{font-size:12px;color:var(--ss-blue)}
.browser-frame{border:1px solid var(--ss-border);background:#fff;max-height:590px;overflow-y:auto}
.browser-bar{height:38px;background:#f2f2f2;padding:12px 16px;color:var(--ss-blue);font-size:10px}
.browser-bar span{color:var(--ss-sub);margin-left:20px}
.browser-frame img{width:100%;display:block}
.page-row{display:flex;gap:20px;padding:14px 0;border-top:1px solid var(--ss-border);align-items:center;font-size:11px}
.page-row>div{display:grid;gap:4px;min-width:0;flex:1}
.page-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ss-muted);font:10px var(--mono)}
.journey-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.journey-card{margin:0;min-width:0}
.journey-title{display:flex;justify-content:space-between;gap:8px;margin-bottom:20px}
.journey-title strong{font-size:14px}
.journey-title span{font-size:10px;color:var(--ss-blue)}
.journey-step{display:flex;gap:10px;margin:14px 0}
.journey-step>b{font:700 10px var(--mono);color:var(--ss-blue);border:1px solid var(--ss-blue);padding:4px 6px;align-self:start}
.journey-step>div{display:grid;gap:4px;min-width:0}
.journey-step strong{font-size:11px}
.journey-step small{font:9px var(--mono);color:var(--ss-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.event-feed{padding:20px;background:#fff;border:1px solid var(--ss-border);margin-top:24px}
.event-feed>div{display:flex;gap:20px;padding:9px 0;border-bottom:1px solid var(--ss-border);font-size:11px}
.event-feed>div:last-child{border-bottom:0}
.event-feed time{font:10px var(--mono);color:var(--ss-muted);white-space:nowrap}
.feedback-card{display:flex;gap:20px}
.feedback-index{font:800 15px var(--mono);color:var(--ss-blue)}
.feedback-level{font:700 9px var(--mono);color:var(--ss-blue);letter-spacing:1px}
.feedback-card h4{margin:7px 0 12px}
.feedback-card p{margin:7px 0}
.feedback-card p b{color:var(--ss-text);margin-right:12px}
.pending-card{max-width:760px;margin:75px auto;background:#fff;border:1px solid var(--ss-border);padding:34px}
.pending-card h3{font-size:22px;margin:15px 0}
.pending-card>p{font-size:12px;color:var(--ss-sub);line-height:1.7}
.progress-track{height:3px;background:#eee;margin:24px 0}
.progress-track span{height:100%;width:32%;display:block;background:var(--ss-blue);animation:progress 2s infinite alternate}
@keyframes progress{to{transform:translateX(210%)}}
.notice.error{color:#b42318}
@media(max-width:1100px){.result-grid,.journey-grid{grid-template-columns:1fr}.pipeline-stages{flex-wrap:wrap}.metric-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:750px){.workspace{display:block;overflow:auto;height:auto}.sidebar{width:100%;height:auto}.sidebar-nav,.sidebar-flow,.sidebar-bottom{display:none}.main-area{min-height:100vh}.work-panel{padding:25px 18px}.context-bar{padding:0 16px}.context-crumb,.status-url,.sub-tab-hint{display:none}.sub-tabs{padding:0 6px;overflow:auto}.sub-tab{padding:0 10px;white-space:nowrap}.pipeline-stages>span{display:none}.pipeline-stages>div{width:46%}}
</style>
