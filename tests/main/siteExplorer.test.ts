import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exploreSite, type SitePage } from '../../src/main/siteExplorer'
import { requestLlmJsonText, type LlmConnection } from '../../src/main/llmClient'

vi.mock('../../src/main/llmClient', () => ({ requestLlmJsonText: vi.fn() }))

const connection: LlmConnection = {
  apiKey: 'private-model-key', baseUrl: 'https://provider.example/v1', model: 'gpt-5.5',
  apiType: 'responses', httpHeaders: {}, storeResponses: false
}
const origin = 'https://video.example'
const searchUrl = `${origin}/search?wd=${encodeURIComponent('示例片')}`
const detailUrl = `${origin}/detail/1`
const playUrl = `${origin}/play/1`
const homeHtml = '<form action="/search" method="get"><input name="wd"></form><a href="/detail/1" title="示例片"></a>'
const searchHtml = '<div class="results"><a href="/detail/1">示例片</a></div>'
const detailHtml = '<h1>示例片</h1><ul class="episodes"><li><a href="/play/1">第1集</a></li></ul>'
const playHtml = '<script>var player_aaaa={"url":"https://cdn.example/episode.m3u8"}</script>'

interface Choice { id: string; url: string; needsKeyword?: boolean; suggestedKind: string }
interface PlanningState { missing: string[]; candidates: Choice[]; feedback: string }
const page = (url: string, html: string): SitePage => ({ url, html, promptHtml: html })

function setup(home = homeHtml, extraRoutes: Record<string, string> = {}) {
  const routes: Record<string, string> = { [searchUrl]: searchHtml, [detailUrl]: detailHtml, [playUrl]: playHtml, ...extraRoutes }
  const fetchPage = vi.fn(async (url: string): Promise<SitePage> => {
    if (!(url in routes)) throw new Error(`No public sample at ${url}`)
    return page(url, routes[url]!)
  })
  const report = vi.fn()
  const choose = (state: PlanningState) => {
    const kind = state.missing[0]!
    const target = kind === 'search' ? searchUrl : kind === 'detail' ? detailUrl : playUrl
    const selected = state.candidates.find((candidate) => candidate.url === target)
    return { candidateId: selected?.id || 'not-in-the-page', kind }
  }
  const decide = vi.fn((state: PlanningState) => choose(state))
  vi.mocked(requestLlmJsonText).mockImplementation(async (_connection, prompt) => JSON.stringify(decide(JSON.parse(prompt.input))))
  const options = { home: page(`${origin}/`, home), connection, fetchPage, report }
  return { options, fetchPage, report, decide, choose }
}

beforeEach(() => { vi.mocked(requestLlmJsonText).mockReset() })

