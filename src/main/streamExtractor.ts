import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { BrowserWindow, session, type Session } from 'electron'
import type { SiteRule, UpstreamHeaders } from '../shared/types'
import { AppError, errorMessage } from './errors'
import { assertSafeRemoteUrl, parseRemoteUrl, readResponseText, safeFetch } from './urlSafety'
import { SnifferProxy } from './snifferProxy'
import { blockDownloads, restrictWindow } from './windowSecurity'

const HTML_LIMIT = 2 * 1024 * 1024
const STATIC_REGEX_INPUT_LIMIT = 700_000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'

export interface ExtractedStream {
  url: string
  mediaType: 'hls' | 'mp4'
  headers: UpstreamHeaders
  extractedBy: 'static' | 'sniffer'
  fromCache?: boolean
  playPageHtml?: string
}

function decodeCandidate(initial: string, pipeline: NonNullable<SiteRule['streamExtraction']['staticRule']>['decodePipeline']): string {
  let value: unknown = initial
  for (const step of pipeline) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    switch (step) {
      case 'unescape_slashes':
        value = text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&')
        break
      case 'url_decode':
        try { value = decodeURIComponent(text.replace(/\+/g, '%20')) } catch { value = text }
        break
      case 'base64_decode': {
        const compact = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
        value = Buffer.from(compact, 'base64').toString('utf8')
        break
      }
      case 'json_parse': {
        try {
          const parsed = JSON.parse(text)
          value = typeof parsed === 'object' && parsed && 'url' in parsed
            ? (parsed as { url: unknown }).url
            : parsed
        } catch {
          value = text
        }
        break
      }
    }
  }
  return String(value).trim().replace(/^['"]|['"]$/g, '')
}

function mediaTypeFor(url: string): 'hls' | 'mp4' {
  const pathname = new URL(url).pathname.toLowerCase()
  return pathname.endsWith('.mp4') || pathname.endsWith('.m4v') ? 'mp4' : 'hls'
}

async function execRegexWithTimeout(
  pattern: string,
  flags: string,
  input: string,
  timeoutMs = 750
): Promise<string | undefined> {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const match = new RegExp(workerData.pattern, workerData.flags).exec(workerData.input);
      parentPort.postMessage({ value: match ? (match[1] ?? match[0]) : undefined });
    } catch (error) {
      parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  `, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    workerData: { pattern, flags, input }
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new AppError('STATIC_REGEX_TIMEOUT', '静态提取正则执行超时'))
    }, timeoutMs)
    worker.once('message', (message: { value?: string; error?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (message.error) reject(new AppError('STATIC_REGEX_FAILED', message.error))
      else resolve(message.value)
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      reject(new AppError('STATIC_REGEX_FAILED', '静态提取正则执行失败', error))
    })
  })
}

export async function extractStaticUrlFromHtml(
  html: string,
  pageUrl: string,
  staticRule: NonNullable<SiteRule['streamExtraction']['staticRule']>
): Promise<string> {
  const flags = (staticRule.flags ?? '').replace(/[gy]/g, '')
  const captured = await execRegexWithTimeout(staticRule.regex, flags, html.slice(0, STATIC_REGEX_INPUT_LIMIT))
  if (!captured) throw new AppError('STATIC_NO_MATCH', '静态规则未匹配到流地址')
  const decoded = decodeCandidate(captured, staticRule.decodePipeline)
  const streamUrl = parseRemoteUrl(decoded, pageUrl).toString()
  if (staticRule.validUrlPattern && await execRegexWithTimeout(staticRule.validUrlPattern, 'i', streamUrl) === undefined) {
    throw new AppError('STATIC_INVALID_STREAM', '静态规则提取结果未通过地址校验')
  }
  return streamUrl
}

function filterCapturedHeaders(headers: Record<string, string | string[]>): UpstreamHeaders {
  const allowed = new Set([
    'user-agent', 'referer', 'origin', 'cookie', 'authorization',
    'accept', 'accept-language', 'x-requested-with'
  ])
  const output: UpstreamHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!allowed.has(lower) && !lower.startsWith('x-')) continue
    const stringValue = Array.isArray(value) ? value.join(', ') : value
    if (stringValue && stringValue.length <= 8_192) output[lower] = stringValue
  }
  return output
}

async function staticExtract(playPageUrl: string, rule: SiteRule): Promise<ExtractedStream> {
  const staticRule = rule.streamExtraction.staticRule
  if (!staticRule) throw new AppError('STATIC_RULE_MISSING', '站点没有配置静态流提取规则')
  const response = await safeFetch(playPageUrl, {
    headers: { 'user-agent': USER_AGENT, referer: rule.baseUrl, accept: 'text/html,application/xhtml+xml' }
  }, { timeoutMs: 15_000 })
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppError('UPSTREAM_HTTP_ERROR', `播放页请求失败（HTTP ${response.status}）`)
  }
  const html = await readResponseText(response, HTML_LIMIT)
  const streamUrl = await extractStaticUrlFromHtml(html, response.url || playPageUrl, staticRule)
  await assertSafeRemoteUrl(streamUrl)
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = responseHeaders.getSetCookie?.()
    .map((value) => value.split(';', 1)[0])
    .filter((value): value is string => Boolean(value))
    .join('; ')
  return {
    url: streamUrl,
    mediaType: mediaTypeFor(streamUrl),
    headers: {
      'user-agent': USER_AGENT,
      referer: response.url || playPageUrl,
      ...(cookie && new URL(streamUrl).origin === new URL(response.url || playPageUrl).origin ? { cookie } : {})
    },
    extractedBy: 'static',
    playPageHtml: html
  }
}

interface SnifferHandle {
  cancel(reason?: string): void
}

async function createSnifferWindow(networkProxy: SnifferProxy, isDisposed: () => boolean): Promise<{
  window: BrowserWindow
  isolatedSession: Session
}> {
  let isolatedSession: Session | undefined
  let window: BrowserWindow | undefined
  try {
    isolatedSession = session.fromPartition(`temp:sniffer-${randomUUID()}`, { cache: false })
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setDevicePermissionHandler(() => false)
    blockDownloads(isolatedSession)
    const proxyRules = await networkProxy.start()
    await isolatedSession.setProxy({ mode: 'fixed_servers', proxyRules, proxyBypassRules: '<-loopback>' })
    if (isDisposed()) throw new AppError('SNIFFER_CANCELLED', '解析器已关闭')
    window = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        session: isolatedSession,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        webgl: false,
        spellcheck: false,
        javascript: true,
        images: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    restrictWindow(window, allowRemoteNavigation)
    return { window, isolatedSession }
  } catch (error) {
    networkProxy.close()
    if (window && !window.isDestroyed()) window.destroy()
    void isolatedSession?.clearStorageData().catch(() => undefined)
    throw error
  }
}

function allowRemoteNavigation(target: string): boolean {
  try { parseRemoteUrl(target); return true } catch { return false }
}

export class StreamExtractor {
  private readonly activeSniffers = new Set<SnifferHandle>()
  private startingSniffers = 0
  private disposed = false

  async resolve(playPageUrlValue: string, rule: SiteRule): Promise<ExtractedStream> {
    if (this.disposed) throw new AppError('SNIFFER_CANCELLED', '解析器已关闭')
    const playPageUrl = (await assertSafeRemoteUrl(new URL(playPageUrlValue, rule.baseUrl))).toString()
    const errors: string[] = []

    if (rule.streamExtraction.primaryMode === 'static') {
      try {
        return await staticExtract(playPageUrl, rule)
      } catch (error) {
        errors.push(errorMessage(error))
        if (rule.streamExtraction.fallbackMode === 'none') throw error
      }
    }

    try {
      return await this.sniff(playPageUrl, rule)
    } catch (error) {
      errors.push(errorMessage(error))
      if (rule.streamExtraction.primaryMode === 'sniffer' && rule.streamExtraction.staticRule) {
        try { return await staticExtract(playPageUrl, rule) } catch (staticError) { errors.push(errorMessage(staticError)) }
      }
      throw new AppError('STREAM_RESOLVE_FAILED', `无法解析视频流：${errors.join('；')}`)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const handle of this.activeSniffers) handle.cancel('应用正在退出')
    this.activeSniffers.clear()
  }

  private async sniff(playPageUrl: string, rule: SiteRule): Promise<ExtractedStream> {
    if (this.activeSniffers.size + this.startingSniffers >= 3) {
      throw new AppError('SNIFFER_BUSY', '同时解析的站点过多，请稍后重试')
    }
    this.startingSniffers += 1
    const snifferRule = rule.streamExtraction.snifferRule ?? {
      timeoutMs: 10_000,
      urlMatchRegex: '\\.(m3u8|mp4)(\\?.*)?$',
      excludeRegex: '(ad|tracker|analytics|doubleclick)'
    }
    const networkProxy = new SnifferProxy()
    let ready: Awaited<ReturnType<typeof createSnifferWindow>>
    try {
      ready = await createSnifferWindow(networkProxy, () => this.disposed)
    } finally {
      this.startingSniffers -= 1
    }
    const { window, isolatedSession } = ready

    return new Promise<ExtractedStream>((resolve, reject) => {
      let settled = false
      let capturePending = false
      const captureQueue: Array<{ url: string; headers: Record<string, string | string[]> }> = []
      let requestCount = 0
      let timeout: ReturnType<typeof setTimeout>

      const cleanup = (): void => {
        clearTimeout(timeout)
        networkProxy.close()
        captureQueue.length = 0
        try { isolatedSession.webRequest.onBeforeRequest(null) } catch { /* already detached */ }
        try { isolatedSession.webRequest.onBeforeSendHeaders(null) } catch { /* already detached */ }
        if (!window.isDestroyed()) window.destroy()
        this.activeSniffers.delete(handle)
        void isolatedSession.clearStorageData().catch(() => undefined)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = (stream: ExtractedStream): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(stream)
      }
      const handle: SnifferHandle = {
        cancel: (reason = '嗅探已取消') => fail(new AppError('SNIFFER_CANCELLED', reason))
      }
      this.activeSniffers.add(handle)
      if (this.disposed) { handle.cancel('应用正在退出'); return }

      try {
        isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
          requestCount += 1
          const blocked = settled || requestCount > 600 || ['image', 'stylesheet', 'font'].includes(details.resourceType) ||
            !allowRemoteNavigation(details.url) || /\.(?:exe|msi|dll|bat|cmd|ps1|vbs|scr|com|iso|zip|rar|7z)(?:$|[?#])/i.test(details.url)
          callback({ cancel: blocked })
        })
        const processCaptures = async (): Promise<void> => {
          if (capturePending) return
          capturePending = true
          try {
            while (!settled && captureQueue.length) {
              const candidate = captureQueue.shift()!
              if (await execRegexWithTimeout(snifferRule.urlMatchRegex, 'i', candidate.url) === undefined) continue
              if (snifferRule.excludeRegex && await execRegexWithTimeout(snifferRule.excludeRegex, 'i', candidate.url) !== undefined) continue
              const safeUrl = await assertSafeRemoteUrl(candidate.url)
              if (settled) return
              const headers = filterCapturedHeaders(candidate.headers)
              if (!headers.referer) headers.referer = playPageUrl
              if (!headers['user-agent']) headers['user-agent'] = USER_AGENT
              succeed({ url: safeUrl.toString(), mediaType: mediaTypeFor(safeUrl.toString()), headers, extractedBy: 'sniffer' })
            }
          } catch (error) {
            fail(new AppError('SNIFFER_RULE_FAILED', '嗅探规则执行失败或目标地址不安全', error))
          } finally { capturePending = false }
        }
        isolatedSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
          callback({ cancel: false, requestHeaders: details.requestHeaders })
          if (settled || details.url.length > 8192 || captureQueue.length >= 100) return
          captureQueue.push({ url: details.url, headers: details.requestHeaders })
          void processCaptures()
        })
        window.webContents.on('render-process-gone', () => fail(new AppError('SNIFFER_CRASHED', '隔离的站点解析进程已终止')))

        timeout = setTimeout(() => fail(new AppError('SNIFFER_TIMEOUT', '动态嗅探超时')), snifferRule.timeoutMs)
        void window.loadURL(playPageUrl, { userAgent: USER_AGENT }).catch((error) => {
          fail(new AppError('SNIFFER_LOAD_FAILED', '播放页加载失败', error))
        })
      } catch (error) {
        fail(new AppError('SNIFFER_START_FAILED', '无法启动隔离的站点解析窗口', error))
      }
    })
  }
}

export const __testing = { decodeCandidate, mediaTypeFor, filterCapturedHeaders }
