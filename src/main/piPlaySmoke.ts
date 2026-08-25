/**
 * Play-shaped Pi wrap smoke: wait for a live TUI and Vertragus MCP on the
 * orchestrator PTY, then exit. Inert without {@link PI_PLAY_SMOKE_ENV}.
 *
 * Judges **raw** PTY bytes. `read_output` strips CSI, and DECSET 2004
 * (`?2004h`) is the signal that ConPTY actually attached — the Windows
 * blank-window bug is empty output and a child that exits 0.
 *
 * `No API key found` is Pi's own store, not this smoke. Isolated HOME is
 * empty on purpose so developer `~/.pi` is never read.
 */
import { writeFile } from 'node:fs/promises'
import { app } from 'electron'

/** Path of the log the driver script reads after Electron exits. */
export const PI_PLAY_SMOKE_ENV = 'VERTRAGUS_PI_PLAY_SMOKE'

/** How long the orchestrator PTY may take to show TUI + MCP. */
export const PI_PLAY_SMOKE_TIMEOUT_MS = 60_000

/** Pause between snapshot polls. */
export const PI_PLAY_SMOKE_POLL_MS = 250

export type PiPlaySmokeStatus = 'pass' | 'fail' | 'wait'

export interface PiPlaySmokeJudgement {
  status: PiPlaySmokeStatus
  reason: string
}

const MCP_CONNECTED = /servers connected \(\d+ tools\)/
const MCP_FAILED = /Failed to connect to vertragus/i
const TUI_BRACKETED_PASTE = '?2004h'

/**
 * Classify one PTY snapshot. `wait` means keep polling.
 */
export function judgePiPlayScrollback(text: string): PiPlaySmokeJudgement {
  if (MCP_FAILED.test(text)) {
    return { status: 'fail', reason: 'Pi MCP adapter failed to connect to vertragus' }
  }
  const tui = text.includes(TUI_BRACKETED_PASTE)
  const mcp = MCP_CONNECTED.test(text)
  if (tui && mcp) {
    return { status: 'pass', reason: 'Pi TUI started and Vertragus MCP attached' }
  }
  if (tui && !mcp) {
    return { status: 'wait', reason: 'TUI up; waiting for MCP attach' }
  }
  if (!text.trim()) {
    return { status: 'wait', reason: 'PTY still empty' }
  }
  return { status: 'wait', reason: 'waiting for TUI (DECSET 2004) and MCP attach' }
}

export interface PiPlaySmokeLoop {
  /** Absolute path written before `app.exit`. */
  logPath: string
  /** Raw orchestrator PTY bytes. */
  snapshot: () => string
  /** False once the child is gone — empty output then is the blank-window bug. */
  alive?: () => boolean
  /** Workspace/dev-run never produced an orchestrator. */
  failedToStart?: boolean
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  wait?: (ms: number) => Promise<void>
  writeLog?: (path: string, body: string) => Promise<void>
  exit?: (code: number) => void
  log?: (message: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function formatLog(judgement: PiPlaySmokeJudgement, snapshot: string): string {
  return [
    `status=${judgement.status}`,
    `reason=${judgement.reason}`,
    '--- snapshot ---',
    snapshot || '(empty)',
    ''
  ].join('\n')
}

/**
 * Poll until pass/fail or timeout, write the log, exit. Testable without a
 * process: inject snapshot/wait/exit.
 */
export async function runPiPlaySmoke(input: PiPlaySmokeLoop): Promise<void> {
  const timeoutMs = input.timeoutMs ?? PI_PLAY_SMOKE_TIMEOUT_MS
  const pollMs = input.pollMs ?? PI_PLAY_SMOKE_POLL_MS
  const now = input.now ?? Date.now
  const wait = input.wait ?? sleep
  const writeLog = input.writeLog ?? writeFile
  const exit = input.exit ?? ((code: number) => app.exit(code))
  const log = input.log ?? ((message: string) => console.error(message))
  const deadline = now() + timeoutMs

  const finish = async (judgement: PiPlaySmokeJudgement, snapshot: string): Promise<void> => {
    const body = formatLog(judgement, snapshot)
    log(`[pi-play-smoke] ${judgement.status}: ${judgement.reason}`)
    try {
      await writeLog(input.logPath, body)
    } catch (error) {
      log(`[pi-play-smoke] could not write log: ${String(error)}`)
    }
    exit(judgement.status === 'pass' ? 0 : 1)
  }

  if (input.failedToStart) {
    await finish(
      { status: 'fail', reason: 'dev-run did not start an orchestrator' },
      ''
    )
    return
  }

  for (;;) {
    const snapshot = input.snapshot()
    const judgement = judgePiPlayScrollback(snapshot)
    if (judgement.status !== 'wait') {
      await finish(judgement, snapshot)
      return
    }
    if (input.alive && !input.alive() && !snapshot.includes(TUI_BRACKETED_PASTE)) {
      await finish(
        {
          status: 'fail',
          reason: 'orchestrator PTY died with no TUI — blank window / ConPTY attach failure'
        },
        snapshot
      )
      return
    }
    if (now() >= deadline) {
      await finish(
        { status: 'fail', reason: `timed out after ${timeoutMs} ms (${judgement.reason})` },
        snapshot
      )
      return
    }
    await wait(pollMs)
  }
}

/**
 * Fire-and-forget the loop. A no-op when {@link PI_PLAY_SMOKE_ENV} is unset.
 */
export function armPiPlaySmoke(
  input: Omit<PiPlaySmokeLoop, 'logPath'> & { logPath?: string },
  env: NodeJS.ProcessEnv = process.env
): void {
  const logPath = input.logPath ?? env[PI_PLAY_SMOKE_ENV]?.trim()
  if (!logPath) return
  void runPiPlaySmoke({ ...input, logPath })
}
