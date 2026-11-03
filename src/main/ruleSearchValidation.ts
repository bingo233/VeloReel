import { load } from 'cheerio'
import type { SiteRule } from '../shared/types'
import { AppError } from './errors'
import { parseRemoteUrl } from './urlSafety'
import { parseSearchPage } from './vodService'

export interface SearchSample {
  url: string
  html: string
  keyword?: string
  expectedDetailUrl?: string
  urlTemplate?: string
}

interface SearchSampleRequest {
  url: string
  keyword: string
  expectedDetailUrl: string
  urlTemplate: string
}

const KEYWORD_NAMES = ['wd', 'keyword', 'searchword', 'searchkey', 'q', 'query', 'search', 'key']

export function searchKeywordFromUrl(url: string): string | undefined {
  const params = new URL(url).searchParams
  for (const name of KEYWORD_NAMES) {
    const value = params.get(name)?.trim()
    if (value) return value
  }
  return undefined
}

/** Read a public GET search form and a real title; never guess a search endpoint. */
export function discoverSearchSample(
  homeHtml: string,
  homeUrl: string,
  titleSource?: { html: string; url: string }
): SearchSampleRequest | undefined {
  const $ = load(homeHtml)
  const home = parseRemoteUrl(homeUrl)
  const titleDocument = titleSource ? load(titleSource.html) : $
  const titleBase = titleSource ? parseRemoteUrl(titleSource.url) : home
  const titles: Array<{ title: string; url: string; score: number }> = []
  titleDocument('h1 a[href], h2 a[href], h3 a[href], h4 a[href], a[title][href]').each((_index, element) => {
    const anchor = titleDocument(element)
    const title = (anchor.attr('title') || anchor.text()).replace(/\s+/g, ' ').trim()
    if (title.length < 2 || title.length > 80) return
    try {
      const url = parseRemoteUrl(anchor.attr('href') || '', titleBase)
      if (url.origin !== titleBase.origin || url.pathname === titleBase.pathname || url.hash) return
      const score = /(?:voddetail|\/detail\/|\/show\/|\/movie\/|\/series\/)/i.test(url.pathname) ? 2
        : anchor.find('img').length || /thumb|poster/.test(anchor.attr('class') || '') ? 1 : 0
      if (score) titles.push({ title, url: url.toString(), score })
    } catch { /* Ignore navigation links that cannot be public sample pages. */ }
  })
  titles.sort((a, b) => b.score - a.score)
  const title = titles[0]
  if (!title) return undefined

  let sample: SearchSampleRequest | undefined
  $('form').each((_index, element) => {
    if (sample) return
    const form = $(element)
    if ((form.attr('method') || 'get').toLowerCase() !== 'get') return
    const fields = form.find('input[name]').filter((_i, input) => {
      const field = $(input)
      return !field.is('[disabled]') && ['text', 'search', ''].includes((field.attr('type') || '').toLowerCase())
    })
    const keywordField = KEYWORD_NAMES.map((name) => fields.filter((_i, input) => $(input).attr('name')?.toLowerCase() === name).first())
      .find((field) => field.length)
    if (!keywordField) return
    try {
      const target = parseRemoteUrl(form.attr('action') || home.toString(), home)
      if (target.origin !== home.origin) return
      form.find('input[type="hidden"][name]:not([disabled])').each((_i, input) => {
        const field = $(input)
        target.searchParams.set(field.attr('name')!, field.attr('value') || '')
      })
      const name = keywordField.attr('name')!
      target.hash = ''
      target.searchParams.set(name, '__VIDEO_PLAYER_SEARCH_KEYWORD__')
      const urlTemplate = target.toString().replace('__VIDEO_PLAYER_SEARCH_KEYWORD__', '{keyword}')
      target.searchParams.set(name, title.title)
      sample = { url: target.toString(), keyword: title.title, expectedDetailUrl: title.url, urlTemplate }
    } catch { /* A malformed form is not evidence for a usable endpoint. */ }
  })
  return sample
}

/** The runtime parser is deliberately used here: a valid JSON shape is insufficient. */
export function validateSearchSample(rule: SiteRule, sample: SearchSample): void {
  if (!rule.search.urlTemplate.includes('{keyword}')) {
    throw new AppError('INVALID_SEARCH_RULE', '搜索地址模板缺少 {keyword}，无法替换搜索关键词。')
  }
  if (sample.urlTemplate && rule.search.urlTemplate !== sample.urlTemplate) {
    throw new AppError('INVALID_SEARCH_RULE', `搜索地址模板与首页真实搜索表单不一致。应使用：${sample.urlTemplate}`)
  }
  let items
  try {
    items = parseSearchPage(rule, sample.html, sample.url)
  } catch (error) {
    throw new AppError('INVALID_SEARCH_RULE', '搜索选择器无法执行，请根据真实搜索页生成有效的 CSS 选择器。', error)
  }
  if (!items.length) {
    throw new AppError('INVALID_SEARCH_RULE',
      `搜索规则未通过实际页面验证：listSelector=${rule.search.listSelector}，titleSelector=${rule.search.titleSelector}，detailUrlSelector=${rule.search.detailUrlSelector}，未解析到有效影片。搜索页：${sample.url}`)
  }
  const normalize = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  const keyword = sample.keyword ? normalize(sample.keyword) : ''
  const expected = sample.expectedDetailUrl
  const relevantItems = items.filter((item) =>
    (expected && item.detailUrl === expected) || (keyword && normalize(item.title).includes(keyword)))
  if ((keyword || expected) && !relevantItems.length) {
    throw new AppError('INVALID_SEARCH_RULE', '解析到了页面内容，但没有搜索样本对应的影片，可能匹配到了推荐列表或侧栏。')
  }
  if (keyword && items.some((item) => !normalize(item.title).includes(keyword) && item.detailUrl !== expected)) {
    throw new AppError('INVALID_SEARCH_RULE', '搜索列表混入了与样本关键词无关的影片，请将选择器限定在真正的搜索结果区域。')
  }
}
