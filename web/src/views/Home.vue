<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const url = ref('')
const busy = ref(false)
const error = ref('')
const runs = ref([])
onMounted(async () => { try { runs.value = await (await fetch('/api/runs')).json() } catch { error.value = '서버에 연결할 수 없습니다. API가 실행 중인지 확인하세요.' } })
async function start() {
  error.value = ''
  busy.value = true
  try {
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value }) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || '분석을 시작하지 못했습니다.')
    router.push(`/runs/${body.id}`)
  } catch (err) { error.value = err.message } finally { busy.value = false }
}
const date = value => new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const hostFor = value => { try { return new URL(value).hostname } catch { return value } }
</script>

<template>
  <main>
    <section class="hero"><div class="wrap hero-grid"><div class="hero-copy"><div class="eyebrow"><span class="eyebrow-line"></span> BROWSER EVIDENCE ENGINE <span class="version">V1.0</span></div><h1>마케팅의 다음 선택,<br><em>추측 말고</em> 증거로.</h1><p class="hero-desc">실제 웹사이트를 탐색하고, 방문자 경로를 오프라인에서 재생합니다. 발견한 문제와 개선 방향을 페이지 근거와 함께 확인하세요.</p><form class="url-form" @submit.prevent="start"><label for="target">분석할 웹사이트 URL</label><div class="input-row"><span class="link-icon">↗</span><input id="target" v-model.trim="url" type="url" placeholder="https://your-website.com" required aria-describedby="url-hint"><button :disabled="busy" type="submit">{{ busy ? '시작 중…' : '분석 시작' }} <span>→</span></button></div><p id="url-hint">공개된 웹사이트의 읽기 전용 탐색 · 폼 제출이나 구매 진행 없음</p><p v-if="error" class="error" role="alert">{{ error }}</p></form><div class="hero-notes"><span><b>01</b> LIVE CAPTURE</span><span><b>02</b> OFFLINE REPLAY</span><span><b>03</b> EVIDENCE REPORT</span></div></div><div class="hero-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-label top-label">✦ SIGNAL DETECTED</div><img src="/mascot.png" alt="MarketClaw 가재 마스코트" class="mascot"><div class="art-label bottom-label"><span class="status-dot"></span> BROWSER SESSION ACTIVE</div></div></div></section>
    <section class="how wrap"><div class="section-heading"><div><p class="kicker">HOW IT WORKS</p><h2>사이트를 보는 방식부터<br>결과를 읽는 방식까지.</h2></div><p>클릭 가능한 화면, 실제 요청, 수집된 페이지를 바탕으로 간결하게 진단합니다.</p></div><div class="step-grid"><article><span class="step-no">01 / CAPTURE</span><div class="step-icon">⌁</div><h3>실제 브라우저 탐색</h3><p>최대 4개의 동일 출처 페이지를 열어 제목, CTA, 양식, 링크와 첫 화면을 저장합니다.</p></article><article><span class="step-no">02 / REPLAY</span><div class="step-icon">↗</div><h3>읽기 전용 경로 재생</h3><p>저장된 HAR에서 첫 방문자, 가격 검토자, 문의 준비자의 탐색 경로를 확인합니다.</p></article><article><span class="step-no">03 / IMPROVE</span><div class="step-icon">✳</div><h3>근거가 있는 개선안</h3><p>확인한 신호와 해당 페이지를 함께 제시해 다음 실험을 바로 정할 수 있습니다.</p></article></div></section>
    <section class="recent wrap"><div class="recent-head"><div><p class="kicker">YOUR WORKSPACE</p><h2>최근 분석</h2></div><span>{{ runs.length }}개 기록</span></div><div v-if="runs.length" class="run-list"><RouterLink v-for="run in runs.slice(0,6)" :key="run.id" :to="`/runs/${run.id}`" class="run-row"><div class="run-favicon">↗</div><div class="run-name"><strong>{{ hostFor(run.url) }}</strong><small>{{ run.url }}</small></div><span class="run-date">{{ date(run.createdAt) }}</span><span class="badge" :class="run.status">{{ {completed:'완료',running:'진행 중',queued:'대기',failed:'실패',interrupted:'중단'}[run.status] }}</span><span class="row-arrow">→</span></RouterLink></div><div v-else class="empty"><span>◇</span><strong>첫 분석을 시작해보세요</strong><p>위에 URL을 입력하면 결과가 여기에 쌓입니다.</p></div></section>
  </main>
</template>
