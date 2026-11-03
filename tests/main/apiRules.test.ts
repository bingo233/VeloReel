import { describe, expect, it } from 'vitest'

import { parseJsonPath, queryJson, queryString } from '../../src/main/jsonPath'
import { extractId, mapApiDetail, mapApiSearch, renderItemTemplate, renderTemplate } from '../../src/main/apiRuleEngine'
import type { SiteRule } from '../../src/shared/types'

describe('jsonPath', () => {
  const data = {
    data: {
      list: [
        { id: 1, name: '越狱', pic: '/a.jpg' },
        { id: 2, name: '绝命毒师', pic: '/b.jpg' }
      ],
      nested: { 'key with space': 42 }
    }
  }

  it('取标量与数组元素', () => {
    expect(queryString(data, '$.data.list[0].name')).toBe('越狱')
    expect(queryString(data, '$.data.nested["key with space"]')).toBe('42')
  })

  it('通配符收集所有匹配', () => {
    expect(queryJson(data, '$.data.list[*].name')).toEqual(['越狱', '绝命毒师'])
    expect(queryJson(data, '$.data.list')).toHaveLength(1)
  })

  it('路径不存在返回空，非法路径抛错', () => {
    expect(queryJson(data, '$.data.missing.deep')).toEqual([])
    expect(queryString(data, '$.nope')).toBe('')
    expect(() => parseJsonPath('data.list')).toThrow()
    expect(() => parseJsonPath('$.a?b')).toThrow()
  })
})

const apiRule: SiteRule = {
  siteId: 'spa_site',
  siteName: '示例站',
  baseUrl: 'https://spa.example',
  ruleType: 'api',
  apiSearch: {
    request: { method: 'GET', urlTemplate: 'https://spa.example/api/search?kw={keyword}' },
    list: '$.data.list',
    title: '$.name',
    detailUrlTemplate: 'https://spa.example/pc/detail/{id}',
    coverUrl: '$.pic'
  },
  apiDetail: {
    request: { method: 'GET', urlTemplate: 'https://spa.example/api/detail/{id}' },
    idRegex: '/detail/(\\d+)',
    title: '$.data.name',
    episodes: '$.data.eps',
    episodeName: '$.title',
    episodeUrlTemplate: 'https://spa.example/pc/play/{eid}'
  },
  apiStream: {
    request: { method: 'GET', urlTemplate: 'https://spa.example/api/play/{id}' },
    idRegex: '/play/(\\d+)',
    streamUrl: '$.data.url'
  }
}

describe('apiRuleEngine 映射', () => {
  it('renderTemplate 按模式编码', () => {
    expect(renderTemplate('https://x/?kw={keyword}', { keyword: '越狱 第一季' })).toBe('https://x/?kw=%E8%B6%8A%E7%8B%B1%20%E7%AC%AC%E4%B8%80%E5%AD%A3')
    expect(renderTemplate('{"kw":"{keyword}"}', { keyword: 'a"b' }, 'json')).toBe('{"kw":"a\\"b"}')
    expect(renderTemplate('{a}-{b}', { a: '1' }, 'raw')).toBe('1-')
  })

  it('renderItemTemplate 从条目字段取值', () => {
    expect(renderItemTemplate('https://x/pc/detail/{id}', { id: 868 })).toBe('https://x/pc/detail/868')
  })

  it('extractId 取第一个捕获组', () => {
    expect(extractId('/detail/(\\d+)', 'https://x/pc/detail/868?from=1')).toBe('868')
    expect(extractId(undefined, 'https://x')).toBeUndefined()
  })

  it('mapApiSearch 映射结果并拼接详情地址', () => {
    const payload = { data: { list: [{ id: 868, name: '周三俱乐部', pic: '/p.jpg' }, { id: 869, name: '' }] } }
    const items = mapApiSearch(apiRule, payload)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      siteId: 'spa_site',
      title: '周三俱乐部',
      detailUrl: 'https://spa.example/pc/detail/868',
      coverUrl: 'https://spa.example/p.jpg'
    })
  })

  it('mapApiDetail 映射剧集；无剧集抛错', () => {
    const payload = { data: { name: '周三俱乐部', eps: [{ eid: 1, title: 'EP1' }, { eid: 2, title: 'EP2' }] } }
    const detail = mapApiDetail(apiRule, payload, 'https://spa.example/pc/detail/868')
    expect(detail.title).toBe('周三俱乐部')
    expect(detail.playlistGroups[0]!.episodes.map((e) => e.name)).toEqual(['EP1', 'EP2'])
    expect(detail.playlistGroups[0]!.episodes[1]!.url).toBe('https://spa.example/pc/play/2')
    expect(() => mapApiDetail(apiRule, { data: { eps: [] } }, 'https://spa.example/pc/detail/868')).toThrow('没有剧集')
  })
})
