import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'vitest'

const require = createRequire(import.meta.url)
const directory = dirname(require.resolve('electron'))
const binary = resolve(directory, 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')

it.skipIf(!existsSync(binary))('masks passwords, moves focus, submits real forms and rejects stale DOM refs in Chromium', async () => {
  const electron = resolve(directory, 'dist', readFileSync(resolve(directory, 'path.txt'), 'utf8').trim())
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_OVERRIDE_DIST_PATH
  await promisify(execFile)(electron, [resolve('extensions/chromium/content.dom.cjs'), '--no-sandbox'], {
    env, windowsHide: true, timeout: 25_000
  })
}, 30_000)
