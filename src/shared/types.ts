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

/** API 声明式规则的一次请求定义。模板中可用 {keyword} / {detailUrl} / {episodeUrl} / {id} 占位。 */
export interface ApiRequestSpec {
  method?: 'GET' | 'POST'
  urlTemplate: string
  bodyTemplate?: string
  headers?: Record<string, string>
}

/** API 规则：搜索接口到搜索结果列表的映射。路径为 JSONPath 子集（$.a.b[0]、[*]）。 */
export interface ApiSearchSpec {
  request: ApiRequestSpec
  /** 指向结果数组的路径，例如 $.data.list。 */
  list: string
  /** 相对单个结果条目的路径。 */
  title: string
  detailUrl?: string
  /** 用条目字段拼详情地址，形如 https://x.com/pc/detail/{id}，花括号内为条目字段路径。 */
  detailUrlTemplate?: string
  coverUrl?: string
}

/** API 规则：详情接口到剧集列表的映射。 */
export interface ApiDetailSpec {
  request: ApiRequestSpec
  /** 从详情地址提取 {id} 的正则（第一个捕获组），请求模板需要 {id} 时使用。 */
  idRegex?: string
  title?: string
  coverUrl?: string
  description?: string
  /** 指向剧集数组的路径。 */
  episodes: string
  episodeName: string
  episodeUrl?: string
  /** 用剧集字段拼播放页地址，花括号内为剧集字段路径。 */
  episodeUrlTemplate?: string
}

/** API 规则：播放接口到流地址的映射（可选，缺省时回退浏览器嗅探）。 */
export interface ApiStreamSpec {
  request: ApiRequestSpec
  idRegex?: string
  /** 指向流地址的路径。 */
  streamUrl: string
}

export interface SiteRule {
  siteId: string
  siteName: string
  baseUrl: string
  /** selector：CSS 选择器规则（默认）；api：JSON 接口声明式规则。 */
  ruleType?: 'selector' | 'api'
  apiSearch?: ApiSearchSpec
  apiDetail?: ApiDetailSpec
  apiStream?: ApiStreamSpec
  /** 以下三组仅 selector 规则使用。 */
  search?: {
    urlTemplate: string
    listSelector: string
    titleSelector: string
    detailUrlSelector: string
    coverUrlSelector?: string
  }
  detail?: {
    titleSelector?: string
    coverUrlSelector?: string
    descriptionSelector?: string
    playlistGroupSelector?: string
    episodeGroupSelector?: string
    episodeListSelector: string
    episodeNameSelector: string
    episodeUrlSelector: string
  }
  streamExtraction?: {
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
  lanEnabled: boolean
  lanPort: number
  deviceName: string
}

export interface LanStatus {
  enabled: boolean
  running: boolean
  port: number
  addresses: string[]
  error: string
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
  lan: {
    status(): Promise<LanStatus>
  }
}
