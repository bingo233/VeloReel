<script setup lang="ts">
import Artplayer from 'artplayer'
import Hls, { type ErrorData } from 'hls.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watchEffect } from 'vue'
import { PLAYBACK_RATES, adjacentPlaybackRate, playerShortcut, seekTarget } from '../playerControls'
import UiIcon from './UiIcon.vue'
import FavoriteButton from './FavoriteButton.vue'
import {
  DEFAULT_SETTINGS,
  episodeName,
  episodeUrl,
  type AppSettings,
  type FavoriteInput,
  type FavoriteItem,
  type PlayerContext,
  type StreamResolution,
  type ToastMessage
} from '../types'
import { errorMessage, formatDuration } from '../utils'

const props = defineProps<{ context: PlayerContext; favorites?: FavoriteItem[]; favoritePending?: string[]; favoritesLoading?: boolean }>()
const emit = defineEmits<{
  close: []
  saved: []
  favorite: [item: FavoriteInput]
  notify: [tone: ToastMessage['tone'], title: string, message?: string]
}>()

const playerHost = ref<HTMLDivElement | null>(null)
const playerSurface = shallowRef<HTMLDivElement | null>(null)
const video = shallowRef<HTMLVideoElement | null>(null)
const showShortcuts = ref(false)
const playlistIndex = ref(props.context.playlistIndex)
const episodeIndex = ref(props.context.episodeIndex)
const loading = ref(true)
const loadingMessage = ref('正在读取播放页…')
const playbackError = ref('')
const resolution = ref<StreamResolution | null>(null)
const showEpisodes = ref(false)
const resumeTime = ref<number | null>(null)
const currentTime = ref(0)
const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
const switching = ref(false)
const retryCount = ref(0)
let hls: Hls | null = null
let art: Artplayer | null = null
let previousButton: HTMLButtonElement | undefined
let nextButton: HTMLButtonElement | undefined
let loadSequence = 0
let hlsRetryTimer: number | undefined
let loadingHintTimer: number | undefined
let resumeHintTimer: number | undefined
let lastSavedAt = 0
let saveChain = Promise.resolve()
let outroHandled = false
let disposed = false
let preferredPlaybackRate = 1
let cacheRefreshAttempted = false
let recoveryTime: number | null = null

const currentPlaylist = computed(() => props.context.playlists[playlistIndex.value])
const episodes = computed(() => currentPlaylist.value?.episodes || [])
const currentEpisode = computed(() => episodes.value[episodeIndex.value])
const currentEpisodeName = computed(() =>
  currentEpisode.value ? episodeName(currentEpisode.value) : '未命名剧集'
)
const hasPrevious = computed(() => episodeIndex.value > 0)
const hasNext = computed(() => episodeIndex.value < episodes.value.length - 1)

watchEffect(() => {
  const previousDisabled = !hasPrevious.value || switching.value
  const nextDisabled = !hasNext.value || switching.value
  if (previousButton) previousButton.disabled = previousDisabled
  if (nextButton) nextButton.disabled = nextDisabled
})

function focusPlayer(): void {
  playerSurface.value?.focus({ preventScroll: true })
}

function closePanels(): void {
  showEpisodes.value = false
  showShortcuts.value = false
  focusPlayer()
}

function toggleEpisodes(): void {
  showShortcuts.value = false
  showEpisodes.value = !showEpisodes.value
  if (!showEpisodes.value) focusPlayer()
}

function toggleShortcuts(): void {
  showEpisodes.value = false
  showShortcuts.value = !showShortcuts.value
  if (!showShortcuts.value) focusPlayer()
}

