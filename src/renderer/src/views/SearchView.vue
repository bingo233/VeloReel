<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import UiIcon from '../components/UiIcon.vue'
import FavoriteButton from '../components/FavoriteButton.vue'
import type {
  FavoriteInput,
  FavoriteItem,
  SearchResultItem,
  SiteRule,
  ToastMessage
} from '../types'
import { coverSource, errorMessage } from '../utils'

const props = defineProps<{ rulesRevision: number; favorites: FavoriteItem[]; favoritePending: string[]; favoritesLoading: boolean }>()
const emit = defineEmits<{
  openDetail: [item: SearchResultItem]
  favorite: [item: FavoriteInput]
  openRules: []
  notify: [tone: ToastMessage['tone'], title: string, message?: string]
}>()

const keyword = ref('')
const selectedSite = ref('')
const rules = ref<SiteRule[]>([])
const loadingRules = ref(true)
const searching = ref(false)
const searched = ref(false)
const results = ref<SearchResultItem[]>([])
const searchError = ref('')
const resultTitle = computed(() => {
  if (!searched.value) return ''
  if (selectedSite.value) {
    return `在 ${rules.value.find((rule) => rule.siteId === selectedSite.value)?.siteName || '指定站点'} 找到 ${results.value.length} 个结果`
  }
  return `从 ${rules.value.length} 个站点找到 ${results.value.length} 个结果`
})

async function loadRules(): Promise<void> {
  loadingRules.value = true
  try {
    rules.value = await window.api.rules.list()
    if (selectedSite.value && !rules.value.some((rule) => rule.siteId === selectedSite.value)) {
      selectedSite.value = ''
    }
  } catch (error) {
    emit('notify', 'danger', '站点列表加载失败', errorMessage(error))
  } finally {
    loadingRules.value = false
  }
}

async function search(): Promise<void> {
  const value = keyword.value.trim()
  if (!value || searching.value) return
  if (!rules.value.length) {
    emit('notify', 'warning', '还没有可搜索的站点', '请先添加或生成一条站点规则')
    return
  }
  searching.value = true
  searched.value = true
  searchError.value = ''
  results.value = []
  try {
    results.value = await window.api.vod.search({
      keyword: value,
      ...(selectedSite.value ? { siteId: selectedSite.value } : {})
    })
  } catch (error) {
    searchError.value = errorMessage(error)
  } finally {
    searching.value = false
  }
}

function openDetail(result: SearchResultItem): void { emit('openDetail', result) }

function imageFailed(event: Event): void {
  ;(event.currentTarget as HTMLImageElement).style.display = 'none'
}

watch(
  () => props.rulesRevision,
  () => loadRules()
)
onMounted(() => loadRules())
</script>

