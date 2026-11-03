import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import type { SiteRule } from '../../src/shared/types'
import { StreamExtractor } from '../../src/main/streamExtractor'

const fixtures = vi.hoisted(() => ({
  proxy: { start: vi.fn(async () => 'http://127.0.0.1:9999'), close: vi.fn() },
  session: {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    on: vi.fn(), setProxy: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}),
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() }
  },
  window: {
    isDestroyed: vi.fn(() => false), destroy: vi.fn(), loadURL: vi.fn(async () => {}),
    webContents: { setWindowOpenHandler: vi.fn(), setWebRTCIPHandlingPolicy: vi.fn(), on: vi.fn() }
  }
}))
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(), session: { fromPartition: vi.fn(() => fixtures.session) }
}))
vi.mock('../../src/main/snifferProxy', () => ({ SnifferProxy: vi.fn(function () { return fixtures.proxy }) }))
vi.mock('../../src/main/urlSafety', async (original) => ({
  ...await original<typeof import('../../src/main/urlSafety')>(),
  assertSafeRemoteUrl: vi.fn(async (input) => new URL(String(input)))
}))

const rule: SiteRule = {
  siteId: 'fixture', siteName: 'Fixture', baseUrl: 'https://video.example/',
  search: { urlTemplate: 'https://video.example/?wd={keyword}', listSelector: 'li', titleSelector: 'a', detailUrlSelector: 'a@href' },
  detail: { episodeListSelector: 'a', episodeNameSelector: '@text', episodeUrlSelector: '@href' },
  streamExtraction: { primaryMode: 'sniffer' }
}

beforeEach(() => {
  vi.clearAllMocks()
  fixtures.proxy.start.mockImplementation(async () => 'http://127.0.0.1:9999')
  fixtures.session.webRequest.onBeforeRequest.mockReset()
  vi.mocked(BrowserWindow).mockImplementation(function () { return fixtures.window as unknown as BrowserWindow })
})

describe('sniffer failure cleanup', () => {
  it('closes the proxy and releases the concurrency slot when a window cannot be created', async () => {
    vi.mocked(BrowserWindow).mockImplementation(function () { throw new Error('window creation failed') })
    const extractor = new StreamExtractor()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(extractor.resolve('/play', rule)).rejects.toThrow('window creation failed')
    }
    expect(fixtures.proxy.close).toHaveBeenCalledTimes(4)
    expect(fixtures.session.clearStorageData).toHaveBeenCalledTimes(4)
  })

  it('destroys the window and network proxy if request interception cannot be installed', async () => {
    fixtures.session.webRequest.onBeforeRequest.mockImplementation((filter) => {
      if (filter) throw new Error('interception unavailable')
    })
    const extractor = new StreamExtractor()
    await expect(extractor.resolve('/play', rule)).rejects.toThrow('无法启动隔离')
    expect(fixtures.proxy.close).toHaveBeenCalledOnce()
    expect(fixtures.window.destroy).toHaveBeenCalledOnce()
    expect(fixtures.session.clearStorageData).toHaveBeenCalledOnce()
    expect(fixtures.window.loadURL).not.toHaveBeenCalled()
    extractor.dispose()
    expect(fixtures.proxy.close).toHaveBeenCalledOnce()
  })

  it('does not create a new browser window if disposed while the proxy is starting', async () => {
    const extractor = new StreamExtractor()
    fixtures.proxy.start.mockImplementation(async () => { extractor.dispose(); return 'http://127.0.0.1:9999' })
    await expect(extractor.resolve('/play', rule)).rejects.toThrow('解析器已关闭')
    expect(BrowserWindow).not.toHaveBeenCalled()
    expect(fixtures.proxy.close).toHaveBeenCalledOnce()
    expect(fixtures.session.clearStorageData).toHaveBeenCalledOnce()
  })
})
