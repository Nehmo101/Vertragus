import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const resultPath = join(tmpdir(), `orca-ui-smoke-${randomUUID()}.json`)
const dataPath = join(tmpdir(), `orca-ui-smoke-data-${randomUUID()}`)
mkdirSync(dataPath, { recursive: true })
const timeoutMs = 30_000

const electronArgs = ['.']
if (process.platform === 'linux' && process.env.CI) {
  // GitHub-hosted Linux runners cannot use Chromium's SUID sandbox.
  electronArgs.push('--no-sandbox')
}
electronArgs.push(`--user-data-dir=${dataPath}`)

const child = spawn(electron, electronArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ORCA_UI_SMOKE: resultPath,
    ORCA_UI_SMOKE_DATA: dataPath,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  },
  stdio: 'inherit',
  windowsHide: true
})

const timeout = setTimeout(() => {
  child.kill()
}, timeoutMs)

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => resolve(code ?? 1))
}).finally(() => clearTimeout(timeout))

try {
  if (!existsSync(resultPath)) {
    throw new Error(`Electron UI smoke produced no result (exit ${exitCode}).`)
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  if (!result.ok || exitCode !== 0) {
    throw new Error(`Electron UI smoke failed: ${JSON.stringify(result)}`)
  }
  console.log(
    `Electron UI smoke passed: ${Object.entries(result.checks)
      .map(([name, passed]) => `${name}=${passed ? 'ok' : 'failed'}`)
      .join(', ')}`
  )
} finally {
  rmSync(resultPath, { force: true })
  rmSync(dataPath, { recursive: true, force: true })
}
