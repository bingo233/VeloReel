export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

export type PlayerShortcut =
  | 'toggle'
  | 'backward'
  | 'forward'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'fullscreen'
  | 'slower'
  | 'faster'

type ShortcutEvent = Pick<
  KeyboardEvent,
  'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented' | 'repeat'
>

export function playerShortcut(event: ShortcutEvent, interactiveTarget: boolean): PlayerShortcut | null {
  if (
    interactiveTarget || event.defaultPrevented || event.isComposing ||
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
  ) return null

  const shortcuts: Record<string, PlayerShortcut> = {
    Space: 'toggle',
    ArrowLeft: 'backward',
    ArrowRight: 'forward',
    ArrowUp: 'volumeUp',
    ArrowDown: 'volumeDown',
    KeyM: 'mute',
    KeyF: 'fullscreen',
    BracketLeft: 'slower',
    BracketRight: 'faster'
  }
  const action = shortcuts[event.code]
  if (event.repeat && (action === 'toggle' || action === 'mute' || action === 'fullscreen')) return null
  return action || null
}

export function seekTarget(current: number, duration: number, delta: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current)) return null
  return Math.max(0, Math.min(duration, current + delta))
}

export function adjacentPlaybackRate(current: number, direction: -1 | 1): number {
  return direction > 0
    ? PLAYBACK_RATES.find((rate) => rate > current) ?? 2
    : [...PLAYBACK_RATES].reverse().find((rate) => rate < current) ?? PLAYBACK_RATES[0]
}
