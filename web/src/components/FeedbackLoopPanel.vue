<template>
  <div class="detail-card loop-panel">
    <div class="card-heading"><span>통합 시뮬레이션 · 피드백 루프</span><small>{{ rounds.length }}라운드 · 피어 {{ report.peerStats?.avgPeers ?? '-' }}명/페르소나 · 방문 확률 갱신: 전환 +0.35 · 참여 +0.12 · 이탈 −0.05 · 공유 +0.18 (× 친화도 × 허브)</small></div>
    <div class="loop-stages">
      <div v-for="(stage, i) in stages" :key="stage.key" class="loop-stage-wrap">
        <div class="loop-stage"><strong>{{ stage.name }}</strong><small>{{ stage.desc }}</small></div>
        <span v-if="i < stages.length - 1" class="stage-arrow">→</span>
      </div>
      <span class="loop-back">↩ 다음 라운드 방문자 재추출</span>
    </div>
    <p v-if="rounds.length < 2" class="notice info">라운드가 1개라 추이가 없습니다. 실행 폼에서 <strong>라운드</strong>를 2 이상으로 두면 세션 결과가 피어의 방문 확률을 바꾸고, 다음 라운드 방문자가 그 확률로 다시 추출됩니다.</p>
    <div class="loop-grid">
      <div class="chart-col">
        <div class="picker-label">라운드별 가중 CVR 추이</div>
        <svg class="loop-svg" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet" role="img" aria-label="라운드별 가중 CVR">
          <g><line v-for="t in yTicks" :key="'g' + t" :x1="pad.l" :y1="y(t)" :x2="W - pad.r" :y2="y(t)" stroke="#eaeaea" /></g>
          <g><text v-for="t in yTicks" :key="'y' + t" :x="pad.l - 8" :y="y(t) + 4" text-anchor="end" fill="#9e9e9e" font-size="10" font-family="JetBrains Mono, monospace">{{ t }}%</text></g>
          <g><text v-for="r in rounds" :key="'x' + r.round" :x="x(r.round)" :y="H - pad.b + 16" text-anchor="middle" fill="#9e9e9e" font-size="10" font-family="JetBrains Mono, monospace">R{{ r.round }}</text></g>
          <g v-for="v in variants" :key="v.key">
            <path :d="area(v.key)" :fill="v.color" fill-opacity="0.06" />
            <path :d="line(v.key)" :stroke="v.color" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
            <circle v-for="r in rounds" :key="v.key + r.round" :cx="x(r.round)" :cy="y(cvr(v.key, r))" r="3.5" :fill="v.color" stroke="#fff" stroke-width="1.5"><title>{{ v.name }} R{{ r.round }}: {{ cvr(v.key, r) }}% (n={{ r.n[v.key] }})</title></circle>
          </g>
          <line :x1="pad.l" :y1="pad.t" :x2="pad.l" :y2="H - pad.b" stroke="#eaeaea" stroke-width="1.5" />
          <line :x1="pad.l" :y1="H - pad.b" :x2="W - pad.r" :y2="H - pad.b" stroke="#eaeaea" stroke-width="1.5" />
        </svg>
        <div class="legend"><span v-for="v in variants" :key="v.key"><i :style="{ background: v.color }"></i>{{ v.name }}</span></div>
        <div class="picker-label" style="margin-top:20px">세그먼트 × 라운드 방문 확률 <select v-model="heatVariant" class="heat-select"><option v-for="v in variants" :key="v.key" :value="v.key">{{ v.name }}</option></select></div>
        <div class="heat-wrap">
          <table class="heat-table">
            <thead><tr><th>세그먼트</th><th class="base">기준</th><th v-for="r in rounds" :key="'h' + r.round">R{{ r.round }}</th><th>Δ</th></tr></thead>
            <tbody>
              <tr v-for="seg in segments" :key="seg">
                <td class="seg-name" :title="seg">{{ label(seg) }}</td>
                <td class="heat-cell base" :style="heatStyle(report.baseVisitProb?.[seg] || 0)"><span>{{ pct(report.baseVisitProb?.[seg]) }}</span></td>
                <td v-for="r in rounds" :key="seg + r.round" class="heat-cell" :style="heatStyle(prob(seg, r))" :title="`${seg} R${r.round}: ${pct(prob(seg, r))}`"><span>{{ pct(prob(seg, r)) }}</span></td>
                <td class="delta" :class="{ up: delta(seg) > 0, down: delta(seg) < 0 }">{{ delta(seg) > 0 ? '+' : '' }}{{ delta(seg) }}%</td>
              </tr>
            </tbody>
          </table>
          <div class="heat-legend"><span>낮음</span><i></i><span>높음</span></div>
        </div>
      </div>
      <div class="metrics-col">
        <div class="metric-section">
          <div class="picker-label">최종 K-factor</div>
          <div v-for="v in variants" :key="'k' + v.key" class="kf"><div class="kf-head"><i :style="{ background: v.color }"></i>{{ v.name }}<strong>{{ kFinal(v.key).toFixed(3) }}</strong></div><div class="dist-bar"><i :style="{ width: kWidth(v.key) + '%', background: v.color }"></i></div></div>
        </div>
        <div class="metric-section">
          <div class="picker-label">누적 전환자 · 라운드별 방문</div>
          <table class="sim-table small">
            <thead><tr><th>변형</th><th>누적 전환</th><th v-for="r in rounds" :key="'n' + r.round">R{{ r.round }} n</th></tr></thead>
            <tbody><tr v-for="v in variants" :key="'c' + v.key"><td><i class="variant-dot" :style="{ background: v.color }"></i>{{ v.key }}</td><td class="num strong">{{ last.cumulativeConverters?.[v.key] ?? '-' }}</td><td v-for="r in rounds" :key="v.key + 'n' + r.round" class="num">{{ r.n[v.key] }}<small v-if="r.newSessions?.[v.key]">+{{ r.newSessions[v.key] }} 신규</small></td></tr></tbody>
          </table>
        </div>
        <div class="metric-section">
          <div class="picker-label">CVR 변화 · R1 → R{{ rounds.length }}</div>
          <div v-for="v in variants" :key="'l' + v.key" class="lift-row"><span><i :style="{ background: v.color }"></i>{{ v.name }}</span><strong :class="liftClass(v.key)">{{ liftText(v.key) }}</strong></div>
        </div>
        <div class="metric-section summary">
          <div class="summary-row"><span>최우수 K-factor</span><strong>{{ bestK.name }} · {{ bestK.value.toFixed(3) }}</strong></div>
          <div class="summary-row"><span>방문 확률 상승 1위 세그먼트</span><strong>{{ topSegment }}</strong></div>
          <div class="summary-row"><span>라운드당 방문자</span><strong>{{ perRound }}명</strong></div>
        </div>
      </div>
    </div>
    <p class="hint">K-factor = 전환자 1인당 방문 확률이 기준보다 0.05 이상 오른 피어 수 × 그 피어들의 전환율. 반복 방문자는 같은 시드의 세션 결과를 재사용하므로 새 브라우저 세션은 첫 방문에만 열립니다. 수치는 페르소나 모델의 결과이며 실제 구전 효과를 측정하지 않습니다.</p>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
