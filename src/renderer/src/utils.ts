export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60
  return hours > 0
    ? [hours, minutes, remaining].map((part) => String(part).padStart(2, '0')).join(':')
    : [minutes, remaining].map((part) => String(part).padStart(2, '0')).join(':')
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '刚刚'
  const delta = Date.now() - timestamp
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < day * 7) return `${Math.floor(delta / day)} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp)
}

export function progressPercent(current: number, duration: number): number {
  if (!duration || duration <= 0) return 0
  return Math.max(0, Math.min(100, (current / duration) * 100))
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '发生了未知错误'
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function coverSource(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return `safe-image://cover/?url=${encodeURIComponent(url.href)}`
  } catch { return '' }
}

export function createSeriesId(siteId: string, detailUrl: string): string {
  let hash = 2166136261
  const source = `${siteId}:${detailUrl}`
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${siteId}_${(hash >>> 0).toString(36)}`
}