describe('AI exploration from a single homepage', () => {
  it('follows actual search, detail and playback links and reads each page', async () => {
    const { options, fetchPage, report } = setup()
    const samples = await exploreSite(options)
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([searchUrl, detailUrl, playUrl])
    expect(samples.search.keyword).toBe('示例片')
    expect(samples.detail.html).toBe(detailHtml)
    expect(samples.play.html).toContain('var player_aaaa')
    expect(report.mock.calls.some(([progress]) => progress.url === playUrl)).toBe(true)
  })

  it('visits a search entry page first, then uses its form with a title from the homepage', async () => {
    const entry = `${origin}/lookup`
    const { options, fetchPage, decide, choose } = setup('<a href="/lookup">搜索影片</a><a href="/detail/1" title="示例片"></a>', {
      [entry]: '<form action="/search" method="get"><input type="search" name="wd"></form>'
    })
    decide.mockImplementation((state) => {
      const entryChoice = state.candidates.find((candidate) => candidate.url === entry)
      return entryChoice ? { candidateId: entryChoice.id, kind: 'navigation' } : choose(state)
    })
    await exploreSite(options)
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([entry, searchUrl, detailUrl, playUrl])
  })

  it('converts a POST search form into a GET template candidate', async () => {
    const postUrl = `${origin}/search.php?searchword=${encodeURIComponent('示例片')}`
    const { options, fetchPage, decide, choose } = setup(
      '<form action="/search.php" method="post"><input name="searchword" placeholder="搜索"></form><a href="/detail/1" title="示例片"></a>',
      { [postUrl]: searchHtml }
    )
    decide.mockImplementation((state) => {
      const form = state.candidates.find((candidate) => candidate.needsKeyword)
      return state.missing.includes('search') && form
        ? { candidateId: form.id, kind: 'search', keyword: '示例片' } : choose(state)
    })
    const samples = await exploreSite(options)
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([postUrl, detailUrl, playUrl])
    expect(samples.search.url).toBe(postUrl)
    expect(samples.search.urlTemplate).toBe(`${origin}/search.php?searchword={keyword}`)
  })

  it('lets the model choose a query for an observed form with an unfamiliar field name', async () => {
    const customUrl = `${origin}/find?movie=${encodeURIComponent('示例片')}`
    const { options, decide, choose } = setup('<form action="/find"><input type="search" name="movie" placeholder="搜索影片"></form>', {
      [customUrl]: searchHtml
    })
    decide.mockImplementation((state) => {
      const form = state.candidates.find((candidate) => candidate.needsKeyword)
      return state.missing.includes('search') && form
        ? { candidateId: form.id, kind: 'search', keyword: '示例片' } : choose(state)
    })
    const result = await exploreSite(options)
    expect(result.search.url).toBe(customUrl)
    expect(result.search.keyword).toBe('示例片')
    expect(result.search.urlTemplate).toBe(`${origin}/find?movie={keyword}`)
  })

  it('returns visit errors to the model so it can select another real link', async () => {
    const broken = `${origin}/detail/broken`
    const { options, fetchPage, decide, choose } = setup(homeHtml, {
      [searchUrl]: `<a href="${broken}">无效详情</a>${searchHtml}`
    })
    decide.mockImplementation((state) => {
      const bad = state.candidates.find((candidate) => candidate.url === broken)
      return state.missing[0] === 'detail' && bad ? { candidateId: bad.id, kind: 'detail' } : choose(state)
    })
    await exploreSite(options)
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([searchUrl, broken, detailUrl, playUrl])
    expect(decide.mock.calls.some(([state]) => state.feedback.includes('访问') && state.feedback.includes('失败'))).toBe(true)
  })

  it('rejects invented action IDs and stops after a bounded number of attempts', async () => {
    const { options, decide, fetchPage } = setup()
    decide.mockReturnValue({ candidateId: 'invented-link', kind: 'search' })
    await expect(exploreSite(options)).rejects.toThrow('最多执行 8 次探索')
    expect(requestLlmJsonText).toHaveBeenCalledTimes(8)
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('does not offer private, executable, or unrelated external links for browsing', async () => {
    const { options, decide } = setup(`${homeHtml}
      <a href="http://127.0.0.1/admin">本机</a><a href="https://other.example/detail/1">其他网站</a>
      <a href="/installer.exe">下载</a><a href="/logout">退出</a>`)
    await exploreSite(options)
    for (const [state] of decide.mock.calls) {
      expect(state.candidates.every((candidate) => !/127\.0\.0\.1|other\.example|installer\.exe|\/logout/.test(candidate.url))).toBe(true)
    }
    for (const [, prompt] of vi.mocked(requestLlmJsonText).mock.calls) {
      expect(prompt.input).not.toContain(connection.apiKey)
    }
  })

  it('requires the model to obtain search results before choosing a movie detail page', async () => {
    const { options, decide, choose, fetchPage } = setup()
    decide.mockImplementationOnce((state) => ({ candidateId: state.candidates.find((candidate) => candidate.url === detailUrl)!.id, kind: 'detail' }))
      .mockImplementation(choose)
    await exploreSite(options)
    expect(fetchPage.mock.calls[0]?.[0]).toBe(searchUrl)
    expect(decide.mock.calls[1]?.[0].feedback).toContain('先获得真实搜索结果')
  })

  it('respects explicitly provided samples without additional browsing requests', async () => {
    const { options, fetchPage } = setup()
    await exploreSite({ ...options, search: page(searchUrl, searchHtml), detail: page(detailUrl, detailHtml), play: page(playUrl, playHtml) })
    expect(fetchPage).not.toHaveBeenCalled()
    expect(requestLlmJsonText).not.toHaveBeenCalled()
  })

  it('propagates provider rate limits immediately', async () => {
    const { options, fetchPage } = setup()
    vi.mocked(requestLlmJsonText).mockRejectedValue(new Error('429 rate limit'))
    await expect(exploreSite(options)).rejects.toThrow('429')
    expect(requestLlmJsonText).toHaveBeenCalledOnce()
    expect(fetchPage).not.toHaveBeenCalled()
  })
})
