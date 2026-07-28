/**
 * Vertragus headless CLI (docs/HEADLESS.md):
 *
 *   pnpm run headless                 start the host without a window and follow it
 *   pnpm run headless -- status       query a running host (gateway/tunnel/devices)
 *   pnpm run headless -- pair         start a pairing: terminal QR + one-time code
 *
 * The host (VERTRAGUS_HEADLESS=1, src/main/headlessMode.ts) writes a local
 * control descriptor to `userData/headless-control.json` — loopback port plus
 * bearer token, readable only by the owning user. `status` and `pair` talk to
 * that control server; they never weaken the Mission-Control gateway itself.
 *
 * Pure helpers are exported for unit tests (src/main/headlessMode.test.ts);
 * the process logic only runs when the file is executed directly.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONTROL_FILENAME = 'headless-control.json'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Parse argv (after `node scripts/headless.mjs`) into a command description. */
export function parseHeadlessCliArgs(argv) {
  // pnpm forwards the literal `--` separator from `pnpm run headless -- status`.
  const args = argv.filter((value) => value !== '--')
  let command = 'start'
  if (args.length > 0 && !args[0].startsWith('-')) command = args.shift()
  if (!['start', 'status', 'pair', 'help'].includes(command)) {
    return { error: `Unbekanntes Kommando "${command}" — erlaubt: start, status, pair, help.` }
  }
  const result = { command }
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--help' || flag === '-h') {
      result.command = 'help'
    } else if (flag === '--user-data') {
      const value = args.shift()
      if (!value) return { error: '--user-data braucht einen Verzeichnispfad.' }
      result.userData = value
    } else if (flag === '--timeout') {
      const value = Number(args.shift())
      if (!Number.isFinite(value) || value <= 0) {
        return { error: '--timeout braucht eine positive Zahl (Sekunden).' }
      }
      result.timeoutSec = value
    } else {
      return { error: `Unbekannte Option "${flag}".` }
    }
  }
  return result
}

/**
 * Recognize the host's control announcement on stdout:
 * `[headless] control=127.0.0.1:PORT file=PATH`.
 */
export function parseControlAnnouncement(line) {
  const match = /^\[headless\] control=127\.0\.0\.1:(\d{1,5}) file=(.+)$/.exec(line.trim())
  if (!match) return undefined
  return { port: Number(match[1]), file: match[2] }
}

/**
 * Candidate Electron userData directories for this app: dev runs use the
 * package name ("vertragus"), packaged builds the productName ("Vertragus").
 */
export function candidateUserDataDirs(platform, env, home) {
  // Separators must follow the TARGET platform, not the host running the CLI.
  const p = platform === 'win32' ? win32 : posix
  const base =
    platform === 'win32'
      ? env.APPDATA ?? p.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? p.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME ?? p.join(home, '.config')
  return [p.join(base, 'vertragus'), p.join(base, 'Vertragus')]
}

const TUNNEL_LABEL = {
  disabled: 'aus',
  starting: 'startet …',
  online: 'online',
  degraded: 'gestört (Reconnect läuft)',
  error: 'Fehler'
}

/** Human-readable German status block from a RemoteStatus JSON payload. */
export function formatStatusReport(status) {
  const lines = [
    `Mission Control : ${status.enabled ? 'aktiviert' : 'deaktiviert'}`,
    `Gateway         : ${
      status.gatewayRunning && status.gatewayPort
        ? `läuft auf 127.0.0.1:${status.gatewayPort}`
        : 'gestoppt'
    }`,
    `Tunnel          : ${TUNNEL_LABEL[status.tunnel] ?? status.tunnel}${
      status.publicUrl ? ` — ${status.publicUrl}` : ''
    }`,
    `Geräte          : ${status.deviceCount} gepairt`
  ]
  if (status.error) lines.push(`Fehler          : ${status.error}`)
  return lines
}

/** Pairing block (without QR — the caller appends the rendered QR if available). */
export function formatPairingReport(challenge) {
  const expires = new Date(challenge.expiresAt)
  const hhmm = `${String(expires.getHours()).padStart(2, '0')}:${String(
    expires.getMinutes()
  ).padStart(2, '0')}`
  const lines = [
    'Pairing gestartet — auf dem Mobilgerät öffnen und Code eingeben:',
    '',
    `  Code       : ${challenge.code}`,
    `  Gültig bis : ${hhmm} Uhr (einmalig verwendbar)`
  ]
  if (challenge.pairingUrl) lines.push(`  URL        : ${challenge.pairingUrl}`)
  return lines
}

// ---------------------------------------------------------------------------
// Control-file client
// ---------------------------------------------------------------------------

