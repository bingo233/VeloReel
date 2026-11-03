/** 局域网服务协议版本，桌面端与 App 必须一致。 */
export const LAN_PROTOCOL_VERSION = 1

/** 客户端广播发现使用的固定 UDP 端口。 */
export const LAN_DISCOVERY_PORT = 39393

/** 局域网 HTTP 服务的默认端口。 */
export const LAN_DEFAULT_HTTP_PORT = 8790

/** 单条发现报文的最大字节数。 */
export const LAN_MAX_DISCOVER_BYTES = 512

export interface LanDiscoverPacket {
  v: number
  type: 'discover'
  clientId?: string
  clientName?: string
  platform?: string
}

export interface LanAnnouncePacket {
  v: number
  type: 'announce'
  name: string
  appVersion: string
  httpPort: number
}

function readShortText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = value.trim().slice(0, maxLength)
  return text.length > 0 ? text : undefined
}

/** 解析客户端发现报文，版本或类型不匹配时返回 null。 */
export function parseDiscoverPacket(input: unknown): LanDiscoverPacket | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const value = input as Record<string, unknown>
  if (Number(value.v) !== LAN_PROTOCOL_VERSION || value.type !== 'discover') {
    return null
  }
  return {
    v: LAN_PROTOCOL_VERSION,
    type: 'discover',
    clientId: readShortText(value.clientId, 64),
    clientName: readShortText(value.clientName, 40),
    platform: readShortText(value.platform, 24)
  }
}
