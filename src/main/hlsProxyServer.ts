import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import type { StreamResolution, UpstreamHeaders } from '../shared/types'
import type { ExtractedStream } from './streamExtractor'
import type { AppStorage } from './storage'
import { AppError, errorMessage } from './errors'
import { parseRemoteUrl, readResponseBuffer, safeFetch, stripCrossOriginCredentials } from './urlSafety'

type ResourceKind = 'manifest' | 'segment' | 'key' | 'map'

interface ProxyResource {
  token: string
  url: string
  kind: ResourceKind
  index?: number
  rangeHeader?: string
  manifestDepth?: number
}

interface ProxySession {
  id: string
  sourceUrl: string
  mediaType: 'hls' | 'mp4'
  headers: UpstreamHeaders
  resources: Map<string, ProxyResource>
  dedupe: Map<string, string>
  orderedSegments: string[]
  lastAccess: number
  prefetchCount: number
  prefetchConcurrency: number
  prefetchActive: number
  prefetchQueue: string[]
  prefetchQueued: Set<string>
  abort: AbortController
}

interface BufferedResponse {
  body: Buffer
  status: number
  contentType: string
  contentRange?: string
  acceptRanges?: string
}

class ByteLru {
  private readonly entries = new Map<string, BufferedResponse>()
  private totalBytes = 0

  constructor(private maxBytes: number) {}

  setLimit(maxBytes: number): void {
    this.maxBytes = maxBytes
    this.trim()
  }

  get(key: string): BufferedResponse | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: BufferedResponse): void {
    const prior = this.entries.get(key)
    if (prior) this.totalBytes -= prior.body.byteLength
    this.entries.delete(key)
    this.entries.set(key, value)
    this.totalBytes += value.body.byteLength
    this.trim()
  }

  deletePrefix(prefix: string): void {
    for (const [key, value] of this.entries) {
      if (!key.startsWith(prefix)) continue
      this.totalBytes -= value.body.byteLength
      this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  private trim(): void {
    while (this.totalBytes > this.maxBytes && this.entries.size) {
      const oldest = this.entries.entries().next().value as [string, BufferedResponse] | undefined
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.totalBytes -= oldest[1].body.byteLength
    }
  }
}

const SESSION_TTL_MS = 30 * 60_000
const MAX_SESSIONS = 32
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024
const MAX_RESOURCES_PER_SESSION = 20_000
const MAX_INFLIGHT_RESOURCES = 8

function token(): string {
  return randomBytes(18).toString('base64url')
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase()
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

function copyHeader(response: Response, res: ServerResponse, name: string): void {
  const value = response.headers.get(name)
  if (value) res.setHeader(name, value)
}

function cors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): boolean {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('X-Frame-Options', 'DENY')
  if (req.headers.origin && req.headers.origin !== allowedOrigin) return false
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
  res.setHeader('Cache-Control', 'no-store')
  return true
}

function upstreamHeaders(session: ProxySession, targetUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(session.headers)) {
    const lower = key.toLowerCase()
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'range'].includes(lower)) continue
    result[lower] = value
  }
  const headers = new Headers(result)
  if (new URL(targetUrl).origin !== new URL(session.sourceUrl).origin) stripCrossOriginCredentials(headers)
  const sanitized: Record<string, string> = {}
  headers.forEach((value, name) => { sanitized[name] = value })
  return { ...sanitized, ...extra }
}

function mediaContentType(kind: ResourceKind, upstream: string | null): string {
  if (upstream && /(?:text\/html|javascript|x-msdownload|x-dosexec|x-sh|x-executable)/i.test(upstream)) {
    throw new AppError('UNSAFE_MEDIA', '上游返回了网页、脚本或可执行文件，已拒绝作为视频播放')
  }
  if (kind === 'key') return 'application/octet-stream'
  if (kind === 'map') return 'video/mp4'
  if (upstream && /^(?:video|audio)\/[a-z0-9.+-]+(?:\s*;.*)?$/i.test(upstream)) return upstream
  return 'video/mp2t'
}

