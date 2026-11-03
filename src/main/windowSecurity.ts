import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { AppError } from './errors'

export function blockDownloads(target: Session): void {
  target.on('will-download', (event, item) => {
    event.preventDefault()
    try { item.cancel() } catch { /* preventDefault 已阻止下载，部分版本会立即销毁条目。 */ }
  })
}

export function isSameDocumentUrl(value: string, expected: string): boolean {
  try {
    const actualUrl = new URL(value)
    const expectedUrl = new URL(expected)
    actualUrl.hash = ''
    expectedUrl.hash = ''
    return actualUrl.href === expectedUrl.href
  } catch { return false }
}

export function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  contents: WebContents | undefined,
  rendererUrl: string
): void {
  if (
    !contents || contents.isDestroyed() || event.sender !== contents ||
    !event.senderFrame || event.senderFrame !== contents.mainFrame ||
    !isSameDocumentUrl(event.senderFrame.url, rendererUrl)
  ) throw new AppError('UNTRUSTED_SENDER', '已拒绝来自非播放器页面的操作')
}

export function restrictWindow(window: BrowserWindow, allowNavigation: (url: string) => boolean): void {
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-navigate', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
  contents.on('will-frame-navigate', (event) => { if (!allowNavigation(event.url)) event.preventDefault() })
}

export function configureRendererNetwork(target: Session, rendererUrl: string, proxyOrigin: string): void {
  const developmentOrigin = ['http:', 'https:'].includes(new URL(rendererUrl).protocol) ? new URL(rendererUrl).origin : undefined
  blockDownloads(target)
  target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    try {
      const url = new URL(details.url)
      const websocketOrigin = url.protocol === 'ws:' ? `http://${url.host}` : url.protocol === 'wss:' ? `https://${url.host}` : url.origin
      const dev = developmentOrigin && websocketOrigin === developmentOrigin
      const media = url.origin === proxyOrigin && /^\/proxy\//.test(url.pathname)
      callback({ cancel: !dev && !media })
    } catch { callback({ cancel: true }) }
  })
}
