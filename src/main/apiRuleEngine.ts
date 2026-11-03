import { AppError } from './errors'
import { fetchHtmlWithJsChallenge } from './jsChallenge'
import { queryJson, queryString } from './jsonPath'
import { parseRemoteUrl } from './urlSafety'
import type {
  ApiRequestSpec,
  SiteRule,
  SearchResultItem,
  VodDetail,
  Episode
} from '../shared/types'

const MAX_API_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 500

/** 请求模板占位符：{keyword} {detailUrl} {episodeUrl} {id}。 */
type RequestValues = Record<string, string | undefined>

type EncodeMode = 'url' | 'json' | 'raw'

/** 渲染 {token} 模板；token 不存在时替换为空串。 */
export function renderTemplate(template: string, values: RequestValues, encode: EncodeMode = 'url'): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    const value = values[token.trim()] ?? ''
    if (encode === 'url') return encodeURIComponent(value)
    if (encode === 'json') return JSON.stringify(value).slice(1, -1)
    return value
  })
}

/** 用条目自身的字段渲染 {field} 模板（字段路径取自条目 JSON）。 */
export function renderItemTemplate(template: string, item: unknown): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, path: string) => {
    const value = queryString(item, path.trim().startsWith('$') ? path.trim() : `$.${path.trim()}`)
    return encodeURIComponent(value)
  })
}

/** 从 URL 按正则提取 {id}（第一个捕获组；无捕获组则用整体匹配）。 */
export function extractId(idRegex: string | undefined, url: string): string | undefined {
  if (!idRegex) return undefined
  let pattern: RegExp
  try {
    pattern = new RegExp(idRegex)
  } catch {
    throw new AppError('INVALID_RULE', `API 规则的 idRegex 无法编译：${idRegex}`)
  }
  const match = pattern.exec(url)
  return match?.[1] ?? match?.[0]
}

/** 执行一次 API 请求并解析 JSON；响应不是 JSON 时抛错。 */
export async function execApiRequest(
  baseUrl: string,
  spec: ApiRequestSpec,
  values: RequestValues
): Promise<unknown> {
  const url = parseRemoteUrl(renderTemplate(spec.urlTemplate, values, 'url'), baseUrl)
  const method = spec.method === 'POST' ? 'POST' : 'GET'
  const headers: Record<string, string> = { ...(spec.headers ?? {}) }
  let body: string | undefined
  if (method === 'POST') {
    body = renderTemplate(spec.bodyTemplate ?? '', values, 'json')
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = body.trimStart().startsWith('{') || body.trimStart().startsWith('[')
        ? 'application/json'
        : 'application/x-www-form-urlencoded'
    }
  }
  const page = await fetchHtmlWithJsChallenge(
    url,
    { method, headers, body },
    { timeoutMs: 15_000 },
    MAX_API_BYTES
  )
  if (!page.ok) {
    throw new AppError('UPSTREAM_HTTP_ERROR', `接口请求失败（HTTP ${page.status}）`)
  }
  try {
    return JSON.parse(page.html)
  } catch {
    throw new AppError('PARSE_EMPTY', '接口返回的内容不是有效 JSON，API 规则可能已失效')
  }
}

function resolveMaybeRelative(value: string, baseUrl: string): string {
  if (!value) return ''
  try {
    return parseRemoteUrl(value, baseUrl).toString()
  } catch {
    return ''
  }
}

/** 把搜索接口返回的 JSON 映射为统一搜索结果。 */
export function mapApiSearch(rule: SiteRule, data: unknown): SearchResultItem[] {
  const spec = rule.apiSearch!
  const list = queryJson(data, spec.list).flatMap((value) => (Array.isArray(value) ? value : [value]))
  const items: SearchResultItem[] = []
  for (const entry of list.slice(0, MAX_ITEMS)) {
    const title = queryString(entry, spec.title).trim()
    if (!title) continue
    let detailUrl = spec.detailUrl ? queryString(entry, spec.detailUrl).trim() : ''
    if (!detailUrl && spec.detailUrlTemplate) {
      detailUrl = renderItemTemplate(spec.detailUrlTemplate, entry)
    }
    detailUrl = resolveMaybeRelative(detailUrl, rule.baseUrl)
    if (!detailUrl) continue
    const coverUrl = spec.coverUrl ? resolveMaybeRelative(queryString(entry, spec.coverUrl).trim(), rule.baseUrl) : ''
    items.push({ siteId: rule.siteId, siteName: rule.siteName, title, coverUrl, detailUrl })
  }
  return items
}

/** 把详情接口返回的 JSON 映射为统一详情结构。 */
export function mapApiDetail(rule: SiteRule, data: unknown, detailUrl: string): VodDetail {
  const spec = rule.apiDetail!
  const episodeEntries = queryJson(data, spec.episodes).flatMap((value) => (Array.isArray(value) ? value : [value]))
  const episodes: Episode[] = []
  episodeEntries.forEach((entry, index) => {
    const name = queryString(entry, spec.episodeName).trim() || `第 ${index + 1} 集`
    let episodeUrl = spec.episodeUrl ? queryString(entry, spec.episodeUrl).trim() : ''
    if (!episodeUrl && spec.episodeUrlTemplate) {
      episodeUrl = renderItemTemplate(spec.episodeUrlTemplate, entry)
    }
    episodeUrl = resolveMaybeRelative(episodeUrl, rule.baseUrl)
    if (episodeUrl) episodes.push({ name, url: episodeUrl, episodeUrl, index })
  })
  if (!episodes.length) {
    throw new AppError('PARSE_EMPTY', '接口详情中没有剧集，API 规则可能已失效')
  }
  return {
    siteId: rule.siteId,
    title: (spec.title ? queryString(data, spec.title).trim() : '') || '未命名影片',
    coverUrl: spec.coverUrl ? resolveMaybeRelative(queryString(data, spec.coverUrl).trim(), rule.baseUrl) : '',
    description: spec.description ? queryString(data, spec.description).trim() : '',
    detailUrl,
    playlistGroups: [{ name: '默认线路', episodes }]
  }
}

/** 执行 API 搜索。 */
export async function runApiSearch(rule: SiteRule, keyword: string): Promise<SearchResultItem[]> {
  const data = await execApiRequest(rule.baseUrl, rule.apiSearch!.request, { keyword })
  return mapApiSearch(rule, data)
}

/** 执行 API 详情。 */
export async function runApiDetail(rule: SiteRule, detailUrl: string): Promise<VodDetail> {
  const spec = rule.apiDetail!
  const data = await execApiRequest(rule.baseUrl, spec.request, {
    detailUrl,
    id: extractId(spec.idRegex, detailUrl)
  })
  return mapApiDetail(rule, data, detailUrl)
}

/** 执行 API 流地址解析。 */
export async function runApiStream(rule: SiteRule, episodeUrl: string): Promise<{ url: string; mediaType: 'hls' | 'mp4' }> {
  const spec = rule.apiStream!
  const data = await execApiRequest(rule.baseUrl, spec.request, {
    episodeUrl,
    id: extractId(spec.idRegex, episodeUrl)
  })
  const streamUrl = resolveMaybeRelative(queryString(data, spec.streamUrl).trim(), rule.baseUrl)
  if (!streamUrl) {
    throw new AppError('PARSE_EMPTY', '接口未返回播放地址，API 规则可能已失效')
  }
  return { url: streamUrl, mediaType: /\.m3u8(?:[?#]|$)/i.test(streamUrl) ? 'hls' : 'mp4' }
}