function readControlDescriptor(explicitDir) {
  const dirs = explicitDir
    ? [explicitDir]
    : candidateUserDataDirs(process.platform, process.env, homedir())
  for (const dir of dirs) {
    const file = join(dir, CONTROL_FILENAME)
    if (!existsSync(file)) continue
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (Number.isInteger(data.port) && typeof data.token === 'string') {
        return { ...data, file }
      }
    } catch {
      // Malformed descriptor: treat as absent, keep probing other candidates.
    }
  }
  return undefined
}

async function controlFetch(control, path, { method = 'GET', timeoutMs = 5_000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${control.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${control.token}` },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

function noHostHint(explicitDir) {
  return [
    'Kein laufender Headless-Host gefunden (keine gültige Kontrolldatei).',
    explicitDir
      ? `  Gesucht in: ${join(explicitDir, CONTROL_FILENAME)}`
      : `  Gesucht in: ${candidateUserDataDirs(process.platform, process.env, homedir())
          .map((dir) => join(dir, CONTROL_FILENAME))
          .join(' | ')}`,
    '  Zuerst starten: pnpm run headless'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandStatus(options) {
  const control = readControlDescriptor(options.userData)
  if (!control) {
    console.error(noHostHint(options.userData))
    return 1
  }
  let result
  try {
    result = await controlFetch(control, '/status')
  } catch {
    console.error(
      `Headless-Host (PID ${control.pid ?? '?'}) nicht erreichbar — Kontrolldatei vermutlich veraltet:\n  ${control.file}\nZuerst starten: pnpm run headless`
    )
    return 1
  }
  if (!result.ok) {
    console.error(`Statusabfrage fehlgeschlagen (HTTP ${result.status}): ${result.body.error ?? ''}`)
    return 1
  }
  const status = result.body
  let healthLine = 'Health          : Gateway läuft nicht'
  if (status.gatewayRunning && status.gatewayPort) {
    try {
      const health = await fetch(`http://127.0.0.1:${status.gatewayPort}/health`, {
        signal: AbortSignal.timeout(3_000)
      })
      healthLine = `Health          : ${health.ok ? 'ok' : `HTTP ${health.status}`} (GET /health)`
    } catch {
      healthLine = 'Health          : /health nicht erreichbar'
    }
  }
  console.log(`Vertragus Headless-Host (PID ${control.pid ?? '?'})`)
  for (const line of formatStatusReport(status)) console.log(line)
  console.log(healthLine)
  return 0
}

async function renderTerminalQr(payload) {
  try {
    const qrcode = await import('qrcode')
    return await qrcode.toString(payload, { type: 'terminal', small: true })
  } catch {
    return undefined
  }
}

async function commandPair(options) {
  const control = readControlDescriptor(options.userData)
  if (!control) {
    console.error(noHostHint(options.userData))
    return 1
  }
  let result
  try {
    result = await controlFetch(control, '/pair', { method: 'POST' })
  } catch {
    console.error(
      `Headless-Host nicht erreichbar — Kontrolldatei vermutlich veraltet:\n  ${control.file}`
    )
    return 1
  }
  if (!result.ok) {
    console.error(`Pairing nicht möglich: ${result.body.error ?? `HTTP ${result.status}`}`)
    if (result.status === 409) {
      console.error(
        'Hinweis: Gateway und Tunnel müssen online sein (Mission Control in der Desktop-App aktivieren, dann headless starten).'
      )
    }
    return 1
  }
  for (const line of formatPairingReport(result.body)) console.log(line)
  if (result.body.pairingUrl) {
    const qr = await renderTerminalQr(result.body.pairingUrl)
    if (qr) console.log(`\n${qr}`)
    else {
      console.log(
        '\n(QR-Anzeige nicht verfügbar — optionales Paket "qrcode" fehlt; URL/Code manuell eingeben.)'
      )
    }
  }
  return 0
}

function resolveElectronBinary(cwd) {
  try {
    const pathTxt = join(cwd, 'node_modules', 'electron', 'path.txt')
    if (existsSync(pathTxt)) {
      const binary = join(cwd, 'node_modules', 'electron', 'dist', readFileSync(pathTxt, 'utf8').trim())
      if (existsSync(binary)) return binary
    }
    return createRequire(import.meta.url)('electron')
  } catch {
    return undefined
  }
}

