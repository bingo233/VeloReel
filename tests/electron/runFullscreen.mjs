import { createServer, transformWithEsbuild } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
await mkdir('.tmp', { recursive: true })
const permissions = await readFile('src/main/playerPermissions.ts', 'utf8')
const compiled = await transformWithEsbuild(permissions, 'playerPermissions.ts', { format: 'cjs' })
const permissionsPath = resolve('.tmp/fullscreen-permissions.cjs')
await writeFile(permissionsPath, compiled.code)
const server = await createServer({
  configFile: false, root: process.cwd(), plugins: [vue()],
  server: { host: '127.0.0.1', port: 5179 }
})
try {
  await server.listen()
  const port = server.httpServer.address().port
  const env = {
    ...process.env, PLAYER_PERMISSIONS_MODULE: permissionsPath,
    PLAYER_FULLSCREEN_URL: `http://127.0.0.1:${port}/tests/electron/fullscreen.fixture.html`
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['tests/electron/fullscreen.cjs'], { windowsHide: true, stdio: 'inherit', env })
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
  if (code !== 0) process.exitCode = code || 1
} finally {
  await server.close()
}
