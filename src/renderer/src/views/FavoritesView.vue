<script setup lang="ts">
import { computed, ref } from 'vue'
import UiIcon from '../components/UiIcon.vue'
import FavoriteButton from '../components/FavoriteButton.vue'
import type { FavoriteInput, FavoriteItem } from '../types'
import { coverSource, formatRelativeTime } from '../utils'

const props = defineProps<{ items: FavoriteItem[]; loading: boolean; error: string; pending: string[] }>()
const emit = defineEmits<{
  open: [item: FavoriteItem]
  favorite: [item: FavoriteInput]
  explore: []
  reload: []
}>()
const keyword = ref('')
const visibleItems = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase()
  return query ? props.items.filter((item) => `${item.title}\n${item.siteName}`.toLocaleLowerCase().includes(query)) : props.items
})
function imageFailed(event: Event): void {
  ;(event.currentTarget as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <section class="page favorites-page">
    <header class="page-header">
      <div>
        <span class="eyebrow"><span class="eyebrow-dot"></span>WATCHLIST</span>
        <h1>我的收藏</h1>
        <p>把想看的影片留在这里，随时打开选集。</p>
      </div>
      <button type="button" class="primary-button" @click="emit('explore')"><UiIcon name="search" :size="18" />发现影片</button>
    </header>
    <div v-if="loading" class="state-panel" aria-label="正在加载收藏"><span class="spinner"></span><h2>正在加载收藏</h2></div>
    <div v-else-if="error" class="state-panel error-state">
      <span class="state-icon"><UiIcon name="alert" :size="28" /></span>
      <h2>收藏加载失败</h2><p>{{ error }}</p>
      <button type="button" class="secondary-button" @click="emit('reload')"><UiIcon name="refresh" :size="17" />重新加载</button>
    </div>
    <div v-else-if="!items.length" class="state-panel empty-library">
      <span class="state-icon"><UiIcon name="bookmark" :size="32" /></span>
      <h2>还没有收藏影片</h2>
      <p>在搜索结果、详情或播放页面点击收藏，喜欢的影片就会出现在这里。</p>
      <button type="button" class="primary-button" @click="emit('explore')"><UiIcon name="search" :size="18" />去找想看的影片</button>
    </div>
    <template v-else>
      <div class="favorites-toolbar">
        <span>{{ items.length }} 部收藏 · 按收藏时间排序</span>
        <label class="favorites-filter"><UiIcon name="search" :size="17" /><input v-model="keyword" type="search" placeholder="搜索收藏的影片或站点…" aria-label="搜索收藏" /></label>
      </div>
      <div v-if="!visibleItems.length" class="state-panel compact-state"><h2>没有匹配的收藏</h2><p>试试其他片名或站点名称。</p></div>
      <div v-else class="poster-grid">
        <article v-for="item in visibleItems" :key="item.favoriteId" class="result-card">
          <div class="favorite-poster">
            <button type="button" class="result-cover" :aria-label="`查看选集 ${item.title}`" @click="emit('open', item)">
              <span class="poster-fallback"><UiIcon name="film" :size="34" /></span>
              <img v-if="item.coverUrl" :src="coverSource(item.coverUrl)" :alt="item.title" loading="lazy" @error="imageFailed" />
              <span class="result-overlay"><span class="poster-play"><UiIcon name="play" :size="22" /></span><small>查看选集</small></span>
            </button>
            <FavoriteButton :item="item" :favorites="items" :pending="pending" compact @toggle="emit('favorite', $event)" />
          </div>
          <button type="button" class="result-copy" @click="emit('open', item)"><strong :title="item.title">{{ item.title }}</strong><span><i></i>{{ item.siteName || item.siteId }}</span></button>
          <small class="favorite-date">{{ formatRelativeTime(item.createdAt) }}收藏</small>
        </article>
      </div>
    </template>
  </section>
</template>
