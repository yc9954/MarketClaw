<template>
  <div class="home">
    <Transition name="modal">
      <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
        <div class="modal-card">
          <div class="modal-header">
            <div class="modal-eyebrow">PIPELINE START</div>
            <h3 class="modal-title">브라우저 분석 시작</h3>
            <p class="modal-sub">{{ fullUrl }}</p>
          </div>
          <div class="modal-options">
            <button class="modal-opt modal-opt--primary" :disabled="busy" @click="confirmStart">
              <div class="opt-icon-wrap"><PhPlay :size="20" weight="fill" /></div>
              <div class="opt-body">
                <div class="opt-title">{{ busy ? '분석을 시작하는 중…' : '전체 분석 실행' }}</div>
                <div class="opt-desc">실제 페이지 탐색 → HAR 기록 → 경로 재생 → 개선 리포트</div>
              </div>
              <PhArrowRight :size="16" class="opt-arrow" />
            </button>
            <button class="modal-opt modal-opt--secondary" @click="showModal = false">
              <div class="opt-icon-wrap opt-icon-wrap--ghost"><PhGlobe :size="20" weight="light" /></div>
              <div class="opt-body"><div class="opt-title">URL 다시 확인</div><div class="opt-desc">분석 대상을 수정한 후 시작합니다</div></div>
              <PhArrowRight :size="16" class="opt-arrow" />
            </button>
          </div>
          <p v-if="error" class="modal-error" role="alert">{{ error }}</p>
          <button class="modal-cancel" @click="showModal = false">취소</button>
        </div>
      </div>
    </Transition>

    <header class="ss-header">
      <div class="ss-header-inner">
        <div class="ss-logo"><span class="ss-logo-mark"></span><span class="ss-logo-name">MarketClaw</span><span class="ss-logo-tag">by Genspark</span></div>
        <div class="ss-header-meta">
          <span class="meta-pill"><span class="meta-dot meta-dot-live"></span>Browser Evidence Engine</span>
          <span class="meta-pill meta-pill-mono">v1.0 · {{ today }}</span>
        </div>
        <div class="ss-header-right"><span class="language-badge">한국어 ▾</span></div>
      </div>
    </header>

    <div class="page-body">
      <aside class="left-col">
        <div class="brand-block">
          <div class="brand-eyebrow">All-in-one Marketing Automation</div>
          <h1 class="brand-title">URL 하나로<br />사이트를 <span class="brand-accent">기록·진단</span>하는<br />마케팅 에이전트</h1>
          <p class="brand-desc">Playwright가 실제 웹사이트를 탐색하고 HAR로 기록합니다.<br />방문 목적별 경로를 저장된 기록에서 재생하고,<br />확인한 근거를 바탕으로 개선 지점을 제시합니다.</p>
        </div>
        <div class="flow-diagram">
          <div v-for="(step, i) in steps" :key="step.title" class="flow-row">
            <div class="flow-step">
              <span class="flow-num">{{ String(i + 1).padStart(2, '0') }}</span>
              <div class="flow-body"><div class="flow-title">{{ step.title }}</div><div class="flow-desc">{{ step.desc }}</div></div>
              <component :is="step.icon" class="flow-icon" :size="20" weight="light" />
            </div>
            <div v-if="i < steps.length - 1" class="flow-line"></div>
          </div>
        </div>
        <div class="spec-grid">
          <div class="spec-item"><div class="spec-num">4</div><div class="spec-label">최대 탐색 페이지</div></div>
          <div class="spec-item"><div class="spec-num">3</div><div class="spec-label">방문 목적별 경로</div></div>
          <div class="spec-item"><div class="spec-num">HAR</div><div class="spec-label">네트워크 기록</div></div>
        </div>
      </aside>

      <main class="right-col">
        <div class="input-panel">
          <div class="panel-header">
            <div class="panel-step-tag">STEP 01 · URL INPUT</div>
            <h2 class="panel-title">분석할 웹사이트 주소 입력</h2>
            <p class="panel-sub">실제 브라우저로 페이지를 열고 화면과 네트워크 기록을 수집합니다.</p>
          </div>
          <div class="url-field">
            <label class="field-label" for="target-url">TARGET URL</label>
            <div class="url-input-wrap" :class="{ focused: urlFocused }">
              <span v-if="!hasProtocol" class="url-prefix">https://</span>
              <input id="target-url" v-model.trim="targetUrlClean" class="url-input" type="text" placeholder="sweetspot.co.kr" @keydown.enter="startPipeline" @focus="urlFocused = true" @blur="urlFocused = false" />
            </div>
            <div class="url-preview">{{ fullUrl || 'URL을 입력하세요' }}</div>
          </div>
          <div class="config-block">
            <div class="config-label">PIPELINE CONFIG</div>
            <div class="config-list">
              <div v-for="cfg in configs" :key="cfg.key" class="config-row"><span class="config-key">{{ cfg.key }}</span><span class="config-val">{{ cfg.val }}</span></div>
            </div>
          </div>
          <div class="isolation-block">
            <div class="iso-title"><PhShieldCheck :size="14" weight="bold" /><span>Isolation Sandbox</span></div>
            <div class="iso-list">
              <div class="iso-row"><PhCheck :size="12" weight="bold" /> 알려진 분석·광고 도메인 차단</div>
              <div class="iso-row"><PhCheck :size="12" weight="bold" /> UTM 파라미터 제거</div>
              <div class="iso-row"><PhCheck :size="12" weight="bold" /> HAR 네트워크 기록</div>
              <div class="iso-row"><PhCheck :size="12" weight="bold" /> 폼 제출·결제 수행 안 함</div>
            </div>
          </div>
          <div class="panel-actions">
            <button class="start-btn" @click="startPipeline">파이프라인 시작<span class="start-arrow">→</span></button>
            <p class="panel-note">Playwright 브라우저와 API가 실행 중이어야 합니다</p>
            <p v-if="error && !showModal" class="inline-error" role="alert">{{ error }}</p>
          </div>
        </div>
        <div class="recent-block">
          <div class="section-title">RECENT PIPELINES</div>
          <div v-if="runs.length" class="recent-list">
            <RouterLink v-for="run in runs.slice(0, 5)" :key="run.id" :to="'/runs/' + run.id" class="run-row">
              <span class="run-led" :class="run.status"></span>
              <span class="run-info"><strong>{{ hostFor(run.url) }}</strong><small>{{ run.url }}</small></span>
              <span class="run-status">{{ statusText[run.status] || run.status }}</span>
              <PhArrowRight :size="15" />
            </RouterLink>
          </div>
          <div v-else class="recent-empty">분석 기록</div>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { PhGlobe, PhRecord, PhUsersThree, PhTerminal, PhRobot, PhPlay, PhArrowRight, PhShieldCheck, PhCheck } from '@phosphor-icons/vue'

