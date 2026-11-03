import { transformWithEsbuild } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const directory = resolve('.tmp/security-native')
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, 'package.json'), '{"type":"commonjs"}')
for (const name of ['windowSecurity', 'snifferProxy', 'urlSafety', 'errors']) {
  const source = await readFile(`src/main/${name}.ts`, 'utf8')
  const result = await transformWithEsbuild(source, `${name}.ts`, { format: 'cjs' })
  await writeFile(resolve(directory, `${name}.js`), result.code)
}
const env = { ...process.env, PLAYER_SECURITY_MODULES: directory }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), ['tests/electron/security.cjs', ...process.argv.slice(2)], {
  windowsHide: true, stdio: 'inherit', env
})
const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
if (code !== 0) process.exitCode = code || 1
