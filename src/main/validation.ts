import { validateHeaderName, validateHeaderValue } from 'node:http'
import type {
  ApiDetailSpec,
  ApiRequestSpec,
  ApiSearchSpec,
  ApiStreamSpec,
  AppSettings,
  FavoriteInput,
  LlmApiType,
  ProgressPayload,
  SiteRule,
  StaticExtractionRule
} from '../shared/types'
import { AppError } from './errors'
import { parseJsonPath } from './jsonPath'
import { parseRemoteUrl } from './urlSafety'

export function requireRecord(value: unknown, label = '参数'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGUMENT', `${label}格式无效`)
  }
  return value as Record<string, unknown>
}

export function requireString(
  value: unknown,
  label: string,
  maxLength = 2_048,
  allowEmpty = false
): string {
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', `${label}必须是字符串`)
  const result = value.trim()
  if (!allowEmpty && !result) throw new AppError('INVALID_ARGUMENT', `${label}不能为空`)
  if (result.length > maxLength) throw new AppError('INVALID_ARGUMENT', `${label}过长`)
  return result
}

export function assertLlmApiType(value: unknown): LlmApiType {
  if (value !== 'chat_completions' && value !== 'responses') {
    throw new AppError('INVALID_ARGUMENT', '接口类型必须是 Chat Completions 或 Responses')
  }
  return value
}

export function assertLlmHttpHeaders(value: unknown): Record<string, string> {
  const raw = requireRecord(value, '自定义请求头')
  const entries = Object.entries(raw)
  if (entries.length > 32) throw new AppError('INVALID_ARGUMENT', '自定义请求头最多支持 32 项')
  const headers = new Map<string, string>()
  for (const [key, headerValue] of entries) {
    const name = requireString(key, '请求头名称', 100).toLowerCase()
    if (['authorization', 'host', 'content-length', 'connection', 'transfer-encoding'].includes(name)) {
      throw new AppError('INVALID_ARGUMENT', name === 'authorization'
        ? 'Authorization 由 API Key 自动生成，请在密钥输入框中填写'
        : `不能自定义请求头 ${name}`)
    }
    if (typeof headerValue !== 'string' || headerValue.length > 8192) {
      throw new AppError('INVALID_ARGUMENT', `请求头 ${name} 的值必须是长度不超过 8192 的字符串`)
    }
    try {
      validateHeaderName(name)
      validateHeaderValue(name, headerValue)
    } catch {
      throw new AppError('INVALID_ARGUMENT', `请求头 ${name} 包含无效字符或换行`)
    }
    headers.set(name, headerValue)
  }
  return Object.fromEntries(headers)
}

function assertSelector(value: unknown, label: string): string {
  const selector = requireString(value, label, 500)
  if (selector.includes('\0')) throw new AppError('INVALID_RULE', `${label}包含无效字符`)
  return selector
}

function assertStaticRule(value: unknown): StaticExtractionRule {
  const raw = requireRecord(value, '静态提取规则')
  const regex = requireString(raw.regex, '提取正则', 1_500)
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(regex)) {
    throw new AppError('INVALID_RULE', '提取正则包含高风险的嵌套量词')
  }
  const flags = typeof raw.flags === 'string' ? raw.flags : ''
  if (/[^imsu]/.test(flags) || new Set(flags).size !== flags.length) {
    throw new AppError('INVALID_RULE', '提取正则 flags 无效')
  }
  try {
    new RegExp(regex, flags)
  } catch {
    throw new AppError('INVALID_RULE', '提取正则无法编译')
  }
  const allowedSteps = new Set(['unescape_slashes', 'url_decode', 'base64_decode', 'json_parse'])
  if (!Array.isArray(raw.decodePipeline) || raw.decodePipeline.some((step) => !allowedSteps.has(String(step)))) {
    throw new AppError('INVALID_RULE', '解码流水线无效')
  }
  const validUrlPattern = typeof raw.validUrlPattern === 'string'
    ? requireString(raw.validUrlPattern, '流地址校验正则', 500)
    : undefined
  if (validUrlPattern) {
    try {
      new RegExp(validUrlPattern, 'i')
    } catch {
      throw new AppError('INVALID_RULE', '流地址校验正则无法编译')
    }
  }
  return { regex, flags, decodePipeline: raw.decodePipeline as StaticExtractionRule['decodePipeline'], validUrlPattern }
}

