import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, protocol, session } from 'electron'
import { AppStorage } from './storage'
import { HlsProxyServer } from './hlsProxyServer'
import { LlmRuleGenerator } from './llmRuleGenerator'
import { registerIpcHandlers } from './ipcHandlers'
import { StreamExtractor } from './streamExtractor'
import { StreamResolver } from './streamResolver'
import { VodService } from './vodService'
import { configurePlayerPermissions } from './playerPermissions'
import { configureRendererNetwork, isSameDocumentUrl, restrictWindow } from './windowSecurity'
import { registerSafeImages } from './safeImages'
import { closePublicConnections } from './urlSafety'

const rendererUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).href
app.enableSandbox()
protocol.registerSchemesAsPrivileged([{ scheme: 'safe-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | undefined
let storage: AppStorage | undefined
let proxy: HlsProxyServer | undefined
let extractor: StreamExtractor | undefined
let shutdownStarted = false
let shutdownComplete = false

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#090b10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  restrictWindow(window, (url) => isSameDocumentUrl(url, rendererUrl))

  void window.loadURL(rendererUrl)
  return window
}

async function bootstrap(): Promise<void> {
  configurePlayerPermissions(session.defaultSession, () => mainWindow?.webContents)
  session.defaultSession.setDevicePermissionHandler(() => false)
  registerSafeImages(session.defaultSession.protocol)

  storage = new AppStorage()
  proxy = new HlsProxyServer(storage, rendererUrl)
  extractor = new StreamExtractor()
  const resolver = new StreamResolver(storage, extractor)
  const vod = new VodService(storage)
  const ruleGenerator = new LlmRuleGenerator(storage, extractor)
  const proxyPort = await proxy.start()
  configureRendererNetwork(session.defaultSession, rendererUrl, `http://127.0.0.1:${proxyPort}`)
  disposeIpc = registerIpcHandlers({ storage, proxy, resolver, vod, ruleGenerator, rendererUrl, getPlayerContents: () => mainWindow?.webContents })
  mainWindow = createWindow()
}

async function shutdown(): Promise<void> {
  disposeIpc?.()
  disposeIpc = undefined
  extractor?.dispose()
  storage?.flush()
  await proxy?.stop()
  await closePublicConnections()
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

void app.whenReady().then(bootstrap).catch((error) => {
  console.error('Application bootstrap failed:', error)
  app.exit(1)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && storage && proxy) mainWindow = createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void shutdown().catch((error) => console.error('Shutdown failed:', error)).finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