function createPlayer(): void {
  if (!playerHost.value) throw new Error('播放器容器尚未准备好')
  art = new Artplayer({
    container: playerHost.value,
    url: '',
    lang: 'zh-cn',
    theme: '#a997ff',
    volume: 0.7,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    fullscreen: true,
    pip: true,
    miniProgressBar: true,
    autoPlayback: false,
    // 快捷键由组件统一管理，选集面板和表单控件保留自己的键盘操作。
    hotkey: false,
    moreVideoAttr: { preload: 'auto' },
    cssVar: {
      '--art-progress-height': '6px',
      '--art-mini-progress-height': '3px',
      '--art-control-height': '48px',
      '--art-bottom-height': '105px',
      '--art-loaded-color': 'rgba(255, 255, 255, 0.35)'
    }
  })
  const player = art
  video.value = player.video
  playerSurface.value = player.template.$player
  playerSurface.value.tabIndex = 0
  playerSurface.value.setAttribute('aria-label', '视频画面，空格暂停，方向键调节进度和音量，F 全屏')
  // 本组件负责本地代理会话与 HLS 重试，避免内置重连直接重载代理播放列表。
  player.off('video:error')
  player.on('video:loadedmetadata', onLoadedMetadata)
  player.on('video:playing', onPlaying)
  player.on('video:timeupdate', onTimeUpdate)
  player.on('video:pause', onPause)
  player.on('video:seeked', onSeeked)
  player.on('video:ended', onEnded)
  player.on('video:error', onVideoError)
  player.on('video:ratechange', () => {
    preferredPlaybackRate = player.playbackRate
    if (player.video.defaultPlaybackRate !== preferredPlaybackRate) {
      player.video.defaultPlaybackRate = preferredPlaybackRate
    }
  })
  player.on('fullscreenError', () => {
    player.notice.show = '全屏切换失败，请退出后重试'
  })
  player.proxy(player.video, 'pointerdown', focusPlayer)

  function addButton(name: string, label: string, position: 'left' | 'right', index: number, click: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'player-control-button'
    button.textContent = label
    button.setAttribute('aria-label', label)
    player.controls.add({ name, html: button, position, index })
    player.proxy(button, 'click', click)
    return button
  }
  previousButton = addButton('previousEpisode', '上一集', 'left', 35, () => { void goPrevious() })
  nextButton = addButton('nextEpisode', '下一集', 'left', 36, () => { void goNext() })
  previousButton.disabled = !hasPrevious.value || switching.value
  nextButton.disabled = !hasNext.value || switching.value
  addButton('episodes', '选集', 'right', 15, toggleEpisodes)
  addButton('shortcuts', '快捷键', 'right', 16, toggleShortcuts)

  const rateSelect = document.createElement('select')
  rateSelect.className = 'player-rate-select'
  rateSelect.setAttribute('aria-label', '播放速度')
  for (const rate of PLAYBACK_RATES) {
    rateSelect.add(new Option(`${rate}×`, String(rate), rate === 1, rate === 1))
  }
  player.controls.add({ name: 'playbackSpeed', html: rateSelect, position: 'right', index: 10 })
  player.proxy(rateSelect, 'change', () => { player.playbackRate = Number(rateSelect.value) })
  player.on('video:ratechange', () => { rateSelect.value = String(player.playbackRate) })
  focusPlayer()
}

