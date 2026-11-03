import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request } from 'node:http'
import { connect, type LookupFunction } from 'node:net'
import type { AddressInfo } from 'node:net'
import { lookup } from 'node:dns/promises'
import { isPrivateIp, parseRemoteUrl, publicLookup, safeFetch } from '../../src/main/urlSafety'
import { SnifferProxy } from '../../src/main/snifferProxy'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

afterEach(() => { vi.restoreAllMocks(); vi.mocked(lookup).mockReset() })

function resolveViaSocket(hostname: string, all = false): Promise<string | Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    publicLookup(hostname, { all }, (error, address) => error ? reject(error) : resolve(address))
  })
}

describe('public network boundaries', () => {
  it.each(['0x7f000001', '2130706433', '[::1]', '[::ffff:7f00:1]', '169.254.169.254', '192.168.0.1'])('rejects local address representation %s', (host) => {
    expect(() => parseRemoteUrl(`http://${host}/`)).toThrow()
  })

  it.each(['198.51.100.20', '203.0.113.1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::'])('rejects reserved and translated ranges %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it('allows public IPv6 literals', () => {
    expect(parseRemoteUrl('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]')
  })

  it('uses the checked DNS addresses directly in the socket lookup and rejects later rebinding', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
    expect(await resolveViaSocket('cdn.example', true)).toEqual([{ address: '1.1.1.1', family: 4 }])
    await expect(resolveViaSocket('cdn.example')).rejects.toThrow('内网')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('rejects a DNS response containing both public and private addresses', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] as never)
    await expect(resolveViaSocket('mixed.example')).rejects.toThrow('内网')
  })

  it('never connects to an internal service through safeFetch or the browser forward proxy', async () => {
    let hits = 0
    const target = createServer((_req, res) => { hits += 1; res.end('private service') })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const port = (target.address() as AddressInfo).port
    const proxy = new SnifferProxy()
    const proxyUrl = new URL(await proxy.start())
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
    try {
      await expect(safeFetch(`http://private-alias.example:${port}/`)).rejects.toThrow()
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ hostname: proxyUrl.hostname, port: proxyUrl.port, path: `http://private-alias.example:${port}/` }, (response) => {
          response.resume()
          resolve(response.statusCode!)
        })
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(502)
      const tunnelResponse = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) }, () => {
          socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
        })
        socket.on('error', reject)
        socket.on('data', (chunk) => { resolve(chunk.toString()); socket.destroy() })
      })
      expect(tunnelResponse).toContain('403 Forbidden')
      expect(hits).toBe(0)
    } finally {
      proxy.close()
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })

  it('drops credentials when a CDN redirects to a different origin', async () => {
    const mock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example/video' } }))
      .mockResolvedValueOnce(new Response('media'))
    await safeFetch('https://cdn.example/video', { headers: {
      cookie: 'session=secret', authorization: 'Bearer secret', 'x-site-token': 'secret',
      referer: 'https://video.example/play', 'user-agent': 'Player'
    } })
    const headers = new Headers(mock.mock.calls[1]![1]!.headers)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-site-token')).toBe(false)
    expect(headers.get('referer')).toBe('https://video.example/play')
    expect(headers.get('user-agent')).toBe('Player')
  })

  it('rejects redirects to private targets before issuing a second request', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'http://169.254.169.254/metadata' }
    }))
    await expect(safeFetch('https://cdn.example/start')).rejects.toThrow()
    expect(mock).toHaveBeenCalledTimes(1)
  })
})
