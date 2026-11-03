import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { Agent } from 'undici'
import { AppError } from './errors'

const FORBIDDEN_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home',
  '.lan'
]

export function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIp(normalized.slice(7))
  }

  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number)
    const a = octets[0] ?? -1
    const b = octets[1] ?? -1
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && octets[2] === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }

  if (isIP(normalized) === 6) {
    return (
      !/^[23][0-9a-f]{3}:/.test(normalized) ||
      normalized.startsWith('2001:db8:') ||
      /^2001:(?:[01]?[0-9a-f]{1,2}):/.test(normalized) ||
      normalized.startsWith('2002:')
    )
  }

  return true
}

export function parseRemoteUrl(input: string, base?: string | URL): URL {
  let url: URL
  try {
    url = base ? new URL(input, base) : new URL(input)
  } catch {
    throw new AppError('INVALID_URL', '地址格式无效')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('UNSAFE_URL', '只允许访问 HTTP 或 HTTPS 地址')
  }
  if (url.username || url.password) {
    throw new AppError('UNSAFE_URL', '地址中不能包含登录凭据')
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (!hostname.includes('.') && isIP(hostname) === 0)
  ) {
    throw new AppError('UNSAFE_URL', '不允许访问本机或内网主机')
  }
  if (isIP(hostname) && isPrivateIp(hostname)) {
    throw new AppError('UNSAFE_URL', '不允许访问本机或内网地址')
  }
  return url
}

export async function assertSafeRemoteUrl(input: string | URL): Promise<URL> {
  const url = parseRemoteUrl(input.toString())
  await resolvePublicHost(url.hostname)
  return url
}

export async function resolvePublicHost(hostnameValue: string): Promise<Array<{ address: string; family: number }>> {
  const hostname = hostnameValue.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new AppError('UNSAFE_URL', '不允许连接本机或内网地址')
    return [{ address: hostname, family: isIP(hostname) }]
  }
  let addresses: Array<{ address: string; family: number }>
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), 5000)
        timer.unref()
      })
    ])
  } catch (error) {
    throw new AppError('DNS_FAILED', `无法解析主机 ${hostname}`, error)
  } finally {
    clearTimeout(timer)
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new AppError('UNSAFE_URL', '域名解析到了本机或内网地址')
  }
  return addresses
}

// 校验发生在实际建连的 DNS 回调内，连接直接使用校验过的 IP，避免二次解析绕过。
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  void resolvePublicHost(hostname).then((resolved) => {
    const addresses = options.family ? resolved.filter((item) => item.family === options.family) : resolved
    const first = addresses[0]
    if (!first) throw new AppError('DNS_FAILED', '没有可用的公网地址')
    if (options.all) callback(null, addresses)
    else callback(null, first.address, first.family)
  }).catch((error: Error) => callback(error, '', 0))
}

const publicAgent = new Agent({
  connect: { lookup: publicLookup, timeout: 10_000 },
  connections: 8,
  maxOrigins: 128
})

export async function closePublicConnections(): Promise<void> {
  await publicAgent.destroy()
}

export function stripCrossOriginCredentials(headers: Headers): void {
  const names: string[] = []
  headers.forEach((_value, name) => names.push(name))
  for (const name of names) {
    if (['authorization', 'cookie', 'proxy-authorization'].includes(name) || name.startsWith('x-')) {
      headers.delete(name)
    }
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
}

/** Fetch with protocol, DNS, redirect and timeout checks. */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1_000), 60_000)
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? 4, 0), 8)
  let current = parseRemoteUrl(input.toString())
  let redirects = 0
  const headers = new Headers(init.headers)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal

  while (true) {
    const response = await fetch(current, {
      ...init,
      headers,
      redirect: 'manual',
      signal,
      dispatcher: publicAgent
    } as RequestInit)

    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    if (redirects >= maxRedirects) {
      await response.body?.cancel()
      throw new AppError('TOO_MANY_REDIRECTS', '远程地址重定向次数过多')
    }
    await response.body?.cancel()
    const next = parseRemoteUrl(new URL(location, current).toString())
    if (next.origin !== current.origin) stripCrossOriginCredentials(headers)
    current = next
    redirects += 1
  }
}

export async function readResponseBuffer(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new AppError('RESPONSE_TOO_LARGE', '远程响应体积超过安全限制')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new AppError('RESPONSE_TOO_LARGE', '远程响应体积超过安全限制')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size)
}

export async function readResponseText(
  response: Response,
  maxBytes: number
): Promise<string> {
  return (await readResponseBuffer(response, maxBytes)).toString('utf8')
}
