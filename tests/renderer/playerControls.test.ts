import { describe, expect, it } from 'vitest'
import { adjacentPlaybackRate, playerShortcut, seekTarget } from '../../src/renderer/src/playerControls'

const key = (code: string, extra = {}) => ({
  code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
  isComposing: false, defaultPrevented: false, repeat: false, ...extra
})

describe('player keyboard controls', () => {
  it('maps arrow keys to seeking and volume', () => {
    expect(playerShortcut(key('ArrowLeft'), false)).toBe('backward')
    expect(playerShortcut(key('ArrowRight'), false)).toBe('forward')
    expect(playerShortcut(key('ArrowUp'), false)).toBe('volumeUp')
    expect(playerShortcut(key('ArrowDown'), false)).toBe('volumeDown')
  })

  it('preserves keyboard input in interactive controls and composition', () => {
    expect(playerShortcut(key('ArrowRight'), true)).toBeNull()
    expect(playerShortcut(key('Space', { isComposing: true }), false)).toBeNull()
    expect(playerShortcut(key('Space', { defaultPrevented: true }), false)).toBeNull()
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      expect(playerShortcut(key('KeyF', { [modifier]: true }), false)).toBeNull()
    }
  })

  it('allows held arrows but does not repeatedly toggle playback, mute or fullscreen', () => {
    expect(playerShortcut(key('ArrowRight', { repeat: true }), false)).toBe('forward')
    for (const code of ['Space', 'KeyM', 'KeyF']) {
      expect(playerShortcut(key(code), false)).not.toBeNull()
      expect(playerShortcut(key(code, { repeat: true }), false)).toBeNull()
    }
  })

  it('keeps seeking inside the video and waits for a finite duration', () => {
    expect(seekTarget(2, 100, -5)).toBe(0)
    expect(seekTarget(98, 100, 5)).toBe(100)
    expect(seekTarget(40, 100, 5)).toBe(45)
    for (const duration of [0, NaN, Infinity]) expect(seekTarget(0, duration, 5)).toBeNull()
  })

  it('changes playback speed within the supported range', () => {
    expect(adjacentPlaybackRate(1, 1)).toBe(1.25)
    expect(adjacentPlaybackRate(1, -1)).toBe(0.75)
    expect(adjacentPlaybackRate(2, 1)).toBe(2)
    expect(adjacentPlaybackRate(0.5, -1)).toBe(0.5)
    expect(adjacentPlaybackRate(1.4, 1)).toBe(1.5)
    expect(playerShortcut(key('BracketLeft'), false)).toBe('slower')
    expect(playerShortcut(key('BracketRight'), false)).toBe('faster')
  })
})
