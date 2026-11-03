import { createApp, nextTick } from 'vue'
import PlayerOverlay from '../../src/renderer/src/components/PlayerOverlay.vue'
import { DEFAULT_SETTINGS } from '../../src/renderer/src/types'
import '../../src/renderer/src/styles/main.css'

// 只模拟视频数据和 IPC；全屏使用 Electron / Chromium 的真实 API 和权限检查。
const stopped = new WeakMap<HTMLMediaElement, boolean>()
Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 180 })
Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 })
Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true, get() { return stopped.get(this) ?? true }
})
HTMLMediaElement.prototype.load = function () { this.playbackRate = this.defaultPlaybackRate }
HTMLMediaElement.prototype.play = function () {
  stopped.set(this, false)
  this.dispatchEvent(new Event('playing'))
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function () {
  stopped.set(this, true)
  this.dispatchEvent(new Event('pause'))
}
const url = URL.createObjectURL(new Blob([], { type: 'video/mp4' }))
window.api = {
  settings: { get: async () => DEFAULT_SETTINGS },
  stream: {
    resolve: async () => ({ localUrl: url, mediaType: 'mp4', sessionId: 'test', extractedBy: 'static' }),
    release: async () => undefined
  },
  history: { list: async () => [], save: async () => undefined }
} as never
createApp(PlayerOverlay, { context: {
  siteId: 'test', title: '全屏回归测试', coverUrl: '', detailUrl: 'https://example.com/detail',
  playlistIndex: 0, episodeIndex: 0,
  playlists: [{ name: '线路一', episodes: [
    { name: '第一集', url: 'https://example.com/1' },
    { name: '第二集', url: 'https://example.com/2' }
  ] }]
} }).mount('#app')
await new Promise((resolve) => setTimeout(resolve, 100))
const video = document.querySelector('video')!
video.dispatchEvent(new Event('loadedmetadata'))
video.dispatchEvent(new Event('canplay'))
await nextTick()
document.body.dataset.ready = 'true'
