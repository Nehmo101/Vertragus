/**
 * Headless task runner: spawns a provider CLI non-interactively, parses its
 * stream-json (claude/cursor) or JSONL + last-message file (codex), extracts
 * the final result, and emits pretty ANSI log lines for live pane display.
 *
 * Used by the orchestrator's dispatch_subagent tool — each dispatched task is
 * one headless run whose textual result flows back to the orchestrator.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderId } from '@shared/providers'
import { buildHeadlessLaunch, type HeadlessOpts } from '@main/providers/types'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { runOllamaChat } from '@main/agents/ollamaHeadless'

// ---- ANSI helpers (colors match the xterm theme) ----
const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m'
}
function line(color: string, text: string): string {
  return `${color}${text}${C.reset}\r\n`
}

export type HeadlessStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out'

export interface HeadlessResult {
  result: string
  isError: boolean
  /** Explicit terminal reason; optional for compatibility with provider adapters. */
  status?: HeadlessStatus
  error?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  steps?: number
}

export interface HeadlessRuntimeOptions {
  /** Includes command resolution. Defaults to 30 minutes. */
  timeoutMs?: number
  /** Maximum wait for a closing process after cancellation. */
  stopGraceMs?: number
}

export const DEFAULT_HEADLESS_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_STOP_GRACE_MS = 5_000

export interface HeadlessHandle {
  pid?: number
  done: Promise<HeadlessResult>
  kill(): void
}

/** Interprets one parsed JSON event from a provider stream. */
interface LineInterpretation {
  log?: string
  /** Final assistant text (result), if this event carries it. */
  result?: string
  /** The provider reported a failure (may exit 0 anyway, e.g. codex). */
  isError?: boolean
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  steps?: number
}

/** claude & cursor share the Anthropic-style stream-json envelope. */
function interpretClaudeStyle(obj: Record<string, unknown>): LineInterpretation {
  const type = obj['type']
  if (type === 'assistant' || type === 'user') {
    const message = obj['message'] as { content?: unknown } | undefined
    const content = message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue
        const b = block as { type?: string; text?: string; name?: string }
        if (b.type === 'text' && b.text) return { log: line(C.reset, b.text.trim()) }
        if (b.type === 'tool_use') return { log: line(C.cyan, `⚙ ${b.name ?? 'tool'}`) }
        if (b.type === 'tool_result') return { log: line(C.grey, '  ↳ tool result') }
      }
    }
    return {}
  }
  if (type === 'result') {
    const usage = obj['usage'] as { input_tokens?: number; output_tokens?: number } | undefined
    return {
      result: typeof obj['result'] === 'string' ? (obj['result'] as string) : '',
      isError: obj['is_error'] === true,
      costUsd: typeof obj['total_cost_usd'] === 'number' ? (obj['total_cost_usd'] as number) : undefined,
      tokensIn: usage?.input_tokens,
      tokensOut: usage?.output_tokens,
      steps: typeof obj['num_turns'] === 'number' ? (obj['num_turns'] as number) : undefined
    }
  }
  if (type === 'system') return {} // init noise
  return {}
}

/** Pull a human-readable message out of codex's sometimes-nested error payloads. */
function codexErrorText(raw: unknown): string {
  if (typeof raw !== 'string') return 'unbekannter Fehler'
  try {
    const inner = JSON.parse(raw) as { error?: { message?: string }; message?: string }
    return inner.error?.message ?? inner.message ?? raw
  } catch {
    return raw
  }
}

/** codex exec --json emits its own event shapes. */
function interpretCodex(obj: Record<string, unknown>): LineInterpretation {
  const type = String(obj['type'] ?? '')
  const item = obj['item'] as
    | { type?: string; text?: string; command?: string; message?: string }
    | undefined
  if (type === 'item.completed' || type === 'item.started') {
    if (item?.type === 'agent_message' && item.text) return { log: line(C.reset, item.text.trim()) }
    if (item?.type === 'command_execution' && item.command)
      return { log: line(C.cyan, `$ ${item.command}`) }
    if (item?.type === 'error' && item.message) return { log: line(C.red, `✗ ${item.message}`) }
    if (item?.type === 'reasoning') return { log: line(C.grey, '  · denkt nach …') }
    return {}
  }
  if (type === 'error') {
    const msg = codexErrorText(obj['message'])
    return { log: line(C.red, `✗ ${msg}`), isError: true, result: msg }
  }
  if (type === 'turn.failed') {
    const err = obj['error'] as { message?: string } | undefined
    const msg = codexErrorText(err?.message)
    return { log: line(C.red, `✗ ${msg}`), isError: true, result: msg }
  }
  if (type === 'turn.completed') {
    const usage = obj['usage'] as { input_tokens?: number; output_tokens?: number } | undefined
    return { tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens }
  }
  return {}
}

