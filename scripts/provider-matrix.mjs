/**
 * Provider live matrix: probe every shipped preset's CLI on THIS machine.
 *
 * What this proves, honestly: that each CLI is installed (it answers its
 * version probe), that it spawns under a real PTY, and that it takes the
 * keyboard (it announces DECSET 2004 — the same readiness signal the seed
 * handshake waits for, see src/main/agents/interactiveReady.ts). It does NOT
 * prove the CLI can log in, list models, or execute a task — that is what the
 * live probe in tests/live/handover.live.test.ts is for. This script is the
 * weekly canary that notices a CLI release breaking the launch surface before
 * a user does.
 *
 * Output: a markdown table (provider · installed version · verified-against ·
 * spawn ok · keyboard ok) on stdout, appended to `$GITHUB_STEP_SUMMARY` when
 * set, and written to a file when `--out <path>` is given.
 *
 * Usage: `node scripts/provider-matrix.mjs [--out provider-matrix.md]`
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A CLI that cannot print its version in 10 s is not usable interactively. */
export const VERSION_TIMEOUT_MS = 10_000

/** How long a spawned CLI gets to take the keyboard before we give up. */
export const KEYBOARD_TIMEOUT_MS = 20_000

/**
 * DECSET 2004 enable — how a TUI announces it has taken the keyboard. The
 * canonical definition and the measured rationale live in
 * src/main/agents/interactiveReady.ts (BRACKETED_PASTE_ON).
 */
export const KEYBOARD_TAKEN = '\u001b[?2004h'

/**
 * True once the CLI has announced DECSET 2004 anywhere in its output. Unlike
 * `bracketedPasteActive` (which tracks the CURRENT state for seeding), this
 * asks the weaker dry-run question — "did the TUI ever take the keyboard?" —
 * so a CLI that announces and later hands the keyboard back still counts.
 */
export function sawKeyboardTaken(buffer) {
  return buffer.includes(KEYBOARD_TAKEN)
}

/**
 * The probe table, one row per shipped preset.
 *
 * `command`/`versionArgs`/`spawnArgs` are DUPLICATED from
 * src/main/providers/presets.ts, and `verifiedVersion` from
 * src/shared/presetVerification.ts. Duplication is the least-drift option
 * available to a plain .mjs: the presets are TypeScript behind path aliases,
 * so importing them here would need a build step this weekly job does not
 * have, and a generated JSON export would be a second artefact that can go
 * stale invisibly. Instead the colocated scripts/providerMatrix.test.ts
 * imports BOTH this table and the real presets under vitest's TS pipeline and
 * fails CI the moment any tuple here drifts — the duplication is enforced
 * equal on every push, which no comment could promise.
 */
export const MATRIX_PROVIDERS = [
  { id: 'claude', label: 'Claude Code', command: 'claude', versionArgs: ['--version'], spawnArgs: [], verifiedVersion: '2.1.238' },
  { id: 'codex', label: 'Codex', command: 'codex', versionArgs: ['--version'], spawnArgs: [], verifiedVersion: '0.144.6' },
  { id: 'kimi', label: 'Kimi Code', command: 'kimi', versionArgs: ['--version'], spawnArgs: [], verifiedVersion: '0.34.0' },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', versionArgs: ['--version'], spawnArgs: ['--trust'], verifiedVersion: '2026.08.11' },
  { id: 'grok', label: 'Grok Build', command: 'grok', versionArgs: ['--version'], spawnArgs: [], verifiedVersion: '0.0.34' },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    command: 'ollama',
    versionArgs: ['--version'],
    // `ollama run` needs a local model and is a line REPL that never announces
    // DECSET 2004 (the preset opts out via `seed.keyboardWaitMs: 0`), so a
    // keyboard dry-run can only ever time out — probe the version, skip the spawn.
    spawnArgs: null,
    verifiedVersion: '0.30.11'
  }
]

/**
 * Render the result rows as a markdown table. Pure and exported so the
 * colocated test can pin the format without spawning anything.
 */
