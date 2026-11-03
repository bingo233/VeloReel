import { describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
import { configurePlayerPermissions } from '../../src/main/playerPermissions'

function setup() {
  const requestHandler = vi.fn<Session['setPermissionRequestHandler']>()
  const checkHandler = vi.fn<Session['setPermissionCheckHandler']>()
  const rendererSession = {
    setPermissionRequestHandler: requestHandler,
    setPermissionCheckHandler: checkHandler
  } as unknown as Session
  const contents = { isDestroyed: vi.fn(() => false) } as unknown as WebContents
  let mainContents: WebContents | undefined = contents
  configurePlayerPermissions(rendererSession, () => mainContents)
  return {
    contents,
    changeMainContents: (value: WebContents | undefined) => { mainContents = value },
    request: requestHandler.mock.calls[0]![0]!,
    check: checkHandler.mock.calls[0]![0]!
  }
}

describe('player fullscreen permission', () => {
  const details = { isMainFrame: true, requestingUrl: 'http://localhost:5173/' }

  it('allows fullscreen in both Electron permission handlers for the player main frame', () => {
    const { contents, request, check } = setup()
    const callback = vi.fn()
    request(contents, 'fullscreen', callback, details)
    expect(callback).toHaveBeenCalledWith(true)
    expect(check(contents, 'fullscreen', 'http://localhost:5173', details)).toBe(true)
  })

  it('continues to deny other permissions and subframes', () => {
    const { contents, request, check } = setup()
    for (const permission of ['media', 'geolocation', 'notifications'] as const) {
      const callback = vi.fn()
      request(contents, permission, callback, details)
      expect(callback).toHaveBeenCalledWith(false)
      expect(check(contents, permission, '', details)).toBe(false)
    }
    const callback = vi.fn()
    request(contents, 'fullscreen', callback, { ...details, isMainFrame: false })
    expect(callback).toHaveBeenCalledWith(false)
    expect(check(contents, 'fullscreen', '', { ...details, isMainFrame: false })).toBe(false)
  })

  it('does not grant fullscreen to other windows or missing contents', () => {
    const { contents, changeMainContents, request, check } = setup()
    const otherContents = { isDestroyed: () => false } as WebContents
    const callback = vi.fn()
    request(otherContents, 'fullscreen', callback, details)
    expect(callback).toHaveBeenCalledWith(false)
    expect(check(otherContents, 'fullscreen', '', details)).toBe(false)
    expect(check(null, 'fullscreen', '', details)).toBe(false)
    changeMainContents(undefined)
    expect(check(contents, 'fullscreen', '', details)).toBe(false)
  })

  it('uses the current player window after a window is recreated', () => {
    const { contents, changeMainContents, check } = setup()
    const replacement = { isDestroyed: () => false } as WebContents
    changeMainContents(replacement)
    expect(check(contents, 'fullscreen', '', details)).toBe(false)
    expect(check(replacement, 'fullscreen', '', details)).toBe(true)
  })
})