function onKeydown(event: KeyboardEvent): void {
  if (!art || disposed) return
  const target = event.target instanceof Element ? event.target : null
  if (!target || (!playerSurface.value?.contains(target) && !target.closest('.player-overlay'))) return
  if (event.code === 'Escape') {
    if (showEpisodes.value || showShortcuts.value) {
      event.preventDefault()
      closePanels()
    } else if (document.fullscreenElement === playerSurface.value) {
      event.preventDefault()
      void document.exitFullscreen().catch(() => undefined)
    }
    return
  }
  if (showEpisodes.value || showShortcuts.value) return
  const interactive = !!target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"]')
  const action = playerShortcut(event, interactive)
  if (!action) return
  event.preventDefault()
  art.controls.show = true
  switch (action) {
    case 'toggle':
      if (!loading.value && !playbackError.value) {
        if (video.value && !video.value.paused) art.pause()
        else void art.play().catch(() => undefined)
      }
      break
    case 'backward':
    case 'forward': {
      if (loading.value || playbackError.value) break
      const time = seekTarget(art.currentTime, art.duration, action === 'forward' ? 5 : -5)
      if (time !== null) art.seek = time
      break
    }
    case 'volumeUp':
    case 'volumeDown':
      art.volume = Math.max(0, Math.min(1, Math.round(((art.muted ? 0 : art.volume) + (action === 'volumeUp' ? 0.05 : -0.05)) * 100) / 100))
      art.muted = false
      break
    case 'mute':
      art.muted = !art.muted
      art.notice.show = art.muted ? '已静音' : `音量：${Math.round(art.volume * 100)}%`
      break
    case 'fullscreen':
      if (video.value?.readyState) art.fullscreen = !art.fullscreen
      break
    case 'slower':
    case 'faster':
      art.playbackRate = adjacentPlaybackRate(art.playbackRate, action === 'faster' ? 1 : -1)
      break
  }
}

function streamUrl(value: StreamResolution): string {
  return value.localUrl || value.localProxyM3u8 || ''
}

function destroyHls(): void {
  window.clearTimeout(hlsRetryTimer)
  if (!hls) return
  hls.destroy()
  hls = null
}

async function releaseResolution(value: StreamResolution | null): Promise<void> {
  if (!value?.sessionId) return
  try {
    await window.api.stream.release({ sessionId: value.sessionId })
  } catch {
    // 会话过期清理由主进程兜底，关闭播放器不应被释放失败阻塞。
  }
}

async function loadEpisode(forceRefresh = false, resumeAt: number | null = null): Promise<void> {
  if (disposed) return
  const item = currentEpisode.value
  if (!item) {
    playbackError.value = '当前线路没有可播放的剧集'
    loading.value = false
    return
  }

  const sequence = ++loadSequence
  cacheRefreshAttempted = forceRefresh
  recoveryTime = resumeAt
  switching.value = true
  loading.value = true
  playbackError.value = ''
  resolution.value && void releaseResolution(resolution.value)
  resolution.value = null
  retryCount.value = 0
  outroHandled = false
  resumeTime.value = null
  currentTime.value = 0
  lastSavedAt = 0
  destroyHls()
  window.clearTimeout(loadingHintTimer)
  window.clearTimeout(resumeHintTimer)
  const element = video.value
  if (element) {
    preferredPlaybackRate = element.playbackRate
    element.defaultPlaybackRate = preferredPlaybackRate
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
  if (art) {
    art.emit('setBar', 'played', 0)
    art.emit('setBar', 'loaded', 0)
    art.controls.show = true
    art.setting.show = false
  }

  loadingMessage.value = forceRefresh ? '正在重新解析视频地址…' : '正在获取可用的视频地址…'
  loadingHintTimer = window.setTimeout(() => {
    if (loading.value && sequence === loadSequence) {
      loadingMessage.value = '正在验证视频地址或解析播放页，请稍候…'
    }
  }, 900)

  try {
    const value = await window.api.stream.resolve({
      siteId: props.context.siteId,
      playPageUrl: episodeUrl(item),
      ...(forceRefresh ? { forceRefresh: true } : {})
    })
    if (sequence !== loadSequence || disposed) {
      void releaseResolution(value)
      return
    }
    const url = streamUrl(value)
    if (!url) throw new Error('解析器没有返回可播放地址')
    resolution.value = value
    await nextTick()
    if (sequence !== loadSequence || disposed) return
    attachMedia(url, value.mediaType)
  } catch (error) {
    if (sequence !== loadSequence || disposed) return
    playbackError.value = errorMessage(error)
    loading.value = false
  } finally {
    if (sequence === loadSequence) {
      switching.value = false
      window.clearTimeout(loadingHintTimer)
    }
  }
}

function attachMedia(url: string, mediaType: 'hls' | 'mp4'): void {
  const element = video.value
  if (!element) throw new Error('播放器尚未准备好')
  if (art) art.option.url = url
  element.playbackRate = preferredPlaybackRate
  const isHls = mediaType === 'hls' || /\.m3u8(?:$|\?)/i.test(url)
  if (isHls && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 60,
      maxBufferLength: 30,
      manifestLoadingTimeOut: 20_000,
      fragLoadingTimeOut: 25_000
    })
    const instance = hls
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (hls === instance && !disposed) onHlsError(event, data)
    })
    hls.loadSource(url)
    hls.attachMedia(element)
  } else if (isHls && element.canPlayType('application/vnd.apple.mpegurl')) {
    element.src = url
    element.load()
  } else if (isHls) {
    throw new Error('当前设备不支持 HLS 播放')
  } else {
    element.src = url
    element.load()
  }
  void element.play().catch(() => {
    // 自动播放被拦截时，用户仍可使用播放器的播放按钮。
  })
}

