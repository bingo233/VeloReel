import { describe, expect, it } from 'vitest'
import { isPrivateIp, parseRemoteUrl } from '../../src/main/urlSafety'

describe('URL safety', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '::1',
    'fc00::1',
    'fe80::1'
  ])('blocks private address %s', (address) => {
    expect(isPrivateIp(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts public address %s', (address) => {
    expect(isPrivateIp(address)).toBe(false)
  })

  it('resolves a relative public URL against its page', () => {
    expect(parseRemoteUrl('/watch/1', 'https://video.example/path').toString())
      .toBe('https://video.example/watch/1')
  })

  it.each([
    'file:///etc/passwd',
    'http://localhost/admin',
    'http://127.0.0.1:8080/',
    'http://router.local/',
    'https://user:pass@example.com/'
  ])('rejects unsafe URL %s', (url) => {
    expect(() => parseRemoteUrl(url)).toThrow()
  })
})
