import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LanServer } from '../../src/main/lanServer'
import { makeSeriesId } from '../../src/main/storage'
import { isPrivateAddress } from '../../src/main/lanAddress'
import type { AppStorage } from '../../src/main/storage'
import type { VodService } from '../../src/main/vodService'
import { LAN_PROTOCOL_VERSION, parseDiscoverPacket } from '../../src/shared/lanProtocol'
import type { AppSettings } from '../../src/shared/types'

const settings = { deviceName: '测试服务', lanEnabled: true, lanPort: 8790 } as unknown as AppSettings

const favorites: Array<Record<string, unknown>> = []
const rules = new Map<string, Record<string, unknown>>()
const history = new Map<string, Record<string, unknown>>()

const fakeStorage = {
  getSettings: () => settings,
  getRule: (siteId: string) => rules.get(siteId),
  listFavorites: () => [...favorites],
  listRules: () => [...rules.values()],
  addFavorite: (input: Record<string, unknown>) => {
    const item = { ...input, favoriteId: `fav-${favorites.length + 1}`, createdAt: 1 }
    favorites.push(item)
    return item
  },
  removeFavorite: (favoriteId: string) => {
    const index = favorites.findIndex((item) => item.favoriteId === favoriteId)
    if (index >= 0) favorites.splice(index, 1)
  },
  listHistory: () => [...history.values()],
  getHistory: (seriesId: string) => history.get(seriesId) ?? null,
  saveProgress: (input: Record<string, unknown>) => {
    const seriesId = typeof input.seriesId === 'string'
      ? input.seriesId
      : makeSeriesId(String(input.siteId), String(input.detailUrl))
    const item = {
      ...input,
      seriesId,
      lastCurrentTime: input.currentTime,
      updatedAt: 5
    }
    history.set(seriesId, item)
    return item
  },
  saveRule: (input: { siteId: string } & Record<string, unknown>) => {
    const saved = { ...input, updatedAt: 5 }
    rules.set(String(input.siteId), saved)
    return saved
  },
  removeRule: (siteId: string) => {
    rules.delete(siteId)
  }
} as unknown as AppStorage

const fakeVod = {
  search: async (input: { keyword: string }) => [{ title: `结果:${input.keyword}`, siteId: 'demo', siteName: 'Demo', coverUrl: '', detailUrl: '/detail/1' }],
  detail: async () => ({ title: '示例', episodes: [] })
} as unknown as VodService

let server: LanServer | undefined

beforeEach(() => {
  favorites.length = 0
  favorites.push({ favoriteId: 'fav-1', siteId: 'demo', siteName: 'Demo', title: '示例', coverUrl: '', detailUrl: '/detail/1', createdAt: 1 })
  rules.clear()
  rules.set('demo', { siteId: 'demo', siteName: 'Demo' })
  history.clear()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

describe('private address detection', () => {
  it('accepts private and loopback ranges', () => {
    expect(isPrivateAddress('192.168.1.20')).toBe(true)
    expect(isPrivateAddress('10.0.0.5')).toBe(true)
    expect(isPrivateAddress('172.20.1.1')).toBe(true)
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('::ffff:192.168.1.20')).toBe(true)
  })

  it('rejects public addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('172.32.0.1')).toBe(false)
    expect(isPrivateAddress('2001:db8::1')).toBe(false)
    expect(isPrivateAddress(undefined)).toBe(false)
  })
})

describe('discovery packet parsing', () => {
  it('accepts a matching version', () => {
    expect(parseDiscoverPacket({ v: LAN_PROTOCOL_VERSION, type: 'discover', clientName: 'TV' }))
      .toMatchObject({ type: 'discover', clientName: 'TV' })
  })

  it('rejects malformed or mismatched payloads', () => {
    expect(parseDiscoverPacket({ v: 2, type: 'discover' })).toBeNull()
    expect(parseDiscoverPacket({ v: 1, type: 'announce' })).toBeNull()
    expect(parseDiscoverPacket('discover')).toBeNull()
  })
})

