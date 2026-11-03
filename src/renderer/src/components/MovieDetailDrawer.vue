<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import FavoriteButton from './FavoriteButton.vue'
import type { FavoriteInput, FavoriteItem, PlayerContext, SearchResultItem, VodDetail } from '../types'
import { detailPlaylists, episodeName } from '../types'
import { coverSource, errorMessage, safeHostname } from '../utils'

const props = defineProps<{ item: SearchResultItem; favorites: FavoriteItem[]; pending: string[]; favoritesLoading: boolean }>()
const emit = defineEmits<{
  close: []
  play: [context: PlayerContext]
  favorite: [item: FavoriteInput]
}>()
const detail = ref<VodDetail | null>(null)
const loading = ref(false)
const loadError = ref('')
const activePlaylist = ref(0)
let sequence = 0
const playlists = computed(() => detail.value ? detailPlaylists(detail.value) : [])
const episodes = computed(() => playlists.value[activePlaylist.value]?.episodes || [])
const favorite = computed<FavoriteInput>(() => ({
  siteId: props.item.siteId, siteName: props.item.siteName,
  title: detail.value?.title || props.item.title,
  coverUrl: detail.value?.coverUrl || props.item.coverUrl,
  detailUrl: props.item.detailUrl
}))

async function loadDetail(): Promise<void> {
  const request = ++sequence
  detail.value = null
  loading.value = true
  loadError.value = ''
  activePlaylist.value = 0
  try {
    const value = await window.api.vod.detail({ siteId: props.item.siteId, detailUrl: props.item.detailUrl })
    if (request !== sequence) return
    detail.value = value
    activePlaylist.value = Math.max(0, detailPlaylists(value).findIndex((playlist) => playlist.episodes.length))
  } catch (error) {
    if (request === sequence) loadError.value = errorMessage(error)
  } finally {
    if (request === sequence) loading.value = false
  }
}

function playEpisode(index: number): void {
  if (!detail.value || !episodes.value[index]) return
  emit('play', {
    siteId: props.item.siteId, title: favorite.value.title, coverUrl: favorite.value.coverUrl,
    detailUrl: props.item.detailUrl, playlists: playlists.value,
    playlistIndex: activePlaylist.value, episodeIndex: index
  })
}

function imageFailed(event: Event): void {
  ;(event.currentTarget as HTMLImageElement).style.display = 'none'
}

watch(() => [props.item.siteId, props.item.detailUrl], loadDetail, { immediate: true })
onBeforeUnmount(() => { sequence += 1 })
</script>

<template>
  <div class="detail-backdrop" @click.self="emit('close')">
    <aside class="detail-drawer" role="dialog" aria-modal="true" aria-label="影片详情">
      <header class="drawer-header">
        <FavoriteButton :item="favorite" :favorites="favorites" :pending="pending" :disabled="favoritesLoading" @toggle="emit('favorite', $event)" />
        <button type="button" class="icon-button" aria-label="关闭详情" @click="emit('close')"><UiIcon name="close" :size="20" /></button>
      </header>
      <div v-if="loading" class="detail-loading">
        <span class="spinner"></span>
        <strong>正在解析详情与选集</strong>
        <small>{{ safeHostname(item.detailUrl) }}</small>
      </div>
      <div v-else-if="loadError" class="state-panel error-state compact-state">
        <span class="state-icon"><UiIcon name="alert" :size="28" /></span>
        <h2>详情解析失败</h2><p>{{ loadError }}</p>
        <button type="button" class="secondary-button" @click="loadDetail"><UiIcon name="refresh" :size="17" />重试</button>
      </div>
      <template v-else-if="detail">
        <div class="detail-hero">
          <div class="detail-cover">
            <span class="poster-fallback"><UiIcon name="film" :size="34" /></span>
            <img v-if="favorite.coverUrl" :src="coverSource(favorite.coverUrl)" :alt="favorite.title" @error="imageFailed" />
          </div>
          <div class="detail-copy">
            <span class="source-chip"><i></i>{{ item.siteName || item.siteId }}</span>
            <h2>{{ favorite.title }}</h2>
            <p>{{ detail.description || item.description || '站点暂未提供影片简介。' }}</p>
          </div>
        </div>
        <div class="episode-panel">
          <div class="episode-panel-header">
            <div><span class="eyebrow">EPISODES</span><h3>选择剧集</h3></div>
            <span>{{ episodes.length }} 集</span>
          </div>
          <div v-if="playlists.length > 1" class="playlist-tabs" role="tablist">
            <button v-for="(playlist, index) in playlists" :key="`${playlist.name}:${index}`" type="button" :class="{ active: activePlaylist === index }" @click="activePlaylist = index">
              {{ playlist.name || `线路 ${index + 1}` }}
            </button>
          </div>
          <div v-if="episodes.length" class="episode-grid">
            <button v-for="(episode, index) in episodes" :key="`${episode.url}:${index}`" type="button" @click="playEpisode(index)">
              <UiIcon name="play" :size="14" /><span>{{ episodeName(episode) }}</span>
            </button>
          </div>
          <div v-else class="inline-empty">该线路没有解析到剧集</div>
        </div>
      </template>
    </aside>
  </div>
</template>
