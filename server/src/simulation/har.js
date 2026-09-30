// Reads the run's capture.har.zip without extra dependencies: a minimal ZIP reader (stored and
// deflated entries, no ZIP64) plus an index of the recorded responses by URL.
import fs from 'node:fs/promises'
import zlib from 'node:zlib'

const EOCD = 0x06054b50, CDIR = 0x02014b50, LOCAL = 0x04034b50

export function readZip(buffer) {
  const out = new Map()
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break }
  if (eocd < 0) throw new Error('ZIP 파일 형식이 아닙니다.')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (offset === 0xffffffff) throw new Error('ZIP64 아카이브는 지원하지 않습니다.')
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== CDIR) throw new Error('ZIP 중앙 디렉터리가 손상되었습니다.')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error(`ZIP 항목 ${name}의 로컬 헤더가 손상되었습니다.`)
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const data = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, zlib.inflateRawSync(data))
    else throw new Error(`지원하지 않는 ZIP 압축 방식 (${method}): ${name}`)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return out
}

export async function readHar(harZipPath) {
  const entries = readZip(await fs.readFile(harZipPath))
  const harEntry = [...entries.entries()].find(([name]) => name.endsWith('.har'))
  if (!harEntry) throw new Error('HAR 아카이브 안에 .har 파일이 없습니다.')
  return JSON.parse(harEntry[1].toString('utf8'))
}

// url → { status, mimeType, body: Buffer, headers, redirect } for every successful GET the capture
// recorded. When a URL was recorded more than once the last successful response wins.
export function indexHar(har) {
  const index = new Map()
  for (const entry of har.log?.entries || []) {
    if (entry.request?.method !== 'GET') continue
    const status = entry.response?.status ?? -1
    if (status < 200 || status >= 400) continue
    const content = entry.response.content || {}
    const body = content.text == null ? Buffer.alloc(0) : content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : Buffer.from(content.text, 'utf8')
    const headers = Object.fromEntries((entry.response.headers || []).map(h => [String(h.name).toLowerCase(), h.value]))
    const redirect = status >= 300 && status < 400 ? headers.location || entry.response.redirectURL || '' : ''
    let url = entry.request.url
    try { const u = new URL(url); u.hash = ''; url = u.href } catch { continue }
    index.set(url, { url, status, mimeType: content.mimeType || headers['content-type'] || 'application/octet-stream', body, redirect })
  }
  return index
}

export async function loadHarIndex(harZipPath) { return indexHar(await readHar(harZipPath)) }
