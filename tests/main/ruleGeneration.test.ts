import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteRule } from '../../src/shared/types'
import type { AppStorage } from '../../src/main/storage'
import { requestLlmJsonText } from '../../src/main/llmClient'
import { LlmRuleGenerator, __testing } from '../../src/main/llmRuleGenerator'
import { discoverSearchSample, validateSearchSample } from '../../src/main/ruleSearchValidation'
import { parseSearchPage } from '../../src/main/vodService'
import { extractStaticUrlFromHtml } from '../../src/main/streamExtractor'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))
vi.mock('../../src/main/llmClient', () => ({ requestLlmJsonText: vi.fn() }))
vi.mock('../../src/main/streamExtractor', () => ({ extractStaticUrlFromHtml: vi.fn() }))

const siteUrl = 'https://crjyksw.com/'
const template = `${siteUrl}vodsearch/-------------.html?wd={keyword}`
const searchUrl = template.replace('{keyword}', encodeURIComponent('力量之戒'))
const detailUrl = `${siteUrl}voddetail/28622.html`
const playUrl = `${siteUrl}vodplay/28622-1-1.html`
const html = readFileSync(new URL('../fixtures/crjyksw-search.html', import.meta.url), 'utf8')
const home = `<form method="get" action="/vodsearch/-------------.html"><input type="text" name="wd"></form>
  <ul class="macplus-vodlist"><li><a class="macplus-vodlist__thumb" href="/voddetail/28622.html" title="力量之戒"></a></li></ul>`
const validRule: SiteRule = {
  siteId: 'crjyksw', siteName: '碟调电影网', baseUrl: siteUrl,
  search: {
    urlTemplate: template, listSelector: '.macplus-vodlist__media > li',
    titleSelector: '.title a', detailUrlSelector: '.macplus-vodlist__thumb@href',
    coverUrlSelector: '.macplus-vodlist__thumb@data-original'
  },
  detail: { episodeListSelector: '.playlist a', episodeNameSelector: '@text', episodeUrlSelector: '@href' },
  streamExtraction: { primaryMode: 'sniffer', fallbackMode: 'sniffer' }
}
const failedRule: SiteRule = { ...validRule, search: { ...validRule.search, listSelector: '.macplus-vodlist li' } }

