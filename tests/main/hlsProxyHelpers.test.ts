import { describe, expect, it } from 'vitest'
import { __testing } from '../../src/main/hlsProxyServer'

const response = (size: number, marker: number) => ({
  body: Buffer.alloc(size, marker),
  status: 200,
  contentType: 'video/mp2t'
})

describe('HLS proxy helpers', () => {
  it('reads master-playlist bandwidth values', () => {
    expect(__testing.parseBandwidth('#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080')).toBe(4_200_000)
    expect(__testing.parseBandwidth('#EXT-X-STREAM-INF:RESOLUTION=640x360')).toBe(0)
  })

  it('reads quoted and unquoted HLS attributes', () => {
    const line = 'TYPE=AUDIO,GROUP-ID="stereo",NAME=Chinese,URI="audio/index.m3u8"'
    expect(__testing.attribute(line, 'GROUP-ID')).toBe('stereo')
    expect(__testing.attribute(line, 'NAME')).toBe('Chinese')
    expect(__testing.attribute(line, 'URI')).toBe('audio/index.m3u8')
  })

  it('turns explicit and implicit byte ranges into HTTP Range headers', () => {
    expect(__testing.byterangeToHeader('1000@200', 0)).toEqual({
      header: 'bytes=200-1199',
      end: 1200
    })
    expect(__testing.byterangeToHeader('500', 1200)).toEqual({
      header: 'bytes=1200-1699',
      end: 1700
    })
    expect(__testing.byterangeToHeader('invalid', 0)).toBeUndefined()
  })

  it('evicts the least-recently-used responses by total bytes', () => {
    const cache = new __testing.ByteLru(10)
    cache.set('a', response(6, 1))
    cache.set('b', response(4, 2))
    expect(cache.get('a')?.body[0]).toBe(1) // refresh a, making b the oldest
    cache.set('c', response(4, 3))

    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')?.body[0]).toBe(1)
    expect(cache.get('c')?.body[0]).toBe(3)
  })

  it('removes only entries belonging to a released proxy session', () => {
    const cache = new __testing.ByteLru(100)
    cache.set('session-a:one', response(3, 1))
    cache.set('session-b:one', response(3, 2))
    cache.deletePrefix('session-a:')

    expect(cache.get('session-a:one')).toBeUndefined()
    expect(cache.get('session-b:one')?.body[0]).toBe(2)
  })
})
