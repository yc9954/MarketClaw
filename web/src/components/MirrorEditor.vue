<template>
  <div class="detail-card mirror-panel" @keydown.ctrl.z.prevent="undo" @keydown.meta.z.prevent="undo" tabindex="-1">
    <div class="card-heading">
      <span>미러 편집기 · 캡처한 사이트 위에서 변형 만들기</span>
      <div class="heading-actions">
        <small v-if="pages">{{ pages.assets }}개 자원 · 스크립트 제거 · 추적 요청 차단</small>
        <span v-if="savedCount" class="saved-badge">저장된 변형 {{ savedCount }}개</span>
        <span v-if="patches.length" class="saved-badge session">세션 패치 {{ patches.length }}개</span>
      </div>
    </div>
    <div class="toolbar">
      <button v-if="!open" class="ghost-btn mirror-open" @click="openMirror">미러 열기</button>
      <template v-else>
        <select v-model="currentPath" class="page-select" @change="navigate(currentPath)"><option v-for="p in pages?.pages || []" :key="p.path" :value="p.path">{{ p.path }} · {{ p.title || '제목 없음' }}</option></select>
        <button class="ghost-btn" @click="navigate(currentPath)">새로고침</button>
        <button class="ghost-btn" :class="{ on: picking }" @click="picking = !picking">{{ picking ? '선택 모드 (클릭해서 요소 지정)' : '탐색 모드' }}</button>
        <button class="ghost-btn mirror-undo" :disabled="!history.length" @click="undo">되돌리기 ({{ history.length }})</button>
      </template>
      <span class="toolbar-note">{{ open ? (picking ? '요소 위에 마우스를 올리면 강조되고, 클릭하면 오른쪽에서 편집합니다.' : '탐색 모드에서는 링크를 따라 미러 안을 이동합니다.') : '저장된 HAR에서 랜딩 페이지를 같은 출처로 띄웁니다. 실제 사이트에는 접속하지 않습니다.' }}</span>
    </div>
    <div v-if="error" class="notice error">{{ error }}</div>
    <div v-if="open" class="editor-body">
      <div class="canvas-wrap">
        <div class="browser-bar">● ● ● <span>{{ pages?.origin }}{{ currentPath }}</span></div>
        <iframe ref="frameEl" class="mirror-frame" :src="frameSrc" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="captured site mirror" @load="onFrameLoad"></iframe>
      </div>
      <aside class="side">
        <div class="side-section">
          <div class="picker-label">선택한 요소</div>
          <template v-if="selected">
            <div class="sel-head"><code class="sel-tag">{{ selected.tag }}</code><span class="sel-text">{{ selected.text || '(텍스트 없음)' }}</span></div>
            <div class="sel-selector"><span class="ev-label">selector</span><code class="mirror-selector">{{ selected.selector }}</code></div>
            <div class="sel-css"><span v-for="(v, k) in selected.css" :key="k" class="css-chip">{{ k }} {{ v }}</span></div>
            <div class="tools">
              <button v-for="t in tools" :key="t.type" class="mirror-tool" :class="{ on: tool === t.type }" @click="tool = t.type">{{ t.label }}</button>
            </div>
            <div v-if="tool === 'text'" class="tool-body"><label class="tool-label">새 텍스트</label><textarea v-model="input" class="mirror-input" rows="3" placeholder="요소의 첫 텍스트 노드를 이 문구로 바꿉니다"></textarea></div>
            <div v-else-if="tool === 'css'" class="tool-body"><label class="tool-label">CSS 선언 (선택자에 적용)</label><textarea v-model="input" class="mirror-input" rows="3" placeholder="예) background:#000;color:#fff;font-size:20px"></textarea></div>
            <div v-else-if="tool === 'inject'" class="tool-body"><label class="tool-label">요소 뒤에 삽입할 HTML (스크립트·이벤트 핸들러 불가)</label><textarea v-model="input" class="mirror-input" rows="4" placeholder='예) <p style="font-weight:700">1,200개 팀이 사용 중</p>'></textarea></div>
            <div v-else-if="tool === 'hide'" class="tool-body"><p class="tool-note">이 요소를 <code>display:none</code>으로 숨깁니다.</p></div>
            <div v-else-if="tool === 'reorder'" class="tool-body"><p class="tool-note">이 요소를 부모의 맨 앞으로 옮깁니다.</p></div>
            <button class="start-btn mirror-apply" :disabled="!canApply" @click="apply">패치 적용<span>→</span></button>
          </template>
          <div v-else class="hist-empty">{{ picking ? '미러에서 요소를 클릭하세요.' : '선택 모드를 켜고 요소를 클릭하세요.' }}</div>
        </div>
        <div class="side-section">
          <div class="picker-label">세션 패치 <small>({{ patches.length }}) · 변형으로 저장하면 시뮬레이션에서 사용할 수 있습니다</small></div>
          <div v-for="(p, i) in patches" :key="i" class="mirror-patch"><span class="patch-type">{{ p.type }}</span><code>{{ p.selector || p.rule.split('{')[0] }}</code><span class="patch-value">{{ p.text || p.html || (p.rule ? p.rule.slice(p.rule.indexOf('{')) : '') }}</span></div>
          <div v-if="!patches.length" class="hist-empty">아직 적용한 패치가 없습니다.</div>
          <div v-if="patches.length" class="save-row">
            <input v-model.trim="variantName" class="name-input" type="text" placeholder="변형 이름 (예: 히어로 카피 교체)" />
            <button class="ghost-btn on mirror-save" :disabled="saving" @click="saveVariant">{{ saving ? '저장 중…' : '변형으로 저장' }}</button>
          </div>
        </div>
        <div class="side-section">
          <div class="picker-label">저장된 변형 <small>({{ savedCount }})</small></div>
          <div v-for="v in saved" :key="v.key" class="saved-row"><span class="variant-dot" :style="{ background: v.color }"></span><span class="saved-name">{{ v.name }}<small>{{ v.key }} · 패치 {{ v.patches.length }}개 · {{ date(v.createdAt) }}</small></span><button class="q-undo" @click="preview(v)">미러에 적용</button><button class="q-undo" @click="remove(v.key)">삭제</button></div>
          <div v-if="!saved.length" class="hist-empty">저장된 변형이 없습니다.</div>
        </div>
      </aside>
    </div>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
