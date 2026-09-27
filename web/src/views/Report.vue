<script setup>
import { onMounted, onUnmounted, ref, computed } from 'vue'
const props = defineProps({ id: String })
const run = ref(null)
const error = ref('')
let timer
async function refresh() {
  try {
    const response = await fetch(`/api/runs/${props.id}`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    run.value = body
    if (['completed','failed','interrupted'].includes(body.status)) clearInterval(timer)
  } catch (err) { error.value = err.message; clearInterval(timer) }
}
onMounted(() => { refresh(); timer = setInterval(refresh, 1500) })
onUnmounted(() => clearInterval(timer))
const summary = computed(() => run.value?.report?.summary)
const host = computed(() => { try { return new URL(run.value?.url).hostname } catch { return '' } })
const time = value => new Date(value).toLocaleString('ko-KR')
</script>

<template>
  <main class="report-main wrap"><div v-if="error" class="alert error">{{ error }}</div><template v-if="run"><div class="report-top"><RouterLink to="/" class="back">← 전체 분석</RouterLink><span class="report-id">RUN / {{ run.id.slice(0,8).toUpperCase() }}</span></div><div class="report-title"><div><p class="kicker">WEBSITE INTELLIGENCE REPORT</p><h1>{{ host }}</h1><a :href="run.url" target="_blank" rel="noreferrer">{{ run.url }} ↗</a></div><span class="badge large" :class="run.status"><span class="status-dot"></span>{{ {completed:'분석 완료',running:'분석 진행 중',queued:'대기 중',failed:'분석 실패',interrupted:'중단됨'}[run.status] }}</span></div><div class="report-meta"><span>생성 {{ time(run.createdAt) }}</span><span>읽기 전용 브라우저 탐색</span><span>동일 출처 · 최대 4페이지</span></div>
    <div v-if="run.status !== 'completed'" class="processing"><div class="processing-icon">✳</div><h2>{{ run.status === 'failed' || run.status === 'interrupted' ? '분석을 완료하지 못했습니다' : '사이트를 살펴보고 있습니다' }}</h2><p>{{ run.error || '실제 브라우저에서 페이지를 캡처하고, 저장한 요청으로 경로를 재생합니다.' }}</p><div v-if="run.status === 'running' || run.status === 'queued'" class="loading-line"><i></i></div><div class="event-log"><p class="kicker">LIVE ACTIVITY</p><div v-for="(event,index) in run.events" :key="index"><span>{{ new Date(event.at).toLocaleTimeString('ko-KR') }}</span><span>{{ event.message }}</span></div></div></div>
    <template v-else><div class="metric-grid"><article><span>확인한 페이지</span><strong>{{ summary.pagesInspected }}<small> pages</small></strong><p>브라우저에서 실제로 연 페이지</p></article><article><span>재생한 경로</span><strong>{{ summary.journeysCompleted }}<small> / {{ summary.journeysAttempted }}</small></strong><p>저장된 네트워크 기록 기반</p></article><article><span>첫 화면 CTA</span><strong>{{ summary.aboveFoldCtas }}<small> visible</small></strong><p>초기 뷰포트에 노출된 행동 요소</p></article><article><span>차단한 추적 요청</span><strong>{{ summary.requestsBlocked }}<small> requests</small></strong><p>알려진 분석·광고 도메인</p></article></div>
      <section class="report-section"><div class="section-top"><div><p class="kicker">01 / WEBSITE CAPTURE</p><h2>실제로 본 화면</h2></div><span class="caption">첫 페이지 · 전체 화면 캡처</span></div><div class="capture-frame"><div class="browser-bar"><span class="browser-dots">● ● ●</span><span>{{ run.url }}</span><span>↗</span></div><img :src="run.screenshotUrl" :alt="`${host} 첫 페이지 캡처`"></div></section>
      <section class="report-section"><div class="section-top"><div><p class="kicker">02 / SIGNALS & ACTIONS</p><h2>발견한 개선 지점</h2></div><span class="caption">관찰 기반 · 성과 예측 아님</span></div><div class="finding-list"><article v-for="(item,index) in summary.findings" :key="index" class="finding"><span class="finding-num">{{ String(index+1).padStart(2,'0') }}</span><div><span class="severity" :class="item.level">{{ {high:'우선 확인',medium:'개선 기회',info:'확인 결과'}[item.level] }}</span><h3>{{ item.title }}</h3><p><b>근거</b> {{ item.evidence }}</p><p><b>제안</b> {{ item.action }}</p></div></article></div></section>
      <section class="report-section"><div class="section-top"><div><p class="kicker">03 / BROWSER JOURNEYS</p><h2>방문자 경로 재생</h2></div><span class="caption">HAR 오프라인 재생 · 입력과 구매는 수행하지 않음</span></div><div class="journey-grid"><article v-for="journey in run.report.journeys" :key="journey.profile"><div class="journey-top"><span class="journey-symbol">↗</span><span class="badge" :class="journey.success ? 'completed':'interrupted'">{{ journey.success ? '경로 확인':'링크 없음 / 재생 실패' }}</span></div><h3>{{ journey.profile }}</h3><ol><li v-for="(step,index) in journey.steps" :key="index"><span>{{ index+1 }}</span><div><strong>{{ step.title || '제목 없음' }}</strong><small>{{ step.url }}</small></div></li></ol><p v-if="journey.note" class="journey-note">{{ journey.note }}</p></article></div></section>
      <section class="report-section"><div class="section-top"><div><p class="kicker">04 / PAGE INVENTORY</p><h2>탐색한 페이지</h2></div></div><div class="page-table"><div class="table-head"><span>페이지</span><span>상태</span><span>H1</span><span>CTA</span><span>양식</span></div><div v-for="page in run.report.pages" :key="page.url" class="table-row"><div><strong>{{ page.title || '제목 없음' }}</strong><small>{{ page.url }}</small></div><span>{{ page.error ? '오류' : page.status }}</span><span>{{ page.h1.length }}</span><span>{{ page.ctas.length }}</span><span>{{ page.forms.length }}</span></div></div></section><div class="method-note"><span>ℹ</span><p>이 결과는 페이지 구조와 읽기 전용 탐색 결과입니다. 실제 방문자 행동, 구매, 전환율 또는 향후 매출을 측정하거나 예측하지 않습니다. 저장된 HAR와 캡처는 로컬 <code>data/runs</code>에 보관됩니다.</p></div>
    </template></template></main>
</template>
