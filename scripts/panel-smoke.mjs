/**
 * Panel smoke: boot the real app, capture the panel, prove it rendered.
 *
 * Unit tests cover the panel's view model; nothing in them would notice a
 * renderer that white-screens on a CSP violation, a preload that fails to
 * expose the bridge, or a window that never becomes visible. This script is the
 * cheapest possible check against that: it starts the packaged main process
 * with `VERTRAGUS_PANEL_SCREENSHOT=<png>` (the hook in src/main/index.ts), waits
 * for the process to exit on its own, and then looks at the file.
 *
 * The hook itself refuses to capture a window whose `#root` never got a child
 * (see src/main/windows/smokeCapture.ts) — a white screen therefore fails here
 * with a message instead of arriving as a plausible-looking PNG.
 *
 * "Looks at the file" means the PNG header, not the bytes: under Xvfb there is
 * no compositor, so a transparent window renders on whatever backdrop the
 * server provides and byte-comparing against a reference would fail for reasons
 * that have nothing to do with the app. Dimensions and a plausible size catch
 * the failure this is here for — a window that produced nothing.
 *
 * Usage: `node scripts/panel-smoke.mjs [--keep]`
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The app gets this long to boot, load and capture before it is killed. */
export const SMOKE_TIMEOUT_MS = 90_000

/** Below this the capture is an empty or single-colour placeholder. */
export const MIN_PNG_BYTES = 1_024

/** A panel window is 280 px wide; anything smaller is not the panel. */
export const MIN_PNG_WIDTH = 100
export const MIN_PNG_HEIGHT = 100

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Read a PNG's IHDR. Returns the reason it is not a usable capture, or null.
 * Pure and exported so the checks themselves are unit-testable.
 */
export function inspectPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return 'Datei ist kürzer als ein PNG-Header.'
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'Datei beginnt nicht mit der PNG-Signatur.'
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return 'PNG ohne IHDR-Block.'
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width < MIN_PNG_WIDTH || height < MIN_PNG_HEIGHT) {
    return `Aufnahme ist ${width}×${height} px — zu klein für das Panel.`
  }
  if (buffer.length < MIN_PNG_BYTES) {
    return `Aufnahme ist nur ${buffer.length} Bytes groß — vermutlich eine leere Fläche.`
  }
  return null
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options })
    child.on('error', (error) => resolveRun({ code: 1, error }))
    child.on('exit', (code, signal) => resolveRun({ code: code ?? 1, signal }))
  })
}

async function ensureBuild() {
  if (existsSync(join(root, 'out', 'main', 'index.js'))) return true
  console.log('[panel-smoke] out/ fehlt — baue zuerst.')
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const { code } = await run(pnpm, ['run', 'build'], { shell: process.platform === 'win32' })
  if (code !== 0) console.error('[panel-smoke] Build fehlgeschlagen.')
  return code === 0
}

async function main() {
  if (!(await ensureBuild())) return 1

  const { default: electronPath } = await import('electron')
  if (typeof electronPath !== 'string') {
    console.error('[panel-smoke] Electron-Binärpfad nicht auflösbar.')
    return 1
  }

  const outDir = join(tmpdir(), 'vertragus-panel-smoke')
  mkdirSync(outDir, { recursive: true })
  const target = join(outDir, `panel-${process.pid}.png`)
  rmSync(target, { force: true })

  // Linux CI runners have unprivileged user namespaces disabled, which stops
  // Chromium's setuid sandbox from starting at all. This is a rendering check,
  // not a sandbox check — the production posture is asserted by the window
  // security contract test, which greps the real flags in src/main/windows.
  //
  // The GPU switches are the other half of running under Xvfb: there is no
  // compositor and no GPU there, so Chromium's viz process negotiates a
  // surface it cannot actually get, and a capture request that lands in that
  // window is answered with `UnknownVizError` (CI, 2026-08-12: the identical
  // commit captured at 10:16 and failed at 11:39). Forcing the software
  // compositing path takes the GPU process out of the picture entirely, and
  // /dev/shm on a container runner is too small for Chromium's default.
  // Linux-only and smoke-only: nothing here changes how the app ships.
  const args = ['.']
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--disable-dev-shm-usage')
  }

  console.log(`[panel-smoke] starte Electron → ${target}`)
  const child = spawn(electronPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VERTRAGUS_PANEL_SCREENSHOT: target }
  })

  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      console.error(`[panel-smoke] Zeitüberschreitung nach ${SMOKE_TIMEOUT_MS} ms.`)
      child.kill('SIGKILL')
      resolveExit(1)
    }, SMOKE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      console.error('[panel-smoke] Electron ließ sich nicht starten:', error)
      resolveExit(1)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal) console.error(`[panel-smoke] Electron endete mit Signal ${signal}.`)
      resolveExit(code ?? 1)
    })
  })

  if (exit !== 0) {
    console.error(`[panel-smoke] Electron endete mit Code ${exit}.`)
    return 1
  }
  if (!existsSync(target)) {
    console.error('[panel-smoke] Keine Aufnahme geschrieben — das Panel hat nie geladen.')
    return 1
  }

  const buffer = readFileSync(target)
  const problem = inspectPng(buffer)
  if (problem) {
    console.error(`[panel-smoke] ${problem}`)
    return 1
  }

  console.log(
    `[panel-smoke] ok — ${statSync(target).size} Bytes, ` +
      `${buffer.readUInt32BE(16)}×${buffer.readUInt32BE(20)} px.`
  )
  if (!process.argv.includes('--keep')) rmSync(target, { force: true })
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main())
}
