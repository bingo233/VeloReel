import { createSocket } from 'node:dgram'
import { AppError } from './errors'
import { isPrivateIp, readResponseBuffer } from './urlSafety'

const SSDP_HOST = '239.255.255.250'
const SSDP_PORT = 1900
const SOAP_TIMEOUT_MS = 8000
const DESCRIPTION_TIMEOUT_MS = 5000
const MAX_DESCRIPTION_BYTES = 256 * 1024
const MAX_DISCOVERY_DEVICES = 20

export interface DlnaDevice {
  /** 设备 UDN，作为后续投屏操作的标识。 */
  id: string
  name: string
  model: string
  controlUrl: string
  location: string
}

export interface PublicDlnaDevice {
  id: string
  name: string
  model: string
}

/** 通过 SSDP 搜索局域网内的 DLNA 媒体渲染器，并解析设备描述。 */
export async function discoverDlnaDevices(timeoutMs = 4000): Promise<DlnaDevice[]> {
  const locations = new Set<string>()
  await new Promise<void>((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let finished = false
    const finish = (): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // 已经关闭时忽略
      }
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    socket.on('message', (message) => {
      const parsed = parseSsdpResponse(message.toString('utf8'))
      if (parsed?.location) {
        locations.add(parsed.location)
      }
    })
    socket.on('error', finish)
    socket.bind(0, () => {
      for (const searchTarget of [
        'urn:schemas-upnp-org:device:MediaRenderer:1',
        'ssdp:all'
      ]) {
        const payload = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 3',
          `ST: ${searchTarget}`,
          '',
          ''
        ].join('\r\n')
        socket.send(payload, SSDP_PORT, SSDP_HOST, () => {
          // 发送失败时继续等待其他响应
        })
      }
    })
  })

  const results = await Promise.all(
    [...locations].slice(0, MAX_DISCOVERY_DEVICES).map((location) =>
      fetchDeviceDescription(location).catch(() => null)
    )
  )
  const seen = new Set<string>()
  const devices: DlnaDevice[] = []
  for (const device of results) {
    if (!device || seen.has(device.id)) {
      continue
    }
    seen.add(device.id)
    devices.push(device)
  }
  return devices
}

