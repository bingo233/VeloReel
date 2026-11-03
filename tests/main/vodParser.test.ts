import { describe, expect, it } from 'vitest'
import type { SiteRule } from '../../src/shared/types'
import { __testing } from '../../src/main/vodService'

const rule: SiteRule = {
  siteId: 'demo',
  siteName: 'Demo',
  baseUrl: 'https://video.example/',
  search: {
    urlTemplate: 'https://video.example/search?q={keyword}',
    listSelector: '.result',
    titleSelector: '.name',
    detailUrlSelector: 'a@href',
    coverUrlSelector: 'img@data-src'
  },
  detail: {
    titleSelector: 'h1',
    coverUrlSelector: '.cover@src',
    descriptionSelector: '.summary',
    playlistGroupSelector: '.tab',
    episodeGroupSelector: '.playlist',
    episodeListSelector: 'a',
    episodeNameSelector: '@text',
    episodeUrlSelector: '@href'
  },
  streamExtraction: {
    primaryMode: 'static',
    staticRule: {
      regex: '"url":"([^"]+)"',
      decodePipeline: ['unescape_slashes']
    },
    fallbackMode: 'sniffer'
  }
}

describe('VOD page parser', () => {
  it('parses and de-duplicates search results', () => {
    const html = `
      <div class="result"><a href="/show/1"><span class="name">示例剧</span></a><img data-src="/1.jpg"></div>
      <div class="result"><a href="/show/1"><span class="name">示例剧</span></a><img data-src="/1.jpg"></div>`
    const result = __testing.parseSearchPage(rule, html, 'https://video.example/search')
    expect(result).toEqual([expect.objectContaining({
      title: '示例剧',
      detailUrl: 'https://video.example/show/1',
      coverUrl: 'https://video.example/1.jpg'
    })])
  })

  it('keeps episodes separated by playback line', () => {
    const html = `
      <h1>示例剧</h1><img class="cover" src="/cover.jpg"><p class="summary">简介</p>
      <button class="tab">线路 A</button><button class="tab">线路 B</button>
      <div class="playlist"><a href="/play/a1">第1集</a><a href="/play/a2">第2集</a></div>
      <div class="playlist"><a href="/play/b1">第1集</a></div>`
    const result = __testing.parseDetailPage(rule, html, 'https://video.example/show/1')
    expect(result.playlistGroups).toHaveLength(2)
    expect(result.playlistGroups[0]?.name).toBe('线路 A')
    expect(result.playlistGroups[0]?.episodes[1]?.url).toBe('https://video.example/play/a2')
    expect(result.playlistGroups[1]?.name).toBe('线路 B')
  })
})
