import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeSeriesId } from './storage'
import type { AppStorage } from './storage'
import type { VodService } from './vodService'
import type { StreamResolver } from './streamResolver'
import type { HlsProxyServer } from './hlsProxyServer'
import { AppError, errorMessage } from './errors'
import { isPrivateAddress } from './lanAddress'
import { isPrivateIp, parseRemoteUrl, readResponseBuffer, safeFetch } from './urlSafety'
import {
  discoverDlnaDevices,
  getDlnaPosition,
  pauseDlnaDevice,
  playOnDlnaDevice,
  resumeDlnaDevice,
  seekDlnaDevice,
  stopDlnaDevice
} from './dlna'
import type { DlnaDevice } from './dlna'
import { LAN_PROTOCOL_VERSION } from '../shared/lanProtocol'

const MAX_REQUESTS_PER_MINUTE = 240
const MAX_DETAIL_URL_LENGTH = 8192
const MAX_BODY_BYTES = 32 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_CACHE_ENTRIES = 64
const IMAGE_CACHE_TTL_MS = 10 * 60_000
const IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp'
])

interface CachedImage {
  body: Buffer
  contentType: string
  storedAt: number
}

export interface LanMediaBridge {
  resolver: Pick<StreamResolver, 'resolve'> & { removeSite?: (siteId: string) => void }
  proxy: Pick<HlsProxyServer, 'registerLan' | 'handleLanMedia'>
}

interface RateBucket {
  count: number
  resetAt: number
}

export class LanServer {
  private server: Server | undefined
  private boundPort = 0
  private startError = ''
  private readonly buckets = new Map<string, RateBucket>()
  private readonly imageCache = new Map<string, CachedImage>()
  private dlnaCache: { at: number; devices: DlnaDevice[] } = { at: 0, devices: [] }

  constructor(
    private readonly storage: AppStorage,
    private readonly vod: VodService,
    private readonly appVersion: string,
    private readonly media?: LanMediaBridge
  ) {}

  get running(): boolean {
    return this.server !== undefined
  }

  get port(): number {
    return this.boundPort
  }

  get error(): string {
    return this.startError
  }

  async start(port: number, bindAddress = '0.0.0.0'): Promise<void> {
    if (this.server) {
      return
    }
    this.startError = ''
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, bindAddress, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.startError = errorMessage(error)
      try {
        server.close()
      } catch {
        // 端口占用时关闭失败不影响后续重试
      }
      return
    }
    server.on('error', (error) => {
      this.startError = errorMessage(error)
    })
    this.server = server
    const address = server.address() as AddressInfo | null
    this.boundPort = address?.port ?? port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.boundPort = 0
    this.startError = ''
    this.buckets.clear()
    if (!server) {
      return
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'")

    const remote = request.socket.remoteAddress
    if (!isPrivateAddress(remote)) {
      this.sendError(response, 403, 'FORBIDDEN', '仅允许局域网设备访问')
      return
    }
    if (request.headers.origin) {
      this.sendError(response, 403, 'FORBIDDEN', '不允许来自浏览器的跨站请求')
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    try {
      if (url.pathname.startsWith('/lan/m/')) {
        if (!this.media) {
          throw new AppError('LAN_MEDIA_UNAVAILABLE', '媒体服务未启用')
        }
        const handled = await this.media.proxy.handleLanMedia(
          request,
          response,
          url,
          this.origin(request)
        )
        if (!handled) {
          this.sendError(response, 404, 'NOT_FOUND', '媒体路径不存在')
        }
        return
      }

      if (!this.allow(remote ?? '')) {
        this.sendError(response, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试')
        return
      }
      const method = request.method ?? 'GET'
      if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method)) {
        this.sendError(response, 405, 'METHOD_NOT_ALLOWED', '当前接口不支持该请求方法')
        return
      }

      await this.route(url, request, response)
    } catch (error) {
      this.sendError(
        response,
        statusForError(error),
        error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        errorMessage(error)
      )
    }
  }