const router = useRouter()
const urlFocused = ref(false)
const showModal = ref(false)
const busy = ref(false)
const error = ref('')
const runs = ref([])
const savedUrl = localStorage.getItem('targetUrl') || 'sweetspot.co.kr'
const targetUrlClean = ref(savedUrl.replace(/^https:\/\//, ''))
const today = new Date().toISOString().slice(0, 10)
const hasProtocol = computed(() => /^https?:\/\//i.test(targetUrlClean.value))
const fullUrl = computed(() => {
  const value = targetUrlClean.value.trim()
  if (!value) return ''
  return hasProtocol.value ? value : 'https://' + value
})
const statusText = { completed: '완료', running: '진행 중', queued: '대기', failed: '실패', interrupted: '중단' }
const hostFor = value => { try { return new URL(value).hostname } catch { return value } }
const steps = [
  { title: 'URL 입력', desc: '대상 사이트와 분석 범위 확인', icon: PhGlobe },
  { title: '브라우저 격리', desc: '별도 Playwright 컨텍스트에서 탐색', icon: PhShieldCheck },
  { title: 'HAR 녹화', desc: '요청과 응답을 har.zip으로 기록', icon: PhRecord },
  { title: '방문 경로 재생', desc: '저장된 HAR에서 3가지 목적별 이동 확인', icon: PhUsersThree },
  { title: '실시간 진행 기록', desc: '페이지와 요청 결과를 이벤트로 표시', icon: PhTerminal },
  { title: '개선 피드백', desc: '관찰 근거와 다음 행동을 정리', icon: PhRobot },
]
const configs = [
  { key: 'ENGINE', val: 'MarketClaw v1.0 · Playwright' },
  { key: 'PAGES', val: '동일 출처 최대 4페이지' },
  { key: 'SANDBOX', val: '분리된 브라우저 · 추적 요청 차단' },
  { key: 'REPLAY', val: '첫 방문 · 가격 · 문의 경로' },
  { key: 'OUTPUT', val: '캡처 · 경로 · 개선 리포트' },
]
onMounted(async () => {
  try {
    const response = await fetch('/api/runs')
    if (!response.ok) throw new Error('분석 목록을 불러올 수 없습니다.')
    runs.value = await response.json()
  } catch (err) { error.value = err.message }
})
function startPipeline() {
  error.value = ''
  if (!targetUrlClean.value.trim()) { error.value = 'URL을 입력하세요.'; return }
  showModal.value = true
}
async function confirmStart() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: fullUrl.value }) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || '분석을 시작하지 못했습니다.')
    localStorage.setItem('targetUrl', fullUrl.value)
    router.push('/runs/' + body.id)
  } catch (err) { error.value = err.message } finally { busy.value = false }
}
</script>

<style scoped src="./Home.css"></style>
<style scoped>
.language-badge{border:1px solid #555;color:#aaa;padding:5px 11px;font-size:11px}
.recent-list{border-bottom:1px solid var(--ss-border)}
.run-row{display:flex;align-items:center;gap:14px;padding:15px 8px;border-bottom:1px solid var(--ss-border);font-size:12px}
.run-row:last-child{border-bottom:0}
.run-row:hover{background:var(--ss-bg-sub)}
.run-led{width:7px;height:7px;background:var(--ss-muted);border-radius:50%;flex:none}
.run-led.completed{background:var(--ss-blue)}
.run-led.failed,.run-led.interrupted{background:#c54e42}
.run-info{min-width:0;display:grid;gap:4px;flex:1}
.run-info strong{font-weight:700}
.run-info small{color:var(--ss-muted);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.run-status{font-family:var(--mono);color:var(--ss-sub);font-size:10px}
.recent-empty{display:grid;place-items:center;min-height:145px;font-family:var(--mono);font-size:11px;color:var(--ss-muted);letter-spacing:2px}
.modal-error,.inline-error{color:#b42318;font-size:12px;padding:0 24px}
.inline-error{padding:0;text-align:center}
</style>