describe('lan api', () => {
  it('serves info, favorites and search without credentials', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    const info = await fetch(`${base}/api/v1/info`).then((response) => response.json()) as { name: string; protocol: number }
    expect(info.name).toBe('测试服务')
    expect(info.protocol).toBe(LAN_PROTOCOL_VERSION)

    const favorites = await fetch(`${base}/api/v1/favorites`).then((response) => response.json()) as unknown[]
    expect(favorites).toHaveLength(1)

    const results = await fetch(`${base}/api/v1/search?keyword=${encodeURIComponent('测试')}`).then((response) => response.json()) as Array<{ title: string }>
    expect(results[0]?.title).toBe('结果:测试')
  })

  it('rejects browser-originated requests', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/info`, {
      headers: { Origin: 'https://evil.example' }
    })
    expect(response.status).toBe(403)
  })

  it('stops listening after shutdown', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const port = server.port
    await server.stop()
    await expect(fetch(`http://127.0.0.1:${port}/api/v1/info`)).rejects.toThrow()
  })

  it('adds and removes favorites', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    const created = await fetch(`${base}/api/v1/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: 'demo',
        siteName: 'Demo',
        title: '新收藏',
        coverUrl: '',
        detailUrl: 'https://site.example/detail/2'
      })
    })
    expect(created.status).toBe(200)
    const item = await created.json() as { favoriteId: string; title: string }
    expect(item.title).toBe('新收藏')

    const removed = await fetch(`${base}/api/v1/favorites/${item.favoriteId}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await removed.json() as { removed: boolean }).removed).toBe(true)

    const list = await fetch(`${base}/api/v1/favorites`).then((response) => response.json()) as unknown[]
    expect(list).toHaveLength(1)
  })

  it('stores progress and reads it back', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`
    const payload = {
      siteId: 'demo',
      title: '示例',
      coverUrl: '',
      detailUrl: 'https://site.example/detail/1',
      episodeUrl: 'https://site.example/play/1',
      episodeName: '第 1 集',
      currentTime: 42,
      duration: 120
    }
    const saved = await fetch(`${base}/api/v1/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    expect(saved.status).toBe(200)

    const query = `siteId=${encodeURIComponent(payload.siteId)}&detailUrl=${encodeURIComponent(payload.detailUrl)}`
    const item = await fetch(`${base}/api/v1/history?${query}`).then((response) => response.json()) as { lastCurrentTime: number } | null
    expect(item?.lastCurrentTime).toBe(42)
    expect(history.size).toBe(1)
  })

  it('reads, updates and removes site rules', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    const list = await fetch(`${base}/api/v1/rules`).then((response) => response.json()) as Array<{ siteId: string }>
    expect(list.map((rule) => rule.siteId)).toContain('demo')

    const single = await fetch(`${base}/api/v1/rules/demo`).then((response) => response.json()) as { siteName: string }
    expect(single.siteName).toBe('Demo')

    const saved = await fetch(`${base}/api/v1/rules/demo2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'demo2', siteName: 'Demo 2' })
    })
    expect(saved.status).toBe(200)
    expect((await saved.json() as { siteId: string }).siteId).toBe('demo2')

    const removed = await fetch(`${base}/api/v1/rules/demo2`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await fetch(`${base}/api/v1/rules/demo2`)).status).toBe(404)
  })

  it('validates image proxy parameters', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    expect((await fetch(`${base}/api/v1/image`)).status).toBe(400)
    expect((await fetch(`${base}/api/v1/image?url=${encodeURIComponent('http://127.0.0.1/a.png')}`)).status).toBe(400)
    expect((await fetch(`${base}/api/v1/image?url=${encodeURIComponent('file:///etc/passwd')}`)).status).toBe(400)
  })
})

describe('lan media bridge', () => {
  const exposed: Array<{ origin: string; pageUrl: string }> = []
  const media = {
    resolver: {
      resolve: async (pageUrl: string) => {
        exposed.push({ origin: '', pageUrl })
        return {
          url: 'https://cdn.example/master.m3u8',
          mediaType: 'hls' as const,
          headers: {},
          extractedBy: 'sniffer' as const,
          fromCache: false
        }
      }
    },
    proxy: {
      registerLan: (_extracted: unknown, origin: string) => {
        const last = exposed[exposed.length - 1]
        if (last) last.origin = origin
        return {
          sessionId: 'session-1',
          localUrl: `${origin}/lan/m/session-1/master.m3u8`,
          localProxyM3u8: `${origin}/lan/m/session-1/master.m3u8`,
          proxyUrl: `${origin}/lan/m/session-1/master.m3u8`,
          mediaType: 'hls' as const,
          extractedBy: 'sniffer' as const,
          fromCache: false
        }
      },
      handleLanMedia: async (_req: unknown, res: import('node:http').ServerResponse, url: URL) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`media:${url.pathname}`)
        return true
      }
    }
  }

  it('resolves a stream and returns a lan media url', async () => {
    exposed.length = 0
    server = new LanServer(fakeStorage, fakeVod, '0.1.0', media)
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    const response = await fetch(`${base}/api/v1/stream/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'demo', playPageUrl: 'https://site.example/play/1' })
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { localUrl: string; sessionId: string }
    expect(payload.sessionId).toBe('session-1')
    expect(payload.localUrl).toBe(`${base}/lan/m/session-1/master.m3u8`)
    expect(exposed[0]?.pageUrl).toBe('https://site.example/play/1')
    expect(exposed[0]?.origin).toBe(base)
  })

  it('rejects unknown rules and non-post methods', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0', media)
    await server.start(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`

    const missing = await fetch(`${base}/api/v1/stream/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'nope', playPageUrl: 'https://site.example/play/1' })
    })
    expect(missing.status).toBe(404)

    const wrongMethod = await fetch(`${base}/api/v1/stream/resolve`)
    expect(wrongMethod.status).toBe(405)
  })

  it('delegates media paths and reports unavailable media', async () => {
    server = new LanServer(fakeStorage, fakeVod, '0.1.0', media)
    await server.start(0, '127.0.0.1')
    const mediaResponse = await fetch(`http://127.0.0.1:${server.port}/lan/m/session-1/master.m3u8`)
    expect(mediaResponse.status).toBe(200)
    expect(await mediaResponse.text()).toBe('media:/lan/m/session-1/master.m3u8')

    await server.stop()
    server = new LanServer(fakeStorage, fakeVod, '0.1.0')
    await server.start(0, '127.0.0.1')
    const unavailable = await fetch(`http://127.0.0.1:${server.port}/lan/m/session-1/master.m3u8`)
    expect(unavailable.status).toBe(503)
  })
})
