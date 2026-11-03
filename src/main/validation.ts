import { validateHeaderName, validateHeaderValue } from 'node:http'
import type {
  AppSettings,
  FavoriteInput,
  LlmApiType,
  ProgressPayload,
  SiteRule,
  StaticExtractionRule
} from '../shared/types'
import { AppError } from './errors'
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

export function assertSiteRule(value: unknown): SiteRule {
  const raw = requireRecord(value, '站点规则')
  const search = requireRecord(raw.search, '搜索规则')
  const detail = requireRecord(raw.detail, '详情规则')
  const stream = requireRecord(raw.streamExtraction, '流提取规则')
  const baseUrl = parseRemoteUrl(requireString(raw.baseUrl, '站点地址')).toString()
  const siteId = requireString(raw.siteId, '站点 ID', 80)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(siteId)) {
    throw new AppError('INVALID_RULE', '站点 ID 只能包含字母、数字、短横线和下划线')
  }
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
    siteId,
    siteName: requireString(raw.siteName, '站点名称', 100),
    baseUrl,
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
    streamExtraction: { primaryMode, staticRule, fallbackMode, snifferRule },
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined
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
    proxyCacheMegabytes: raw.proxyCacheMegabytes === undefined ? current.proxyCacheMegabytes : clamp(raw.proxyCacheMegabytes, 32, 512)
  }
}

function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new AppError('INVALID_ARGUMENT', '数字设置无效')
  return Math.round(Math.min(Math.max(number, min), max))
}
