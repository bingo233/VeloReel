<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import UiIcon from '../components/UiIcon.vue'
import FavoriteButton from '../components/FavoriteButton.vue'
import type { FavoriteInput, FavoriteItem, SeriesHistoryItem, ToastMessage } from '../types'
import { coverSource, errorMessage, formatDuration, formatRelativeTime, progressPercent } from '../utils'

const props = defineProps<{ revision: number; opening: boolean; favorites?: FavoriteItem[]; favoritePending?: string[]; favoritesLoading?: boolean }>()
const emit = defineEmits<{
  continue: [item: SeriesHistoryItem]
  explore: []
  favorite: [item: FavoriteInput]
  notify: [tone: ToastMessage['tone'], title: string, message?: string]
}>()

const histories = ref<SeriesHistoryItem[]>([])
const loading = ref(true)
const loadError = ref('')
const pendingDelete = ref<SeriesHistoryItem | null>(null)
const confirmClear = ref(false)
const mutating = ref(false)

const totalEpisodes = computed(() =>
  histories.value.reduce((total, item) => total + Object.keys(item.episodes || {}).length, 0)
)
const finishedEpisodes = computed(() =>
  histories.value.reduce(
    (total, item) => total + Object.values(item.episodes || {}).filter((episode) => episode.isFinished).length,
    0
  )
)