function setup(homeHtml = home, searchHtml = html) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const target = String(url)
    return new Response(target === siteUrl ? homeHtml : target === searchUrl ? searchHtml
      : target === detailUrl ? `<h1>力量之戒</h1><ul class="playlist"><li><a href="${playUrl}">第1集</a></li></ul>`
        : target === playUrl ? '<script>var player_aaaa={"url":"https://cdn.example/video.m3u8"}</script>'
          : '<html>Wrong search endpoint</html>', {
      headers: { 'content-type': 'text/html' }
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const storage = {
    getApiKey: vi.fn(() => 'test-secret'),
    getSettings: vi.fn(() => ({
      llmApiBaseUrl: 'https://provider.example/v1', llmModel: 'gpt-5.5',
      llmApiType: 'responses', llmHttpHeaders: {}, llmStoreResponses: false
    })),
    saveRule: vi.fn((rule: SiteRule) => rule), saveSettings: vi.fn(), saveApiKey: vi.fn()
  }
  const extractor = { resolve: vi.fn(async () => ({ url: 'https://cdn.example/video.m3u8', mediaType: 'hls', extractedBy: 'sniffer', headers: {} } as const)) }
  const model = vi.fn<typeof requestLlmJsonText>(async () => JSON.stringify(validRule))
  vi.mocked(requestLlmJsonText).mockImplementation(async (connection, prompt) => {
    if (prompt.instructions.startsWith('You explore')) {
      const state = JSON.parse(prompt.input) as {
        missing: string[]; candidates: Array<{ id: string; url: string; suggestedKind: string }>
      }
      const kind = state.missing[0]!
      const preferred = kind === 'detail' ? detailUrl : kind === 'play' ? playUrl : searchUrl
      const candidate = state.candidates.find((item) => item.url === preferred)
      return JSON.stringify({ candidateId: candidate?.id || 'not-observed', kind })
    }
    return model(connection, prompt)
  })
  const generator = new LlmRuleGenerator(storage as unknown as AppStorage, extractor)
  return { fetcher, storage, generator, model, extractor }
}

beforeEach(() => { vi.mocked(requestLlmJsonText).mockReset() })
afterEach(() => vi.unstubAllGlobals())

describe('rules must work on real search samples before being saved', () => {
  it('reproduces the reported wrong selector and extracts both seasons with the correct rule', () => {
    expect(parseSearchPage(failedRule, html, searchUrl)).toEqual([])
    expect(() => validateSearchSample(failedRule, { url: searchUrl, html, keyword: '力量之戒' })).toThrow('未解析到有效影片')
    expect(parseSearchPage(validRule, html, searchUrl).map((item) => item.title)).toEqual([
      '指环王：力量之戒第二季', '指环王：力量之戒第一季'
    ])
    expect(() => validateSearchSample(validRule, { url: searchUrl, html, keyword: '力量之戒' })).not.toThrow()
  })

  it('automatically obtains a real search page and includes it in the model prompt', async () => {
    const { generator, storage, fetcher, model, extractor } = setup()
    await generator.generate({ siteUrl })
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([siteUrl, searchUrl, detailUrl, playUrl])
    const prompt = model.mock.calls[0]![1]
    expect(prompt.instructions).toContain('never from the homepage grid')
    expect(prompt.input).toContain(`Verified search URL template: ${template}`)
    expect(prompt.input).toContain('macplus-vodlist__media')
    expect(prompt.input).toContain('kind="detail"')
    expect(prompt.input).toContain('kind="play"')
    expect(prompt.input).toContain('var player_aaaa')
    expect(extractor.resolve).toHaveBeenCalledWith(playUrl, expect.any(Object))
    expect(storage.saveRule).toHaveBeenCalledOnce()
    expect(storage.saveRule).toHaveBeenCalledWith(expect.objectContaining({ search: validRule.search }))
  })

  it('sends concrete validation feedback to the model, then saves only a corrected rule', async () => {
    const { generator, storage, model } = setup()
    model.mockResolvedValueOnce(JSON.stringify(failedRule)).mockResolvedValueOnce(JSON.stringify(validRule))
    const result = await generator.generate({ siteUrl, searchResultUrl: searchUrl })
    expect(result.search.listSelector).toBe('.macplus-vodlist__media > li')
    expect(model).toHaveBeenCalledTimes(2)
    expect(model.mock.calls[1]![1].input).toContain('listSelector=.macplus-vodlist li')
    expect(storage.saveRule).toHaveBeenCalledOnce()
    expect(storage.saveRule).toHaveBeenCalledWith(expect.objectContaining({ search: validRule.search }))
  })

  it('never saves or changes credentials when the correction still fails', async () => {
    const { generator, storage, model } = setup()
    model.mockResolvedValue(JSON.stringify(failedRule))
    await expect(generator.generate({ siteUrl, apiKey: 'new-secret', rememberApiKey: true })).rejects.toThrow('规则未保存')
    expect(model).toHaveBeenCalledTimes(2)
    expect(storage.saveRule).not.toHaveBeenCalled()
    expect(storage.saveSettings).not.toHaveBeenCalled()
    expect(storage.saveApiKey).not.toHaveBeenCalled()
  })

  it('reports missing samples only after bounded autonomous discovery fails', async () => {
    const { generator, storage } = setup('<a href="/voddetail/28622.html" title="力量之戒"></a>')
    await expect(generator.generate({ siteUrl })).rejects.toThrow('自动探索未能取得')
    expect(requestLlmJsonText).toHaveBeenCalledTimes(8)
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('uses an explicit sample even when the homepage has no discoverable form', async () => {
    const { generator, storage } = setup('<html>Home</html>')
    await generator.generate({ siteUrl, searchResultUrl: searchUrl })
    expect(storage.saveRule).toHaveBeenCalledOnce()
  })

  it('refuses a template that cannot substitute keywords', async () => {
    const { generator, storage, model } = setup()
    model.mockResolvedValue(JSON.stringify({ ...validRule, search: { ...validRule.search, urlTemplate: searchUrl } }))
    await expect(generator.generate({ siteUrl })).rejects.toThrow('缺少 {keyword}')
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('checks the generated search address as well as the supplied sample', async () => {
    const { generator, storage, fetcher, model } = setup()
    model.mockResolvedValue(JSON.stringify({
      ...validRule, search: { ...validRule.search, urlTemplate: `${siteUrl}incorrect-search?wd={keyword}` }
    }))
    await expect(generator.generate({ siteUrl, searchResultUrl: searchUrl })).rejects.toThrow('规则未保存')
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('incorrect-search'))).toBe(true)
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('rejects selectors that only return unrelated recommendation items', () => {
    const wrongContent = html.replaceAll('力量之戒', '别的影片')
    expect(() => validateSearchSample(validRule, { url: searchUrl, html: wrongContent, keyword: '力量之戒' })).toThrow('推荐列表或侧栏')
  })

  it('validates the original page, even when a selector happens to work on simplified prompt HTML', async () => {
    const original = `<section class="search-results"><style>.title { color: red }</style>${html}</section>`
    const wrongRule = { ...validRule, search: { ...validRule.search, listSelector: '.search-results > ul:nth-child(2) > li' } }
    // The fixture contains a form and a heading before the result UL. Removing STYLE changes :nth-child().
    wrongRule.search.listSelector = '.search-results > ul:nth-child(3) > li'
    const cleaned = __testing.cleanHtml(original, 'search')
    expect(parseSearchPage(wrongRule, cleaned, searchUrl)).toHaveLength(2)
    expect(parseSearchPage(wrongRule, original, searchUrl)).toHaveLength(0)
    const { generator, storage, model } = setup(home, original)
    model.mockResolvedValue(JSON.stringify(wrongRule))
    await expect(generator.generate({ siteUrl, searchResultUrl: searchUrl })).rejects.toThrow('规则未保存')
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('does not swallow provider errors or retry a rate-limited model', async () => {
    const { generator, storage } = setup()
    vi.mocked(requestLlmJsonText).mockRejectedValue(new Error('429 All available accounts are rate-limited'))
    await expect(generator.generate({ siteUrl })).rejects.toThrow('429')
    expect(requestLlmJsonText).toHaveBeenCalledOnce()
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('rejects a rule whose detail selectors cannot find the actual episode page', async () => {
    const { generator, storage, model } = setup()
    model.mockResolvedValue(JSON.stringify({ ...validRule, detail: { ...validRule.detail, episodeListSelector: '.not-an-episode a' } }))
    await expect(generator.generate({ siteUrl })).rejects.toThrow('规则未保存')
    expect(model).toHaveBeenCalledTimes(2)
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('does not save a rule when dynamic stream extraction fails twice', async () => {
    const { generator, storage, extractor } = setup()
    extractor.resolve.mockRejectedValue(new Error('No matching media request captured'))
    await expect(generator.generate({ siteUrl })).rejects.toThrow('No matching media request captured')
    expect(extractor.resolve).toHaveBeenCalledTimes(2)
    expect(storage.saveRule).not.toHaveBeenCalled()
  })

  it('validates static extraction from the actual playback sample without running the sniffer', async () => {
    const { generator, extractor, model } = setup()
    model.mockResolvedValue(JSON.stringify({ ...validRule, streamExtraction: {
      primaryMode: 'static', staticRule: { regex: '"url":"([^"]+)"', decodePipeline: [] }, fallbackMode: 'sniffer'
    } }))
    vi.mocked(extractStaticUrlFromHtml).mockResolvedValueOnce('https://cdn.example/video.m3u8')
    await generator.generate({ siteUrl })
    expect(extractStaticUrlFromHtml).toHaveBeenCalledWith(expect.stringContaining('var player_aaaa'), playUrl, expect.any(Object))
    expect(extractor.resolve).not.toHaveBeenCalled()
  })

  it('reports discovery and validation progress while accepting homepage-only input', async () => {
    const { generator } = setup()
    const report = vi.fn()
    await generator.generate({ siteUrl }, report)
    expect(report.mock.calls.some(([progress]) => progress.stage === 'explore' && progress.url === playUrl)).toBe(true)
    expect(report.mock.calls.some(([progress]) => progress.stage === 'validate')).toBe(true)
    expect(report.mock.calls.at(-1)?.[0].stage).toBe('complete')
  })
})

describe('search sample discovery', () => {
  it('preserves real form metadata during HTML cleanup and encodes a query only once', () => {
    const source = `<form method="get" action="/search?kind=vod"><input name="wd" type="search"><input type="hidden" name="type" value="series"></form><a title="力量 &amp; 戒指" href="/voddetail/28622.html"></a>`
    const sample = discoverSearchSample(__testing.cleanHtml(source, 'home'), siteUrl)
    expect(sample?.keyword).toBe('力量 & 戒指')
    expect(new URL(sample!.url).searchParams.get('wd')).toBe('力量 & 戒指')
    expect(sample?.urlTemplate).toContain('kind=vod&type=series&wd={keyword}')
  })

  it.each([
    home.replace('method="get"', 'method="post"'),
    home.replace('action="/vodsearch/-------------.html"', 'action="https://external.example/search"')
  ])('does not guess endpoints for unsupported or external search forms', (source) => {
    expect(discoverSearchSample(source, siteUrl)).toBeUndefined()
  })
})