function parseBandwidth(line: string): number {
  const match = /(?:^|[:,])BANDWIDTH=(\d+)/i.exec(line)
  return match ? Number(match[1]) : 0
}

function attribute(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|,)${name}=(?:"([^"]+)"|'([^']+)'|([^,]+))`, 'i').exec(line)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function byterangeToHeader(value: string, priorEnd: number): { header: string; end: number } | undefined {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim())
  if (!match) return undefined
  const length = Number(match[1])
  const start = match[2] ? Number(match[2]) : priorEnd
  if (!Number.isSafeInteger(length) || !Number.isSafeInteger(start) || length <= 0 || start < 0) return undefined
  return { header: `bytes=${start}-${start + length - 1}`, end: start + length }
}

export class HlsProxyServer {
  private server: Server | undefined
  private port = 0
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private readonly sessions = new Map<string, ProxySession>()
  private readonly inflight = new Map<string, Promise<BufferedResponse>>()
  private readonly cache = new ByteLru(128 * 1024 * 1024)

  private readonly rendererOrigin: string

  constructor(private readonly storage: AppStorage, rendererUrl?: string) {
    this.rendererOrigin = rendererUrl ? new URL(rendererUrl).origin : 'null'
  }

  async start(): Promise<number> {
    if (this.server) return this.port
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
    this.port = (this.server.address() as AddressInfo).port
    this.cleanupTimer = setInterval(() => this.expireSessions(), 60_000)
    this.cleanupTimer.unref()
    return this.port
  }

  register(extracted: ExtractedStream): StreamResolution {
    return this.registerWithBase(extracted, (id) => `http://127.0.0.1:${this.port}/proxy/${id}`)
  }

  /** 供局域网客户端使用：入口 URL 指向 LAN 地址，清单内的子资源同样走 LAN。 */
  registerLan(extracted: ExtractedStream, origin: string): StreamResolution {
    return this.registerWithBase(extracted, (id) => `${origin}/lan/m/${id}`)
  }