/** 让电视加载指定播放地址并开始播放。 */
export async function playOnDlnaDevice(
  device: DlnaDevice,
  url: string,
  title: string
): Promise<void> {
  const didl = buildDidl(url, title)
  await avTransportAction(
    device,
    'SetAVTransportURI',
    `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(url)}</CurrentURI><CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`
  )
  await avTransportAction(device, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')
}

/** 停止电视上的当前播放。 */
export async function stopDlnaDevice(device: DlnaDevice): Promise<void> {
  await avTransportAction(device, 'Stop', '<InstanceID>0</InstanceID>')
}

/** 暂停电视上的当前播放。 */
export async function pauseDlnaDevice(device: DlnaDevice): Promise<void> {
  await avTransportAction(device, 'Pause', '<InstanceID>0</InstanceID>')
}

/** 继续（恢复）电视上的播放。 */
export async function resumeDlnaDevice(device: DlnaDevice): Promise<void> {
  await avTransportAction(device, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')
}

/** 拖动到指定位置（毫秒）。 */
export async function seekDlnaDevice(device: DlnaDevice, positionMs: number): Promise<void> {
  const target = formatClockTime(Math.max(0, positionMs))
  await avTransportAction(
    device,
    'Seek',
    `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${target}</Target>`
  )
}

export interface DlnaPosition {
  /** 当前播放位置（毫秒）。 */
  positionMs: number
  /** 总时长（毫秒），电视不支持时为 0。 */
  durationMs: number
  /** TransportState，如 PLAYING / PAUSED_PLAYBACK / STOPPED。 */
  state: string
}

/** 查询电视端的播放进度。 */
export async function getDlnaPosition(device: DlnaDevice): Promise<DlnaPosition> {
  const body = await avTransportAction(
    device,
    'GetPositionInfo',
    '<InstanceID>0</InstanceID>'
  )
  return parsePositionInfo(body)
}

export function parsePositionInfo(xml: string): DlnaPosition {
  return {
    positionMs: parseClockTime(matchTag(xml, 'RelTime') ?? ''),
    durationMs: parseClockTime(matchTag(xml, 'TrackDuration') ?? ''),
    state: matchTag(xml, 'TransportState') ?? ''
  }
}

/** 解析 "H:MM:SS.fff" 或 "MM:SS"，无法识别时返回 0。 */
export function parseClockTime(value: string): number {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(value.trim())
  if (!match) {
    return 0
  }
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  return ((hours * 60 + minutes) * 60 + seconds) * 1000
}

/** 输出 DLNA 要求的时间格式 H:MM:SS。 */
export function formatClockTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}`
}

export function parseSsdpResponse(text: string): { location: string } | null {
  const lines = text.split(/\r?\n/)
  if (!/^HTTP\/1\.1 200/i.test(lines[0] ?? '')) {
    return null
  }
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index <= 0) {
      continue
    }
    const name = line.slice(0, index).trim().toLowerCase()
    if (name === 'location') {
      const value = line.slice(index + 1).trim()
      return value ? { location: value } : null
    }
  }
  return null
}

export function parseDeviceDescription(xml: string, location: string): DlnaDevice | null {
  const friendlyName = matchTag(xml, 'friendlyName')
  if (!friendlyName) {
    return null
  }
  let controlUrl = ''
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) ?? []) {
    if (!/AVTransport/i.test(block)) {
      continue
    }
    const raw = matchTag(block, 'controlURL')
    if (raw) {
      try {
        controlUrl = new URL(decodeEntities(raw), location).toString()
      } catch {
        controlUrl = ''
      }
      if (controlUrl) {
        break
      }
    }
  }
  if (!controlUrl) {
    return null
  }
  const udn = matchTag(xml, 'UDN') ?? ''
  return {
    id: udn || controlUrl,
    name: decodeEntities(friendlyName),
    model: decodeEntities(matchTag(xml, 'modelName') ?? ''),
    controlUrl,
    location
  }
}

export function buildDidl(url: string, title: string): string {
  const mime = /\.m3u8(\?|$)/i.test(url) ? 'application/vnd.apple.mpegurl' : 'video/mp4'
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="-1" restricted="1">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    '<upnp:class>object.item.videoItem</upnp:class>',
    `<res protocolInfo="http-get:*:${mime}:*">${escapeXml(url)}</res>`,
    '</item></DIDL-Lite>'
  ].join('')
}

export function buildSoapEnvelope(action: string, inner: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">`,
    inner,
    `</u:${action}></s:Body></s:Envelope>`
  ].join('')
}

async function fetchDeviceDescription(location: string): Promise<DlnaDevice | null> {
  let url: URL
  try {
    url = new URL(location)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isPrivateIp(url.hostname)) {
    return null
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS),
    redirect: 'follow'
  })
  if (!response.ok) {
    await response.body?.cancel()
    return null
  }
  const buffer = await readResponseBuffer(response, MAX_DESCRIPTION_BYTES)
  return parseDeviceDescription(buffer.toString('utf8'), url.toString())
}

async function avTransportAction(
  device: DlnaDevice,
  action: string,
  inner: string
): Promise<string> {
  let target: URL
  try {
    target = new URL(device.controlUrl)
  } catch {
    throw new AppError('DLNA_FAILED', '电视的控制地址无效')
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || !isPrivateIp(target.hostname)) {
    throw new AppError('DLNA_FAILED', '电视的控制地址不在局域网内')
  }
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`
    },
    body: buildSoapEnvelope(action, inner),
    signal: AbortSignal.timeout(SOAP_TIMEOUT_MS)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppError('DLNA_FAILED', `电视拒绝了 ${action} 请求（HTTP ${response.status}）`)
  }
  return response.text()
}

function matchTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return match?.[1]?.trim() ?? null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
