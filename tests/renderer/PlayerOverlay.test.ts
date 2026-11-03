// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Artplayer from 'artplayer'
import { createApp, nextTick, type App } from 'vue'
import PlayerOverlay from '../../src/renderer/src/components/PlayerOverlay.vue'
import { DEFAULT_SETTINGS, type PlayerContext } from '../../src/renderer/src/types'

const context: PlayerContext = {
  siteId: 'test-site', title: '测试影片', coverUrl: '', detailUrl: 'https://example.com/detail',
  playlistIndex: 0, episodeIndex: 0,
  playlists: [{ name: '线路一', episodes: [
    { name: '第一集', url: 'https://example.com/1' },
    { name: '第二集', url: 'https://example.com/2' }
  ] }]
}

const historyList = vi.fn()
const historySave = vi.fn()
const resolveStream = vi.fn()
const releaseStream = vi.fn()
const paused = new WeakMap<HTMLMediaElement, boolean>()
let app: App | undefined
let root: HTMLDivElement

function player(): Artplayer {
  return Artplayer.instances[0]!
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(): Promise<HTMLVideoElement> {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(PlayerOverlay, { context })
  app.mount(root)
  await vi.waitFor(() => expect(resolveStream).toHaveBeenCalledTimes(1))
  await settle()
  const video = player().video
  video.dispatchEvent(new Event('loadedmetadata'))
  video.dispatchEvent(new Event('canplay'))
  await settle()
  return video
}

function press(code: string, target: Element = player().template.$player): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }))
}

function button(label: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`.player-control-button[aria-label="${label}"]`)!
}

beforeAll(() => {
  Artplayer.LOG_VERSION = false
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 180 })
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true, get(this: HTMLMediaElement) { return paused.get(this) ?? true }
  })
  HTMLMediaElement.prototype.load = function () {
    this.playbackRate = this.defaultPlaybackRate
    this.currentTime = 0
  }
  HTMLMediaElement.prototype.play = function () {
    paused.set(this, false)
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  }
  HTMLMediaElement.prototype.pause = function () {
    paused.set(this, true)
    this.dispatchEvent(new Event('pause'))
  }
})

beforeEach(() => {
  historyList.mockReset().mockResolvedValue([])
  historySave.mockReset().mockResolvedValue(undefined)
  resolveStream.mockReset().mockImplementation(async () => ({
    sessionId: `session-${resolveStream.mock.calls.length}`,
    localUrl: `http://127.0.0.1:12345/video-${resolveStream.mock.calls.length}.mp4`,
    mediaType: 'mp4', extractedBy: 'static'
  }))
  releaseStream.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS) },
      stream: { resolve: resolveStream, release: releaseStream },
      history: { list: historyList, save: historySave }
    }
  })
})

afterEach(async () => {
  app?.unmount()
  app = undefined
  await settle()
  root?.remove()
  vi.restoreAllMocks()
})

