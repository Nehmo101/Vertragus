/**
 * One agent = one real PTY process.
 *
 * PtyAgent is the whole lifecycle of a provider CLI: spawn, stream, type into,
 * resize, and kill with the ported escalation chain. It owns a scrollback ring
 * buffer so a CLI window can attach late (or re-attach after being closed)
 * without losing a byte, and so M2's `read_output` has something to read.
 *
 * Deliberately free of Electron and IPC: everything above it (windows, IPC,
 * MCP) plugs in through `onData` / `onExit`.
 */
import * as pty from '@lydell/node-pty'
import {
  PROCESS_TERMINATION_GRACE_MS,
  shouldCreateProcessGroup,
  terminateProcessTreeWithEscalation
} from './processTermination'
import { SCROLLBACK_LIMIT, ScrollbackBuffer } from './scrollback'

export const DEFAULT_COLS = 100
export const DEFAULT_ROWS = 30

export interface PtySpawnOptions {
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  cols?: number
  rows?: number
}

export interface PtyExitInfo {
  exitCode: number
  signal?: number
}

export type PtyDataListener = (data: string) => void
export type PtyExitListener = (info: PtyExitInfo) => void
/** Every listener registration returns its own unsubscribe. */
export type Unsubscribe = () => void

/**
 * The narrow surface everything above PtyAgent depends on. Keeping it explicit
 * lets the IPC layer be tested against a fake without a real process.
 */
export interface PtyAgentLike {
  readonly pid: number | undefined
  readonly isAlive: boolean
  readonly cols: number
  readonly rows: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(listener: PtyDataListener): Unsubscribe
  onExit(listener: PtyExitListener): Unsubscribe
  snapshot(): string
  kill(): void
}

export interface PtyAgentOptions {
  /** Injectable for tests; defaults to node-pty. */
  spawn?: typeof pty.spawn
  scrollbackLimit?: number
  platform?: NodeJS.Platform
  /** SIGTERM → SIGKILL grace on POSIX. */
  killGraceMs?: number
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export class PtyAgent implements PtyAgentLike {
  private proc: pty.IPty | undefined
  private readonly buffer: ScrollbackBuffer
  private readonly dataListeners = new Set<PtyDataListener>()
  private readonly exitListeners = new Set<PtyExitListener>()
  private readonly spawnFn: typeof pty.spawn
  private readonly platform: NodeJS.Platform
  private readonly killGraceMs: number
  private exitInfo: PtyExitInfo | undefined
  private killed = false
  private currentCols = DEFAULT_COLS
  private currentRows = DEFAULT_ROWS

  constructor(options: PtyAgentOptions = {}) {
    this.spawnFn = options.spawn ?? pty.spawn
    this.buffer = new ScrollbackBuffer(options.scrollbackLimit ?? SCROLLBACK_LIMIT)
    this.platform = options.platform ?? process.platform
    this.killGraceMs = options.killGraceMs ?? PROCESS_TERMINATION_GRACE_MS
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get isAlive(): boolean {
    return this.proc !== undefined && this.exitInfo === undefined
  }

  get cols(): number {
    return this.currentCols
  }

  get rows(): number {
    return this.currentRows
  }

  get exit(): PtyExitInfo | undefined {
    return this.exitInfo
  }

  spawn(options: PtySpawnOptions): void {
    if (this.proc) throw new Error('PtyAgent is already spawned')
    this.currentCols = options.cols && options.cols > 0 ? options.cols : DEFAULT_COLS
    this.currentRows = options.rows && options.rows > 0 ? options.rows : DEFAULT_ROWS

    const proc = this.spawnFn(options.file, options.args ?? [], {
      name: 'xterm-256color',
      cols: this.currentCols,
      rows: this.currentRows,
      cwd: options.cwd,
      env: cleanEnv({ ...process.env, ...options.env })
    })
    this.proc = proc

    proc.onData((data) => {
      this.buffer.append(data)
      for (const listener of [...this.dataListeners]) listener(data)
    })
    proc.onExit(({ exitCode, signal }) => {
      if (this.exitInfo) return
      this.exitInfo = { exitCode, signal }
      for (const listener of [...this.exitListeners]) listener(this.exitInfo)
    })
  }

  /** Feed the buffer without a process — spawn failures, banners, tests. */
  push(data: string): void {
    this.buffer.append(data)
    for (const listener of [...this.dataListeners]) listener(data)
  }

  write(data: string): void {
    if (!data || !this.isAlive) return
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (cols <= 0 || rows <= 0) return
    this.currentCols = Math.floor(cols)
    this.currentRows = Math.floor(rows)
    if (!this.isAlive) return
    try {
      this.proc?.resize(this.currentCols, this.currentRows)
    } catch {
      // The process can die between the alive check and the ioctl.
    }
  }

  onData(listener: PtyDataListener): Unsubscribe {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: PtyExitListener): Unsubscribe {
    // A listener registered after the exit still learns about it — the window
    // can be slower to attach than a fast-failing CLI is to die.
    if (this.exitInfo) {
      const info = this.exitInfo
      queueMicrotask(() => listener(info))
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  snapshot(): string {
    return this.buffer.snapshot()
  }

  tail(chars: number): string {
    return this.buffer.tail(chars)
  }

  /**
   * Kill the provider and everything it spawned. Windows uses `taskkill /T /F`;
   * POSIX gets SIGTERM on the process group and escalates to SIGKILL after the
   * grace period, but only while this very PID is still ours.
   */
  kill(): void {
    const proc = this.proc
    if (!proc || this.killed || this.exitInfo) return
    this.killed = true
    const expectedPid = proc.pid
    let cancelEscalation: () => void = () => undefined
    let stopWatching: Unsubscribe = () => undefined
    stopWatching = this.onExit(() => {
      cancelEscalation()
      stopWatching()
    })
    cancelEscalation = terminateProcessTreeWithEscalation(
      expectedPid,
      (signal) => {
        try {
          proc.kill(signal)
        } catch {
          // Already gone.
        }
      },
      (pid) => this.exitInfo === undefined && this.proc?.pid === pid,
      this.platform,
      // POSIX forkpty children lead their own process group; Windows does not.
      shouldCreateProcessGroup(this.platform),
      this.killGraceMs
    )
    if (this.exitInfo) {
      cancelEscalation()
      stopWatching()
    }
  }

  /** Drop every listener (window closed, app shutting down). */
  dispose(): void {
    this.dataListeners.clear()
    this.exitListeners.clear()
  }
}
