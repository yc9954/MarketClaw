// One JSON call against the OpenAI-compatible chat-completions endpoint, with fence stripping and
// truncated-JSON repair. Callers validate the result and fall back to their heuristic path.
import { llmConfig } from './engine.js'

export function stripFences(text) { return String(text || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim() }

// Closes open strings and brackets so a max_tokens-truncated payload can still be parsed.
export function repairTruncatedJson(text) {
  const s = String(text || '').trim()
  if (!s) return s
  let inString = false, escaped = false, lastSafe = 0, prev = ''
  const stack = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') { inString = false; if (prev === ':' || stack.at(-1) === '[') lastSafe = i + 1; prev = '"' } // a closed string is safe only as a value, not as a dangling key
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') { stack.push(ch); prev = ch }
    else if (ch === '}' || ch === ']') { stack.pop(); lastSafe = i + 1; prev = ch }
    else if (ch === ',') { lastSafe = i + 1; prev = ch }
    else if (!/\s/.test(ch)) prev = ch
  }
  let out = (lastSafe ? s.slice(0, lastSafe) : s).replace(/,\s*$/, '')
  for (const opener of stack.reverse()) out += opener === '{' ? '}' : ']'
  return out
}

export function parseJsonLoose(text) {
  const cleaned = stripFences(text)
  for (const candidate of [cleaned, repairTruncatedJson(cleaned)]) { try { return JSON.parse(candidate) } catch { /* try next */ } }
  throw new Error(`LLM 응답을 JSON으로 해석하지 못했습니다: ${cleaned.slice(0, 120)}`)
}

export async function llmJson(messages, { temperature = 0.3, maxTokens = 2500, timeoutMs = 45000, fetchImpl = fetch } = {}) {
  const cfg = llmConfig()
  if (!cfg.configured) throw new Error('LLM_API_KEY가 설정되지 않았습니다.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } }) })
    if (!res.ok) throw new Error(`LLM ${res.status}`)
    const body = await res.json()
    return parseJsonLoose(body.choices?.[0]?.message?.content || '')
  } finally { clearTimeout(timer) }
}
