import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteRule } from '../../src/shared/types'
import { StreamResolver, type StreamCacheEntry } from '../../src/main/streamResolver'
import { safeFetch } from '../../src/main/urlSafety'
import type { ExtractedStream } from '../../src/main/streamExtractor'

vi.mock('../../src/main/urlSafety', async (original) => ({
  ...await original<typeof import('../../src/main/urlSafety')>(), safeFetch: vi.fn()
}))

const rule: SiteRule = {
  siteId: 'fixture', siteName: 'Fixture', baseUrl: 'https://video.example/',
  search: { urlTemplate: 'https://video.example/?wd={keyword}', listSelector: 'li', titleSelector: 'a', detailUrlSelector: 'a@href' },
  detail: { episodeListSelector: 'a', episodeNameSelector: '@text', episodeUrlSelector: '@href' },
  streamExtraction: { primaryMode: 'sniffer' }
}
const stream: ExtractedStream = {
  url: 'https://cdn.example/video.m3u8?token=secret', mediaType: 'hls', extractedBy: 'sniffer',
  headers: { referer: 'https://video.example/play', cookie: 'session=secret' }, playPageHtml: '<html>large page</html>'
}

function fixture() {
  let entries: StreamCacheEntry[] = []
  const storage = {
    getStreamCache: vi.fn(() => structuredClone(entries)),
    saveStreamCache: vi.fn((value: StreamCacheEntry[]) => { entries = structuredClone(value) })
  }
  const extractor = { resolve: vi.fn(async () => stream) }
  return { storage, extractor, resolver: new StreamResolver(storage, extractor), entries: () => entries }
}

beforeEach(() => { vi.mocked(safeFetch).mockReset().mockImplementation(async () => new Response('#EXTM3U\n#EXTINF:10,\n1.ts')) })
afterEach(() => { vi.restoreAllMocks() })

