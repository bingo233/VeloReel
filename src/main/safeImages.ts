import type { Protocol } from 'electron'
import { readResponseBuffer, safeFetch } from './urlSafety'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
let active = 0
const waiting: Array<() => void> = []

async function takeSlot(): Promise<void> {
  if (active < 6) { active += 1; return }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function releaseSlot(): void {
  const next = waiting.shift()
  if (next) next()
  else active -= 1
}

export function imageContentType(body: Buffer): string | undefined {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (body.subarray(4, 8).toString('ascii') === 'ftyp' && /^(avif|avis)$/.test(body.subarray(8, 12).toString('ascii'))) return 'image/avif'
  return undefined
}

export function registerSafeImages(protocol: Protocol): void {
  protocol.handle('safe-image', async (request) => {
    if (request.method !== 'GET' || waiting.length >= 150) return new Response(null, { status: 429 })
    await takeSlot()
    try {
      const target = new URL(request.url).searchParams.get('url')
      if (!target || target.length > 4096) return new Response(null, { status: 400 })
      const response = await safeFetch(target, { signal: request.signal, headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' } }, { timeoutMs: 10_000 })
      if (!response.ok) { await response.body?.cancel(); return new Response(null, { status: 502 }) }
      const body = await readResponseBuffer(response, MAX_IMAGE_BYTES)
      const contentType = imageContentType(body)
      if (!contentType) return new Response(null, { status: 415 })
      return new Response(new Uint8Array(body), { headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox"
      } })
    } catch { return new Response(null, { status: 502 }) }
    finally { releaseSlot() }
  })
}
