<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import HistoryView from './views/HistoryView.vue'
import SearchView from './views/SearchView.vue'
import FavoritesView from './views/FavoritesView.vue'
import RulesView from './views/RulesView.vue'
import SettingsView from './views/SettingsView.vue'
import PlayerOverlay from './components/PlayerOverlay.vue'
import ToastStack from './components/ToastStack.vue'
import UiIcon from './components/UiIcon.vue'
import MovieDetailDrawer from './components/MovieDetailDrawer.vue'
import type {
  FavoriteInput,
  FavoriteItem,
  NavigationKey,
  PlayerContext,
  SearchResultItem,
  SeriesHistoryItem,
  ToastMessage
} from './types'
import { detailPlaylists, episodeUrl } from './types'
import { errorMessage } from './utils'
import { favoriteKey } from './favorites'

const activeView = ref<NavigationKey>('history')
const player = ref<PlayerContext | null>(null)
const playerKey = ref(0)
const historyRevision = ref(0)
const rulesRevision = ref(0)
const version = ref('')
const openingHistory = ref(false)
const toasts = ref<ToastMessage[]>([])
const favorites = ref<FavoriteItem[]>([])
const favoritesLoading = ref(true)
const favoritesError = ref('')
const favoritePending = ref<string[]>([])
const detailTarget = ref<SearchResultItem | null>(null)
let toastSequence = 0

const navigation = [
  { id: 'history' as const, label: '继续观看', icon: 'history' as const },
  { id: 'favorites' as const, label: '我的收藏', icon: 'bookmark' as const },
  { id: 'search' as const, label: '聚合搜索', icon: 'search' as const },
  { id: 'rules' as const, label: '站点规则', icon: 'globe' as const },
  { id: 'settings' as const, label: '偏好设置', icon: 'settings' as const }
]

const currentLabel = computed(
  () => navigation.find((item) => item.id === activeView.value)?.label || '影梭'
)

function notify(
  tone: ToastMessage['tone'],
  title: string,
  message?: string,
  duration = 3800
): void {
  const id = ++toastSequence
  toasts.value.push({ id, tone, title, message })
  if (tone !== 'danger') window.setTimeout(() => dismissToast(id), duration)
}

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((item) => item.id !== id)
}

async function loadFavorites(): Promise<void> {
  favoritesLoading.value = true
  favoritesError.value = ''
  try { favorites.value = await window.api.favorites.list() }
  catch (error) { favoritesError.value = errorMessage(error) }
  finally { favoritesLoading.value = false }
}

async function toggleFavorite(input: FavoriteInput): Promise<void> {
  if (favoritesLoading.value) return
  if (favoritesError.value) {
    await loadFavorites()
    if (favoritesError.value) { notify('danger', '收藏加载失败', favoritesError.value); return }
  }
  const key = favoriteKey(input)
  if (favoritePending.value.includes(key)) return
  favoritePending.value = [...favoritePending.value, key]
  try {
    const existing = favorites.value.find((item) => favoriteKey(item) === key)
    if (existing) {
      await window.api.favorites.remove({ favoriteId: existing.favoriteId })
      favorites.value = favorites.value.filter((item) => item.favoriteId !== existing.favoriteId)
      notify('success', '已取消收藏', input.title)
    } else {
      const saved = await window.api.favorites.add({
        siteId: input.siteId, siteName: input.siteName, title: input.title,
        coverUrl: input.coverUrl, detailUrl: input.detailUrl
      })
      favorites.value = [saved, ...favorites.value.filter((item) => item.favoriteId !== saved.favoriteId)]
        .sort((a, b) => b.createdAt - a.createdAt)
      notify('success', '已加入收藏', saved.title)
    }
  } catch (error) {
    notify('danger', '收藏操作失败', errorMessage(error))
  } finally { favoritePending.value = favoritePending.value.filter((item) => item !== key) }
}

function openPlayer(context: PlayerContext): void {
  player.value = context
  playerKey.value += 1
}