describe('playback address reuse', () => {
  it('reopens the same episode without a second sniffer, while retaining upstream headers and validating the address', async () => {
    const { resolver, storage, extractor, entries } = fixture()
    expect((await resolver.resolve('/play', rule)).fromCache).toBe(false)
    expect(safeFetch).not.toHaveBeenCalled()
    const hit = await resolver.resolve('https://video.example/play#episode', rule)
    expect(hit).toMatchObject({ url: stream.url, headers: stream.headers, fromCache: true })
    expect(extractor.resolve).toHaveBeenCalledOnce()
    expect(safeFetch).toHaveBeenCalledWith(stream.url, { headers: stream.headers }, { timeoutMs: 5000 })
    expect(entries()[0]).not.toHaveProperty('playPageHtml')
    const reopened = new StreamResolver(storage, extractor)
    expect((await reopened.resolve('/play', rule)).fromCache).toBe(true)
    expect(extractor.resolve).toHaveBeenCalledOnce()
  })

  it.each(['forbidden', 'html', 'network', 'oversized'] as const)('re-extracts when a cached address becomes unusable: %s', async (failure) => {
    const { resolver, extractor, entries } = fixture()
    await resolver.resolve('/play', rule)
    if (failure === 'forbidden') vi.mocked(safeFetch).mockResolvedValueOnce(new Response('expired', { status: 403 }))
    if (failure === 'html') vi.mocked(safeFetch).mockResolvedValueOnce(new Response('<html>expired token</html>'))
    if (failure === 'network') vi.mocked(safeFetch).mockRejectedValueOnce(new Error('connection refused'))
    if (failure === 'oversized') vi.mocked(safeFetch).mockResolvedValueOnce(new Response('bad', { headers: { 'content-length': '3000000' } }))
    extractor.resolve.mockResolvedValueOnce({ ...stream, url: 'https://new-cdn.example/new.m3u8' })
    const result = await resolver.resolve('/play', rule)
    expect(result).toMatchObject({ url: 'https://new-cdn.example/new.m3u8', fromCache: false })
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
    expect(entries()[0]!.url).toBe(result.url)
  })

  it('can force a fresh extraction instead of reusing a still-valid address', async () => {
    const { resolver, extractor } = fixture()
    await resolver.resolve('/play', rule)
    expect((await resolver.resolve('/play', rule, true)).fromCache).toBe(false)
    expect(safeFetch).not.toHaveBeenCalled()
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
  })

  it('invalidates old addresses after 24 hours and when extraction rules change', async () => {
    const { resolver, extractor } = fixture()
    const now = Date.now()
    await resolver.resolve('/play', rule)
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60_000 + 100)
    await resolver.resolve('/play', rule)
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
    await resolver.resolve('/play', { ...rule, streamExtraction: { primaryMode: 'static', staticRule: { regex: '(https:.*)', decodePipeline: [] } } })
    expect(extractor.resolve).toHaveBeenCalledTimes(3)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('separates episodes and sites but keeps cached addresses after unrelated rule metadata changes', async () => {
    const { resolver, extractor } = fixture()
    await resolver.resolve('/play', rule)
    await resolver.resolve('/play-2', rule)
    await resolver.resolve('/play', { ...rule, siteId: 'another' })
    expect((await resolver.resolve('/play', { ...rule, siteName: 'New title', updatedAt: Date.now() })).fromCache).toBe(true)
    expect(extractor.resolve).toHaveBeenCalledTimes(3)
  })

  it('shares concurrent requests for the same episode rather than opening duplicate sniffers', async () => {
    const { resolver, extractor } = fixture()
    let finish!: (value: ExtractedStream) => void
    extractor.resolve.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = resolver.resolve('/play', rule)
    const second = resolver.resolve('/play', rule)
    expect(extractor.resolve).toHaveBeenCalledOnce()
    finish(stream)
    expect(await second).toEqual(await first)
  })

  it('releases failed shared requests so the next attempt can succeed', async () => {
    const { resolver, extractor } = fixture()
    extractor.resolve.mockRejectedValueOnce(new Error('sniffer failed'))
    await expect(resolver.resolve('/play', rule)).rejects.toThrow('sniffer failed')
    await expect(resolver.resolve('/play', rule)).resolves.toMatchObject({ fromCache: false })
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
  })

  it('does not return an in-progress cache hit to a request that explicitly forces refresh', async () => {
    const { resolver, extractor } = fixture()
    await resolver.resolve('/play', rule)
    let finish!: (value: Response) => void
    vi.mocked(safeFetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const hit = resolver.resolve('/play', rule)
    const refresh = resolver.resolve('/play', rule, true)
    finish(new Response('#EXTM3U\n#EXTINF:10,\n1.ts'))
    expect((await hit).fromCache).toBe(true)
    expect((await refresh).fromCache).toBe(false)
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
  })

  it('validates MP4 using a one-byte Range and cancels the probe body without downloading the movie', async () => {
    const { resolver, extractor } = fixture()
    extractor.resolve.mockResolvedValue({ ...stream, mediaType: 'mp4', url: 'https://cdn.example/video.mp4' })
    await resolver.resolve('/play', rule)
    const cancel = vi.fn()
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 206, headers: { 'content-type': 'video/mp4' } }))
    expect((await resolver.resolve('/play', rule)).fromCache).toBe(true)
    expect(new Headers(vi.mocked(safeFetch).mock.calls[0]![1]!.headers).get('range')).toBe('bytes=0-0')
    expect(cancel).toHaveBeenCalledOnce()
    expect(extractor.resolve).toHaveBeenCalledOnce()
  })

  it('rejects tampered private addresses and unsafe headers loaded from disk', async () => {
    const { storage, extractor, resolver, entries } = fixture()
    await resolver.resolve('/play', rule)
    storage.getStreamCache.mockReturnValue([{ ...entries()[0]!, url: 'http://127.0.0.1/private' }])
    await new StreamResolver(storage, extractor).resolve('/play', rule)
    storage.getStreamCache.mockReturnValue([{ ...entries()[0]!, headers: { host: 'internal.example' } }])
    await new StreamResolver(storage, extractor).resolve('/play', rule)
    expect(safeFetch).not.toHaveBeenCalled()
    expect(extractor.resolve).toHaveBeenCalledTimes(3)
  })

  it('removes a deleted site and still plays if persistent cache writes fail', async () => {
    const { resolver, storage, extractor, entries } = fixture()
    await resolver.resolve('/play', rule)
    resolver.removeSite(rule.siteId)
    expect(entries()).toEqual([])
    storage.saveStreamCache.mockImplementation(() => { throw new Error('disk full') })
    await expect(resolver.resolve('/play', rule)).resolves.toMatchObject({ fromCache: false })
    expect((await resolver.resolve('/play', rule)).fromCache).toBe(true)
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
  })
})
