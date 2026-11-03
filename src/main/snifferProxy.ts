import { createServer, request, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { parseRemoteUrl, publicLookup } from './urlSafety'

const MAX_CONNECTIONS = 40
const MAX_REQUESTS = 600
const MAX_TRAFFIC = 128 * 1024 * 1024
const HOP_HEADERS = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding'])

/** 每个嗅探窗口独享的转发代理。HTTPS 只建立隧道，不解密、不替换站点证书。 */
export class SnifferProxy {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private requests = 0
  private traffic = 0
  private stopped = false

  async start(): Promise<string> {
    const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => { void this.forward(req, res) })
    this.server = server
    server.on('connection', (socket) => {
      if (this.stopped || this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return }
      this.track(socket)
    })
    server.on('connect', (req, socket, head) => { void this.tunnel(req, socket, head) })
    server.on('upgrade', (_req, socket) => socket.destroy())
    server.headersTimeout = 10_000
    server.requestTimeout = 20_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动嗅探网络代理')
    return `http://127.0.0.1:${address.port}`
  }

  close(): void {
    this.stopped = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = undefined
  }

  private track(socket: Socket): void {
    this.sockets.add(socket)
    socket.setTimeout(20_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('data', (chunk: Buffer) => {
      this.traffic += chunk.byteLength
      if (this.traffic > MAX_TRAFFIC) this.close()
    })
  }

  private accept(): boolean {
    this.requests += 1
    return !this.stopped && this.requests <= MAX_REQUESTS && this.sockets.size < MAX_CONNECTIONS
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.accept()) { res.writeHead(429).end(); return }
    try {
      const url = parseRemoteUrl(req.url || '')
      if (url.protocol !== 'http:') throw new Error('HTTPS 必须使用隧道')
      if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method || '')) throw new Error('请求方法不允许')
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)))
      headers.host = url.host
      const upstream = request(url, { method: req.method, headers, lookup: publicLookup, agent: false }, (response) => {
        const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !HOP_HEADERS.has(name)))
        res.writeHead(response.statusCode || 502, responseHeaders)
        response.on('error', () => res.destroy())
        response.pipe(res)
      })
      upstream.on('socket', (socket) => this.track(socket))
      upstream.setTimeout(15_000, () => upstream.destroy())
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      res.once('close', () => upstream.destroy())
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
    } catch {
      res.writeHead(403).end()
    }
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.accept()) { client.destroy(); return }
    try {
      const authority = req.url || ''
      const url = parseRemoteUrl(`https://${authority}`)
      if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}$/i.test(authority) || url.pathname !== '/' || url.search || url.hash) throw new Error('无效隧道地址')
      if (this.stopped || client.destroyed) throw new Error('连接已取消')
      const upstream = connect({
        host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443),
        lookup: publicLookup, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250
      })
      this.track(upstream)
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.once('error', () => client.destroy())
      client.once('error', () => upstream.destroy())
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    }
  }
}