function refreshCachedAddress(): boolean {
  if (!resolution.value?.fromCache || cacheRefreshAttempted || switching.value || disposed) return false
  cacheRefreshAttempted = true
  const position = video.value?.currentTime || 0
  void saveProgress()
  void loadEpisode(true, position)
  return true
}

function onHlsError(_event: string, data: ErrorData): void {
  if (!data.fatal || !hls) return
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && refreshCachedAddress()) return
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retryCount.value < 2) {
    retryCount.value += 1
    loading.value = true
    loadingMessage.value = `网络波动，正在重试（${retryCount.value}/2）…`
    const instance = hls
    window.clearTimeout(hlsRetryTimer)
    hlsRetryTimer = window.setTimeout(() => {
      if (hls === instance && !disposed) instance.startLoad()
    }, 600 * retryCount.value)
    return
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retryCount.value < 2) {
    retryCount.value += 1
    hls.recoverMediaError()
    return
  }
  playbackError.value = data.details || 'HLS 播放器遇到无法恢复的错误'
  loading.value = false
}

function onVideoError(): void {
  if (switching.value || disposed || hls) return
  const code = video.value?.error?.code
  if ((code === 2 || code === 4) && refreshCachedAddress()) return
  const descriptions: Record<number, string> = {
    1: '播放已被终止',
    2: '视频数据下载失败',
    3: '视频解码失败',
    4: '当前视频格式不受支持'
  }
  playbackError.value = (code && descriptions[code]) || '视频播放器遇到未知错误'
  loading.value = false
}

async function restoreProgress(): Promise<void> {
  const sequence = loadSequence
  const element = video.value
  const item = currentEpisode.value
  if (!element || !item || !Number.isFinite(element.duration)) return
  try {
    const allHistory = await window.api.history.list()
    if (disposed || sequence !== loadSequence || element !== video.value) return
    const history = allHistory.find(
      (entry) => entry.siteId === props.context.siteId && entry.detailUrl === props.context.detailUrl
    )
    const saved = history?.episodes?.[episodeUrl(item)]
    if (
      saved &&
      !saved.isFinished &&
      saved.currentTime > 5 &&
      element.duration - saved.currentTime > 30
    ) {
      element.currentTime = Math.min(saved.currentTime, Math.max(0, element.duration - 1))
      resumeTime.value = saved.currentTime
      resumeHintTimer = window.setTimeout(() => {
        resumeTime.value = null
      }, 9000)
    }
  } catch {
    // 历史读取失败不应阻止视频播放。
  }
}