  private async route(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const path = url.pathname
    if (path === '/api/v1/info') {
      if (!this.allowMethods(request, response, 'GET')) return
      const settings = this.storage.getSettings()
      this.send(response, request, 200, {
        name: settings.deviceName,
        appVersion: this.appVersion,
        protocol: LAN_PROTOCOL_VERSION,
        auth: 'none'
      })
      return
    }
    if (path === '/api/v1/health') {
      if (!this.allowMethods(request, response, 'GET')) return
      this.send(response, request, 200, { status: 'ok', protocol: LAN_PROTOCOL_VERSION })
      return
    }
    if (path === '/api/v1/favorites') {
      if (request.method === 'POST') {
        const saved = this.storage.addFavorite(await this.readJson(request))
        this.send(response, request, 200, saved)
        return
      }
      if (!this.allowMethods(request, response, 'GET')) return
      this.send(response, request, 200, this.storage.listFavorites())
      return
    }
    const favoriteMatch = /^\/api\/v1\/favorites\/([^/]+)$/.exec(path)
    if (favoriteMatch) {
      if (!this.allowMethods(request, response, 'DELETE')) return
      const favoriteId = decodeSegment(favoriteMatch[1])
      this.storage.removeFavorite(favoriteId)
      this.send(response, request, 200, { favoriteId, removed: true })
      return
    }
    if (path === '/api/v1/sites') {
      if (!this.allowMethods(request, response, 'GET')) return
      this.send(
        response,
        request,
        200,
        this.storage.listRules().map((rule) => ({ siteId: rule.siteId, siteName: rule.siteName }))
      )
      return
    }
    if (path === '/api/v1/search') {
      if (!this.allowMethods(request, response, 'GET')) return
      const keyword = (url.searchParams.get('keyword') ?? '').trim()
      const siteId = url.searchParams.get('siteId') ?? undefined
      const results = await this.vod.search({ keyword, siteId })
      this.send(response, request, 200, results)
      return
    }
    if (path === '/api/v1/detail') {
      if (!this.allowMethods(request, response, 'GET')) return
      const siteId = url.searchParams.get('siteId') ?? ''
      const detailUrl = url.searchParams.get('detailUrl') ?? ''
      if (detailUrl.length > MAX_DETAIL_URL_LENGTH) {
        throw new AppError('INVALID_ARGUMENT', '详情地址过长')
      }
      const detail = await this.vod.detail({ siteId, detailUrl })
      this.send(response, request, 200, detail)
      return
    }
    if (path === '/api/v1/history') {
      if (!this.allowMethods(request, response, 'GET')) return
      const seriesId = (url.searchParams.get('seriesId') ?? '').trim()
      const siteId = (url.searchParams.get('siteId') ?? '').trim()
      const detailUrl = (url.searchParams.get('detailUrl') ?? '').trim()
      if (seriesId) {
        this.send(response, request, 200, this.storage.getHistory(seriesId))
        return
      }
      if (siteId && detailUrl) {
        this.send(response, request, 200, this.storage.getHistory(makeSeriesId(siteId, detailUrl)))
        return
      }
      this.send(response, request, 200, this.storage.listHistory())
      return
    }
    if (path === '/api/v1/progress') {
      if (!this.allowMethods(request, response, 'POST')) return
      const body = await this.readJson(request)
      const siteId = bodyString(body.siteId, '站点 ID', 80)
      const detailUrl = bodyString(body.detailUrl, '详情地址', MAX_DETAIL_URL_LENGTH)
      const episodeUrl = bodyString(body.episodeUrl, '播放页地址', MAX_DETAIL_URL_LENGTH)
      const seriesId = body.seriesId === undefined || body.seriesId === ''
        ? makeSeriesId(siteId, detailUrl)
        : bodyString(body.seriesId, '剧集 ID', 128)
      const clientUpdatedAt = typeof body.updatedAt === 'number' && Number.isFinite(body.updatedAt)
        ? body.updatedAt
        : undefined
      const existing = this.storage.getHistory(seriesId)
      const previousEpisode = existing?.episodes?.[episodeUrl]
      if (clientUpdatedAt !== undefined && previousEpisode && previousEpisode.updatedAt > clientUpdatedAt) {
        this.send(response, request, 200, existing)
        return
      }
      this.send(
        response,
        request,
        200,
        this.storage.saveProgress({ ...body, seriesId })
      )
      return
    }
    if (path === '/api/v1/rules') {
      if (!this.allowMethods(request, response, 'GET')) return
      this.send(response, request, 200, this.storage.listRules())
      return
    }
    const ruleMatch = /^\/api\/v1\/rules\/([^/]+)$/.exec(path)
    if (ruleMatch) {
      const siteId = decodeSegment(ruleMatch[1])
      if (request.method === 'PUT') {
        const body = await this.readJson(request)
        const saved = this.storage.saveRule({ ...body, siteId })
        this.media?.resolver.removeSite?.(saved.siteId)
        this.send(response, request, 200, saved)
        return
      }
      if (request.method === 'DELETE') {
        this.storage.removeRule(siteId)
        this.media?.resolver.removeSite?.(siteId)
        this.send(response, request, 200, { siteId, removed: true })
        return
      }
      if (!this.allowMethods(request, response, 'GET')) return
      const rule = this.storage.getRule(siteId)
      if (!rule) {
        throw new AppError('RULE_NOT_FOUND', `找不到站点规则：${siteId}`)
      }
      this.send(response, request, 200, rule)
      return
    }
    if (path === '/api/v1/image') {
      if (!this.allowMethods(request, response, 'GET')) return
      const raw = (url.searchParams.get('url') ?? url.searchParams.get('u') ?? '').trim()
      if (!raw) {
        throw new AppError('INVALID_ARGUMENT', '缺少图片地址')
      }
      if (raw.length > MAX_DETAIL_URL_LENGTH) {
        throw new AppError('INVALID_ARGUMENT', '图片地址过长')
      }
      await this.serveImage(request, response, parseRemoteUrl(raw))
      return
    }
    if (path === '/api/v1/stream/resolve') {
      if (!this.allowMethods(request, response, 'POST')) return
      if (!this.media) {
        throw new AppError('LAN_MEDIA_UNAVAILABLE', '媒体服务未启用')
      }
      const body = await this.readJson(request)
      const siteId = bodyString(body.siteId, '站点 ID', 80)
      const playPageUrl = bodyString(body.playPageUrl, '播放页地址', MAX_DETAIL_URL_LENGTH)
      const rule = this.storage.getRule(siteId)
      if (!rule) {
        throw new AppError('RULE_NOT_FOUND', `找不到站点规则：${siteId}`)
      }
      const extracted = await this.media.resolver.resolve(playPageUrl, rule, body.forceRefresh === true)
      const resolution = this.media.proxy.registerLan(extracted, this.origin(request))
      this.send(response, request, 200, resolution)
      return
    }
    if (path === '/api/v1/dlna/devices') {
      if (!this.allowMethods(request, response, 'GET')) return
      const devices = await this.listDlnaDevices()
      this.send(
        response,
        request,
        200,
        devices.map((device) => ({
          id: device.id,
          name: device.name,
          model: device.model
        }))
      )
      return
    }
    if (path === '/api/v1/dlna/cast') {
      if (!this.allowMethods(request, response, 'POST')) return
      const body = await this.readJson(request)
      const deviceId = bodyString(body.deviceId, '电视设备 ID', 512)
      const mediaUrl = bodyString(body.url, '播放地址', MAX_DETAIL_URL_LENGTH)
      this.assertCastUrl(mediaUrl)
      const device = await this.findDlnaDevice(deviceId)
      const title = typeof body.title === 'string' ? body.title.slice(0, 200) : 'VeloReel'
      await playOnDlnaDevice(device, mediaUrl, title)
      this.send(response, request, 200, { deviceId: device.id, casting: true })
      return
    }
    if (path === '/api/v1/dlna/stop') {
      if (!this.allowMethods(request, response, 'POST')) return
      const body = await this.readJson(request)
      const deviceId = bodyString(body.deviceId, '电视设备 ID', 512)
      await stopDlnaDevice(await this.findDlnaDevice(deviceId))
      this.send(response, request, 200, { deviceId, stopped: true })
      return
    }
    if (path === '/api/v1/dlna/position') {
      if (!this.allowMethods(request, response, 'GET')) return
      const deviceId = (url.searchParams.get('deviceId') ?? '').trim()
      if (!deviceId) {
        throw new AppError('INVALID_ARGUMENT', '缺少电视设备 ID')
      }
      const position = await getDlnaPosition(await this.findDlnaDevice(deviceId))
      this.send(response, request, 200, position)
      return
    }
    if (path === '/api/v1/dlna/control') {
      if (!this.allowMethods(request, response, 'POST')) return
      const body = await this.readJson(request)
      const deviceId = bodyString(body.deviceId, '电视设备 ID', 512)
      const action = bodyString(body.action, '控制动作', 32)
      const device = await this.findDlnaDevice(deviceId)
      if (action === 'pause') {
        await pauseDlnaDevice(device)
      } else if (action === 'play') {
        await resumeDlnaDevice(device)
      } else if (action === 'seek') {
        const positionMs = typeof body.positionMs === 'number' && Number.isFinite(body.positionMs)
          ? Math.max(0, Math.floor(body.positionMs))
          : -1
        if (positionMs < 0) {
          throw new AppError('INVALID_ARGUMENT', 'seek 动作需要 positionMs 参数')
        }
        await seekDlnaDevice(device, positionMs)
      } else {
        throw new AppError('INVALID_ARGUMENT', '不支持的控制动作')
      }
      this.send(response, request, 200, { deviceId, action, ok: true })
      return
    }
    this.sendError(response, 404, 'NOT_FOUND', '接口不存在')
  }

