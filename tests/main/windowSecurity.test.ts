import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { assertTrustedIpcSender, blockDownloads, configureRendererNetwork } from '../../src/main/windowSecurity'
import { imageContentType } from '../../src/main/safeImages'

describe('renderer and third-party window isolation', () => {
  it('accepts IPC only from the application main frame in the current player window', () => {
    const frame = { url: 'file:///app/renderer/index.html' }
    const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    expect(() => assertTrustedIpcSender(event, contents, frame.url)).not.toThrow()
    expect(() => assertTrustedIpcSender(event, undefined, frame.url)).toThrow('非播放器')
    expect(() => assertTrustedIpcSender({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent, contents, frame.url)).toThrow('非播放器')
    expect(() => assertTrustedIpcSender({ ...event, sender: {} } as IpcMainInvokeEvent, contents, frame.url)).toThrow('非播放器')
    frame.url = 'https://malicious.example/'
    expect(() => assertTrustedIpcSender(event, contents, 'file:///app/renderer/index.html')).toThrow('非播放器')
  })

  it('prevents and cancels website downloads', () => {
    const on = vi.fn()
    blockDownloads({ on } as unknown as Session)
    const event = { preventDefault: vi.fn() }
    const item = { cancel: vi.fn() }
    on.mock.calls[0]![1](event, item)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(item.cancel).toHaveBeenCalledOnce()
  })

  it('allows local playback and dev HMR, but blocks direct remote requests in the application renderer', () => {
    const beforeRequest = vi.fn()
    configureRendererNetwork({ on: vi.fn(), webRequest: { onBeforeRequest: beforeRequest } } as unknown as Session,
      'http://localhost:5173/', 'http://127.0.0.1:9999')
    const handler = beforeRequest.mock.calls[0]![1]
    for (const url of ['http://localhost:5173/src/main.ts', 'ws://localhost:5173/', 'http://127.0.0.1:9999/proxy/token/media']) {
      const callback = vi.fn()
      handler({ url }, callback)
      expect(callback).toHaveBeenCalledWith({ cancel: false })
    }
    for (const url of ['http://127.0.0.1:8888/admin', 'http://192.168.1.1/', 'https://malicious.example/payload', 'ws://127.0.0.1:8000/']) {
      const callback = vi.fn()
      handler({ url }, callback)
      expect(callback).toHaveBeenCalledWith({ cancel: true })
    }
  })

  it('rejects HTML, SVG and executables disguised as cover images', () => {
    for (const content of ['<html><script>bad()</script></html>', '<svg onload="bad()"/>', 'MZ executable']) {
      expect(imageContentType(Buffer.from(content))).toBeUndefined()
    }
    expect(imageContentType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png')
    expect(imageContentType(Buffer.from([255, 216, 255, 1]))).toBe('image/jpeg')
  })
})