const props = defineProps({ report: Object, personasPerRound: Number })
const W = 560, H = 240, pad = { t: 16, r: 16, b: 28, l: 44 }
const stages = [{ key: 'web', name: '웹 탐색', desc: '방문자 세션 실행' }, { key: 'attitude', name: '경험 → 태도', desc: '전환·참여·이탈·공유' }, { key: 'social', name: '소셜 전파', desc: '피어 방문 확률 갱신' }, { key: 'visit', name: '방문 확률↑', desc: 'K-factor · 다음 방문자' }]
const rounds = computed(() => props.report?.rounds || [])
const last = computed(() => rounds.value.at(-1) || {})
const variants = computed(() => Object.values(props.report?.variants || {}).map(v => ({ key: v.key, name: v.name, color: v.color })))
const heatVariant = ref('control')
watch(variants, list => { if (!list.some(v => v.key === heatVariant.value)) heatVariant.value = list[0]?.key || 'control' }, { immediate: true })
const segments = computed(() => Object.keys(last.value.visitProbBySegment?.[heatVariant.value] || props.report?.baseVisitProb || {}))
const labels = computed(() => Object.fromEntries((props.report?.segments || []).map(s => [s.segment, s.label])))
const label = seg => labels.value[seg] || seg
const cvr = (key, r) => r.cvrByVariant?.[key] ?? 0
const prob = (seg, r) => r.visitProbBySegment?.[heatVariant.value]?.[seg] ?? 0
const pct = v => `${Math.round((v || 0) * 100)}%`
const delta = seg => props.report?.segmentDeltaPct?.[heatVariant.value]?.[seg] ?? 0
const yMax = computed(() => Math.max(10, ...rounds.value.flatMap(r => variants.value.map(v => cvr(v.key, r)))) )
const yTicks = computed(() => { const step = yMax.value <= 20 ? 5 : yMax.value <= 50 ? 10 : 25; const out = []; for (let t = 0; t <= yMax.value + step - 0.001; t += step) out.push(t); return out })
const x = round => rounds.value.length <= 1 ? pad.l + (W - pad.l - pad.r) / 2 : pad.l + (round - 1) / (rounds.value.length - 1) * (W - pad.l - pad.r)
const y = v => { const top = yTicks.value.at(-1) || 10; return pad.t + (H - pad.t - pad.b) * (1 - v / top) }
const line = key => 'M ' + rounds.value.map(r => `${x(r.round)},${y(cvr(key, r))}`).join(' L ')
const area = key => { if (!rounds.value.length) return ''; const base = y(0); return `M ${x(rounds.value[0].round)},${base} L ${rounds.value.map(r => `${x(r.round)},${y(cvr(key, r))}`).join(' L ')} L ${x(rounds.value.at(-1).round)},${base} Z` }
const heatStyle = p => { const t = Math.max(0, Math.min(1, p)); const c = Math.round(245 - t * 245); return { background: `rgb(${c},${c},${c})`, color: t > 0.45 ? '#fff' : '#212121' } }
const kFinal = key => last.value.kFactor?.[key] ?? 0
const maxK = computed(() => Math.max(0.001, ...variants.value.map(v => kFinal(v.key))))
const kWidth = key => Math.min(100, kFinal(key) / maxK.value * 100)
const liftOf = key => { const first = cvr(key, rounds.value[0] || {}), end = cvr(key, last.value); return first === 0 ? null : (end - first) / first * 100 }
const liftText = key => { const l = liftOf(key); return l === null ? 'n/a' : `${l >= 0 ? '+' : ''}${l.toFixed(1)}%` }
const liftClass = key => { const l = liftOf(key); return l === null ? '' : l >= 0 ? 'up' : 'down' }
const bestK = computed(() => variants.value.reduce((best, v) => kFinal(v.key) > best.value ? { name: v.name, value: kFinal(v.key) } : best, { name: '-', value: 0 }))
const topSegment = computed(() => { const d = props.report?.segmentDeltaPct?.[heatVariant.value] || {}; const top = Object.entries(d).sort((a, b) => b[1] - a[1])[0]; return top ? `${label(top[0])} (+${top[1]}%)` : '-' })
const perRound = computed(() => Object.values(last.value.n || {})[0] ?? props.personasPerRound ?? '-')
</script>