async function onLoadedMetadata(): Promise<void> {
  const sequence = loadSequence
  const element = video.value
  loading.value = false
  playbackError.value = ''
  retryCount.value = 0
  if (recoveryTime !== null && element && Number.isFinite(element.duration)) {
    element.currentTime = Math.max(0, Math.min(recoveryTime, element.duration - 1))
    recoveryTime = null
  } else {
    await restoreProgress()
  }
  if (disposed || sequence !== loadSequence) return
  if (element) element.playbackRate = preferredPlaybackRate
  await element?.play().catch(() => undefined)
}

function progressPayload(finished = false) {
  if (switching.value) return null
  const element = video.value
  const item = currentEpisode.value
  if (!element || !item) return null
  const currentTime = Number.isFinite(element.currentTime) ? element.currentTime : 0
  const duration = Number.isFinite(element.duration) ? element.duration : 0
  if (duration <= 0) return null
  return {
    siteId: props.context.siteId,
    title: props.context.title,
    coverUrl: props.context.coverUrl,
    detailUrl: props.context.detailUrl,
    episodeUrl: episodeUrl(item),
    episodeName: episodeName(item),
    currentTime,
    duration,
    isFinished: finished || currentTime / duration >= 0.95
  }
}

function saveProgress(finished = false): Promise<void> {
  const payload = progressPayload(finished)
  if (!payload) return saveChain
  saveChain = saveChain
    .catch(() => undefined)
    .then(async () => {
      await window.api.history.save(payload)
      emit('saved')
    })
    .catch(() => undefined)
  return saveChain
}

function onTimeUpdate(): void {
  if (switching.value || disposed) return
  const element = video.value
  if (!element) return
  currentTime.value = element.currentTime
  const now = Date.now()
  if (now - lastSavedAt >= 5000) {
    lastSavedAt = now
    void saveProgress()
  }

  const skipOutro = settings.value.skipOutroSeconds || 0
  if (
    settings.value.autoPlayNext &&
    skipOutro > 0 &&
    !outroHandled &&
    Number.isFinite(element.duration) &&
    element.currentTime > 30 &&
    element.duration - element.currentTime <= skipOutro
  ) {
    outroHandled = true
    void finishAndContinue()
  }
}

function onPlaying(): void {
  loading.value = false
  loadingMessage.value = ''
}

function onPause(): void {
  if (!switching.value && !disposed) void saveProgress()
}

function onSeeked(): void {
  if (!switching.value && !disposed) void saveProgress()
}

async function finishAndContinue(): Promise<void> {
  const sequence = loadSequence
  await saveProgress(true)
  if (sequence !== loadSequence || disposed) return
  if (settings.value.autoPlayNext && hasNext.value) {
    emit('notify', 'info', '正在自动播放下一集')
    await goNext(false)
  }
}

async function onEnded(): Promise<void> {
  if (outroHandled || switching.value || disposed) return
  outroHandled = true
  await finishAndContinue()
}

async function selectEpisode(index: number): Promise<void> {
  if (index === episodeIndex.value || switching.value) return
  await saveProgress()
  episodeIndex.value = index
  closePanels()
  await loadEpisode()
}

async function selectPlaylist(index: number): Promise<void> {
  if (index === playlistIndex.value || switching.value) return
  const playlist = props.context.playlists[index]
  if (!playlist) return
  await saveProgress()
  playlistIndex.value = index
  episodeIndex.value = Math.min(episodeIndex.value, playlist.episodes.length - 1)
  episodeIndex.value = Math.max(0, episodeIndex.value)
  focusPlayer()
  await loadEpisode()
}

async function goNext(saveCurrent = true): Promise<void> {
  if (switching.value) return
  if (saveCurrent) await saveProgress()
  if (episodeIndex.value < episodes.value.length - 1) {
    episodeIndex.value += 1
  } else {
    emit('notify', 'success', '已经看完最后一集')
    return
  }
  await loadEpisode()
  focusPlayer()
}

async function goPrevious(): Promise<void> {
  if (switching.value) return
  await saveProgress()
  if (episodeIndex.value > 0) {
    episodeIndex.value -= 1
  } else return
  await loadEpisode()
  focusPlayer()
}