  /** 发现结果缓存 60 秒，避免每次打开投屏面板都重新搜索。 */
  private async listDlnaDevices(force = false): Promise<DlnaDevice[]> {
    const fresh = Date.now() - this.dlnaCache.at < 60_000
    if (!force && fresh && this.dlnaCache.devices.length > 0) {
      return this.dlnaCache.devices
    }
    const devices = await discoverDlnaDevices()
    this.dlnaCache = { at: Date.now(), devices }
    return devices
  }

  private async findDlnaDevice(deviceId: string): Promise<DlnaDevice> {
    let devices = await this.listDlnaDevices()
    let device = devices.find((item) => item.id === deviceId)
    if (!device) {
      devices = await this.listDlnaDevices(true)
      device = devices.find((item) => item.id === deviceId)
    }
    if (!device) {
      throw new AppError('DLNA_NOT_FOUND', '找不到该电视，请重新搜索')
    }
    return device
  }

  /** 只允许把本机媒体代理地址投给电视，避免被当作任意地址转发器。 */
  private assertCastUrl(raw: string): void {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new AppError('INVALID_URL', '播放地址格式无效')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError('UNSAFE_URL', '只允许投屏 HTTP 或 HTTPS 地址')
    }
    if (!parsed.pathname.startsWith('/lan/m/')) {
      throw new AppError('UNSAFE_URL', '只能投屏本机媒体地址')
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    if (!isPrivateIp(host)) {
      throw new AppError('UNSAFE_URL', '媒体地址不在局域网内')
    }
  }