<style scoped>
.loop-stages{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 16px;border:1px solid var(--ss-border);background:var(--ss-bg-sub);margin-bottom:16px}
.loop-stage-wrap{display:flex;align-items:center;gap:8px}
.loop-stage{display:grid;gap:2px;padding:8px 12px;background:#fff;border:1px solid var(--ss-border)}
.loop-stage strong{font-size:11px}
.loop-stage small{font:10px var(--mono);color:var(--ss-muted)}
.stage-arrow{color:var(--ss-muted);font-size:14px}
.loop-back{margin-left:auto;font:700 10px var(--mono);color:var(--ss-blue)}
.loop-grid{display:grid;grid-template-columns:1.5fr 1fr;gap:24px}
.loop-svg{width:100%;height:auto;display:block}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11px;color:var(--ss-sub);margin-top:6px}
.legend i,.kf-head i,.lift-row i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.heat-select{margin-left:8px;border:1px solid var(--ss-border-dark);font:600 11px var(--sans);padding:3px 6px;background:#fff}
.heat-wrap{overflow:auto}
.heat-table{border-collapse:collapse;width:100%;font-size:11px}
.heat-table th{font:700 10px var(--mono);color:var(--ss-muted);text-align:center;padding:6px 4px;border-bottom:1px solid var(--ss-border)}
.heat-table th:first-child{text-align:left}
.seg-name{padding:6px 8px 6px 0;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.heat-cell{text-align:center;padding:0;border:2px solid #fff;min-width:44px;height:30px}
.heat-cell span{font:700 10px var(--mono)}
.heat-cell.base{border-left:2px solid var(--ss-border)}
.delta{font:700 10px var(--mono);text-align:right;padding-left:8px;white-space:nowrap}
.delta.up{color:#0a7a3f}.delta.down{color:#b42318}
.heat-legend{display:flex;align-items:center;gap:8px;font:10px var(--mono);color:var(--ss-muted);margin-top:8px}
.heat-legend i{flex:1;max-width:160px;height:6px;background:linear-gradient(90deg,#f5f5f5,#000)}
.metric-section{margin-bottom:20px}
.kf{margin-bottom:10px}
.kf-head{display:flex;align-items:center;font-size:11px;margin-bottom:5px}
.kf-head strong{margin-left:auto;font:800 14px var(--mono);color:var(--ss-blue)}
.sim-table.small td,.sim-table.small th{padding:6px 8px}
.lift-row{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:6px 0;border-bottom:1px solid var(--ss-border)}
.lift-row strong{font:800 12px var(--mono)}
.lift-row .up{color:#0a7a3f}.lift-row .down{color:#b42318}
.summary{border:1px solid var(--ss-border);padding:12px 14px;background:var(--ss-bg-sub)}
.summary-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;padding:5px 0}
.summary-row strong{font:700 11px var(--mono);color:var(--ss-blue);text-align:right}
@media(max-width:1100px){.loop-grid{grid-template-columns:1fr}.loop-back{margin-left:0}}
</style>
