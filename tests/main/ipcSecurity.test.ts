import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerIpcHandlers } from '../../src/main/ipcHandlers'
import { IPC } from '../../src/shared/ipc'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>())
vi.mock('electron', () => ({
  app: { getVersion: () => 'test-version' },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))
vi.mock('../../src/main/llmConnectionTest', () => ({ testLlmConnection: vi.fn() }))

describe('IPC entry points', () => {
  it('guards every request channel before settings, keys, rules or stream actions can execute', () => {
    const frame = { url: 'file:///app/renderer/index.html' }
    const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
    const dispose = registerIpcHandlers({
      rendererUrl: frame.url, getPlayerContents: () => contents,
      storage: {}, proxy: {}, resolver: {}, vod: {}, ruleGenerator: {}
    } as unknown as Parameters<typeof registerIpcHandlers>[0])
    try {
      expect(handlers.size).toBe(Object.keys(IPC).length - 1)
      const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
      expect(handlers.get(IPC.APP_VERSION)!(trusted)).toBe('test-version')
      const untrusted = { sender: {}, senderFrame: { url: 'https://video.example/' } }
      for (const handler of handlers.values()) expect(() => handler(untrusted, {})).toThrow('非播放器')
      const iframe = { sender: contents, senderFrame: { url: frame.url } }
      for (const handler of handlers.values()) expect(() => handler(iframe, {})).toThrow('非播放器')
    } finally { dispose() }
    expect(handlers.size).toBe(0)
  })

  it('routes playback through address reuse, skips model repair on cache hits, and forwards forced refresh', async () => {
    const frame = { url: 'file:///app/renderer/index.html' }
    const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
    const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const rule = { siteId: 'site' }
    const stream = { url: 'https://cdn.example/video.m3u8', mediaType: 'hls', headers: {}, extractedBy: 'sniffer', fromCache: true }
    const local = { localUrl: 'http://127.0.0.1:12345/proxy/session/master.m3u8', fromCache: true }
    const resolver = { resolve: vi.fn(async () => stream), removeSite: vi.fn() }
    const proxy = { register: vi.fn(() => local) }
    const ruleGenerator = { autoHeal: vi.fn(async () => undefined) }
    const storage = { getRule: vi.fn(() => rule), removeRule: vi.fn() }
    const dispose = registerIpcHandlers({
      rendererUrl: frame.url, getPlayerContents: () => contents,
      storage, resolver, proxy, vod: {}, ruleGenerator
    } as unknown as Parameters<typeof registerIpcHandlers>[0])
    try {
      const input = { siteId: 'site', playPageUrl: 'https://video.example/play' }
      expect(await handlers.get(IPC.STREAM_RESOLVE)!(trusted, input)).toEqual(local)
      expect(resolver.resolve).toHaveBeenLastCalledWith(input.playPageUrl, rule, false)
      expect(proxy.register).toHaveBeenCalledWith(stream)
      expect(ruleGenerator.autoHeal).not.toHaveBeenCalled()
      resolver.resolve.mockResolvedValueOnce({ ...stream, fromCache: false })
      await handlers.get(IPC.STREAM_RESOLVE)!(trusted, { ...input, forceRefresh: true })
      expect(resolver.resolve).toHaveBeenLastCalledWith(input.playPageUrl, rule, true)
      expect(ruleGenerator.autoHeal).toHaveBeenCalledOnce()
      handlers.get(IPC.RULE_REMOVE)!(trusted, 'site')
      expect(storage.removeRule).toHaveBeenCalledWith('site')
      expect(resolver.removeSite).toHaveBeenCalledWith('site')
    } finally { dispose() }
  })
})