  private registerWithBase(extracted: ExtractedStream, baseFor: (id: string) => string): StreamResolution {
    if (!this.server || !this.port) throw new AppError('PROXY_NOT_STARTED', '本地媒体代理尚未启动')
    parseRemoteUrl(extracted.url)
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0]
      if (oldest) this.release(oldest.id)
    }
    const settings = this.storage.getSettings()
    this.cache.setLimit(settings.proxyCacheMegabytes * 1024 * 1024)
    const id = randomUUID()
    const session: ProxySession = {
      id,
      sourceUrl: extracted.url,
      mediaType: extracted.mediaType,
      headers: { ...extracted.headers },
      resources: new Map(),
      dedupe: new Map(),
      orderedSegments: [],
      lastAccess: Date.now(),
      prefetchCount: settings.proxyPrefetchCount,
      prefetchConcurrency: 4,
      prefetchActive: 0,
      prefetchQueue: [],
      prefetchQueued: new Set(),
      abort: new AbortController()
    }
    this.sessions.set(id, session)
    const path = extracted.mediaType === 'hls' ? 'master.m3u8' : 'media'
    const localUrl = `${baseFor(id)}/${path}`
    return {
      sessionId: id,
      localUrl,
      localProxyM3u8: localUrl,
      proxyUrl: localUrl,
      mediaType: extracted.mediaType,
      extractedBy: extracted.extractedBy,
      fromCache: extracted.fromCache
    }
  }

  release(sessionId: string): void {
    this.sessions.get(sessionId)?.abort.abort()
    this.sessions.delete(sessionId)
    this.cache.deletePrefix(`${sessionId}:`)
    for (const key of this.inflight.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.inflight.delete(key)
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
    for (const id of this.sessions.keys()) this.release(id)
    this.cache.clear()
    this.inflight.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.port = 0
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress) || req.headers.host !== `127.0.0.1:${this.port}` ||
      !cors(req, res, this.rendererOrigin)) { res.writeHead(403).end(); return }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }

    try {
      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      if (requestUrl.origin !== `http://127.0.0.1:${this.port}`) { res.writeHead(403).end(); return }
      const match = /^\/proxy\/([^/]+)\/(master\.m3u8|media|r\/([^/]+))$/.exec(requestUrl.pathname)
      if (!match) { res.writeHead(404).end(); return }
      const sessionId = match[1]
      if (!sessionId) { res.writeHead(404).end(); return }
      const session = this.sessions.get(sessionId)
      if (!session) { res.writeHead(404).end('Session expired'); return }
      session.lastAccess = Date.now()
      const base = `http://127.0.0.1:${this.port}/proxy/${session.id}`

      if (match[2] === 'master.m3u8') {
        if (session.mediaType !== 'hls') throw new AppError('BAD_PROXY_REQUEST', '该会话不是 HLS')
        await this.serveManifest(session, session.sourceUrl, req, res, 0, base)
      } else if (match[2] === 'media') {
        if (session.mediaType !== 'mp4') throw new AppError('BAD_PROXY_REQUEST', '该会话不是 MP4')
        await this.serveMp4(session, req, res)
      } else {
        const resourceToken = match[3]
        if (!resourceToken) { res.writeHead(404).end(); return }
        const resource = session.resources.get(resourceToken)
        if (!resource) { res.writeHead(404).end('Resource expired'); return }
        if (resource.kind === 'manifest') await this.serveManifest(session, resource.url, req, res, resource.manifestDepth ?? 0, base)
        else await this.serveResource(session, resource, req, res)
      }
    } catch (error) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.writeHead(error instanceof AppError ? 502 : 500)
      }
      if (!res.writableEnded) res.end(errorMessage(error))
    }
  }

  /** 局域网媒体入口，返回 false 表示该路径不属于媒体路由。 */
  async handleLanMedia(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
    origin: string
  ): Promise<boolean> {
    const match = /^\/lan\/m\/([^/]+)\/(master\.m3u8|media|r\/([^/]+))$/.exec(requestUrl.pathname)
    if (!match) return false

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return true }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return true }

    const sessionId = match[1]
    if (!sessionId) { res.writeHead(404).end(); return true }
    const session = this.sessions.get(sessionId)
    if (!session) { res.writeHead(404).end('Session expired'); return true }
    session.lastAccess = Date.now()
    const base = `${origin}/lan/m/${session.id}`

    try {
      if (match[2] === 'master.m3u8') {
        if (session.mediaType !== 'hls') throw new AppError('BAD_PROXY_REQUEST', '该会话不是 HLS')
        await this.serveManifest(session, session.sourceUrl, req, res, 0, base)
      } else if (match[2] === 'media') {
        if (session.mediaType !== 'mp4') throw new AppError('BAD_PROXY_REQUEST', '该会话不是 MP4')
        await this.serveMp4(session, req, res)
      } else {
        const resourceToken = match[3]
        if (!resourceToken) { res.writeHead(404).end(); return true }
        const resource = session.resources.get(resourceToken)
        if (!resource) { res.writeHead(404).end('Resource expired'); return true }
        if (resource.kind === 'manifest') {
          await this.serveManifest(session, resource.url, req, res, resource.manifestDepth ?? 0, base)
        } else {
          await this.serveResource(session, resource, req, res)
        }
      }
    } catch (error) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.writeHead(error instanceof AppError ? 502 : 500)
      }
      if (!res.writableEnded) res.end(errorMessage(error))
    }
    return true
  }

  private async serveManifest(
    session: ProxySession,
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
    depth: number,
    base: string
  ): Promise<void> {
    if (depth > 4) throw new AppError('MANIFEST_NESTING', 'HLS 清单嵌套层级过深')
    const response = await safeFetch(url, {
      headers: upstreamHeaders(session, url, { accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain' }),
      signal: session.abort.signal
    }, { timeoutMs: 15_000 })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AppError('UPSTREAM_HTTP_ERROR', `HLS 清单请求失败（HTTP ${response.status}）`)
    }
    const finalUrl = response.url || url
    const source = (await readResponseBuffer(response, MAX_MANIFEST_BYTES)).toString('utf8').replace(/^\uFEFF/, '')
    if (!source.trimStart().startsWith('#EXTM3U')) throw new AppError('INVALID_MANIFEST', '上游响应不是有效 HLS 清单')
    const rewritten = this.rewriteManifest(session, source, finalUrl, depth, base)
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(rewritten))
    res.writeHead(200)
    if (req.method === 'HEAD') res.end()
    else res.end(rewritten)
  }

  private rewriteManifest(session: ProxySession, source: string, manifestUrl: string, depth: number, base: string): string {
    const lines = source.split(/\r?\n/)
    const variants: Array<{ infoIndex: number; uriIndex: number; bandwidth: number }> = []
    for (let index = 0; index < lines.length; index += 1) {
      const currentLine = lines[index]
      if (!currentLine?.startsWith('#EXT-X-STREAM-INF:')) continue
      let uriIndex = index + 1
      while (uriIndex < lines.length) {
        const candidateLine = lines[uriIndex]
        if (candidateLine?.trim() && !candidateLine.startsWith('#')) break
        uriIndex += 1
      }
      if (uriIndex < lines.length) variants.push({ infoIndex: index, uriIndex, bandwidth: parseBandwidth(currentLine) })
    }
    if (variants.length) return this.reduceMasterManifest(session, lines, variants, manifestUrl, depth, base)

    const output: string[] = []
    let pendingRange: string | undefined
    let priorRangeEnd = 0
    for (const original of lines) {
      const line = original.trim()
      if (!line) { output.push(original); continue }
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const parsed = byterangeToHeader(line.slice('#EXT-X-BYTERANGE:'.length), priorRangeEnd)
        if (parsed) { pendingRange = parsed.header; priorRangeEnd = parsed.end }
        output.push(original)
        continue
      }
      if (line.startsWith('#')) {
        output.push(this.rewriteTagUri(session, original, manifestUrl, depth, base))
        continue
      }
      const absolute = new URL(line, manifestUrl).toString()
      const index = session.orderedSegments.length
      const resource = this.addResource(session, absolute, 'segment', true, index, pendingRange)
      if (resource.index === index) session.orderedSegments.push(resource.token)
      pendingRange = undefined
      output.push(this.localResourceUrl(session, resource.token, base))
    }
    return output.join('\n')
  }

  private reduceMasterManifest(
    session: ProxySession,
    lines: string[],
    variants: Array<{ infoIndex: number; uriIndex: number; bandwidth: number }>,
    manifestUrl: string,
    depth: number,
    base: string
  ): string {
    const chosen = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0]
    if (!chosen) throw new AppError('INVALID_MANIFEST', '主清单没有可用码率')
    const infoLine = lines[chosen.infoIndex]
    const variantLine = lines[chosen.uriIndex]
    if (!infoLine || !variantLine) throw new AppError('INVALID_MANIFEST', '主清单码率条目不完整')
    const audioGroup = attribute(infoLine.slice(infoLine.indexOf(':') + 1), 'AUDIO')
    const subtitleGroup = attribute(infoLine.slice(infoLine.indexOf(':') + 1), 'SUBTITLES')
    const output = ['#EXTM3U']
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue
      const attrs = line.slice(line.indexOf(':') + 1)
      const type = attribute(attrs, 'TYPE')?.toUpperCase()
      const groupId = attribute(attrs, 'GROUP-ID')
      if ((type === 'AUDIO' && groupId === audioGroup) || (type === 'SUBTITLES' && groupId === subtitleGroup)) {
        output.push(this.rewriteTagUri(session, line, manifestUrl, depth, base))
      }
    }
    output.push(infoLine)
    const variantUrl = new URL(variantLine.trim(), manifestUrl).toString()
    const resource = this.addResource(session, variantUrl, 'manifest', true, undefined, undefined, depth + 1)
    output.push(this.localResourceUrl(session, resource.token, base))
    return output.join('\n')
  }

  private rewriteTagUri(session: ProxySession, line: string, manifestUrl: string, depth: number, base: string): string {
    const uriMatch = /URI=(?:"([^"]*)"|'([^']*)'|([^,]*))/i.exec(line)
    if (!uriMatch) return line
    const raw = uriMatch[1] ?? uriMatch[2] ?? uriMatch[3]
    if (!raw) return line
    const absolute = new URL(raw, manifestUrl).toString()
    let kind: ResourceKind = 'manifest'
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) kind = 'key'
    else if (line.startsWith('#EXT-X-MAP')) kind = 'map'
    else if (line.startsWith('#EXT-X-PART') || line.startsWith('#EXT-X-PRELOAD-HINT')) kind = 'segment'
    const resource = this.addResource(session, absolute, kind, true, undefined, undefined, kind === 'manifest' ? depth + 1 : undefined)
    if (kind === 'segment' && resource.index === undefined) {
      resource.index = session.orderedSegments.length
      session.orderedSegments.push(resource.token)
    }
    return line.replace(uriMatch[0], `URI="${this.localResourceUrl(session, resource.token, base)}"`)
  }

  private addResource(
    session: ProxySession,
    url: string,
    kind: ResourceKind,
    dedupe: boolean,
    index?: number,
    rangeHeader?: string,
    manifestDepth?: number
  ): ProxyResource {
    parseRemoteUrl(url)
    const dedupeKey = `${kind}:${url}:${rangeHeader ?? ''}:${manifestDepth ?? ''}`
    if (dedupe) {
      const existingToken = session.dedupe.get(dedupeKey)
      const existing = existingToken ? session.resources.get(existingToken) : undefined
      if (existing) return existing
    }
    if (session.resources.size >= MAX_RESOURCES_PER_SESSION) throw new AppError('RESOURCE_LIMIT', '视频清单包含过多资源')
    const resource: ProxyResource = { token: token(), url, kind, index, rangeHeader, manifestDepth }
    session.resources.set(resource.token, resource)
    if (dedupe) session.dedupe.set(dedupeKey, resource.token)
    return resource
  }

  private localResourceUrl(session: ProxySession, resourceToken: string, base: string): string {
    return `${base}/r/${resourceToken}`
  }

  private async serveResource(
    session: ProxySession,
    resource: ProxyResource,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const range = typeof req.headers.range === 'string' ? req.headers.range : resource.rangeHeader
    const buffered = await this.getBuffered(session, resource, range)
    res.setHeader('Content-Type', buffered.contentType)
    res.setHeader('Content-Length', buffered.body.byteLength)
    if (buffered.contentRange) res.setHeader('Content-Range', buffered.contentRange)
    if (buffered.acceptRanges) res.setHeader('Accept-Ranges', buffered.acceptRanges)
    res.writeHead(buffered.status)
    if (req.method === 'HEAD') res.end()
    else res.end(buffered.body)
    if (resource.kind === 'segment' && resource.index !== undefined) this.schedulePrefetch(session, resource.index)
  }

  private async getBuffered(
    session: ProxySession,
    resource: ProxyResource,
    range?: string
  ): Promise<BufferedResponse> {
    const key = `${session.id}:${resource.token}:${range ?? ''}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const existing = this.inflight.get(key)
    if (existing) return existing
    if (this.inflight.size >= MAX_INFLIGHT_RESOURCES) throw new AppError('PROXY_BUSY', '视频资源请求过多，请稍后重试')

    const task = this.downloadBuffered(session, resource, range).then((value) => {
      if (this.sessions.get(session.id) === session) this.cache.set(key, value)
      return value
    }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  private async downloadBuffered(
    session: ProxySession,
    resource: ProxyResource,
    range?: string,
    retry = true
  ): Promise<BufferedResponse> {
    const extra: Record<string, string> = {}
    if (range) extra.range = range
    let response = await safeFetch(resource.url, {
      headers: upstreamHeaders(session, resource.url, extra), signal: session.abort.signal
    }, { timeoutMs: 25_000 })
    if (retry && (response.status === 429 || response.status === 503)) {
      await response.body?.cancel()
      session.prefetchConcurrency = 2
      await new Promise((resolve) => setTimeout(resolve, 500))
      response = await safeFetch(resource.url, {
        headers: upstreamHeaders(session, resource.url, extra), signal: session.abort.signal
      }, { timeoutMs: 25_000 })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new AppError('UPSTREAM_HTTP_ERROR', `媒体资源请求失败（HTTP ${response.status}）`)
    }
    let contentType: string
    try { contentType = mediaContentType(resource.kind, response.headers.get('content-type')) }
    catch (error) { await response.body?.cancel(); throw error }
    const maxBytes = resource.kind === 'key' ? 16 * 1024 : MAX_RESOURCE_BYTES
    const body = await readResponseBuffer(response, maxBytes)
    return {
      body,
      status: response.status,
      contentType,
      contentRange: response.headers.get('content-range') ?? undefined,
      acceptRanges: response.headers.get('accept-ranges') ?? undefined
    }
  }

  private schedulePrefetch(session: ProxySession, currentIndex: number): void {
    for (let offset = 1; offset <= session.prefetchCount; offset += 1) {
      const resourceToken = session.orderedSegments[currentIndex + offset]
      if (!resourceToken || session.prefetchQueued.has(resourceToken)) continue
      const resource = session.resources.get(resourceToken)
      if (!resource) continue
      const key = `${session.id}:${resource.token}:${resource.rangeHeader ?? ''}`
      if (this.cache.get(key) || this.inflight.has(key)) continue
      session.prefetchQueued.add(resourceToken)
      session.prefetchQueue.push(resourceToken)
    }
    this.pumpPrefetch(session)
  }

  private pumpPrefetch(session: ProxySession): void {
    while (session.prefetchActive < session.prefetchConcurrency && session.prefetchQueue.length) {
      const resourceToken = session.prefetchQueue.shift()!
      const resource = session.resources.get(resourceToken)
      if (!resource) { session.prefetchQueued.delete(resourceToken); continue }
      session.prefetchActive += 1
      void this.getBuffered(session, resource, resource.rangeHeader).catch(() => undefined).finally(() => {
        session.prefetchActive -= 1
        session.prefetchQueued.delete(resourceToken)
        if (this.sessions.has(session.id)) this.pumpPrefetch(session)
      })
    }
  }

  private async serveMp4(session: ProxySession, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const extra: Record<string, string> = { accept: 'video/*,*/*' }
    if (typeof req.headers.range === 'string') extra.range = req.headers.range
    const response = await safeFetch(session.sourceUrl, {
      method: req.method,
      headers: upstreamHeaders(session, session.sourceUrl, extra), signal: session.abort.signal
    }, { timeoutMs: 30_000 })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel()
      throw new AppError('UPSTREAM_HTTP_ERROR', `MP4 请求失败（HTTP ${response.status}）`)
    }
    try { mediaContentType('map', response.headers.get('content-type')) }
    catch (error) { await response.body?.cancel(); throw error }
    res.setHeader('Content-Type', 'video/mp4')
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      copyHeader(response, res, name)
    }
    res.writeHead(response.status)
    if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); return }
    const stream = Readable.fromWeb(response.body as never)
    res.once('close', () => stream.destroy())
    stream.on('error', (error) => {
      if (!res.writableEnded) res.destroy(error)
    })
    stream.pipe(res)
  }

  private expireSessions(): void {
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const session of this.sessions.values()) {
      if (session.lastAccess < cutoff) this.release(session.id)
    }
  }
}

export const __testing = { ByteLru, parseBandwidth, attribute, byterangeToHeader, mediaContentType, upstreamHeaders }