<template>
  <section class="page search-page">
    <header class="page-header search-heading">
      <div>
        <span class="eyebrow"><span class="eyebrow-dot"></span>DISCOVER</span>
        <h1>聚合搜索</h1>
        <p>一次搜索所有已配置站点，快速找到想看的内容。</p>
      </div>
      <button type="button" class="ghost-button" @click="emit('openRules')">
        <UiIcon name="globe" :size="17" />管理站点
      </button>
    </header>

    <form class="search-console" @submit.prevent="search">
      <div class="search-input-wrap">
        <UiIcon name="search" :size="22" />
        <input
          v-model="keyword"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="输入影片、剧集或动漫名称…"
          aria-label="搜索关键词"
        />
        <kbd>Enter</kbd>
      </div>
      <label class="site-filter">
        <span>搜索范围</span>
        <select v-model="selectedSite" :disabled="loadingRules || !rules.length">
          <option value="">全部站点（{{ rules.length }}）</option>
          <option v-for="rule in rules" :key="rule.siteId" :value="rule.siteId">
            {{ rule.siteName }}
          </option>
        </select>
      </label>
      <button type="submit" class="primary-button search-submit" :disabled="searching || !keyword.trim()">
        <span v-if="searching" class="spinner small"></span>
        <UiIcon v-else name="search" :size="18" />
        {{ searching ? '搜索中…' : '开始搜索' }}
      </button>
    </form>

    <div v-if="!loadingRules && !rules.length" class="setup-banner">
      <span class="setup-icon"><UiIcon name="sparkles" :size="24" /></span>
      <div>
        <strong>先连接一个内容站点</strong>
        <p>影梭通过本地站点规则进行搜索，不会将你的搜索记录上传到中间服务器。</p>
      </div>
      <button type="button" class="secondary-button" @click="emit('openRules')">
        添加站点<UiIcon name="chevron" :size="15" />
      </button>
    </div>

    <div v-if="searching" class="result-section">
      <div class="section-heading">
        <span class="skeleton skeleton-line medium"></span>
      </div>
      <div class="poster-grid">
        <article v-for="index in 8" :key="index" class="result-card skeleton-result">
          <span class="skeleton result-cover"></span>
          <span class="skeleton skeleton-line wide"></span>
          <span class="skeleton skeleton-line short"></span>
        </article>
      </div>
    </div>

    <div v-else-if="searchError" class="state-panel error-state compact-state">
      <span class="state-icon"><UiIcon name="alert" :size="28" /></span>
      <h2>搜索没有完成</h2>
      <p>{{ searchError }}</p>
      <button type="button" class="secondary-button" @click="search">
        <UiIcon name="refresh" :size="17" />重试
      </button>
    </div>

    <div v-else-if="searched && !results.length" class="state-panel compact-state">
      <span class="state-icon"><UiIcon name="search" :size="29" /></span>
      <h2>没有找到“{{ keyword }}”</h2>
      <p>试试更简短的关键词，或切换到全部站点再次搜索。</p>
    </div>

    <div v-else-if="results.length" class="result-section">
      <div class="section-heading">
        <div>
          <span class="eyebrow">SEARCH RESULTS</span>
          <h2>{{ resultTitle }}</h2>
        </div>
        <span class="result-count">{{ results.length }}</span>
      </div>
      <div class="poster-grid">
        <article v-for="result in results" :key="`${result.siteId}:${result.detailUrl}`" class="result-card">
          <div class="favorite-poster">
            <button type="button" class="result-cover" @click="openDetail(result)">
              <span class="poster-fallback"><UiIcon name="film" :size="34" /></span>
              <img v-if="result.coverUrl" :src="coverSource(result.coverUrl)" :alt="result.title" @error="imageFailed" />
              <span class="result-overlay">
                <span class="poster-play"><UiIcon name="play" :size="22" /></span>
                <small>查看选集</small>
              </span>
              <span v-if="result.latestEpisode" class="latest-badge">{{ result.latestEpisode }}</span>
            </button>
            <FavoriteButton :item="result" :favorites="favorites" :pending="favoritePending" :disabled="favoritesLoading" compact @toggle="emit('favorite', $event)" />
          </div>
          <button type="button" class="result-copy" @click="openDetail(result)">
            <strong :title="result.title">{{ result.title }}</strong>
            <span>
              <i></i>{{ result.siteName || rules.find((rule) => rule.siteId === result.siteId)?.siteName || result.siteId }}
            </span>
          </button>
        </article>
      </div>
    </div>

    <div v-else class="search-welcome">
      <div class="search-welcome-visual">
        <span class="radar radar-one"></span>
        <span class="radar radar-two"></span>
        <span class="radar-center"><UiIcon name="search" :size="30" /></span>
      </div>
      <h2>跨站点，找片更简单</h2>
      <p>输入片名后，影梭会在本机并行解析 {{ rules.length || '所有' }} 个内容源。</p>
      <div class="privacy-note"><span></span>搜索和解析均在你的设备上完成</div>
    </div>
  </section>
</template>
