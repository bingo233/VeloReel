import { load } from 'cheerio'
import type {
  Episode,
  PlaylistGroup,
  SearchResultItem,
  SiteRule,
  VodDetail
} from '../shared/types'
import { AppError, errorMessage } from './errors'
import { readResponseText, safeFetch, parseRemoteUrl } from './urlSafety'
import type { AppStorage } from './storage'

const HTML_LIMIT = 3 * 1024 * 1024
const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
  accept: 'text/html,application/xhtml+xml'
}

function splitSelector(spec: string): { selector: string; attribute?: string } {
  if (spec.startsWith('@')) return { selector: '', attribute: spec.slice(1) }
  const marker = spec.lastIndexOf('@')
  if (marker > 0) return { selector: spec.slice(0, marker), attribute: spec.slice(marker + 1) }
  return { selector: spec }
}

function selectValue(scope: any, spec: string): string {
  const { selector, attribute } = splitSelector(spec)
  const node = selector ? scope.find(selector).first() : scope.first()
  if (attribute === 'text' || !attribute) return node.text().replace(/\s+/g, ' ').trim()
  if (attribute === 'html') return (node.html() ?? '').trim()
  return (node.attr(attribute) ?? '').trim()
}

function resolvePublicReference(value: string, pageUrl: string): string {
  if (!value || value.startsWith('data:') || value.startsWith('javascript:')) return ''
  try {
    return parseRemoteUrl(value, pageUrl).toString()
  } catch {
    return ''
  }
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const response = await safeFetch(url, { headers: DEFAULT_HEADERS }, { timeoutMs: 15_000 })
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppError('UPSTREAM_HTTP_ERROR', `页面请求失败（HTTP ${response.status}）`)
  }
  const html = await readResponseText(response, HTML_LIMIT)
  return { html, finalUrl: response.url || url }
}

export function parseSearchPage(rule: SiteRule, html: string, pageUrl: string): SearchResultItem[] {
  const $ = load(html)
  const results: SearchResultItem[] = []
  $(rule.search.listSelector).each((_index, element) => {
    const scope = $(element)
    const title = selectValue(scope, rule.search.titleSelector)
    const detailUrl = resolvePublicReference(selectValue(scope, rule.search.detailUrlSelector), pageUrl)
    if (!title || !detailUrl) return
    const coverUrl = rule.search.coverUrlSelector
      ? resolvePublicReference(selectValue(scope, rule.search.coverUrlSelector), pageUrl)
      : ''
    results.push({ siteId: rule.siteId, siteName: rule.siteName, title, coverUrl, detailUrl })
  })

  const seen = new Set<string>()
  return results.filter((item) => {
    const key = `${item.siteId}:${item.detailUrl}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 100)
}

function parseEpisodeNodes(
  $: ReturnType<typeof load>,
  scope: any,
  rule: SiteRule,
  pageUrl: string
): Episode[] {
  const episodes: Episode[] = []
  scope.find(rule.detail.episodeListSelector).each((index: number, element: unknown) => {
    const episodeScope = $(element as any)
    const name = selectValue(episodeScope, rule.detail.episodeNameSelector) || `第 ${index + 1} 集`
    const url = resolvePublicReference(selectValue(episodeScope, rule.detail.episodeUrlSelector), pageUrl)
    if (url) episodes.push({ name, url, episodeUrl: url, index })
  })
  return episodes
}

export function parseDetailPage(rule: SiteRule, html: string, pageUrl: string): VodDetail {
  const $ = load(html)
  const root = $.root()
  const title = rule.detail.titleSelector
    ? selectValue(root, rule.detail.titleSelector)
    : $('meta[property="og:title"]').attr('content')?.trim() || $('title').text().trim()
  const coverRaw = rule.detail.coverUrlSelector
    ? selectValue(root, rule.detail.coverUrlSelector)
    : $('meta[property="og:image"]').attr('content') ?? ''
  const description = rule.detail.descriptionSelector
    ? selectValue(root, rule.detail.descriptionSelector)
    : $('meta[name="description"]').attr('content')?.trim() ?? ''
  const groupNames = rule.detail.playlistGroupSelector
    ? $(rule.detail.playlistGroupSelector).map((_index, element) => $(element).text().replace(/\s+/g, ' ').trim()).get()
    : []
  const playlistGroups: PlaylistGroup[] = []

  if (rule.detail.episodeGroupSelector) {
    $(rule.detail.episodeGroupSelector).each((index, element) => {
      const episodes = parseEpisodeNodes($, $(element), rule, pageUrl)
      if (episodes.length) playlistGroups.push({ name: groupNames[index] || `线路 ${index + 1}`, episodes })
    })
  } else {
    const episodes: Episode[] = []
    $(rule.detail.episodeListSelector).each((index, element) => {
      const scope = $(element)
      const name = selectValue(scope, rule.detail.episodeNameSelector) || `第 ${index + 1} 集`
      const url = resolvePublicReference(selectValue(scope, rule.detail.episodeUrlSelector), pageUrl)
      if (url) episodes.push({ name, url, episodeUrl: url, index })
    })
    if (episodes.length) playlistGroups.push({ name: groupNames[0] || '默认线路', episodes })
  }

  if (!playlistGroups.length) throw new AppError('PARSE_EMPTY', '未能从详情页解析出剧集，请检查站点规则')
  return {
    siteId: rule.siteId,
    title: title || '未命名影片',
    coverUrl: resolvePublicReference(coverRaw, pageUrl),
    description,
    detailUrl: pageUrl,
    playlistGroups
  }
}

export class VodService {
  constructor(private readonly storage: AppStorage) {}

  async search(input: { keyword: string; siteId?: string }): Promise<SearchResultItem[]> {
    const keyword = input.keyword.trim().slice(0, 100)
    if (!keyword) throw new AppError('INVALID_ARGUMENT', '请输入搜索关键词')
    const rules = input.siteId
      ? [this.requireRule(input.siteId)]
      : this.storage.listRules()
    if (!rules.length) throw new AppError('NO_SITE_RULES', '请先添加至少一个站点规则')

    const settled = await Promise.allSettled(rules.map(async (rule) => {
      const target = rule.search.urlTemplate.replaceAll('{keyword}', encodeURIComponent(keyword))
      const url = parseRemoteUrl(target, rule.baseUrl).toString()
      const { html, finalUrl } = await fetchHtml(url)
      return parseSearchPage(rule, html, finalUrl)
    }))
    const items = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    if (!items.length && settled.every((result) => result.status === 'rejected')) {
      const messages = settled.map((result) => result.status === 'rejected' ? errorMessage(result.reason) : '').filter(Boolean)
      throw new AppError('SEARCH_FAILED', `所有站点搜索失败：${messages.join('；')}`)
    }
    return items
  }

  async detail(input: { siteId: string; detailUrl: string }): Promise<VodDetail> {
    const rule = this.requireRule(input.siteId)
    const url = parseRemoteUrl(input.detailUrl, rule.baseUrl).toString()
    const { html, finalUrl } = await fetchHtml(url)
    return parseDetailPage(rule, html, finalUrl)
  }

  private requireRule(siteId: string): SiteRule {
    const rule = this.storage.getRule(siteId)
    if (!rule) throw new AppError('RULE_NOT_FOUND', `找不到站点规则：${siteId}`)
    return rule
  }
}

export const __testing = { splitSelector, selectValue, parseSearchPage, parseDetailPage }
