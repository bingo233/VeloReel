import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { HlsProxyServer } from '../../src/main/hlsProxyServer'
import { safeFetch } from '../../src/main/urlSafety'
import type { AppStorage } from '../../src/main/storage'

vi.mock('../../src/main/urlSafety', async (original) => ({ ...await original<typeof import('../../src/main/urlSafety')>(), safeFetch: vi.fn() }))
let proxy: HlsProxyServer

beforeEach(async () => {
  vi.mocked(safeFetch).mockReset()
  proxy = new HlsProxyServer({ getSettings: () => ({ proxyCacheMegabytes: 32, proxyPrefetchCount: 1 }) } as AppStorage, 'http://localhost:5173/')
  await proxy.start()
})
afterEach(async () => { await proxy.stop() })

const extracted = (mediaType: 'hls' | 'mp4' = 'hls') => ({
  url: `https://cdn.example/video.${mediaType === 'hls' ? 'm3u8' : 'mp4'}`,
  mediaType, extractedBy: 'static' as const,
  headers: { cookie: 'secret-cookie', authorization: 'Bearer secret', referer: 'https://video.example/play', 'user-agent': 'Player' }
})

describe('local media proxy security and acceleration', () => {
  it('keeps manifest rewriting, segment caching, prefetching and stable resource tokens', async () => {
    const manifest = '#EXTM3U\n#EXTINF:10,\nsegment-1.ts\n#EXTINF:10,\nsegment-2.ts\n#EXT-X-ENDLIST'
    vi.mocked(safeFetch).mockImplementation(async (url) => String(url).endsWith('.m3u8')
      ? new Response(manifest)
      : new Response('segment', { headers: { 'content-type': 'video/mp2t' } }))
    const { localUrl } = proxy.register(extracted())
    const response = await fetch(localUrl, { headers: { origin: 'http://localhost:5173' } })
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const body = await response.text()
    const urls = body.split('\n').filter((line) => line.startsWith('http:'))
    expect(urls).toHaveLength(2)
    expect(body).not.toContain('cdn.example')
    await expect(fetch(urls[0]!).then((item) => item.text())).resolves.toBe('segment')
    await vi.waitFor(() => expect(safeFetch).toHaveBeenCalledTimes(3))
    await expect(fetch(urls[1]!).then((item) => item.text())).resolves.toBe('segment')
    expect(safeFetch).toHaveBeenCalledTimes(3)
    expect(await fetch(localUrl).then((item) => item.text())).toBe(body)
  })

  it('rejects foreign browser origins and DNS-rebinding Host headers before contacting upstream', async () => {
    const { localUrl } = proxy.register(extracted())
    expect((await fetch(localUrl, { headers: { origin: 'https://malicious.example' } })).status).toBe(403)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(localUrl, { headers: { host: 'malicious.example' } }, (res) => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('stops a recursively linked master playlist before unlimited nesting', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8'))
    let url = proxy.register(extracted()).localUrl
    for (let depth = 0; depth <= 4; depth += 1) {
      vi.mocked(safeFetch).mockResolvedValueOnce(new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8'))
      const response = await fetch(url)
      expect(response.status).toBe(200)
      url = (await response.text()).split('\n').find((line) => line.startsWith('http:'))!
    }
    const response = await fetch(url)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('嵌套层级过深')
    expect(safeFetch).toHaveBeenCalledTimes(5)
  })

  it.each(['http://127.0.0.1:8080/secret', 'http://169.254.169.254/metadata', 'file:///C:/secret'])('rejects unsafe manifest references: %s', async (url) => {
    vi.mocked(safeFetch).mockResolvedValue(new Response(`#EXTM3U\n#EXTINF:10,\n${url}`))
    const { localUrl } = proxy.register(extracted())
    expect((await fetch(localUrl)).status).toBe(502)
    expect(safeFetch).toHaveBeenCalledTimes(1)
  })

  it('does not serve HTML as MP4, and does not relay source credentials to another CDN', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }))
    expect((await fetch(proxy.register(extracted('mp4')).localUrl)).status).toBe(502)
    vi.mocked(safeFetch).mockImplementation(async (url) => String(url).endsWith('.m3u8')
      ? new Response('#EXTM3U\n#EXTINF:10,\nhttps://other-cdn.example/segment.ts\n#EXT-X-ENDLIST')
      : new Response('segment'))
    const manifest = await fetch(proxy.register(extracted()).localUrl).then((res) => res.text())
    await fetch(manifest.split('\n').find((line) => line.startsWith('http:'))!)
    const headers = new Headers(vi.mocked(safeFetch).mock.calls.at(-1)![1]!.headers)
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('referer')).toBe('https://video.example/play')
  })

  it('preserves MP4 Range requests and cancels upstream when a session is released', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(safeFetch).mockImplementation(async (_url, init) => {
      signal = init?.signal || undefined
      expect(new Headers(init?.headers).get('range')).toBe('bytes=100-199')
      return new Response('bytes', { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 100-199/1000' } })
    })
    const resolution = proxy.register(extracted('mp4'))
    const response = await fetch(resolution.localUrl, { headers: { range: 'bytes=100-199' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(await response.text()).toBe('bytes')
    proxy.release(resolution.sessionId)
    expect(signal?.aborted).toBe(true)
    expect((await fetch(resolution.localUrl)).status).toBe(404)
  })
})
