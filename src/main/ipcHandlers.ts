import { app, ipcMain, type WebContents } from 'electron'
import { IPC } from '../shared/ipc'
import type { AppSettings } from '../shared/types'
import type { HlsProxyServer } from './hlsProxyServer'
import type { LanService } from './lanService'
import type { LlmRuleGenerator } from './llmRuleGenerator'
import { testLlmConnection } from './llmConnectionTest'
import type { AppStorage } from './storage'
import type { StreamResolver } from './streamResolver'
import { requireRecord, requireString } from './validation'
import type { VodService } from './vodService'
import { assertTrustedIpcSender } from './windowSecurity'

interface Dependencies {
  storage: AppStorage
  vod: VodService
  resolver: StreamResolver
  proxy: HlsProxyServer
  ruleGenerator: LlmRuleGenerator
  lan: LanService
  rendererUrl: string
  getPlayerContents: () => WebContents | undefined
}

const channels = Object.values(IPC)

export function registerIpcHandlers(deps: Dependencies): () => void {
  const { storage, vod, resolver, proxy, ruleGenerator, lan } = deps
  for (const channel of channels) ipcMain.removeHandler(channel)

  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedIpcSender(event, deps.getPlayerContents(), deps.rendererUrl)
      return listener(event, ...args)
    })
  }

  handle(IPC.APP_VERSION, () => app.getVersion())
  handle(IPC.RULE_LIST, () => storage.listRules())
  handle(IPC.RULE_SAVE, (_event, rule: unknown) => storage.saveRule(rule))
  handle(IPC.RULE_REMOVE, (_event, siteId: unknown) => {
    const id = requireString(siteId, '站点 ID', 80)
    storage.removeRule(id)
    resolver.removeSite(id)
  })
  handle(IPC.RULE_GENERATE, (event, input: unknown) => ruleGenerator.generate(input, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send(IPC.RULE_GENERATION_PROGRESS, progress)
  }))

  handle(IPC.VOD_SEARCH, (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '搜索参数')
    return vod.search({
      keyword: requireString(input.keyword, '搜索关键词', 100),
      siteId: typeof input.siteId === 'string' && input.siteId
        ? requireString(input.siteId, '站点 ID', 80)
        : undefined
    })
  })
  handle(IPC.VOD_DETAIL, (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '详情参数')
    return vod.detail({
      siteId: requireString(input.siteId, '站点 ID', 80),
      detailUrl: requireString(input.detailUrl, '详情地址')
    })
  })

  handle(IPC.STREAM_RESOLVE, async (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '流解析参数')
    const siteId = requireString(input.siteId, '站点 ID', 80)
    const playPageUrl = requireString(input.playPageUrl, '播放页地址')
    const rule = storage.getRule(siteId)
    if (!rule) throw new Error(`找不到站点规则：${siteId}`)
    const extracted = await resolver.resolve(playPageUrl, rule, input.forceRefresh === true)
    const resolution = proxy.register(extracted)
    if (extracted.extractedBy === 'sniffer' && !extracted.fromCache) {
      void ruleGenerator.autoHeal(rule, playPageUrl, extracted.url).catch((error) => {
        console.warn('[auto-heal] skipped:', error instanceof Error ? error.message : String(error))
      })
    }
    return resolution
  })
  handle(IPC.STREAM_RELEASE, (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '代理会话参数')
    proxy.release(requireString(input.sessionId, '代理会话 ID', 100))
  })

  handle(IPC.HISTORY_LIST, () => storage.listHistory())
  handle(IPC.HISTORY_GET, (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '历史记录参数')
    return storage.getHistory(requireString(input.seriesId, '剧集 ID', 128))
  })
  handle(IPC.HISTORY_SAVE, (_event, payload: unknown) => storage.saveProgress(payload))
  handle(IPC.HISTORY_REMOVE, (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '历史记录参数')
    storage.removeHistory(requireString(input.seriesId, '剧集 ID', 128))
  })
  handle(IPC.HISTORY_CLEAR, () => storage.clearHistory())

  handle(IPC.FAVORITE_LIST, () => storage.listFavorites())
  handle(IPC.FAVORITE_ADD, (_event, input: unknown) => storage.addFavorite(input))
  handle(IPC.FAVORITE_REMOVE, (_event, inputValue: unknown) => {
    const input = requireRecord(inputValue, '收藏参数')
    storage.removeFavorite(requireString(input.favoriteId, '收藏 ID', 80))
  })

  handle(IPC.SETTINGS_GET, () => storage.getSettings())
  handle(IPC.SETTINGS_SAVE, async (_event, settings: Partial<AppSettings>) => {
    const saved = storage.saveSettings(settings)
    await lan.apply(saved)
    return saved
  })
  handle(IPC.SETTINGS_HAS_API_KEY, () => storage.hasApiKey())
  handle(IPC.SETTINGS_SET_API_KEY, (_event, apiKey: unknown) => {
    storage.saveApiKey(requireString(apiKey, 'API Key', 10_000))
  })
  handle(IPC.SETTINGS_CLEAR_API_KEY, () => storage.clearApiKey())
  handle(IPC.SETTINGS_TEST_CONNECTION, (_event, input: unknown) => testLlmConnection(input, storage))
  handle(IPC.LAN_STATUS, () => lan.getStatus())

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