function restart(): void {
  if (!video.value) return
  video.value.currentTime = 0
  resumeTime.value = null
  void video.value.play().catch(() => undefined)
}

function skipIntro(): void {
  if (!video.value) return
  const time = seekTarget(video.value.currentTime, video.value.duration, Math.max(0, settings.value.skipIntroSeconds - video.value.currentTime))
  if (time !== null) video.value.currentTime = time
  void video.value.play().catch(() => undefined)
}

async function retry(): Promise<void> {
  await loadEpisode(true)
}

async function closePlayer(): Promise<void> {
  await saveProgress()
  if (document.fullscreenElement === playerSurface.value) {
    await document.exitFullscreen().catch(() => undefined)
  }
  emit('close')
}

function onBeforeUnload(): void {
  void saveProgress()
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('keydown', onKeydown)
  try {
    createPlayer()
  } catch (error) {
    playbackError.value = errorMessage(error)
    loading.value = false
    return
  }
  try {
    settings.value = { ...DEFAULT_SETTINGS, ...(await window.api.settings.get()) }
  } catch {
    settings.value = { ...DEFAULT_SETTINGS }
  }
  await loadEpisode()
})

onBeforeUnmount(() => {
  disposed = true
  loadSequence += 1
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('keydown', onKeydown)
  window.clearTimeout(loadingHintTimer)
  window.clearTimeout(resumeHintTimer)
  void saveProgress()
  destroyHls()
  art?.destroy(false)
  art = null
  video.value = null
  void releaseResolution(resolution.value)
})
</script>

