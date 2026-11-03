import { networkInterfaces } from 'node:os'

/** 判断地址是否属于保留的私网 / 本机范围，拒绝公网来源。 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) {
    return false
  }
  const normalized = address.trim().toLowerCase().split('%')[0] ?? ''
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIPv4(normalized.slice('::ffff:'.length))
  }
  if (normalized === '::1') {
    return true
  }
  if (normalized.includes(':')) {
    const firstGroup = normalized.split(':')[0] ?? ''
    return (
      firstGroup.startsWith('fc') ||
      firstGroup.startsWith('fd') ||
      ['fe8', 'fe9', 'fea', 'feb'].some((prefix) => firstGroup.startsWith(prefix))
    )
  }
  return isPrivateIPv4(normalized)
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) {
    return false
  }
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }
    const value = Number(part)
    if (value < 0 || value > 255) {
      return false
    }
    octets.push(value)
  }
  const a = octets[0] ?? -1
  const b = octets[1] ?? -1
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

/** 枚举本机可用于局域网访问的 IPv4 地址。 */
export function listLanAddresses(): string[] {
  const interfaces = networkInterfaces()
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) {
        addresses.add(entry.address)
      }
    }
  }
  return [...addresses].sort()
}