function assertApiRequest(value: unknown, label: string): ApiRequestSpec {
  const raw = requireRecord(value, label)
  const method = raw.method === undefined ? 'GET' : requireString(raw.method, `${label} 方法`, 8).toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    throw new AppError('INVALID_RULE', `${label} 只支持 GET/POST`)
  }
  const headers = raw.headers === undefined ? undefined : requireRecord(raw.headers, `${label} 请求头`)
  return {
    method,
    urlTemplate: requireString(raw.urlTemplate, `${label} 地址模板`, 2_048),
    bodyTemplate: typeof raw.bodyTemplate === 'string'
      ? requireString(raw.bodyTemplate, `${label} 请求体模板`, 16_384, true)
      : undefined,
    headers: headers
      ? Object.fromEntries(
          Object.entries(headers).map(([key, val]) => [
            requireString(key, '请求头名称', 128),
            requireString(val, '请求头内容', 2_048)
          ])
        )
      : undefined
  }
}

function assertJsonPath(value: unknown, label: string): string {
  const path = requireString(value, label, 512)
  try {
    parseJsonPath(path)
  } catch {
    throw new AppError('INVALID_RULE', `${label} 不是合法的 JSONPath：${path}`)
  }
  return path
}

function assertIdRegex(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const regex = requireString(value, label, 512)
  try {
    new RegExp(regex)
  } catch {
    throw new AppError('INVALID_RULE', `${label} 无法编译`)
  }
  return regex
}

function assertApiSearch(value: unknown): ApiSearchSpec {
  const raw = requireRecord(value, 'API 搜索规则')
  const detailUrl = typeof raw.detailUrl === 'string' && raw.detailUrl
    ? assertJsonPath(raw.detailUrl, '详情地址路径')
    : undefined
  const detailUrlTemplate = typeof raw.detailUrlTemplate === 'string' && raw.detailUrlTemplate
    ? requireString(raw.detailUrlTemplate, '详情地址模板', 2_048, true)
    : undefined
  if (!detailUrl && !detailUrlTemplate) {
    throw new AppError('INVALID_RULE', 'API 搜索规则需要 detailUrl 或 detailUrlTemplate')
  }
  return {
    request: assertApiRequest(raw.request, 'API 搜索请求'),
    list: assertJsonPath(raw.list, '搜索结果列表路径'),
    title: assertJsonPath(raw.title, '标题路径'),
    detailUrl,
    detailUrlTemplate,
    coverUrl: typeof raw.coverUrl === 'string' && raw.coverUrl ? assertJsonPath(raw.coverUrl, '封面路径') : undefined
  }
}

function assertApiDetail(value: unknown): ApiDetailSpec {
  const raw = requireRecord(value, 'API 详情规则')
  const episodeUrl = typeof raw.episodeUrl === 'string' && raw.episodeUrl
    ? assertJsonPath(raw.episodeUrl, '剧集地址路径')
    : undefined
  const episodeUrlTemplate = typeof raw.episodeUrlTemplate === 'string' && raw.episodeUrlTemplate
    ? requireString(raw.episodeUrlTemplate, '剧集地址模板', 2_048, true)
    : undefined
  if (!episodeUrl && !episodeUrlTemplate) {
    throw new AppError('INVALID_RULE', 'API 详情规则需要 episodeUrl 或 episodeUrlTemplate')
  }
  return {
    request: assertApiRequest(raw.request, 'API 详情请求'),
    idRegex: assertIdRegex(raw.idRegex, '详情 ID 正则'),
    title: typeof raw.title === 'string' && raw.title ? assertJsonPath(raw.title, '详情标题路径') : undefined,
    coverUrl: typeof raw.coverUrl === 'string' && raw.coverUrl ? assertJsonPath(raw.coverUrl, '详情封面路径') : undefined,
    description: typeof raw.description === 'string' && raw.description ? assertJsonPath(raw.description, '详情简介路径') : undefined,
    episodes: assertJsonPath(raw.episodes, '剧集列表路径'),
    episodeName: assertJsonPath(raw.episodeName, '剧集名称路径'),
    episodeUrl,
    episodeUrlTemplate
  }
}

