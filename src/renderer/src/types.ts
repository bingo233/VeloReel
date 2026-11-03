import type {
  AppSettings,
  Episode,
  PlaylistGroup,
  RuleGenerateInput,
  SearchResultItem as CoreSearchResultItem,
  SeriesHistoryItem,
  SiteRule,
  StreamResolution,
  VodDetail
} from '../../shared/types'

export type {
  AppSettings,
  FavoriteInput,
  FavoriteItem,
  Episode,
  PlaylistGroup,
  RuleGenerateInput,
  SeriesHistoryItem,
  SiteRule,
  StreamResolution,
  VodDetail
} from '../../shared/types'

export type NavigationKey = 'history' | 'favorites' | 'search' | 'rules' | 'settings'
export type Playlist = PlaylistGroup
export type GenerateRuleInput = RuleGenerateInput

export interface SearchResultItem extends CoreSearchResultItem {
  description?: string
  latestEpisode?: string
}

export interface PlayerContext {
  siteId: string
  title: string
  coverUrl: string
  detailUrl: string
  playlists: Playlist[]
  playlistIndex: number
  episodeIndex: number
}

export interface ToastMessage {
  id: number
  tone: 'info' | 'success' | 'warning' | 'danger'
  title: string
  message?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  llmApiBaseUrl: 'https://api.openai.com/v1',
  llmModel: 'gpt-4.1-mini',
  llmApiType: 'chat_completions',
  llmHttpHeaders: {},
  llmStoreResponses: false,
  autoPlayNext: true,
  skipIntroSeconds: 0,
  skipOutroSeconds: 0,
  proxyPrefetchCount: 4,
  proxyCacheMegabytes: 128,
  lanEnabled: false,
  lanPort: 8790,
  deviceName: '影梭'
}

export function episodeName(episode: Episode): string {
  return episode.name || '未命名剧集'
}

export function episodeUrl(episode: Episode): string {
  return episode.url || ''
}

export function detailPlaylists(detail: VodDetail): Playlist[] {
  return detail.playlistGroups || []
}