function interpreterFor(id: AgentProviderId): (o: Record<string, unknown>) => LineInterpretation {
  return id === 'codex' ? interpretCodex : interpretClaudeStyle
}

/**
 * Run a single headless task. `onLine` receives display-ready (ANSI + CRLF)
 * chunks for the live pane; the promise resolves with the extracted result.
 */
export function runHeadless(
  id: AgentProviderId,
  prompt: string,
  opts: HeadlessOpts,
  onLine: (chunk: string) => void,
  runtime: HeadlessRuntimeOptions = {}
): HeadlessHandle {
  const timeoutMs = Number.isFinite(runtime.timeoutMs) && (runtime.timeoutMs ?? 0) > 0 ? Math.floor(runtime.timeoutMs as number) : DEFAULT_HEADLESS_TIMEOUT_MS
  const stopGraceMs = Number.isFinite(runtime.stopGraceMs) && (runtime.stopGraceMs ?? 0) > 0 ? Math.floor(runtime.stopGraceMs as number) : DEFAULT_STOP_GRACE_MS

  if (id === 'ollama') {
    const handle = runOllamaChat(prompt, opts, onLine)
    let stopStatus: Extract<HeadlessStatus, 'cancelled' | 'timed_out'> | undefined
    const timer = setTimeout(() => { stopStatus = 'timed_out'; handle.kill() }, timeoutMs)
    timer.unref()
    return {
      get pid() { return handle.pid },
      done: handle.done.then((result) => {
        clearTimeout(timer)
        const status = stopStatus ?? (result.isError ? 'failed' : 'succeeded')
        return { ...result, status, isError: status !== 'succeeded', error: status === 'timed_out' ? `Timeout nach ${timeoutMs} ms` : result.error }
      }),
      kill() { if (!stopStatus) stopStatus = 'cancelled'; handle.kill() }
    }
  }

  let lastMsgFile: string | undefined
  let tmpDir: string | undefined
  const extraArgs = [...(opts.extraArgs ?? [])]
  if (id === 'claude') extraArgs.push('--verbose')
  if (id === 'codex') {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-codex-'))
    lastMsgFile = join(tmpDir, 'last.txt')
    extraArgs.push('--json', '-o', lastMsgFile)
  }

  const launch = buildHeadlessLaunch(id, prompt, { ...opts, extraArgs })
  const interpret = interpreterFor(id)
  const acc: HeadlessResult = { result: '', isError: false }
  let child: ChildProcess | undefined
  let stdoutBuf = ''
  let rawTail = ''
  let stderrTail = ''
  let lastText = ''
  let sawError = false
  let settled = false
  let stopStatus: Extract<HeadlessStatus, 'cancelled' | 'timed_out'> | undefined
  let stopFallback: NodeJS.Timeout | undefined
  let resolveDone!: (result: HeadlessResult) => void

  const cleanup = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (stopFallback) clearTimeout(stopFallback)
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined }
  }
  const finish = (status: HeadlessStatus, fallback = '', error?: string): void => {
    if (settled) return
    settled = true
    cleanup()
    resolveDone({ ...acc, result: acc.result || fallback, status, isError: status !== 'succeeded', error })
  }
  const stoppedText = (status: 'cancelled' | 'timed_out'): string => status === 'timed_out' ? `Task-Timeout nach ${timeoutMs} ms` : 'Task abgebrochen'
  const terminateChild = (): void => {
    if (!child) return
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child?.kill())
    } else child.kill('SIGTERM')
  }
  const requestStop = (status: 'cancelled' | 'timed_out'): void => {
    if (settled || stopStatus) return
    stopStatus = status
    if (!child) {
      onLine(line(C.yellow, status === 'timed_out' ? '— Timeout —' : '— gestoppt —'))
      finish(status, stoppedText(status), status === 'timed_out' ? stoppedText(status) : undefined)
      return
    }
    terminateChild()
    stopFallback = setTimeout(() => {
      onLine(line(C.yellow, status === 'timed_out' ? '— Timeout —' : '— gestoppt —'))
      finish(status, stoppedText(status), status === 'timed_out' ? stoppedText(status) : undefined)
    }, stopGraceMs)
    stopFallback.unref()
  }
  const handleLine = (raw: string): void => {
    const trimmed = raw.trim()
    if (!trimmed) return
    rawTail = (rawTail + trimmed + '\n').slice(-4000)
    let obj: Record<string, unknown>
    try { obj = JSON.parse(trimmed) as Record<string, unknown> } catch { onLine(line(C.grey, trimmed)); return }
    const result = interpret(obj)
    if (result.log) onLine(result.log)
    if (typeof result.result === 'string' && result.result) acc.result = result.result
    if (result.isError) sawError = true
    if (result.log && obj['type'] !== 'result') lastText = result.log
    if (result.costUsd != null) acc.costUsd = result.costUsd
    if (result.tokensIn != null) acc.tokensIn = result.tokensIn
    if (result.tokensOut != null) acc.tokensOut = result.tokensOut
    if (result.steps != null) acc.steps = result.steps
  }

  const done = new Promise<HeadlessResult>((resolve) => { resolveDone = resolve })
  const timeoutTimer = setTimeout(() => requestStop('timed_out'), timeoutMs)
  timeoutTimer.unref()

  void resolveLaunch(launch.command, launch.args)
    .then((resolved) => {
      if (settled || stopStatus) return
      try {
        child = spawn(resolved.file, resolved.args, { cwd: opts.workingDir, env: { ...process.env } as Record<string, string>, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        onLine(line(C.red, `Spawn fehlgeschlagen: ${message}`)); finish('failed', message, message); return
      }
      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString(); const parts = stdoutBuf.split(/\r?\n/); stdoutBuf = parts.pop() ?? ''; for (const part of parts) handleLine(part)
      })
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim(); if (!text) return; stderrTail = (stderrTail + text + '\n').slice(-4000); onLine(line(C.red, text))
      })
      child.on('error', (err) => {
        const message = err.message
        if (stopStatus) { finish(stopStatus, stoppedText(stopStatus), stopStatus === 'timed_out' ? stoppedText(stopStatus) : undefined); return }
        onLine(line(C.red, `Spawn fehlgeschlagen: ${message}`)); finish('failed', message, message)
      })
      child.on('close', (code) => {
        if (settled) return
        if (stdoutBuf.trim()) handleLine(stdoutBuf)
        if (lastMsgFile) {
          try { const fileResult = readFileSync(lastMsgFile, 'utf8').trim(); if (fileResult) acc.result = fileResult } catch { /* stream fallback */ }
        }
        if (!acc.result) acc.result = (lastText || rawTail || stderrTail).trim()
        if (stopStatus) {
          onLine(line(C.yellow, stopStatus === 'timed_out' ? '— Timeout —' : '— gestoppt —'))
          finish(stopStatus, stoppedText(stopStatus), stopStatus === 'timed_out' ? stoppedText(stopStatus) : undefined); return
        }
        const failed = sawError || code !== 0
        if (failed) {
          const detail = code == null ? 'Prozess ohne Exit-Code beendet' : `Prozess beendet (exit ${code})`
          onLine(line(C.red, `✗ fehlgeschlagen${code != null ? ` (exit ${code})` : ''}`)); finish('failed', detail, detail)
        } else { onLine(line(C.green, '✓ fertig')); finish('succeeded') }
      })
    })
    .catch((err: unknown) => {
      if (settled || stopStatus) return
      const message = err instanceof Error ? err.message : String(err)
      onLine(line(C.red, `Command-Auflösung fehlgeschlagen: ${message}`)); finish('failed', message, message)
    })

  return { get pid() { return child?.pid }, done, kill() { requestStop('cancelled') } }
}
