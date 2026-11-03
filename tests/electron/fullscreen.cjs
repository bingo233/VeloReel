const { app, BrowserWindow, session } = require('electron')
const { configurePlayerPermissions } = require(process.env.PLAYER_PERMISSIONS_MODULE)
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

app.disableHardwareAcceleration()
app.setPath('userData', fs.mkdtempSync(path.resolve('.tmp/fullscreen-test-')))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.on('window-all-closed', () => {})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let win

async function evaluate(source) {
  let timer
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(source, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${source}`)), 7000) })
    ])
  } finally { clearTimeout(timer) }
}

async function waitUntil(description, check) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}

async function loadFixture() {
  await win.loadURL(process.env.PLAYER_FULLSCREEN_URL)
  await waitUntil('player ready', () => evaluate('document.body.dataset.ready === "true"'))
}

const inFullscreen = () => evaluate('document.fullscreenElement === document.querySelector(".art-video-player")')
const clickFullscreen = () => evaluate('document.querySelector(".art-control-fullscreen").click()')
const press = (code) => evaluate(`(() => {
  const player = document.querySelector('.art-video-player');
  player.focus();
  player.dispatchEvent(new KeyboardEvent('keydown', { code: ${JSON.stringify(code)}, bubbles: true, cancelable: true }));
})()`)

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 1000, height: 720, show: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
    })
    let deniedFullscreen = false
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      if (permission === 'fullscreen') deniedFullscreen = true
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
      if (permission === 'fullscreen') deniedFullscreen = true
      return false
    })
    await loadFixture()
    await evaluate(`void document.querySelector('.art-video-player').requestFullscreen().catch(() => undefined)`)
    await waitUntil('previous policy denies fullscreen', () => deniedFullscreen)
    assert.equal(await inFullscreen(), false, 'the previous deny-all permission policy reproduces the failure')
    console.log('PASS: reproduced fullscreen denial with the previous policy')

    win.destroy()
    win = new BrowserWindow({
      width: 1000, height: 720, show: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
    })

    configurePlayerPermissions(session.defaultSession, () => win?.webContents)
    await loadFixture()
    await clickFullscreen()
    await waitUntil('fullscreen button enters HTML fullscreen', inFullscreen)
    await waitUntil('Electron window enters fullscreen', () => win.isFullScreen())
    await clickFullscreen()
    await waitUntil('fullscreen button exits fullscreen', async () => !(await inFullscreen()) && !win.isFullScreen())
    console.log('PASS: fullscreen button enters and exits native fullscreen')

    await press('KeyF')
    await waitUntil('F enters fullscreen', inFullscreen)
    await evaluate('document.querySelector(".player-control-button[aria-label=选集]").click()')
    assert.equal(await evaluate('!!document.fullscreenElement.querySelector(".player-episodes")'), true)
    await press('Escape')
    assert.equal(await inFullscreen(), true, 'closing the episode panel preserves fullscreen')
    await press('KeyF')
    await waitUntil('F exits fullscreen', async () => !(await inFullscreen()))
    console.log('PASS: F toggles fullscreen and episode controls remain inside it')

    await press('KeyF')
    await waitUntil('F re-enters fullscreen', inFullscreen)
    await press('Escape')
    await waitUntil('Escape exits fullscreen', async () => !(await inFullscreen()))
    console.log('PASS: Escape exits fullscreen')
    win.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    win?.destroy()
    app.exit(1)
  }
})