const props = defineProps({ runId: String })
const emit = defineEmits(['saved'])
const open = ref(false)
const pages = ref(null)
const currentPath = ref('/')
const frameEl = ref(null)
const frameSrc = ref('')
const picking = ref(true)
const selected = ref(null)
const tool = ref('text')
const input = ref('')
const patches = ref([])
const history = ref([])
const saved = ref([])
const variantName = ref('')
const saving = ref(false)
const error = ref('')
const toast = ref('')
let toastTimer, highlight, doc
const tools = [{ type: 'text', label: '텍스트' }, { type: 'hide', label: '숨기기' }, { type: 'css', label: 'CSS' }, { type: 'inject', label: 'HTML 삽입' }, { type: 'reorder', label: '맨 위로' }]
const savedCount = computed(() => saved.value.length)
const canApply = computed(() => selected.value && (['hide', 'reorder'].includes(tool.value) || input.value.trim().length > 0))
const date = v => v ? new Date(v).toLocaleDateString('ko-KR') : ''
const base = computed(() => `/api/runs/${props.runId}/mirror/`)
function say(msg) { toast.value = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = '' }, 2200) }

// id > data attribute > nth-of-type path (stops at the first ancestor with an id, never deeper than body)
function selectorFor(el) {
  const esc = s => (doc.defaultView.CSS?.escape || (x => x.replace(/([^\w-])/g, '\\$1')))(s)
  const parts = []
  let cur = el
  while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    if (cur.id) { parts.unshift('#' + esc(cur.id)); break }
    const data = [...cur.attributes].find(a => /^(data-testid|data-id|data-key|data-section|data-component|name)$/.test(a.name) && a.value)
    if (data) { parts.unshift(`${cur.tagName.toLowerCase()}[${data.name}="${data.value.replace(/"/g, '\\"')}"]`); break }
    let seg = cur.tagName.toLowerCase()
    const siblings = cur.parentElement ? [...cur.parentElement.children].filter(s => s.tagName === cur.tagName) : []
    if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`
    parts.unshift(seg)
    cur = cur.parentElement
  }
  const selector = parts.join(' > ')
  try { if (doc.querySelector(selector) === el) return selector } catch { /* fall through */ }
  return selector
}

function describe(el) {
  const s = doc.defaultView.getComputedStyle(el)
  return { el, tag: el.tagName.toLowerCase(), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), selector: selectorFor(el), css: { color: s.color, bg: s.backgroundColor, font: `${s.fontSize}/${s.fontWeight}`, display: s.display } }
}

function ensureHighlight() {
  if (highlight && highlight.ownerDocument === doc) return highlight
  highlight = doc.createElement('div')
  highlight.setAttribute('data-mc-highlight', '')
  highlight.style.cssText = 'position:absolute;pointer-events:none;border:2px solid #0f43f3;background:rgba(15,67,243,.08);z-index:2147483647;box-sizing:border-box;display:none'
  doc.body.appendChild(highlight)
  return highlight
}
function moveHighlight(el) {
  const h = ensureHighlight()
  if (!el) { h.style.display = 'none'; return }
  const r = el.getBoundingClientRect()
  const win = doc.defaultView
  Object.assign(h.style, { display: 'block', left: r.left + win.scrollX + 'px', top: r.top + win.scrollY + 'px', width: r.width + 'px', height: r.height + 'px' })
}
const isOurs = el => !el || el === doc.body || el === doc.documentElement || el.hasAttribute?.('data-mc-highlight')
function onOver(e) { if (!picking.value) return; const el = e.target; if (isOurs(el)) return moveHighlight(null); moveHighlight(el) }
function onClick(e) {
  if (!picking.value) { const a = e.target.closest?.('a[href]'); if (a) { e.preventDefault(); try { const u = new URL(a.getAttribute('href'), doc.baseURI); if (u.pathname.startsWith(base.value)) navigate('/' + u.pathname.slice(base.value.length) + u.search) } catch { /* ignore */ } } return }
  e.preventDefault(); e.stopPropagation()
  const el = e.target
  if (isOurs(el)) return
  selected.value = describe(el)
  moveHighlight(el)
  input.value = tool.value === 'text' ? selected.value.text : ''
}
function onFrameLoad() {
  try { doc = frameEl.value.contentDocument } catch { error.value = '미러 문서에 접근할 수 없습니다 (동일 출처가 아닙니다).'; return }
  if (!doc?.body) return
  highlight = null
  doc.addEventListener('mouseover', onOver, true)
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('submit', e => e.preventDefault(), true)
  selected.value = null
  history.value = []
  if (pendingPatches) { const list = pendingPatches; pendingPatches = null; for (const p of list) applyPatch(p, false) }
}
let pendingPatches = null

function sanitizeHtml(html) { if (/<script|javascript:|on[a-z]+\s*=/i.test(html)) throw new Error('HTML에는 스크립트나 인라인 이벤트 핸들러를 넣을 수 없습니다.'); return html }
function applyPatch(p, record = true) {
  const undoEntry = { patch: p }
  if (p.type === 'css') { const style = doc.createElement('style'); style.textContent = p.rule; doc.head.appendChild(style); undoEntry.undo = () => style.remove() }
  else {
    const el = doc.querySelector(p.selector)
    if (!el) throw new Error(`선택자와 일치하는 요소가 없습니다: ${p.selector}`)
    if (p.type === 'text') { const node = [...el.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim()); const before = node ? node.nodeValue : el.textContent; if (node) node.nodeValue = p.text; else el.textContent = p.text; undoEntry.undo = () => { if (node) node.nodeValue = before; else el.textContent = before } }
    else if (p.type === 'hide') { const before = el.style.display; el.style.display = 'none'; undoEntry.undo = () => { el.style.display = before } }
    else if (p.type === 'inject') { el.insertAdjacentHTML('afterend', sanitizeHtml(p.html)); const inserted = []; let n = el.nextSibling; const count = (() => { const t = doc.createElement('template'); t.innerHTML = p.html; return t.content.childNodes.length })(); for (let i = 0; i < count && n; i++) { inserted.push(n); n = n.nextSibling } undoEntry.undo = () => inserted.forEach(x => x.remove()) }
    else if (p.type === 'reorder') { const parent = el.parentElement; const next = el.nextSibling; parent.prepend(el); undoEntry.undo = () => parent.insertBefore(el, next) }
  }
  if (record) { history.value.push(undoEntry); patches.value.push(p) }
  return undoEntry
}
function apply() {
  if (!selected.value) return
  error.value = ''
  const sel = selected.value.selector
  const p = tool.value === 'text' ? { type: 'text', selector: sel, text: input.value } : tool.value === 'hide' ? { type: 'hide', selector: sel } : tool.value === 'css' ? { type: 'css', rule: `${sel}{${input.value.replace(/[{}]/g, '')}}` } : tool.value === 'inject' ? { type: 'inject', selector: sel, position: 'afterend', html: input.value } : { type: 'reorder', selector: sel }
  try { applyPatch(p); moveHighlight(selected.value.el); say(`${p.type} 패치 적용됨`) } catch (err) { error.value = err.message }
}
function undo() { const last = history.value.pop(); if (!last) return; try { last.undo() } catch { /* element gone */ } patches.value.pop(); moveHighlight(selected.value?.el || null); say('되돌렸습니다') }
function navigate(path) { currentPath.value = path; selected.value = null; frameSrc.value = base.value + path.replace(/^\//, '') }
async function openMirror() {
  error.value = ''
  try { const res = await fetch(`/api/runs/${props.runId}/mirror-pages`); const body = await res.json(); if (!res.ok) throw new Error(body.error); pages.value = body; open.value = true; navigate(body.pages[0]?.path || '/') } catch (err) { error.value = err.message }
}
async function loadSaved() { try { const res = await fetch(`/api/runs/${props.runId}/variants`); const body = await res.json(); saved.value = body.variants || [] } catch { saved.value = [] } }
async function saveVariant() {
  saving.value = true; error.value = ''
  try {
    const res = await fetch(`/api/runs/${props.runId}/variants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: variantName.value || `미러 변형 ${saved.value.length + 1}`, description: `미러 편집기에서 만든 ${patches.value.length}개 패치`, patches: patches.value }) })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error)
    await loadSaved(); emit('saved', body); say(`변형 "${body.name}" 저장됨 — 시뮬레이션 변형 목록에서 선택할 수 있습니다`); variantName.value = ''
  } catch (err) { error.value = err.message } finally { saving.value = false }
}
async function remove(key) { try { const res = await fetch(`/api/runs/${props.runId}/variants/${key}`, { method: 'DELETE' }); if (!res.ok) throw new Error((await res.json()).error); await loadSaved(); emit('saved'); say('변형 삭제됨') } catch (err) { error.value = err.message } }
function preview(v) { if (!open.value) { pendingPatches = v.patches; openMirror(); return } pendingPatches = v.patches; navigate(currentPath.value); say(`${v.name} 패치를 미러에 적용했습니다 (세션 패치에는 추가되지 않음)`) }
onMounted(loadSaved)
onUnmounted(() => clearTimeout(toastTimer))
</script>

