import type { AppSettings, LanStatus } from '../shared/types'
import type { AppStorage } from './storage'
import type { VodService } from './vodService'
import type { StreamResolver } from './streamResolver'
import type { HlsProxyServer } from './hlsProxyServer'
import { LanServer } from './lanServer'
import { LanDiscovery } from './lanDiscovery'
import { listLanAddresses } from './lanAddress'

export class LanService {
  private readonly server: LanServer
  private readonly discovery: LanDiscovery

  constructor(
    private readonly storage: AppStorage,
    vod: VodService,
    resolver: Pick<StreamResolver, 'resolve'>,
    proxy: Pick<HlsProxyServer, 'registerLan' | 'handleLanMedia'>,
    appVersion: string
  ) {
    this.server = new LanServer(storage, vod, appVersion, { resolver, proxy })
    this.discovery = new LanDiscovery(() => ({
      name: storage.getSettings().deviceName,
      appVersion,
      httpPort: this.server.port
    }))
  }

  getStatus(): LanStatus {
    const settings = this.storage.getSettings()
    return {
      enabled: settings.lanEnabled,
      running: this.server.running,
      port: this.server.running ? this.server.port : settings.lanPort,
      addresses: this.server.running ? listLanAddresses() : [],
      error: this.server.error || this.discovery.error
    }
  }

  /** 按最新设置启动或停止局域网服务。 */
  async apply(settings: AppSettings): Promise<void> {
    if (!settings.lanEnabled) {
      await this.stop()
      return
    }
    if (this.server.running && this.server.port === settings.lanPort) {
      if (!this.discovery.running) {
        await this.discovery.start()
      }
      return
    }
    await this.stop()
    await this.server.start(settings.lanPort)
    if (this.server.running) {
      await this.discovery.start()
    }
  }

  async stop(): Promise<void> {
    await this.discovery.stop()
    await this.server.stop()
  }
}
