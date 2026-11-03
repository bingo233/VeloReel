import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStorage } from '../../src/main/storage'

const values = vi.hoisted(() => new Map<string, unknown>())
vi.mock('electron', () => ({ safeStorage: {} }))
vi.mock('electron-store', () => ({ default: class {
  get(key: string, fallback: unknown) { return structuredClone(values.get(key) ?? fallback) }
  set(key: string, value: unknown) { values.set(key, structuredClone(value)) }
} }))
const favorite = {
  siteId: 'site-a', siteName: '站点 A', title: '力量之戒',
  coverUrl: 'https://images.example/cover.jpg', detailUrl: 'https://video.example/detail/1'
}
beforeEach(() => values.clear())
afterEach(() => vi.restoreAllMocks())

describe('local favorites', () => {
  it('persists favorites across storage instances and deduplicates normalized episode-detail addresses', () => {
    const storage = new AppStorage()
    const saved = storage.addFavorite({ ...favorite, detailUrl: `${favorite.detailUrl}#tab-1`, createdAt: -100 })
    expect(new AppStorage().listFavorites()).toEqual([saved])
    const updated = storage.addFavorite({ ...favorite, title: '更新标题', detailUrl: `${favorite.detailUrl}#tab-2` })
    expect(updated.favoriteId).toBe(saved.favoriteId)
    expect(updated.createdAt).toBe(saved.createdAt)
    expect(storage.listFavorites()).toEqual([updated])
    expect(updated.detailUrl).toBe(favorite.detailUrl)
  })

  it('keeps identical titles from different sites or detail pages separate and orders newest first', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const storage = new AppStorage()
    const first = storage.addFavorite(favorite)
    clock.mockReturnValue(2000)
    const second = storage.addFavorite({ ...favorite, siteId: 'site-b' })
    clock.mockReturnValue(3000)
    const third = storage.addFavorite({ ...favorite, detailUrl: 'https://video.example/detail/2' })
    expect(storage.listFavorites().map((item) => item.favoriteId)).toEqual([third.favoriteId, second.favoriteId, first.favoriteId])
  })

  it('removes favorites independently of history and preserves them when history or site rules are removed', () => {
    values.set('history', { existing: { title: '历史记录' } })
    const storage = new AppStorage()
    const first = storage.addFavorite(favorite)
    const second = storage.addFavorite({ ...favorite, siteId: 'site-b' })
    storage.removeFavorite(first.favoriteId)
    expect(values.get('history')).toEqual({ existing: { title: '历史记录' } })
    expect(storage.listFavorites()).toEqual([second])
    storage.clearHistory()
    storage.removeRule(second.siteId)
    expect(new AppStorage().listFavorites()).toEqual([second])
    storage.removeFavorite('missing')
    expect(storage.listFavorites()).toEqual([second])
  })

  it.each(['file:///C:/Windows/test', 'http://127.0.0.1/private', 'javascript:alert(1)'])('rejects unsafe detail links without writing: %s', (detailUrl) => {
    const storage = new AppStorage()
    expect(() => storage.addFavorite({ ...favorite, detailUrl })).toThrow()
    expect(storage.listFavorites()).toEqual([])
  })

  it('validates required metadata while allowing a favorite with a missing or invalid cover', () => {
    const storage = new AppStorage()
    expect(() => storage.addFavorite({ ...favorite, title: '' })).toThrow('影片名称不能为空')
    values.set('rules', { 'site-a': { siteName: '已配置的站点' } })
    const saved = storage.addFavorite({ ...favorite, siteName: '', coverUrl: 'data:text/html,bad' })
    expect(saved.coverUrl).toBe('')
    expect(saved.siteName).toBe('已配置的站点')
  })
})
