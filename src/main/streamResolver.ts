import { createHash } from 'node:crypto'
import type { SiteRule, UpstreamHeaders } from '../shared/types'
import type { ExtractedStream, StreamExtractor } from './streamExtractor'
import { parseRemoteUrl, readResponseText, safeFetch } from './urlSafety'

const CACHE_TTL_MS = 24 * 60 * 60_000
const MAX_CACHE_ENTRIES = 100
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024

export interface StreamCacheEntry {
  key: string
  siteId: string
  url: string
  mediaType: ExtractedStream['mediaType']
  extractedBy: ExtractedStream['extractedBy']
  headers: UpstreamHeaders
  createdAt: number
  expiresAt: number
}

interface CacheStorage {
  getStreamCache(): unknown
  saveStreamCache(entries: StreamCacheEntry[]): void
}

function cacheKey(pageUrl: string, rule: SiteRule): string {
  return createHash('sha256').update(JSON.stringify([
    rule.siteId, rule.baseUrl, pageUrl, rule.streamExtraction
  ])).digest('hex')
}

function readEntry(value: unknown): StreamCacheEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as Partial<StreamCacheEntry>
  const now = Date.now()
  if (
    typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key) ||
    typeof entry.siteId !== 'string' || entry.siteId.length > 80 ||
    typeof entry.url !== 'string' || entry.url.length > 8192 ||
    !['hls', 'mp4'].includes(entry.mediaType || '') ||
    !['static', 'sniffer'].includes(entry.extractedBy || '') ||
    !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt) ||
    entry.createdAt! > now || entry.expiresAt! <= now || entry.expiresAt! > entry.createdAt! + CACHE_TTL_MS ||
    !entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)
  ) return undefined
  try {
    parseRemoteUrl(entry.url)
    const headers = Object.entries(entry.headers)
    if (headers.length > 40 || headers.some(([name, item]) =>
      typeof item !== 'string' || item.length > 8192 ||
      !/^(?:user-agent|referer|origin|cookie|authorization|accept|accept-language|x-[a-z0-9-]+)$/i.test(name)
    )) return undefined
    if (JSON.stringify(entry.headers).length > 32_768) return undefined
    new Headers(entry.headers)
    return entry as StreamCacheEntry
  } catch { return undefined }
}

/** Stores upstream addresses independently of short-lived playback proxy sessions. */
export class StreamResolver {
  private readonly cache = new Map<string, StreamCacheEntry>()
  private readonly inflight = new Map<string, { task: Promise<ExtractedStream>; forced: boolean }>()

  constructor(private readonly storage: CacheStorage, private readonly extractor: Pick<StreamExtractor, 'resolve'>) {
    try {
      const saved = storage.getStreamCache()
      if (Array.isArray(saved)) {
        for (const value of saved.slice(-MAX_CACHE_ENTRIES)) {
          const entry = readEntry(value)
          if (entry) this.cache.set(entry.key, entry)
        }
      }
    } catch { /* Cache availability must not prevent playback. */ }
  }

  async resolve(pageUrlValue: string, rule: SiteRule, forceRefresh = false): Promise<ExtractedStream> {
    const pageUrl = parseRemoteUrl(pageUrlValue, rule.baseUrl)
    pageUrl.hash = ''
    const key = cacheKey(pageUrl.href, rule)
    const existing = this.inflight.get(key)
    if (existing) {
      if (!forceRefresh || existing.forced) return existing.task
      // A manual refresh must not inherit an older cache validation already in progress.
      await existing.task.catch(() => undefined)
      return this.resolve(pageUrlValue, rule, true)
    }
    if (forceRefresh && this.cache.delete(key)) this.persist()
    const task = this.resolveOnce(key, pageUrl.href, rule, forceRefresh)
    this.inflight.set(key, { task, forced: forceRefresh })
    try { return await task }
    finally { if (this.inflight.get(key)?.task === task) this.inflight.delete(key) }
  }

  removeSite(siteId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.siteId === siteId) this.cache.delete(key)
    }
    this.persist()
  }

  private async resolveOnce(key: string, pageUrl: string, rule: SiteRule, forceRefresh: boolean): Promise<ExtractedStream> {
    const cached = this.cache.get(key)
    if (!forceRefresh && cached && cached.expiresAt > Date.now() && await this.isPlayable(cached)) {
      return {
        url: cached.url, mediaType: cached.mediaType, extractedBy: cached.extractedBy,
        headers: { ...cached.headers }, fromCache: true
      }
    }
    if (this.cache.delete(key)) this.persist()
    const stream = await this.extractor.resolve(pageUrl, rule)
    const now = Date.now()
    const entry: StreamCacheEntry = {
      key, siteId: rule.siteId, url: stream.url, mediaType: stream.mediaType,
      extractedBy: stream.extractedBy, headers: { ...stream.headers },
      createdAt: now, expiresAt: now + CACHE_TTL_MS
    }
    if (readEntry(entry)) {
      this.cache.set(key, entry)
      this.persist()
    }
    return { ...stream, fromCache: false }
  }

  private async isPlayable(entry: StreamCacheEntry): Promise<boolean> {
    try {
      const response = await safeFetch(entry.url, {
        headers: {
          ...entry.headers,
          ...(entry.mediaType === 'mp4' ? { range: 'bytes=0-0' } : {})
        }
      }, { timeoutMs: 5000 })
      if (!response.ok) { await response.body?.cancel(); return false }
      if (entry.mediaType === 'hls') {
        const manifest = await readResponseText(response, MAX_MANIFEST_BYTES)
        return manifest.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')
      }
      const contentType = response.headers.get('content-type') || ''
      await response.body?.cancel()
      return /^(?:video\/mp4|video\/x-m4v|application\/octet-stream)(?:;|$)/i.test(contentType)
    } catch { return false }
  }

  private persist(): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= Date.now()) this.cache.delete(key)
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
    try { this.storage.saveStreamCache([...this.cache.values()]) }
    catch { /* Encryption or disk errors leave the in-memory cache available. */ }
  }
}
