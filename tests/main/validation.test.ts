import { describe, expect, it } from 'vitest'
import { assertSiteRule } from '../../src/main/validation'

function baseRule(regex: string): unknown {
  return {
    siteId: 'demo',
    siteName: 'Demo',
    baseUrl: 'https://example.com',
    search: {
      urlTemplate: 'https://example.com/search?q={keyword}',
      listSelector: '.item',
      titleSelector: '.title',
      detailUrlSelector: 'a@href'
    },
    detail: {
      episodeListSelector: '.episodes a',
      episodeNameSelector: '@text',
      episodeUrlSelector: '@href'
    },
    streamExtraction: {
      primaryMode: 'static',
      staticRule: { regex, decodePipeline: [] },
      fallbackMode: 'sniffer'
    }
  }
}

describe('site rule validation', () => {
  it('accepts a bounded extraction regex', () => {
    expect(assertSiteRule(baseRule('"url":"([^"]+)"')).siteId).toBe('demo')
  })

  it('rejects a common nested-quantifier ReDoS pattern', () => {
    expect(() => assertSiteRule(baseRule('(a+)+$'))).toThrow(/嵌套量词/)
  })
})