export function formatMatrixTable(rows) {
  const lines = [
    '| Provider | Installed version | Verified against | Spawn ok | Keyboard ok |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const row of rows) {
    const cells = [row.label, row.installed, row.verified, row.spawnOk, row.keyboardOk].map(
      (cell) => String(cell).replaceAll('|', '\\|').replaceAll(/\s+/g, ' ').trim()
    )
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

/** First non-empty line, trimmed — same reading as providers/health.ts. */
export function firstLine(text) {
  return (
    String(text)
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  )
}

/** Run `command args`, resolve its first output line, reject on failure. */
function probeVersion(command, args) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectProbe(new Error(`no answer within ${VERSION_TIMEOUT_MS} ms`))
    }, VERSION_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectProbe(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const line = firstLine(output)
      if (code === 0 && line) resolveProbe(line)
      else rejectProbe(new Error(line || `exited with code ${code}`))
    })
  })
}

/**
 * Spawn the CLI interactively under a real PTY in a scratch directory and
 * watch its output for DECSET 2004 — then kill it. Nothing is typed and no
 * task runs; a CLI stuck on a login screen still usually takes the keyboard,
 * which is exactly the launch fact this dry-run is after.
 */
async function spawnDryRun(command, args) {
  // Lazy: the table/format exports must be importable without a native module.
  const pty = await import('@lydell/node-pty')
  const cwd = mkdtempSync(join(tmpdir(), 'vertragus-matrix-'))
  let child
  try {
    child = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: process.env
    })
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true })
    return { spawned: false, keyboard: false, error }
  }

  let buffer = ''
  let alive = true
  child.onData((chunk) => (buffer += chunk))
  child.onExit(() => (alive = false))

  const deadline = Date.now() + KEYBOARD_TIMEOUT_MS
  let keyboard = false
  while (Date.now() < deadline) {
    if (sawKeyboardTaken(buffer)) {
      keyboard = true
      break
    }
    if (!alive) break
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200))
  }

  if (alive) child.kill()
  rmSync(cwd, { recursive: true, force: true })
  // A CLI that exited before announcing still spawned; the columns say which
  // half failed.
  return { spawned: true, keyboard: keyboard || sawKeyboardTaken(buffer) }
}

async function probeProvider(provider) {
  const row = {
    label: provider.label,
    installed: '—',
    verified: provider.verifiedVersion,
    spawnOk: '—',
    keyboardOk: '—'
  }

  try {
    row.installed = firstLine(await probeVersion(provider.command, provider.versionArgs))
  } catch (error) {
    row.installed = `not installed (${error.code ?? firstLine(error.message ?? error)})`
    row.spawnOk = 'skipped'
    row.keyboardOk = 'skipped'
    return row
  }

  if (provider.spawnArgs === null) {
    row.spawnOk = 'n/a (line REPL, needs a local model)'
    row.keyboardOk = 'n/a (never announces DECSET 2004)'
    return row
  }

  const result = await spawnDryRun(provider.command, provider.spawnArgs)
  row.spawnOk = result.spawned ? 'yes' : `no (${firstLine(result.error?.message ?? 'spawn failed')})`
  row.keyboardOk = result.spawned
    ? result.keyboard
      ? 'yes'
      : `no (nothing within ${KEYBOARD_TIMEOUT_MS / 1000} s)`
    : 'skipped'
  return row
}

async function main() {
  const rows = []
  for (const provider of MATRIX_PROVIDERS) {
    console.error(`[provider-matrix] probing ${provider.id} …`)
    rows.push(await probeProvider(provider))
  }

  const table = [
    '## Provider matrix',
    '',
    'Proves: installed, spawns under a PTY, takes the keyboard (DECSET 2004).',
    'Does NOT prove: login, model discovery, or task execution — see docs/RELEASE-CHECKLIST.md.',
    '',
    formatMatrixTable(rows),
    ''
  ].join('\n')

  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, table)
  }
  const outFlag = process.argv.indexOf('--out')
  if (outFlag >= 0 && process.argv[outFlag + 1]) {
    writeFileSync(process.argv[outFlag + 1], table)
  }

  // The table is the deliverable; a machine without the CLIs is a valid
  // answer. Only "every single probe failed" suggests the script or the
  // runner is broken, and that is worth a red exit.
  return rows.every((row) => row.installed.startsWith('not installed')) ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main())
}