async function loadHistory(silent = false): Promise<void> {
  if (!silent) loading.value = true
  loadError.value = ''
  try {
    histories.value = await window.api.history.list()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function removeHistory(): Promise<void> {
  if (!pendingDelete.value || mutating.value) return
  mutating.value = true
  try {
    await window.api.history.remove({ seriesId: pendingDelete.value.seriesId })
    histories.value = histories.value.filter((item) => item.seriesId !== pendingDelete.value?.seriesId)
    pendingDelete.value = null
    emit('notify', 'success', '已移除观看记录')
  } catch (error) {
    emit('notify', 'danger', '移除失败', errorMessage(error))
  } finally {
    mutating.value = false
  }
}

async function clearHistory(): Promise<void> {
  if (mutating.value) return
  mutating.value = true
  try {
    await window.api.history.clear()
    histories.value = []
    confirmClear.value = false
    emit('notify', 'success', '观看记录已清空')
  } catch (error) {
    emit('notify', 'danger', '清空失败', errorMessage(error))
  } finally {
    mutating.value = false
  }
}

function imageFailed(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.style.display = 'none'
}

watch(
  () => props.revision,
  () => loadHistory(true)
)
onMounted(() => loadHistory())
</script>

<template>
  <section class="page history-page">
    <header class="page-header">
      <div>
        <span class="eyebrow"><span class="eyebrow-dot"></span>YOUR LIBRARY</span>
        <h1>继续观看</h1>
        <p>从上次停下的地方继续，每一秒都已为你记住。</p>
      </div>
      <div class="header-actions">
        <button
          v-if="histories.length"
          type="button"
          class="ghost-button danger-on-hover"
          @click="confirmClear = true"
        >
          <UiIcon name="trash" :size="17" />
          清空记录
        </button>
        <button type="button" class="primary-button" @click="emit('explore')">
          <UiIcon name="search" :size="18" />
          发现影片
        </button>
      </div>
    </header>

    <div v-if="!loading && histories.length" class="library-summary">
      <div class="summary-copy">
        <span class="summary-icon"><UiIcon name="film" :size="22" /></span>
        <span>
          <strong>{{ histories.length }} 部作品</strong>
          <small>{{ totalEpisodes }} 集有观看记录 · {{ finishedEpisodes }} 集已看完</small>
        </span>
      </div>
      <div class="summary-stripes"></div>
    </div>

    <div v-if="loading" class="history-grid" aria-label="正在加载观看记录">
      <div v-for="index in 6" :key="index" class="history-card skeleton-card">
        <div class="skeleton skeleton-cover"></div>
        <div class="skeleton-body">
          <span class="skeleton skeleton-line wide"></span>
          <span class="skeleton skeleton-line"></span>
          <span class="skeleton skeleton-line short"></span>
        </div>
      </div>
    </div>

    <div v-else-if="loadError" class="state-panel error-state">
      <span class="state-icon"><UiIcon name="alert" :size="28" /></span>
      <h2>没有读到观看记录</h2>
      <p>{{ loadError }}</p>
      <button type="button" class="secondary-button" @click="loadHistory()">
        <UiIcon name="refresh" :size="17" />重新加载
      </button>
    </div>

    <div v-else-if="!histories.length" class="state-panel empty-library">
      <div class="empty-orbit">
        <span class="empty-orbit-ring"></span>
        <span class="state-icon"><UiIcon name="play" :size="32" /></span>
      </div>
      <span class="eyebrow">A FRESH START</span>
      <h2>片库还是空的</h2>
      <p>搜索一部想看的影片，播放进度会自动出现在这里。</p>
      <button type="button" class="primary-button" @click="emit('explore')">
        <UiIcon name="search" :size="18" />开始探索
      </button>
    </div>

    <div v-else class="history-grid">
      <article v-for="item in histories" :key="item.seriesId" class="history-card">
        <button
          type="button"
          class="poster-action"
          :aria-label="`继续播放 ${item.title}`"
          :disabled="opening"
          @click="emit('continue', item)"
        >
          <span class="poster-fallback"><UiIcon name="film" :size="34" /></span>
          <img v-if="item.coverUrl" :src="coverSource(item.coverUrl)" :alt="item.title" @error="imageFailed" />
          <span class="poster-shade"></span>
          <span class="poster-play"><UiIcon name="play" :size="24" /></span>
          <span v-if="progressPercent(item.lastCurrentTime, item.lastDuration) >= 95" class="watched-badge">
            <UiIcon name="check" :size="12" />已看完
          </span>
        </button>
        <div class="history-card-body">
          <div class="card-title-row">
            <div>
              <h2 :title="item.title">{{ item.title }}</h2>
              <p>{{ item.lastEpisodeName }}</p>
            </div>
            <button
              type="button"
              class="icon-button subtle"
              aria-label="移除记录"
              @click="pendingDelete = item"
            >
              <UiIcon name="trash" :size="16" />
            </button>
          </div>
          <div class="watch-progress" aria-label="播放进度">
            <span
              class="watch-progress-fill"
              :style="{ width: `${progressPercent(item.lastCurrentTime, item.lastDuration)}%` }"
            ></span>
          </div>
          <div class="card-meta">
            <span>{{ formatDuration(item.lastCurrentTime) }} / {{ formatDuration(item.lastDuration) }}</span>
            <span>{{ formatRelativeTime(item.updatedAt) }}</span>
          </div>
          <FavoriteButton :item="{ ...item, siteName: '' }" :favorites="favorites" :pending="favoritePending" :disabled="favoritesLoading" @toggle="emit('favorite', $event)" />
          <button
            type="button"
            class="continue-button"
            :disabled="opening"
            @click="emit('continue', item)"
          >
            <UiIcon name="play" :size="16" />
            {{ opening ? '正在载入…' : '继续播放' }}
            <UiIcon name="chevron" :size="15" />
          </button>
        </div>
      </article>
    </div>

    <Transition name="modal">
      <div v-if="pendingDelete || confirmClear" class="modal-backdrop" @click.self="pendingDelete = null; confirmClear = false">
        <div class="confirm-dialog" role="dialog" aria-modal="true">
          <span class="dialog-icon danger"><UiIcon name="trash" :size="22" /></span>
          <h2>{{ confirmClear ? '清空全部观看记录？' : `移除《${pendingDelete?.title}》？` }}</h2>
          <p>{{ confirmClear ? '所有影片和分集进度都会被删除，此操作无法撤销。' : '这部影片的所有分集进度都会被删除。' }}</p>
          <div class="dialog-actions">
            <button type="button" class="ghost-button" @click="pendingDelete = null; confirmClear = false">取消</button>
            <button type="button" class="danger-button" :disabled="mutating" @click="confirmClear ? clearHistory() : removeHistory()">
              {{ mutating ? '处理中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>
