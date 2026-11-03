import { createSocket } from 'node:dgram'
import type { RemoteInfo, Socket } from 'node:dgram'
import { errorMessage } from './errors'
import { isPrivateAddress } from './lanAddress'
import {
  LAN_DISCOVERY_PORT,
  LAN_MAX_DISCOVER_BYTES,
  LAN_PROTOCOL_VERSION,
  parseDiscoverPacket
} from '../shared/lanProtocol'
import type { LanAnnouncePacket } from '../shared/lanProtocol'

interface AnnounceInfo {
  name: string
  appVersion: string
  httpPort: number
}

export class LanDiscovery {
  private socket: Socket | undefined
  private startError = ''

  constructor(private readonly getAnnounceInfo: () => AnnounceInfo | null) {}

  get running(): boolean {
    return this.socket !== undefined
  }

  get error(): string {
    return this.startError
  }

  async start(): Promise<void> {
    if (this.socket) {
      return
    }
    this.startError = ''
    const socket = createSocket({ type: 'udp4' })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(LAN_DISCOVERY_PORT, '0.0.0.0', () => {
          socket.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.startError = errorMessage(error)
      try {
        socket.close()
      } catch {
        // 绑定失败时套接字可能尚未打开
      }
      return
    }
    socket.on('message', (message, remote) => this.onMessage(message, remote))
    socket.on('error', (error) => {
      this.startError = errorMessage(error)
    })
    this.socket = socket
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = undefined
    this.startError = ''
    if (!socket) {
      return
    }
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  private onMessage(message: Buffer, remote: RemoteInfo): void {
    if (!isPrivateAddress(remote.address) || message.byteLength > LAN_MAX_DISCOVER_BYTES) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(message.toString('utf8'))
    } catch {
      return
    }
    if (!parseDiscoverPacket(parsed)) {
      return
    }
    const info = this.getAnnounceInfo()
    if (!info || info.httpPort <= 0) {
      return
    }
    const announce: LanAnnouncePacket = {
      v: LAN_PROTOCOL_VERSION,
      type: 'announce',
      name: info.name,
      appVersion: info.appVersion,
      httpPort: info.httpPort
    }
    this.socket?.send(JSON.stringify(announce), remote.port, remote.address, () => undefined)
  }
}