describe('Artplayer integration', () => {
  it('mounts progress, duration, speed, volume and fullscreen controls', async () => {
    await mount()
    expect(root.querySelector('.art-progress')).not.toBeNull()
    expect(root.querySelector('.art-control-time')?.textContent).toContain('03:00')
    expect(root.querySelector('.art-control-volume')).not.toBeNull()
    expect(root.querySelector('.art-control-fullscreen')).not.toBeNull()
    const rates = root.querySelectorAll('.player-rate-select option')
    expect([...rates].map((option) => option.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×'])
    expect(button('上一集').disabled).toBe(true)
    expect(button('下一集').disabled).toBe(false)
  })

  it('seeks, changes volume, mutes, pauses and changes playback speed from the keyboard', async () => {
    const video = await mount()
    video.currentTime = 40
    press('ArrowRight')
    expect(video.currentTime).toBe(45)
    press('ArrowLeft')
    expect(video.currentTime).toBe(40)
    video.volume = 0.98
    press('ArrowUp')
    expect(video.volume).toBe(1)
    press('ArrowDown')
    expect(video.volume).toBe(0.95)
    press('KeyM')
    expect(video.muted).toBe(true)
    press('KeyM')
    expect(video.muted).toBe(false)
    press('Space')
    expect(video.paused).toBe(true)
    press('Space')
    expect(video.paused).toBe(false)
    press('BracketRight')
    await settle()
    expect(video.playbackRate).toBe(1.25)
    expect(root.querySelector<HTMLSelectElement>('.player-rate-select')?.value).toBe('1.25')
  })

  it('preserves form controls and disables media shortcuts while panels are open', async () => {
    const video = await mount()
    video.currentTime = 40
    press('ArrowRight', root.querySelector('.player-rate-select')!)
    press('Space', button('下一集'))
    expect(video.currentTime).toBe(40)
    expect(video.paused).toBe(false)
    button('选集').click()
    await nextTick()
    // 选集面板位于原生全屏元素内，全屏时仍可切集。
    expect(player().template.$player.querySelector('.player-episodes')).not.toBeNull()
    press('ArrowRight')
    expect(video.currentTime).toBe(40)
    press('Escape')
    await vi.waitFor(() => expect(root.querySelector('.player-episodes')).toBeNull())
    expect(document.activeElement).toBe(player().template.$player)
    press('ArrowRight')
    expect(video.currentTime).toBe(45)
  })

  it('keeps the player, speed and volume across episodes and releases the previous proxy', async () => {
    const video = await mount()
    const instance = player()
    const select = root.querySelector<HTMLSelectElement>('.player-rate-select')!
    select.value = '1.5'
    select.dispatchEvent(new Event('change'))
    video.volume = 0.45
    await settle()
    button('下一集').click()
    await vi.waitFor(() => expect(resolveStream).toHaveBeenCalledTimes(2))
    video.dispatchEvent(new Event('loadedmetadata'))
    await settle()
    expect(player()).toBe(instance)
    expect(video.playbackRate).toBe(1.5)
    expect(video.volume).toBe(0.45)
    expect(releaseStream).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(button('上一集').disabled).toBe(false)
    expect(button('下一集').disabled).toBe(true)
  })

  it('does not apply a delayed resume lookup to a different episode', async () => {
    let finishLookup: (value: unknown[]) => void = () => undefined
    historyList.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve }))
    const video = await mount()
    button('下一集').click()
    await vi.waitFor(() => expect(resolveStream).toHaveBeenCalledTimes(2))
    finishLookup([{
      siteId: context.siteId, detailUrl: context.detailUrl,
      episodes: { 'https://example.com/1': { currentTime: 80, isFinished: false } }
    }])
    await settle()
    expect(video.currentTime).toBe(0)
    expect(root.querySelector('.resume-toast')).toBeNull()
  })

  it('restores an unfinished episode and saves its progress', async () => {
    historyList.mockResolvedValue([{
      siteId: context.siteId, detailUrl: context.detailUrl,
      episodes: { 'https://example.com/1': { currentTime: 80, isFinished: false } }
    }])
    const video = await mount()
    expect(video.currentTime).toBe(80)
    expect(root.querySelector('.resume-toast')?.textContent).toContain('01:20')
    video.pause()
    await settle()
    expect(historySave).toHaveBeenCalledWith(expect.objectContaining({
      episodeUrl: 'https://example.com/1', currentTime: 80, isFinished: false
    }))
  })

  it('saves a finished episode and advances once when playback ends', async () => {
    const video = await mount()
    video.currentTime = 180
    video.dispatchEvent(new Event('ended'))
    video.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(resolveStream).toHaveBeenCalledTimes(2))
    expect(historySave).toHaveBeenCalledWith(expect.objectContaining({
      episodeUrl: 'https://example.com/1', isFinished: true
    }))
    expect(resolveStream).toHaveBeenLastCalledWith({
      siteId: context.siteId, playPageUrl: 'https://example.com/2'
    })
  })

  it('cleans up the player and keyboard handlers on close', async () => {
    const video = await mount()
    const oldSurface = player().template.$player
    video.currentTime = 40
    app?.unmount()
    app = undefined
    const stoppedTime = video.currentTime
    document.body.append(oldSurface)
    press('ArrowRight', oldSurface)
    await settle()
    expect(Artplayer.instances).toHaveLength(0)
    expect(video.currentTime).toBe(stoppedTime)
    expect(releaseStream).toHaveBeenCalledWith({ sessionId: 'session-1' })
    oldSurface.remove()
  })

  it('shows cached playback and refreshes an expired address once while preserving progress, speed and volume', async () => {
    resolveStream.mockResolvedValueOnce({
      sessionId: 'cached-session', localUrl: 'http://127.0.0.1:12345/cached.mp4',
      mediaType: 'mp4', extractedBy: 'sniffer', fromCache: true
    })
    const video = await mount()
    expect(root.querySelector('.extract-badge')?.textContent).toContain('缓存直连')
    video.currentTime = 75
    video.volume = 0.45
    video.playbackRate = 1.5
    video.dispatchEvent(new Event('ratechange'))
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } })
    video.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(resolveStream).toHaveBeenCalledTimes(2))
    await settle()
    expect(resolveStream).toHaveBeenLastCalledWith({
      siteId: context.siteId, playPageUrl: 'https://example.com/1', forceRefresh: true
    })
    expect(releaseStream).toHaveBeenCalledWith({ sessionId: 'cached-session' })
    video.dispatchEvent(new Event('loadedmetadata'))
    await settle()
    expect(video.currentTime).toBe(75)
    expect(video.playbackRate).toBe(1.5)
    expect(video.volume).toBe(0.45)
    video.dispatchEvent(new Event('error'))
    await settle()
    expect(resolveStream).toHaveBeenCalledTimes(2)
    expect(root.querySelector('.player-error')?.textContent).toContain('视频数据下载失败')
  })

  it('shows a refresh failure and lets manual re-extraction bypass the cached address', async () => {
    resolveStream.mockResolvedValueOnce({
      sessionId: 'cached-session', localUrl: 'http://127.0.0.1:12345/cached.mp4',
      mediaType: 'mp4', extractedBy: 'sniffer', fromCache: true
    }).mockRejectedValueOnce(new Error('本次重新解析失败'))
    const video = await mount()
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } })
    video.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(root.querySelector('.player-error')?.textContent).toContain('本次重新解析失败'))
    root.querySelector<HTMLButtonElement>('.player-error .primary-button')!.click()
    await vi.waitFor(() => expect(resolveStream).toHaveBeenCalledTimes(3))
    expect(resolveStream).toHaveBeenLastCalledWith({
      siteId: context.siteId, playPageUrl: 'https://example.com/1', forceRefresh: true
    })
  })
})
