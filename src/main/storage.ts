import { createHash } from 'node:crypto'
import { safeStorage } from 'electron'
import Store from 'electron-store'
import type {
  AppSettings,
  FavoriteItem,
  ProgressPayload,
  SeriesHistoryItem,
  SiteRule
} from '../shared/types'
import { AppError } from './errors'
import { assertFavoriteInput, assertProgressPayload, assertSiteRule, sanitizeSettings } from './validation'
import type { StreamCacheEntry } from './streamResolver'

interface StoreSchema {
  rules: Record<string, SiteRule>
  history: Record<string, SeriesHistoryItem>
  favorites: Record<string, FavoriteItem>
  settings: AppSettings
  llmApiKeyCipher: string
  streamCacheCipher: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  llmApiBaseUrl: 'https://api.openai.com/v1',
  llmModel: 'gpt-4.1-mini',
  llmApiType: 'chat_completions',
  llmHttpHeaders: {},
  llmStoreResponses: false,
  skipIntroSeconds: 0,
  skipOutroSeconds: 0,
  autoPlayNext: true,
  proxyPrefetchCount: 4,
  proxyCacheMegabytes: 128,
  lanEnabled: false,
  lanPort: 8790,
  deviceName: '影梭'
}

export function makeSeriesId(siteId: string, detailUrl: string): string {
  return createHash('sha256').update(`${siteId}\0${detailUrl}`).digest('hex').slice(0, 32)
}

export class AppStorage {
  private readonly store: Store<StoreSchema>
  private history: Record<string, SeriesHistoryItem>
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'stream-player',
      clearInvalidConfig: true,
      defaults: {
        rules: {},
        history: {},
        favorites: {},
        settings: DEFAULT_SETTINGS,
        llmApiKeyCipher: '',
        streamCacheCipher: ''
      }
    })
    this.history = this.store.get('history', {})
  }

  listRules(): SiteRule[] {
    return Object.values(this.store.get('rules', {})).sort((a, b) =>
      a.siteName.localeCompare(b.siteName, 'zh-CN')
    )
  }

  getRule(siteId: string): SiteRule | undefined {
    return this.store.get('rules', {})[siteId]
  }

  saveRule(input: unknown): SiteRule {
    const rule = assertSiteRule(input)
    const existing = this.getRule(rule.siteId)
    const now = Date.now()
    const saved: SiteRule = {
      ...rule,
      createdAt: existing?.createdAt ?? rule.createdAt ?? now,
      updatedAt: now
    }
    this.store.set(`rules.${rule.siteId}`, saved)
    return saved
  }

  removeRule(siteId: string): void {
    const rules = this.store.get('rules', {})
    if (rules[siteId]) {
      delete rules[siteId]
      this.store.set('rules', rules)
    }
  }

  listHistory(): SeriesHistoryItem[] {
    return Object.values(this.history).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getHistory(seriesId: string): SeriesHistoryItem | null {
    return this.history[seriesId] ?? null
  }

  saveProgress(input: unknown): SeriesHistoryItem {
    const payload = assertProgressPayload(input)
    const seriesId = payload.seriesId ?? makeSeriesId(payload.siteId, payload.detailUrl)
    const now = Date.now()
    const previous = this.history[seriesId]
    const finished = payload.isFinished === true || (
      payload.duration > 0 && payload.currentTime / payload.duration >= 0.95
    )
    const episode = {
      episodeUrl: payload.episodeUrl,
      episodeName: payload.episodeName,
      currentTime: payload.currentTime,
      duration: payload.duration,
      isFinished: finished,
      updatedAt: now
    }
    const item: SeriesHistoryItem = {
      seriesId,
      siteId: payload.siteId,
      title: payload.title,
      coverUrl: payload.coverUrl,
      detailUrl: payload.detailUrl,
      lastEpisodeUrl: payload.episodeUrl,
      lastEpisodeName: payload.episodeName,
      lastCurrentTime: payload.currentTime,
      lastDuration: payload.duration,
      updatedAt: now,
      episodes: { ...(previous?.episodes ?? {}), [payload.episodeUrl]: episode }
    }
    this.history[seriesId] = item
    this.scheduleHistoryFlush()
    return item
  }

  removeHistory(seriesId: string): void {
    delete this.history[seriesId]
    this.flush()
  }

  clearHistory(): void {
    this.history = {}
    this.flush()
  }

  listFavorites(): FavoriteItem[] {
    return Object.values(this.store.get('favorites', {})).sort((a, b) => b.createdAt - a.createdAt)
  }

  addFavorite(input: unknown): FavoriteItem {
    const payload = assertFavoriteInput(input)
    const favoriteId = makeSeriesId(payload.siteId, payload.detailUrl)
    const favorites = this.store.get('favorites', {})
    const previous = favorites[favoriteId]
    const item: FavoriteItem = {
      ...payload,
      siteName: payload.siteName || this.getRule(payload.siteId)?.siteName || previous?.siteName || payload.siteId,
      coverUrl: payload.coverUrl || previous?.coverUrl || '',
      favoriteId,
      createdAt: previous?.createdAt ?? Date.now()
    }
    this.store.set('favorites', { ...favorites, [favoriteId]: item })
    return item
  }

  removeFavorite(favoriteId: string): void {
    const favorites = { ...this.store.get('favorites', {}) }
    delete favorites[favoriteId]
    this.store.set('favorites', favorites)
  }

  getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.store.get('settings', DEFAULT_SETTINGS) }
  }

  saveSettings(input: Partial<AppSettings>): AppSettings {
    const next = sanitizeSettings(input, this.getSettings())
    this.store.set('settings', next)
    return next
  }

  saveApiKey(apiKey: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppError('ENCRYPTION_UNAVAILABLE', '系统安全存储不可用，API Key 未保存')
    }
    const cipher = safeStorage.encryptString(apiKey).toString('base64')
    this.store.set('llmApiKeyCipher', cipher)
  }

  getApiKey(): string | undefined {
    const cipher = this.store.get('llmApiKeyCipher', '')
    if (!cipher || !safeStorage.isEncryptionAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch {
      return undefined
    }
  }

  hasApiKey(): boolean {
    return Boolean(this.getApiKey())
  }

  clearApiKey(): void {
    this.store.set('llmApiKeyCipher', '')
  }

  getStreamCache(): unknown {
    const cipher = this.store.get('streamCacheCipher', '')
    if (!cipher || cipher.length > 6 * 1024 * 1024 || !safeStorage.isEncryptionAvailable()) return []
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64')))
    } catch { return [] }
  }

  saveStreamCache(entries: StreamCacheEntry[]): void {
    if (!safeStorage.isEncryptionAvailable()) return
    this.store.set('streamCacheCipher', safeStorage.encryptString(JSON.stringify(entries)).toString('base64'))
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.store.set('history', this.history)
  }

  private scheduleHistoryFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), 750)
  }
}