<template>
  <div class="player-overlay" role="dialog" aria-modal="true" aria-label="视频播放器">
    <header class="player-header">
      <button type="button" class="player-back" @click="closePlayer">
        <UiIcon name="back" :size="21" />
        <span>返回</span>
      </button>
      <div class="now-playing">
        <span class="playing-pulse"><i></i><i></i><i></i></span>
        <span>
          <strong>{{ context.title }}</strong>
          <small>{{ currentEpisodeName }} · {{ currentPlaylist?.name || `线路 ${playlistIndex + 1}` }}</small>
        </span>
      </div>
      <div class="player-header-actions">
        <FavoriteButton :item="{ ...context, siteName: '' }" :favorites="favorites" :pending="favoritePending" :disabled="favoritesLoading" @toggle="emit('favorite', $event)" />
        <span v-if="resolution" class="extract-badge" :class="resolution.extractedBy">
          {{ resolution.fromCache ? '缓存直连' : resolution.extractedBy === 'static' ? '极速解析' : '嗅探解析' }}
        </span>
        <button type="button" class="player-episode-button" :aria-expanded="showEpisodes" @click="toggleEpisodes">
          <UiIcon name="film" :size="18" />选集
        </button>
        <button type="button" class="icon-button player-close" aria-label="关闭播放器" @click="closePlayer">
          <UiIcon name="close" :size="20" />
        </button>
      </div>
    </header>

    <div class="player-stage">
      <div ref="playerHost" class="artplayer-host"></div>

      <!-- 浮层随 Artplayer 一起进入原生全屏，继续保留选集和续播操作。 -->
      <Teleport :to="playerSurface || playerHost" :disabled="!playerSurface">
      <div v-if="loading" class="player-state player-loading">
        <span class="stream-loader"><i></i><i></i><i></i></span>
        <strong>{{ loadingMessage }}</strong>
        <small>{{ currentEpisodeName }}</small>
      </div>

      <div v-else-if="playbackError" class="player-state player-error">
        <span class="state-icon"><UiIcon name="alert" :size="28" /></span>
        <strong>这一集暂时无法播放</strong>
        <p>{{ playbackError }}</p>
        <div>
          <button type="button" class="ghost-button light" @click="closePlayer">返回选集</button>
          <button type="button" class="primary-button" @click="retry"><UiIcon name="refresh" :size="17" />重新解析</button>
        </div>
      </div>

      <Transition name="resume">
        <div v-if="resumeTime !== null && !loading" class="resume-toast">
          <span class="resume-icon"><UiIcon name="clock" :size="19" /></span>
          <span><strong>已为你自动续播至 {{ formatDuration(resumeTime) }}</strong><small>进度来自本机观看记录</small></span>
          <button type="button" @click="restart">从头播放</button>
          <button type="button" class="icon-button" aria-label="关闭提示" @click="resumeTime = null"><UiIcon name="close" :size="15" /></button>
        </div>
      </Transition>

      <div v-if="!loading && !playbackError" class="quick-actions">
        <button v-if="settings.skipIntroSeconds > 0 && currentTime < settings.skipIntroSeconds" type="button" @click="skipIntro">
          跳过片头 {{ settings.skipIntroSeconds }} 秒 <UiIcon name="chevron" :size="14" />
        </button>
      </div>

      <Transition name="resume">
        <section v-if="showShortcuts" class="player-shortcuts" role="dialog" aria-label="播放快捷键">
          <header><strong>播放快捷键</strong><button type="button" class="icon-button" aria-label="关闭快捷键说明" @click="closePanels"><UiIcon name="close" :size="18" /></button></header>
          <dl>
            <div><dt><kbd>Space</kbd></dt><dd>播放 / 暂停</dd></div>
            <div><dt><kbd>←</kbd><kbd>→</kbd></dt><dd>后退 / 前进 5 秒</dd></div>
            <div><dt><kbd>↑</kbd><kbd>↓</kbd></dt><dd>音量增加 / 减少 5%</dd></div>
            <div><dt><kbd>F</kbd></dt><dd>进入 / 退出全屏</dd></div>
            <div><dt><kbd>M</kbd></dt><dd>静音 / 恢复音量</dd></div>
            <div><dt><kbd>[</kbd><kbd>]</kbd></dt><dd>降低 / 提高倍速</dd></div>
            <div><dt><kbd>Esc</kbd></dt><dd>关闭面板 / 退出全屏</dd></div>
          </dl>
          <p>点击视频画面后即可使用；双击画面切换全屏。</p>
        </section>
      </Transition>

    <Transition name="episodes-drawer">
      <aside v-if="showEpisodes" class="player-episodes">
        <header>
          <div><span class="eyebrow">PLAYLIST</span><h2>选集</h2></div>
          <button type="button" class="icon-button" aria-label="关闭选集" @click="closePanels"><UiIcon name="close" :size="18" /></button>
        </header>
        <div v-if="context.playlists.length > 1" class="playlist-tabs dark-tabs">
          <button
            v-for="(playlist, index) in context.playlists"
            :key="`${playlist.name}:${index}`"
            type="button"
            :class="{ active: playlistIndex === index }"
            @click="selectPlaylist(index)"
          >
            {{ playlist.name || `线路 ${index + 1}` }}
          </button>
        </div>
        <div class="player-episode-list">
          <p class="player-episode-count">{{ currentEpisodeName }} · 共 {{ episodes.length }} 集</p>
          <button
            v-for="(item, index) in episodes"
            :key="`${episodeUrl(item)}:${index}`"
            type="button"
            :class="{ active: episodeIndex === index }"
            :disabled="switching"
            @click="selectEpisode(index)"
          >
            <span class="episode-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <span>{{ episodeName(item) }}</span>
            <span v-if="episodeIndex === index" class="playing-bars"><i></i><i></i><i></i></span>
            <UiIcon v-else name="play" :size="14" />
          </button>
        </div>
      </aside>
    </Transition>
    <div v-if="showEpisodes || showShortcuts" class="episode-drawer-scrim" @click="closePanels"></div>
      </Teleport>
    </div>
  </div>
</template>
