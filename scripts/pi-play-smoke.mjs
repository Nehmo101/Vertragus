/**
 * Pi Play smoke: boot the real app with isolated userData, Play-shaped
 * `VERTRAGUS_DEV_RUN`, Pi wrap on via the settings store, and exit 0 only
 * when the orchestrator PTY is a live TUI with Vertragus MCP attached.
 *
 * This is the Windows blank-window regression: ConPTY + electron.exe produced
 * no bytes. A PNG of the CLI window would still look like glass. The hook in
 * `src/main/piPlaySmoke.ts` reads raw PTY bytes.
 *
 * Pi is pointed at a throwaway `PI_CODING_AGENT_DIR` so developer `~/.pi` is
 * never read. The Electron process keeps the runner HOME — an empty HOME
 * hung macOS CI (Keychain / first-run Chromium) before the in-app hook armed.
 * Provider API keys are stripped from the child env — this smoke does not
 * spend tokens.
 *
 * Usage: `node scripts/pi-play-smoke.mjs [--keep]`
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Outer kill if Electron never exits (the in-app hook times out at 60s). */
export const SMOKE_TIMEOUT_MS = 90_000

/** Must match `STORE_NAME` in src/main/store/settings.ts. */
export const STORE_FILE = 'vertragus-v2.json'

/** Keys that would let Pi talk to a billed backend. Never forwarded. */
export const PROVIDER_KEY_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']

/**
 * Child env for the Electron boot: isolated userData, throwaway Pi dir, no
 * provider keys. Does not rewrite HOME — macOS Electron hangs on an empty
 * home directory. Exported so the strip is unit-testable.
 */
export function childEnv(base, extras) {
  const env = { ...base, ...extras }
  for (const key of PROVIDER_KEY_ENVS) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  // Developer ~/.pi must not leak unless extras replace it with a throwaway dir.
  if (extras?.PI_CODING_AGENT_DIR === undefined) delete env.PI_CODING_AGENT_DIR
  delete env.VERTRAGUS_PANEL_SCREENSHOT
  delete env.VERTRAGUS_CLI_SCREENSHOT
  delete env.VERTRAGUS_DEV_RUN_SCREENSHOT
  delete env.VERTRAGUS_DEV_GOAL
  delete env.VERTRAGUS_DEV_SPAWN
  return env
}

/** True when the in-app hook wrote a passing verdict. */
export function inspectPiPlayLog(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'Pi Play smoke wrote no log.'
  }
  if (!/^status=pass$/m.test(text)) {
    return 'Pi Play smoke did not pass — see the snapshot in the log.'
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
  console.log('[pi-play-smoke] out/ fehlt — baue zuerst.')
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const { code } = await run(pnpm, ['run', 'build'], { shell: process.platform === 'win32' })
  if (code !== 0) console.error('[pi-play-smoke] Build fehlgeschlagen.')
  return code === 0
}

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git(['init'])
  git(['config', 'user.email', 'smoke@vertragus.invalid'])
  git(['config', 'user.name', 'Pi Play smoke'])
  writeFileSync(join(dir, 'README.md'), 'pi-play-smoke\n')
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'smoke'])
}

async function main() {
  if (!(await ensureBuild())) return 1

  const { default: electronPath } = await import('electron')
  if (typeof electronPath !== 'string') {
    console.error('[pi-play-smoke] Electron-Binärpfad nicht auflösbar.')
    return 1
  }

  const work = join(tmpdir(), `vertragus-pi-play-smoke-${process.pid}`)
  const userData = join(work, 'userData')
  const home = join(work, 'home')
  const repo = join(work, 'repo')
  const logPath = join(work, 'pi-play.log')
  mkdirSync(userData, { recursive: true })
  mkdirSync(home, { recursive: true })
  const piDir = join(home, '.pi')
  mkdirSync(piDir, { recursive: true })
  makeRepo(repo)
  writeFileSync(join(userData, STORE_FILE), `${JSON.stringify({ piHarnessEnabled: true }, null, 2)}\n`)

  const args = ['.', `--user-data-dir=${userData}`]
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--disable-dev-shm-usage')
  }

  console.log(`[pi-play-smoke] starte Electron → ${logPath}`)
  const child = spawn(electronPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: childEnv(process.env, {
      VERTRAGUS_USER_DATA: userData,
      VERTRAGUS_DEV_RUN: repo,
      VERTRAGUS_PI_PLAY_SMOKE: logPath,
      PI_CODING_AGENT_DIR: piDir,
      PI_SKIP_VERSION_CHECK: '1'
    })
  })

  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      console.error(`[pi-play-smoke] Zeitüberschreitung nach ${SMOKE_TIMEOUT_MS} ms.`)
      child.kill('SIGKILL')
      resolveExit(1)
    }, SMOKE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      console.error('[pi-play-smoke] Electron ließ sich nicht starten:', error)
      resolveExit(1)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal) console.error(`[pi-play-smoke] Electron endete mit Signal ${signal}.`)
      resolveExit(code ?? 1)
    })
  })

  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  if (logText) console.error(logText)

  const keep = process.argv.includes('--keep')
  if (!keep) rmSync(work, { recursive: true, force: true })

  if (exit !== 0) {
    console.error(`[pi-play-smoke] Electron endete mit Code ${exit}.`)
    return 1
  }
  const problem = inspectPiPlayLog(logText)
  if (problem) {
    console.error(`[pi-play-smoke] ${problem}`)
    return 1
  }

  console.log('[pi-play-smoke] ok — Pi TUI started and Vertragus MCP attached.')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main())
}