  private allowMethods(
    request: IncomingMessage,
    response: ServerResponse,
    ...methods: string[]
  ): boolean {
    const method = request.method === 'HEAD' ? 'GET' : request.method ?? 'GET'
    if (methods.includes(method)) {
      return true
    }
    this.sendError(response, 405, 'METHOD_NOT_ALLOWED', '当前接口不支持该请求方法')
    return false
  }

  private async serveImage(
    request: IncomingMessage,
    response: ServerResponse,
    imageUrl: URL
  ): Promise<void> {
    const key = imageUrl.href
    const cached = this.imageCache.get(key)
    if (cached && Date.now() - cached.storedAt < IMAGE_CACHE_TTL_MS) {
      this.imageCache.delete(key)
      this.imageCache.set(key, cached)
      this.sendImage(request, response, cached)
      return
    }
    if (cached) {
      this.imageCache.delete(key)
    }

    const upstream = await safeFetch(imageUrl, {
      headers: {
        accept: 'image/*,*/*;q=0.8',
        referer: `${imageUrl.origin}/`
      }
    }, { timeoutMs: 10_000 })
    if (!upstream.ok) {
      await upstream.body?.cancel()
      throw new AppError('UPSTREAM_HTTP_ERROR', `封面请求失败（HTTP ${upstream.status}）`)
    }
    const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!IMAGE_CONTENT_TYPES.has(contentType)) {
      await upstream.body?.cancel()
      throw new AppError('UNSUPPORTED_IMAGE', '上游返回的不是受支持的图片格式')
    }
    const image: CachedImage = {
      body: await readResponseBuffer(upstream, MAX_IMAGE_BYTES),
      contentType,
      storedAt: Date.now()
    }
    this.imageCache.set(key, image)
    while (this.imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
      const oldest = this.imageCache.keys().next().value
      if (oldest === undefined) break
      this.imageCache.delete(oldest)
    }
    this.sendImage(request, response, image)
  }

  private sendImage(
    request: IncomingMessage,
    response: ServerResponse,
    image: CachedImage
  ): void {
    response.setHeader('Content-Type', image.contentType)
    response.setHeader('Content-Length', image.body.byteLength)
    response.setHeader('Cache-Control', 'private, max-age=600')
    response.writeHead(200)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(image.body)
  }

  /** 采用请求来源作为媒体地址，避免 Host 头被用来生成指向其他主机的 URL。 */
  private origin(request: IncomingMessage): string {
    const host = request.headers.host ?? ''
    const match = /^(\[[0-9a-fA-F:.]+\]|[0-9a-zA-Z.-]+)(?::(\d{1,5}))?$/.exec(host)
    const hostname = match?.[1]?.replace(/^\[|\]$/g, '')
    const port = match?.[2] ? Number(match[2]) : 80
    if (match && hostname && port === this.boundPort && isPrivateAddress(hostname)) {
      return `http://${match[1]}:${this.boundPort}`
    }
    const remote = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const fallbackHost = remote.includes(':') ? `[${remote}]` : remote
    return `http://${fallbackHost}:${this.boundPort}`
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        throw new AppError('INVALID_ARGUMENT', '请求体过大')
      }
      chunks.push(buffer)
    }
    if (chunks.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '请求体不能为空')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new AppError('INVALID_ARGUMENT', '请求体不是有效 JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('INVALID_ARGUMENT', '请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  }

  private allow(remote: string): boolean {
    const now = Date.now()
    if (this.buckets.size > 512) {
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) {
          this.buckets.delete(key)
        }
      }
    }
    const bucket = this.buckets.get(remote)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(remote, { count: 1, resetAt: now + 60_000 })
      return true
    }
    bucket.count += 1
    return bucket.count <= MAX_REQUESTS_PER_MINUTE
  }

  private send(
    response: ServerResponse,
    request: IncomingMessage,
    status: number,
    payload: unknown
  ): void {
    const body = JSON.stringify(payload)
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Length', Buffer.byteLength(body))
    response.writeHead(status)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(body)
  }

  private sendError(
    response: ServerResponse,
    status: number,
    code: string,
    message: string
  ): void {
    const body = JSON.stringify({ error: { code, message } })
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Length', Buffer.byteLength(body))
    response.writeHead(status)
    response.end(body)
  }
}

function statusForError(error: unknown): number {
  const code = error instanceof AppError ? error.code : ''
  if (
    code === 'INVALID_ARGUMENT' ||
    code === 'INVALID_RULE' ||
    code === 'INVALID_URL' ||
    code === 'UNSAFE_URL'
  ) {
    return 400
  }
  if (code === 'RULE_NOT_FOUND' || code === 'NO_SITE_RULES' || code === 'DLNA_NOT_FOUND') {
    return 404
  }
  if (code === 'LAN_MEDIA_UNAVAILABLE') {
    return 503
  }
  if (code === 'UNSUPPORTED_IMAGE') {
    return 415
  }
  return 502
}

function decodeSegment(value: string | undefined): string {
  if (!value) {
    throw new AppError('INVALID_ARGUMENT', '路径参数不能为空')
  }
  try {
    return decodeURIComponent(value)
  } catch {
    throw new AppError('INVALID_ARGUMENT', '路径参数编码无效')
  }
}

function bodyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('INVALID_ARGUMENT', `${label}不能为空`)
  }
  if (value.length > maxLength) {
    throw new AppError('INVALID_ARGUMENT', `${label}过长`)
  }
  return value
}
