// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AppShell from '../../src/renderer/src/App.vue'
import type { FavoriteInput, FavoriteItem } from '../../src/shared/types'

vi.mock('../../src/renderer/src/components/PlayerOverlay.vue', () => ({ default: {
  props: ['context'], emits: ['close', 'saved', 'notify', 'favorite'],
  template: '<div class="test-player">{{ context.title }} · {{ context.playlists[context.playlistIndex].episodes[context.episodeIndex].name }}<button @click="$emit(\'close\')">关闭测试播放器</button></div>'
} }))

const movie: FavoriteInput = {
  siteId: 'site-a', siteName: '站点 A', title: '力量之戒',
  coverUrl: 'https://images.example/cover.jpg', detailUrl: 'https://video.example/detail/1'
}
let stored: FavoriteItem[]
let app: App | undefined
let root: HTMLDivElement
const api = {
  getVersion: vi.fn(async () => 'test'),
  favorites: {
    list: vi.fn(async () => structuredClone(stored)),
    add: vi.fn(async (input: FavoriteInput) => {
      const item = { ...input, favoriteId: `${input.siteId}-favorite`, createdAt: Date.now() }
      stored.push(item)
      return item
    }),
    remove: vi.fn(async ({ favoriteId }: { favoriteId: string }) => { stored = stored.filter((item) => item.favoriteId !== favoriteId) })
  },
  history: { list: vi.fn(async () => [] as unknown[]), remove: vi.fn(), clear: vi.fn() },
  rules: { list: vi.fn(async () => [{ siteId: 'site-a', siteName: '站点 A' }]) },
  vod: {
    search: vi.fn(async () => [movie]),
    detail: vi.fn(async () => ({
      ...movie, description: '影片简介', playlistGroups: [{ name: '线路一', episodes: [
        { name: '第一集', url: 'https://video.example/play/1', index: 0 },
        { name: '第二集', url: 'https://video.example/play/2', index: 1 }
      ] }]
    }))
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}
async function mount(): Promise<void> {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(AppShell)
  app.mount(root)
  await settle()
}
function navigate(label: string): void {
  const button = [...root.querySelectorAll<HTMLButtonElement>('.nav-item')].find((item) => item.textContent?.includes(label))!
  button.click()
}
async function search(): Promise<void> {
  navigate('聚合搜索')
  await settle()
  const input = root.querySelector<HTMLInputElement>('[aria-label="搜索关键词"]')!
  input.value = '力量之戒'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}

beforeEach(() => {
  stored = []
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', { configurable: true, value: api })
})
afterEach(async () => {
  app?.unmount()
  app = undefined
  root?.remove()
  await settle()
})

describe('favorites throughout the application', () => {
  it('favorites search results, opens episodes from the list, plays a chosen episode and synchronizes removal', async () => {
    await mount()
    await search()
    const favorite = root.querySelector<HTMLButtonElement>('.result-card .favorite-button')!
    favorite.click()
    favorite.click()
    await settle()
    expect(api.favorites.add).toHaveBeenCalledOnce()
    expect(api.vod.detail).not.toHaveBeenCalled()
    expect(favorite.getAttribute('aria-pressed')).toBe('true')
    expect(root.querySelector('.nav-count')?.textContent).toBe('1')
    navigate('我的收藏')
    await settle()
    expect(root.querySelector('.favorites-page .result-copy')?.textContent).toContain('力量之戒')
    expect(root.querySelector('img')?.getAttribute('src')).toMatch(/^safe-image:/)
    root.querySelector<HTMLButtonElement>('.favorites-page .result-cover')!.click()
    await settle()
    const episodes = root.querySelectorAll<HTMLButtonElement>('.episode-grid button')
    expect(episodes).toHaveLength(2)
    episodes[1]!.click()
    await settle()
    expect(root.querySelector('.test-player')?.textContent).toContain('力量之戒 · 第二集')
    root.querySelector<HTMLButtonElement>('.test-player button')!.click()
    await settle()
    root.querySelector<HTMLButtonElement>('.drawer-header .favorite-button')!.click()
    await settle()
    expect(api.favorites.remove).toHaveBeenCalledWith({ favoriteId: 'site-a-favorite' })
    expect(root.querySelector('.drawer-header .favorite-button')?.getAttribute('aria-pressed')).toBe('false')
    root.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click()
    await settle()
    expect(root.querySelector('.favorites-page')?.textContent).toContain('还没有收藏影片')
  })

  it('favorites history independently and reloads saved favorites after reopening the app', async () => {
    api.history.list.mockResolvedValueOnce([{
      ...movie, seriesId: 'history-1', lastEpisodeName: '第一集', lastEpisodeUrl: 'https://video.example/play/1',
      lastCurrentTime: 60, lastDuration: 180, updatedAt: Date.now(), episodes: {}
    }])
    await mount()
    root.querySelector<HTMLButtonElement>('.history-card .favorite-button')!.click()
    await settle()
    expect(api.favorites.add).toHaveBeenCalledWith({ ...movie, siteName: '' })
    expect(api.history.remove).not.toHaveBeenCalled()
    expect(api.history.clear).not.toHaveBeenCalled()
    app?.unmount()
    root.remove()
    await mount()
    navigate('我的收藏')
    await settle()
    expect(root.querySelectorAll('.favorites-page .result-card')).toHaveLength(1)
  })

  it('filters favorites by title or site and keeps matching titles from different sites separate', async () => {
    stored = [{ ...movie, favoriteId: 'a', createdAt: 1 }, { ...movie, siteId: 'site-b', siteName: '站点 B', favoriteId: 'b', createdAt: 2 }]
    await mount()
    navigate('我的收藏')
    await settle()
    expect(root.querySelectorAll('.favorites-page .result-card')).toHaveLength(2)
    const filter = root.querySelector<HTMLInputElement>('[aria-label="搜索收藏"]')!
    filter.value = '站点 B'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(root.querySelectorAll('.favorites-page .result-card')).toHaveLength(1)
    expect(root.querySelector('.favorites-page .result-copy')?.textContent).toContain('站点 B')
  })

  it('shows load errors with retry and keeps a favorite visible when removing it fails', async () => {
    stored = [{ ...movie, favoriteId: 'a', createdAt: 1 }]
    api.favorites.list.mockRejectedValueOnce(new Error('读取失败'))
    await mount()
    navigate('我的收藏')
    await settle()
    expect(root.querySelector('.favorites-page')?.textContent).toContain('读取失败')
    root.querySelector<HTMLButtonElement>('.favorites-page .secondary-button')!.click()
    await settle()
    api.favorites.remove.mockRejectedValueOnce(new Error('写入失败'))
    root.querySelector<HTMLButtonElement>('.favorites-page .favorite-button')!.click()
    await settle()
    expect(root.querySelectorAll('.favorites-page .result-card')).toHaveLength(1)
    expect(root.querySelector('.favorites-page .favorite-button')?.getAttribute('aria-pressed')).toBe('true')
    expect(root.textContent).toContain('收藏操作失败')
  })
})