async function continueHistory(item: SeriesHistoryItem): Promise<void> {
  if (openingHistory.value) return
  openingHistory.value = true
  try {
    const detail = await window.api.vod.detail({ siteId: item.siteId, detailUrl: item.detailUrl })
    const playlists = detailPlaylists(detail)
    let playlistIndex = 0
    let episodeIndex = 0
    let located = false
    playlists.some((playlist, lineIndex) =>
      playlist.episodes.some((episode, itemIndex) => {
        if (episodeUrl(episode) !== item.lastEpisodeUrl) return false
        playlistIndex = lineIndex
        episodeIndex = itemIndex
        located = true
        return true
      })
    )
    if (!playlists.length) throw new Error('该站点没有返回可播放的剧集')
    if (!located) {
      const firstPlayableLine = playlists.findIndex((playlist) => playlist.episodes.length > 0)
      if (firstPlayableLine < 0) throw new Error('该站点没有返回可播放的剧集')
      playlistIndex = firstPlayableLine
      episodeIndex = 0
      notify('warning', '剧集列表已更新', '将从当前线路第一集开始')
    }
    openPlayer({
      siteId: item.siteId,
      title: item.title || detail.title,
      coverUrl: item.coverUrl || detail.coverUrl,
      detailUrl: item.detailUrl,
      playlists,
      playlistIndex,
      episodeIndex
    })
  } catch (error) {
    notify('danger', '无法继续播放', errorMessage(error))
  } finally {
    openingHistory.value = false
  }
}

function onPlaybackSaved(): void {
  historyRevision.value += 1
}

function onRulesChanged(): void {
  rulesRevision.value += 1
}

onMounted(async () => {
  void loadFavorites()
  try {
    version.value = await window.api.getVersion()
  } catch {
    version.value = 'dev'
  }
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand" aria-label="影梭 VeloReel 播放器">
        <span class="brand-mark"><span></span></span>
        <span class="brand-copy">
          <strong>影梭</strong>
          <small>VELOREEL</small>
        </span>
      </div>

      <nav class="main-navigation" aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          type="button"
          class="nav-item"
          :class="{ active: activeView === item.id }"
          @click="activeView = item.id; detailTarget = null"
        >
          <UiIcon :name="item.icon" :size="20" />
          <span>{{ item.label }}</span>
          <small v-if="item.id === 'favorites' && favorites.length" class="nav-count">{{ favorites.length }}</small>
          <span v-if="activeView === item.id" class="nav-indicator"></span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <div class="core-status">
          <span class="status-dot"></span>
          <span>
            <strong>本地核心已就绪</strong>
            <small>127.0.0.1 · 安全连接</small>
          </span>
        </div>
        <span class="version">v{{ version || '…' }}</span>
      </div>
    </aside>

    <main class="workspace" :aria-label="currentLabel">
      <HistoryView
        v-if="activeView === 'history'"
        :revision="historyRevision"
        :opening="openingHistory"
        :favorites="favorites"
        :favorite-pending="favoritePending"
        :favorites-loading="favoritesLoading"
        @favorite="toggleFavorite"
        @continue="continueHistory"
        @explore="activeView = 'search'"
        @notify="notify"
      />
      <SearchView
        v-else-if="activeView === 'search'"
        :rules-revision="rulesRevision"
        :favorites="favorites"
        :favorite-pending="favoritePending"
        :favorites-loading="favoritesLoading"
        @open-detail="detailTarget = $event"
        @favorite="toggleFavorite"
        @open-rules="activeView = 'rules'"
        @notify="notify"
      />
      <FavoritesView
        v-else-if="activeView === 'favorites'"
        :items="favorites"
        :loading="favoritesLoading"
        :error="favoritesError"
        :pending="favoritePending"
        @open="detailTarget = $event"
        @favorite="toggleFavorite"
        @explore="activeView = 'search'"
        @reload="loadFavorites"
      />
      <RulesView
        v-else-if="activeView === 'rules'"
        @changed="onRulesChanged"
        @notify="notify"
      />
      <SettingsView v-else @notify="notify" />
    </main>

    <Transition name="drawer">
      <MovieDetailDrawer
        v-if="detailTarget"
        :item="detailTarget"
        :favorites="favorites"
        :pending="favoritePending"
        :favorites-loading="favoritesLoading"
        @close="detailTarget = null"
        @play="openPlayer"
        @favorite="toggleFavorite"
      />
    </Transition>

    <Transition name="player-fade">
      <PlayerOverlay
        v-if="player"
        :key="playerKey"
        :context="player"
        :favorites="favorites"
        :favorite-pending="favoritePending"
        :favorites-loading="favoritesLoading"
        @favorite="toggleFavorite"
        @close="player = null"
        @saved="onPlaybackSaved"
        @notify="notify"
      />
    </Transition>

    <ToastStack :messages="toasts" @dismiss="dismissToast" />
  </div>
</template>