<style scoped>
.mirror-panel{position:relative}
.saved-badge{font:700 10px var(--mono);color:var(--ss-blue);border:1px solid var(--ss-blue);padding:3px 8px}
.saved-badge.session{color:var(--ss-sub);border-color:var(--ss-border-dark)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.page-select{border:1px solid var(--ss-border-dark);padding:7px 10px;font:600 11px var(--sans);background:#fff;max-width:320px}
.toolbar-note{font-size:11px;color:var(--ss-muted);margin-left:auto}
.editor-body{display:grid;grid-template-columns:1.7fr 1fr;gap:18px;margin-top:16px}
.canvas-wrap{border:1px solid var(--ss-border);min-width:0}
.browser-bar{font:10px var(--mono);color:var(--ss-muted);padding:7px 12px;border-bottom:1px solid var(--ss-border);background:var(--ss-bg-sub);letter-spacing:1px}
.browser-bar span{margin-left:8px;letter-spacing:0;color:var(--ss-sub)}
.mirror-frame{display:block;width:100%;height:640px;border:0;background:#fff}
.side{min-width:0}
.side-section{margin-bottom:18px}
.sel-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.sel-tag{font:700 11px var(--mono);color:var(--ss-blue);border:1px solid var(--ss-blue);padding:2px 6px}
.sel-text{font-size:11px;color:var(--ss-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sel-selector{display:flex;gap:8px;align-items:baseline;padding:8px 10px;background:var(--ss-bg-sub);border:1px solid var(--ss-border)}
.ev-label{font:700 9px var(--mono);color:var(--ss-blue);letter-spacing:1px}
.mirror-selector{font:10px var(--mono);color:var(--ss-text);word-break:break-all}
.sel-css{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.css-chip{font:9px var(--mono);color:var(--ss-muted);border:1px solid var(--ss-border);padding:2px 5px}
.tools{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.mirror-tool{background:#fff;border:1px solid var(--ss-border-dark);padding:6px 10px;font:700 11px var(--sans);cursor:pointer;color:var(--ss-text)}
.mirror-tool.on{border-color:var(--ss-blue);color:var(--ss-blue);background:#eef2ff}
.tool-label{display:block;font:700 10px var(--mono);color:var(--ss-sub);margin-bottom:6px}
.mirror-input{width:100%;border:1px solid var(--ss-border-dark);padding:8px 10px;font:12px var(--sans);resize:vertical;box-sizing:border-box}
.tool-note{font-size:11px;color:var(--ss-sub);margin:0}
.mirror-apply{margin-top:10px;padding:10px 16px;font-size:12px}
.mirror-patch{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--ss-border);font-size:11px;min-width:0}
.patch-type{font:700 9px var(--mono);border:1px solid var(--ss-border-dark);padding:2px 5px;color:var(--ss-sub);text-transform:uppercase}
.mirror-patch code{font:10px var(--mono);color:var(--ss-blue);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
.patch-value{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ss-sub)}
.save-row{display:flex;gap:8px;margin-top:10px}
.name-input{flex:1;border:1px solid var(--ss-border-dark);padding:8px 10px;font:600 12px var(--sans);min-width:0}
.saved-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--ss-border);font-size:11px}
.saved-row .variant-dot{margin-top:0}
.saved-name{flex:1;display:grid;gap:2px;min-width:0}
.saved-name small{font:9px var(--mono);color:var(--ss-muted)}
.q-undo{background:none;border:0;font:700 10px var(--mono);color:var(--ss-muted);cursor:pointer}
.q-undo:hover{color:var(--ss-blue)}
.hist-empty{font-size:11px;color:var(--ss-muted);padding:12px;border:1px dashed var(--ss-border);line-height:1.6}
.toast{position:absolute;right:24px;bottom:24px;background:#000;color:#fff;font:700 11px var(--sans);padding:10px 14px}
@media(max-width:1100px){.editor-body{grid-template-columns:1fr}.mirror-frame{height:480px}.toolbar-note{margin-left:0}}
</style>
