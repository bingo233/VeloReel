const { app, BrowserWindow, session } = require('electron')
const { blockDownloads, restrictWindow } = require(process.env.PLAYER_SECURITY_MODULES + '/windowSecurity.js')
const { SnifferProxy } = require(process.env.PLAYER_SECURITY_MODULES + '/snifferProxy.js')
const { parseRemoteUrl } = require(process.env.PLAYER_SECURITY_MODULES + '/urlSafety.js')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()
app.enableSandbox()
app.setPath('userData', fs.mkdtempSync(path.resolve('.tmp/security-test-')))
app.on('window-all-closed', () => {})
let win
let server
const proxy = new SnifferProxy()
const deadline = (promise, label, milliseconds = 7000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out: ' + label)), milliseconds)
  })]).finally(() => clearTimeout(timer))
}

app.whenReady().then(async () => {
  try {
    let secretHits = 0
    server = createServer((req, res) => {
      if (req.url === '/private-secret') secretHits += 1
      if (req.url === '/download') {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Disposition', 'attachment; filename="untrusted-test.exe"')
      }
      res.end('security test fixture')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const local = `http://127.0.0.1:${server.address().port}`
    const isolated = session.fromPartition(`security-${Date.now()}`, { cache: false })
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.setDevicePermissionHandler(() => false)
    blockDownloads(isolated)
    win = new BrowserWindow({ show: false, webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      webviewTag: false, navigateOnDragDrop: false, disableDialogs: true, webgl: false
    } })
    restrictWindow(win, (url) => { try { parseRemoteUrl(url); return true } catch { return false } })
    await win.loadURL('data:text/html,<html><body>Untrusted page fixture</body></html>')
    const capabilities = await win.webContents.executeJavaScript(`({ node: typeof require, process: typeof process, ipc: typeof window.api })`)
    assert.deepEqual(capabilities, { node: 'undefined', process: 'undefined', ipc: 'undefined' })
    await win.webContents.executeJavaScript(`window.open('https://example.com/popup')`, true)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    console.log('PASS: third-party page has no Node.js or application IPC; popups are blocked')

    const downloaded = new Promise((resolve) => isolated.once('will-download', (event) => resolve(event.defaultPrevented)))
    win.webContents.downloadURL(local + '/download')
    assert.equal(await deadline(downloaded, 'download blocked'), true)
    console.log('PASS: downloads are cancelled before a file is saved')

    const proxyRules = await proxy.start()
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules, proxyBypassRules: '<-loopback>' })
    await isolated.closeAllConnections()
    await deadline(win.webContents.executeJavaScript(`fetch(${JSON.stringify(local + '/private-secret')}, { mode: 'no-cors' }).then(() => false, () => true)`), 'private fetch blocked')
    assert.equal(secretHits, 0)
    console.log('PASS: Chromium cannot bypass the sniffer proxy to access a loopback service')

    if (process.argv.includes('--public')) {
      await deadline(win.loadURL('https://example.com/'), 'public HTTPS through proxy', 25000)
      assert.match(await win.webContents.executeJavaScript('document.title'), /Example Domain/)
      console.log('PASS: public HTTPS pages still load through the proxy with normal certificate validation')
    }
    win.destroy()
    proxy.close()
    await new Promise((resolve) => server.close(resolve))
    app.exit(0)
  } catch (error) {
    console.error(error)
    win?.destroy()
    proxy.close()
    server?.close()
    app.exit(1)
  }
})
