import { describe, expect, it } from 'vitest'
import {
  buildDidl,
  buildSoapEnvelope,
  formatClockTime,
  parseClockTime,
  parseDeviceDescription,
  parsePositionInfo,
  parseSsdpResponse
} from '../../src/main/dlna'

const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>客厅电视</friendlyName>
    <modelName>Smart TV</modelName>
    <UDN>uuid:test-tv-1</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/rc/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/av/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

describe('dlna helpers', () => {
  it('解析 SSDP 响应中的 location', () => {
    const text = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      'LOCATION: http://192.168.1.20:9197/dmr',
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
      ''
    ].join('\r\n')
    expect(parseSsdpResponse(text)?.location).toBe('http://192.168.1.20:9197/dmr')
  })

  it('忽略非 200 的 SSDP 响应', () => {
    expect(parseSsdpResponse('HTTP/1.1 404 Not Found\r\n\r\n')).toBeNull()
  })

  it('从设备描述中提取 AVTransport 控制地址', () => {
    const device = parseDeviceDescription(
      DESCRIPTION,
      'http://192.168.1.20:9197/description.xml'
    )
    expect(device).toEqual({
      id: 'uuid:test-tv-1',
      name: '客厅电视',
      model: 'Smart TV',
      controlUrl: 'http://192.168.1.20:9197/av/control',
      location: 'http://192.168.1.20:9197/description.xml'
    })
  })

  it('没有 AVTransport 服务时返回 null', () => {
    expect(
      parseDeviceDescription('<root><friendlyName>X</friendlyName></root>', 'http://192.168.1.9/x')
    ).toBeNull()
  })

  it('生成 HLS 的 DIDL 元数据并转义标题', () => {
    const didl = buildDidl('http://192.168.1.2:8790/lan/m/a/master.m3u8', 'A & B <剧>')
    expect(didl).toContain('application/vnd.apple.mpegurl')
    expect(didl).toContain('A &amp; B &lt;剧&gt;')
  })

  it('生成 SetAVTransportURI 的 SOAP 外壳', () => {
    const xml = buildSoapEnvelope(
      'SetAVTransportURI',
      '<InstanceID>0</InstanceID><CurrentURI>http://192.168.1.2/a</CurrentURI>'
    )
    expect(xml).toContain('u:SetAVTransportURI')
    expect(xml).toContain('urn:schemas-upnp-org:service:AVTransport:1')
  })

  it('解析 GetPositionInfo 响应', () => {
    const xml = `<?xml version="1.0"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
          <Track>1</Track>
          <TrackDuration>0:45:00</TrackDuration>
          <RelTime>0:12:34</RelTime>
          <TransportState>PLAYING</TransportState>
        </u:GetPositionInfoResponse></s:Body>
      </s:Envelope>`
    expect(parsePositionInfo(xml)).toEqual({
      positionMs: 754000,
      durationMs: 2700000,
      state: 'PLAYING'
    })
  })

  it('解析各种时间格式', () => {
    expect(parseClockTime('1:02:03')).toBe(3723000)
    expect(parseClockTime('0:00:05.500')).toBe(5000)
    expect(parseClockTime('12:34')).toBe(754000)
    expect(parseClockTime('NOT_IMPLEMENTED')).toBe(0)
    expect(parseClockTime('')).toBe(0)
  })

  it('格式化时间为 H:MM:SS', () => {
    expect(formatClockTime(0)).toBe('0:00:00')
    expect(formatClockTime(3723500)).toBe('1:02:03')
    expect(formatClockTime(59999)).toBe('0:00:59')
  })
})