function assertApiStream(value: unknown): ApiStreamSpec {
  const raw = requireRecord(value, 'API 流规则')
  return {
    request: assertApiRequest(raw.request, 'API 流请求'),
    idRegex: assertIdRegex(raw.idRegex, '播放 ID 正则'),
    streamUrl: assertJsonPath(raw.streamUrl, '流地址路径')
  }
}

export function assertSiteRule(value: unknown): SiteRule {
  const raw = requireRecord(value, '站点规则')
  const baseUrl = parseRemoteUrl(requireString(raw.baseUrl, '站点地址')).toString()
  const siteId = requireString(raw.siteId, '站点 ID', 80)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(siteId)) {
    throw new AppError('INVALID_RULE', '站点 ID 只能包含字母、数字、短横线和下划线')
  }
  const common = {
    siteId,
    siteName: requireString(raw.siteName, '站点名称', 100),
    baseUrl,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined
  }

  if (raw.ruleType === 'api') {
    return {
      ...common,
      ruleType: 'api',
      apiSearch: assertApiSearch(raw.apiSearch),
      apiDetail: assertApiDetail(raw.apiDetail),
      apiStream: raw.apiStream === undefined ? undefined : assertApiStream(raw.apiStream)
    }
  }

  const search = requireRecord(raw.search, '搜索规则')
  const detail = requireRecord(raw.detail, '详情规则')
  const stream = requireRecord(raw.streamExtraction, '流提取规则')
  const primaryMode = stream.primaryMode === 'sniffer' ? 'sniffer' : 'static'
  const fallbackMode = stream.fallbackMode === 'none' ? 'none' : 'sniffer'
  const staticRule = stream.staticRule ? assertStaticRule(stream.staticRule) : undefined
  const snifferRaw = stream.snifferRule ? requireRecord(stream.snifferRule, '嗅探规则') : undefined
  const snifferRule = snifferRaw
    ? {
        timeoutMs: Math.min(Math.max(Number(snifferRaw.timeoutMs) || 10_000, 2_000), 30_000),
        urlMatchRegex: requireString(snifferRaw.urlMatchRegex, '嗅探地址正则', 500),
        excludeRegex: typeof snifferRaw.excludeRegex === 'string'
          ? requireString(snifferRaw.excludeRegex, '嗅探排除正则', 500, true)
          : undefined
      }
    : undefined
  for (const pattern of [snifferRule?.urlMatchRegex, snifferRule?.excludeRegex]) {
    if (!pattern) continue
    try { new RegExp(pattern, 'i') } catch { throw new AppError('INVALID_RULE', '嗅探正则无法编译') }
  }
  if (primaryMode === 'static' && !staticRule) {
    throw new AppError('INVALID_RULE', '静态优先模式缺少静态提取规则')
  }

  return {
    ...common,
    ruleType: 'selector',
    search: {
      urlTemplate: requireString(search.urlTemplate, '搜索地址模板', 2_048),
      listSelector: assertSelector(search.listSelector, '搜索列表选择器'),
      titleSelector: assertSelector(search.titleSelector, '标题选择器'),
      detailUrlSelector: assertSelector(search.detailUrlSelector, '详情地址选择器'),
      coverUrlSelector: typeof search.coverUrlSelector === 'string'
        ? assertSelector(search.coverUrlSelector, '封面选择器')
        : undefined
    },
    detail: {
      titleSelector: typeof detail.titleSelector === 'string' ? assertSelector(detail.titleSelector, '详情标题选择器') : undefined,
      coverUrlSelector: typeof detail.coverUrlSelector === 'string' ? assertSelector(detail.coverUrlSelector, '详情封面选择器') : undefined,
      descriptionSelector: typeof detail.descriptionSelector === 'string' ? assertSelector(detail.descriptionSelector, '简介选择器') : undefined,
      playlistGroupSelector: typeof detail.playlistGroupSelector === 'string' ? assertSelector(detail.playlistGroupSelector, '线路选择器') : undefined,
      episodeGroupSelector: typeof detail.episodeGroupSelector === 'string' ? assertSelector(detail.episodeGroupSelector, '剧集组选择器') : undefined,
      episodeListSelector: assertSelector(detail.episodeListSelector, '剧集列表选择器'),
      episodeNameSelector: assertSelector(detail.episodeNameSelector, '剧集名称选择器'),
      episodeUrlSelector: assertSelector(detail.episodeUrlSelector, '剧集地址选择器')
    },
    streamExtraction: { primaryMode, staticRule, fallbackMode, snifferRule }
  }
}