function runBuild(cwd) {
  const probe = spawnSync('pnpm', ['--version'], { cwd, shell: process.platform === 'win32' })
  const runner = probe.status === 0 ? ['pnpm'] : ['corepack', 'pnpm']
  const [command, ...prefix] = runner
  const result = spawnSync(command, [...prefix, 'exec', 'electron-vite', 'build'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) throw new Error(`electron-vite build fehlgeschlagen (exit ${result.status}).`)
}

/** Newest mtime (ms) below dir; 0 when the dir is missing. */
function newestMtimeMs(dir) {
  let newest = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(path))
    else {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs)
      } catch {
        // Racing deletes are fine; the entry simply does not count.
      }
    }
  }
  return newest
}

async function commandStart(options) {
  const cwd = process.cwd()
  const mainEntry = join(cwd, 'out', 'main', 'index.js')
  const sourcesNewest = Math.max(
    newestMtimeMs(join(cwd, 'src', 'main')),
    newestMtimeMs(join(cwd, 'src', 'shared'))
  )
  if (!existsSync(mainEntry) || statSync(mainEntry).mtimeMs < sourcesNewest) {
    console.log('[headless-cli] out/main fehlt oder ist veraltet — baue (electron-vite build) …')
    runBuild(cwd)
  }
  const electronBinary = resolveElectronBinary(cwd)
  if (!electronBinary) {
    console.error(
      'Electron-Binary nicht gefunden — `pnpm install` ausführen (Electron-Download erforderlich).'
    )
    return 1
  }

  const child = spawn(
    electronBinary,
    ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    {
      cwd,
      env: { ...process.env, VERTRAGUS_HEADLESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let control
  let stdoutRest = ''
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    stdoutRest += String(chunk)
    const lines = stdoutRest.split(/\r?\n/)
    stdoutRest = lines.pop() ?? ''
    for (const line of lines) {
      const announced = parseControlAnnouncement(line)
      if (announced && !control) {
        try {
          const data = JSON.parse(readFileSync(announced.file, 'utf8'))
          control = { port: announced.port, token: data.token, file: announced.file }
          void printStartSummary(control)
        } catch {
          // Descriptor not readable yet; status stays available via `-- status`.
        }
      }
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  async function printStartSummary(active) {
    try {
      const result = await controlFetch(active, '/status')
      if (!result.ok) return
      console.log('\n──────── Vertragus Headless ────────')
      for (const line of formatStatusReport(result.body)) console.log(line)
      console.log('Pairing         : pnpm run headless -- pair   (zweites Terminal)')
      console.log('Status          : pnpm run headless -- status')
      console.log('Beenden         : Ctrl+C (geordneter Shutdown)')
      console.log('────────────────────────────────────\n')
    } catch {
      // Summary is cosmetic; the host's own [headless] lines are already shown.
    }
  }

  let shuttingDown = false
  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[headless-cli] Beende Host …')
    if (control) {
      try {
        await controlFetch(control, '/shutdown', { method: 'POST', timeoutMs: 3_000 })
      } catch {
        // Fall through to the hard kill below.
      }
    }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
      if (child.exitCode !== null) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    if (!exited) {
      console.warn('[headless-cli] Host reagiert nicht — erzwinge Beendigung.')
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      } else {
        child.kill('SIGKILL')
      }
    }
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  if (options.timeoutSec) {
    const timer = setTimeout(() => {
      console.log(`[headless-cli] --timeout ${options.timeoutSec}s erreicht.`)
      void shutdown()
    }, options.timeoutSec * 1000)
    timer.unref?.()
  }

  return new Promise((resolve) => {
    child.once('exit', (code) => {
      console.log(`[headless-cli] Host beendet (exit ${code ?? 0}).`)
      resolve(shuttingDown ? 0 : code ?? 0)
    })
  })
}

function printHelp() {
  console.log(
    [
      'Vertragus Headless-CLI — Betrieb ohne Fenster (docs/HEADLESS.md)',
      '',
      '  pnpm run headless                   Host starten und Ausgabe folgen',
      '  pnpm run headless -- status         laufenden Host abfragen',
      '  pnpm run headless -- pair           Pairing starten (Terminal-QR + Code)',
      '',
      'Optionen:',
      '  --user-data <dir>   userData-Verzeichnis explizit angeben (status/pair)',
      '  --timeout <sek>     Host nach N Sekunden geordnet beenden (start)',
      '  --help              diese Hilfe'
    ].join('\n')
  )
}

async function main() {
  const parsed = parseHeadlessCliArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    printHelp()
    process.exitCode = 2
    return
  }
  if (parsed.command === 'help') {
    printHelp()
    return
  }
  const exit =
    parsed.command === 'status'
      ? await commandStatus(parsed)
      : parsed.command === 'pair'
        ? await commandPair(parsed)
        : await commandStart(parsed)
  process.exitCode = exit
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await main()
}
