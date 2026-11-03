export type DecodeStep =
  | 'unescape_slashes'
  | 'url_decode'
  | 'base64_decode'
  | 'json_parse'

export interface StaticExtractionRule {
  regex: string
  flags?: string
  decodePipeline: DecodeStep[]
  validUrlPattern?: string
}

export interface SnifferRule {
  timeoutMs: number
  urlMatchRegex: string
  excludeRegex?: string
}

export interface SiteRule {
  siteId: string
  siteName: string
  baseUrl: string
  search: {
    urlTemplate: string
    listSelector: string
    titleSelector: string
    detailUrlSelector: string
    coverUrlSelector?: string
  }
  detail: {
    titleSelector?: string
    coverUrlSelector?: string
    descriptionSelector?: string
    playlistGroupSelector?: string
    episodeGroupSelector?: string
    episodeListSelector: string
    episodeNameSelector: string
    episodeUrlSelector: string
  }
  streamExtraction: {
    primaryMode: 'static' | 'sniffer'
    staticRule?: StaticExtractionRule
    fallbackMode?: 'sniffer' | 'none'
    snifferRule?: SnifferRule
  }
  createdAt?: number
  updatedAt?: number
}

export interface SearchResultItem {
  siteId: string
  siteName: string
  title: string
  coverUrl: string
  detailUrl: string
}

export interface FavoriteInput {
  siteId: string
  siteName: string
  title: string
  coverUrl: string
  detailUrl: string
}

export interface FavoriteItem extends FavoriteInput {
  favoriteId: string
  createdAt: number
}

export interface Episode {
  name: string
  url: string
  /** Compatibility alias used by older renderer builds. */
  episodeUrl?: string
  index: number
}

export interface PlaylistGroup {
  name: string
  episodes: Episode[]
}

export interface VodDetail {
  siteId: string
  title: string
  coverUrl: string
  description: string
  detailUrl: string
  playlistGroups: PlaylistGroup[]
}

export type UpstreamHeaders = Record<string, string>

export interface StreamResolution {
  sessionId: string
  localUrl: string
  /** Kept for compatibility with the original product contract. */
  localProxyM3u8: string
  /** Compatibility alias for early UI prototypes. */
  proxyUrl?: string
  mediaType: 'hls' | 'mp4'
  extractedBy: 'static' | 'sniffer'
  fromCache?: boolean
}

export interface EpisodeProgress {
  episodeUrl: string
  episodeName: string
  currentTime: number
  duration: number
  isFinished: boolean
  updatedAt: number
}

export interface SeriesHistoryItem {
  seriesId: string
  siteId: string
  title: string
  coverUrl: string
  detailUrl: string
  lastEpisodeUrl: string
  lastEpisodeName: string
  lastCurrentTime: number
  lastDuration: number
  updatedAt: number
  episodes: Record<string, EpisodeProgress>
}

export interface ProgressPayload {
  seriesId?: string
  siteId: string
  title: string
  coverUrl: string
  detailUrl: string
  episodeUrl: string
  episodeName: string
  currentTime: number
  duration: number
  isFinished?: boolean
}

export type LlmApiType = 'chat_completions' | 'responses'

export interface LlmConnectionTestInput {
  apiBaseUrl: string
  model: string
  apiType: LlmApiType
  httpHeaders: Record<string, string>
  storeResponses: boolean
  /** Omit or leave empty to use the encrypted key already saved on this device. */
  apiKey?: string
}

export interface LlmConnectionTestResult {
  success: boolean
  elapsedMs: number
  apiType?: LlmApiType
  model?: string
  endpoint?: string
  summary: string
  details: string
  httpStatus?: number
  requestId?: string
  retryAfter?: string
}

export interface AppSettings {
  llmApiBaseUrl: string
  llmModel: string
  llmApiType: LlmApiType
  llmHttpHeaders: Record<string, string>
  llmStoreResponses: boolean
  skipIntroSeconds: number
  skipOutroSeconds: number
  autoPlayNext: boolean
  proxyPrefetchCount: number
  proxyCacheMegabytes: number
}

export interface RuleGenerateInput {
  siteUrl: string
  searchResultUrl?: string
  detailUrl?: string
  playPageUrl?: string
  apiKey?: string
  apiBaseUrl?: string
  /** Alias accepted for compatibility with the initial design document. */
  baseUrl?: string
  model?: string
  apiType?: LlmApiType
  rememberApiKey?: boolean
}

export interface RuleGenerationProgress {
  stage: 'explore' | 'generate' | 'validate' | 'repair' | 'complete'
  message: string
  url?: string
  visitedPages?: number
}

export interface DesktopApi {
  getVersion(): Promise<string>
  rules: {
    list(): Promise<SiteRule[]>
    save(rule: SiteRule): Promise<SiteRule>
    remove(siteId: string): Promise<void>
    generate(input: RuleGenerateInput): Promise<SiteRule>
    onGenerationProgress(listener: (progress: RuleGenerationProgress) => void): () => void
  }
  vod: {
    search(input: { keyword: string; siteId?: string }): Promise<SearchResultItem[]>
    detail(input: { siteId: string; detailUrl: string }): Promise<VodDetail>
  }
  stream: {
    resolve(input: { siteId: string; playPageUrl: string; forceRefresh?: boolean }): Promise<StreamResolution>
    release(input: { sessionId: string }): Promise<void>
  }
  history: {
    list(): Promise<SeriesHistoryItem[]>
    get(input: { seriesId: string }): Promise<SeriesHistoryItem | null>
    save(payload: ProgressPayload): Promise<SeriesHistoryItem>
    remove(input: { seriesId: string }): Promise<void>
    clear(): Promise<void>
  }
  favorites: {
    list(): Promise<FavoriteItem[]>
    add(input: FavoriteInput): Promise<FavoriteItem>
    remove(input: { favoriteId: string }): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    save(settings: Partial<AppSettings>): Promise<AppSettings>
    hasApiKey(): Promise<boolean>
    setApiKey(apiKey: string): Promise<void>
    clearApiKey(): Promise<void>
    testConnection(input: LlmConnectionTestInput): Promise<LlmConnectionTestResult>
  }
}