export function assertProgressPayload(value: unknown): ProgressPayload {
  const raw = requireRecord(value, '播放进度')
  const currentTime = Math.max(0, Number(raw.currentTime) || 0)
  const duration = Math.max(0, Number(raw.duration) || 0)
  return {
    seriesId: typeof raw.seriesId === 'string' ? requireString(raw.seriesId, '剧集 ID', 128) : undefined,
    siteId: requireString(raw.siteId, '站点 ID', 80),
    title: requireString(raw.title, '剧名', 300),
    coverUrl: typeof raw.coverUrl === 'string' ? requireString(raw.coverUrl, '封面地址', 2_048, true) : '',
    detailUrl: requireString(raw.detailUrl, '详情地址', 2_048),
    episodeUrl: requireString(raw.episodeUrl, '播放页地址', 2_048),
    episodeName: requireString(raw.episodeName, '剧集名称', 200),
    currentTime: duration > 0 ? Math.min(currentTime, duration) : currentTime,
    duration,
    isFinished: raw.isFinished === true
  }
}

export function assertFavoriteInput(value: unknown): FavoriteInput {
  const raw = requireRecord(value, '收藏信息')
  const detailUrl = parseRemoteUrl(requireString(raw.detailUrl, '详情地址', 2_048))
  detailUrl.hash = ''
  let coverUrl = typeof raw.coverUrl === 'string' ? requireString(raw.coverUrl, '封面地址', 8_192, true) : ''
  if (coverUrl) {
    try { coverUrl = parseRemoteUrl(coverUrl).href } catch { coverUrl = '' }
  }
  return {
    siteId: requireString(raw.siteId, '站点 ID', 80),
    siteName: typeof raw.siteName === 'string' ? requireString(raw.siteName, '站点名称', 200, true) : '',
    title: requireString(raw.title, '影片名称', 300),
    coverUrl,
    detailUrl: detailUrl.href
  }
}

export function sanitizeSettings(
  value: Partial<AppSettings>,
  current: AppSettings
): AppSettings {
  const raw = requireRecord(value, '设置')
  return {
    llmApiBaseUrl: typeof raw.llmApiBaseUrl === 'string'
      ? requireString(raw.llmApiBaseUrl, '模型 API 地址', 2_048, true)
      : current.llmApiBaseUrl,
    llmModel: typeof raw.llmModel === 'string'
      ? requireString(raw.llmModel, '模型名称', 200, true)
      : current.llmModel,
    llmApiType: raw.llmApiType === undefined ? current.llmApiType : assertLlmApiType(raw.llmApiType),
    llmHttpHeaders: raw.llmHttpHeaders === undefined
      ? current.llmHttpHeaders
      : assertLlmHttpHeaders(raw.llmHttpHeaders),
    llmStoreResponses: typeof raw.llmStoreResponses === 'boolean'
      ? raw.llmStoreResponses
      : current.llmStoreResponses,
    skipIntroSeconds: raw.skipIntroSeconds === undefined ? current.skipIntroSeconds : clamp(raw.skipIntroSeconds, 0, 900),
    skipOutroSeconds: raw.skipOutroSeconds === undefined ? current.skipOutroSeconds : clamp(raw.skipOutroSeconds, 0, 900),
    autoPlayNext: typeof raw.autoPlayNext === 'boolean' ? raw.autoPlayNext : current.autoPlayNext,
    proxyPrefetchCount: raw.proxyPrefetchCount === undefined ? current.proxyPrefetchCount : clamp(raw.proxyPrefetchCount, 0, 8),
    proxyCacheMegabytes: raw.proxyCacheMegabytes === undefined ? current.proxyCacheMegabytes : clamp(raw.proxyCacheMegabytes, 32, 512),
    lanEnabled: typeof raw.lanEnabled === 'boolean' ? raw.lanEnabled : current.lanEnabled,
    lanPort: raw.lanPort === undefined ? current.lanPort : clamp(raw.lanPort, 1024, 65535),
    deviceName: typeof raw.deviceName === 'string' && raw.deviceName.trim().length > 0
      ? raw.deviceName.trim().slice(0, 40)
      : current.deviceName
  }
}

function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new AppError('INVALID_ARGUMENT', '数字设置无效')
  return Math.round(Math.min(Math.max(number, min), max))
}
