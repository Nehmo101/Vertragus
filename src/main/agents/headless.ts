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

export type HeadlessStatus = 'succeeded' | 'failed' | 'cancelled'

export type HeadlessLifecyclePhase =
  | 'starting'
  | 'resolving-command'
  | 'starting-process'
  | 'running'
  | 'stopping'
  | 'finished'

interface HeadlessLifecycleEventBase {
  timestamp: number
  elapsedMs: number
  phase: HeadlessLifecyclePhase
}

export type HeadlessLifecycleEvent =
  | (HeadlessLifecycleEventBase & { type: 'started'; provider: AgentProviderId })
  | (HeadlessLifecycleEventBase & {
      type: 'phase'
      previousPhase: HeadlessLifecyclePhase
    })
  | (HeadlessLifecycleEventBase & { type: 'heartbeat'; idleMs: number; pid?: number })
  | (HeadlessLifecycleEventBase & {
      type: 'output'
      chunk: string
      source: 'stdout' | 'stderr' | 'system'
    })
  | (HeadlessLifecycleEventBase & {
      type: 'progress'
      providerEvent: string
      pid?: number
    })
  | (HeadlessLifecycleEventBase & { type: 'usage' } & HeadlessUsageSnapshot)
  | (HeadlessLifecycleEventBase & {
      type: 'finished'
      status: HeadlessStatus
      result: HeadlessResult
    })

export interface HeadlessLifecycleOptions {
  /** Receives structured lifecycle events. Exceptions are isolated from the worker run. */
  onEvent(event: HeadlessLifecycleEvent): void
  /** Heartbeats are deliberately constrained to the product's 30-60 second window. */
  heartbeatIntervalMs?: number
}

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

/** Accumulated provider telemetry, streamed as it accrues during a run. */
export interface HeadlessUsageSnapshot {
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  steps?: number
}

const DEFAULT_STOP_GRACE_MS = 5_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 45_000
const MIN_HEARTBEAT_INTERVAL_MS = 30_000
const MAX_HEARTBEAT_INTERVAL_MS = 60_000

export interface HeadlessHandle {
  pid?: number
  done: Promise<HeadlessResult>
  kill(): void
}

interface LifecycleReporter {
  phase(next: HeadlessLifecyclePhase): void
  output(chunk: string, source: 'stdout' | 'stderr' | 'system'): void
  progress(providerEvent: string): void
  usage(snapshot: HeadlessUsageSnapshot): void
  finish(status: HeadlessStatus, result: HeadlessResult): void
}

function createLifecycleReporter(
  provider: AgentProviderId,
  options: HeadlessLifecycleOptions | undefined,
  getPid: () => number | undefined
): LifecycleReporter {
  if (!options) {
    return {
      phase() {},
      output() {},
      progress() {},
      usage() {},
      finish() {}
    }
  }

  const startedAt = Date.now()
  let lastActivityAt = startedAt
  let currentPhase: HeadlessLifecyclePhase = 'starting'
  let finished = false
  const emit = (event: HeadlessLifecycleEvent): void => {
    try {
      options.onEvent(event)
    } catch {
      // Observability must never be able to fail the task it observes.
    }
  }
  const base = (): HeadlessLifecycleEventBase => {
    const now = Date.now()
    return { timestamp: now, elapsedMs: Math.max(0, now - startedAt), phase: currentPhase }
  }
  const activity = (): void => {
    lastActivityAt = Date.now()
  }

  emit({ ...base(), type: 'started', provider })
  const configuredInterval = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const requestedInterval = Number.isFinite(configuredInterval)
    ? configuredInterval
    : DEFAULT_HEARTBEAT_INTERVAL_MS
  const heartbeatIntervalMs = Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.max(MIN_HEARTBEAT_INTERVAL_MS, requestedInterval)
  )
  const heartbeat = setInterval(() => {
    if (finished) return
    const now = Date.now()
    emit({
      timestamp: now,
      elapsedMs: Math.max(0, now - startedAt),
      phase: currentPhase,
      type: 'heartbeat',
      idleMs: Math.max(0, now - lastActivityAt),
      pid: getPid()
    })
  }, heartbeatIntervalMs)
  heartbeat.unref()

  return {
    phase(next) {
      if (finished || next === currentPhase) return
      const previousPhase = currentPhase
      currentPhase = next
      activity()
      emit({ ...base(), type: 'phase', previousPhase })
    },
    output(chunk, source) {
      if (finished) return
      activity()
      emit({ ...base(), type: 'output', chunk, source })
    },
    progress(providerEvent) {
      if (finished) return
      activity()
      emit({ ...base(), type: 'progress', providerEvent, pid: getPid() })
    },
    usage(snapshot) {
      if (finished) return
      activity()
      emit({ ...base(), type: 'usage', ...snapshot })
    },
    finish(status, result) {
      if (finished) return
      finished = true
      clearInterval(heartbeat)
      const previousPhase = currentPhase
      currentPhase = 'finished'
      activity()
      emit({ ...base(), type: 'phase', previousPhase })
      emit({ ...base(), type: 'finished', status, result })
    }
  }
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
  lifecycleOptions?: HeadlessLifecycleOptions
): HeadlessHandle {
  let currentPid: number | undefined
  const lifecycle = createLifecycleReporter(id, lifecycleOptions, () => currentPid)
  const emitLine = (
    chunk: string,
    source: 'stdout' | 'stderr' | 'system' = 'system'
  ): void => {
    onLine(chunk)
    lifecycle.output(chunk, source)
  }

  if (id === 'ollama') {
    lifecycle.phase('starting-process')
    let handle: HeadlessHandle
    try {
      handle = runOllamaChat(prompt, opts, (chunk) => emitLine(chunk, 'stdout'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const result: HeadlessResult = {
        result: message,
        isError: true,
        status: 'failed',
        error: message
      }
      lifecycle.finish('failed', result)
      throw err
    }
    currentPid = handle.pid
    lifecycle.phase('running')
    let cancelled = false
    return {
      get pid() { return handle.pid },
      done: handle.done.then(
        (result) => {
          const status: HeadlessStatus = cancelled
            ? 'cancelled'
            : result.isError
              ? 'failed'
              : 'succeeded'
          const finalResult: HeadlessResult = {
            ...result,
            status,
            isError: status !== 'succeeded'
          }
          lifecycle.finish(status, finalResult)
          return finalResult
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          const finalResult: HeadlessResult = {
            result: message,
            isError: true,
            status: 'failed',
            error: message
          }
          lifecycle.finish('failed', finalResult)
          throw err
        }
      ),
      kill() {
        if (cancelled) return
        cancelled = true
        lifecycle.phase('stopping')
        handle.kill()
      }
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
  let stopStatus: Extract<HeadlessStatus, 'cancelled'> | undefined
  let stopFallback: NodeJS.Timeout | undefined
  let resolveDone!: (result: HeadlessResult) => void

  lifecycle.phase('resolving-command')

  const cleanup = (): void => {
    if (stopFallback) clearTimeout(stopFallback)
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined }
  }
  const finish = (status: HeadlessStatus, fallback = '', error?: string): void => {
    if (settled) return
    settled = true
    cleanup()
    const result: HeadlessResult = {
      ...acc,
      result: acc.result || fallback,
      status,
      isError: status !== 'succeeded',
      error
    }
    lifecycle.finish(status, result)
    resolveDone(result)
  }
  const stoppedText = (): string => 'Task abgebrochen'
  const terminateChild = (): void => {
    if (!child) return
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child?.kill())
    } else child.kill('SIGTERM')
  }
  const requestStop = (): void => {
    if (settled || stopStatus) return
    stopStatus = 'cancelled'
    lifecycle.phase('stopping')
    if (!child) {
      emitLine(line(C.yellow, 'Task gestoppt'))
      finish(stopStatus, stoppedText())
      return
    }
    terminateChild()
    stopFallback = setTimeout(() => {
      emitLine(line(C.yellow, 'Task gestoppt'))
      finish(stopStatus!, stoppedText())
    }, DEFAULT_STOP_GRACE_MS)
    stopFallback.unref()
  }
  const handleLine = (raw: string): void => {
    const trimmed = raw.trim()
    if (!trimmed) return
    rawTail = (rawTail + trimmed + '\n').slice(-4000)
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      emitLine(line(C.grey, trimmed), 'stdout')
      return
    }
    lifecycle.progress(String(obj['type'] ?? 'provider-event'))
    const result = interpret(obj)
    if (result.log) emitLine(result.log, 'stdout')
    if (typeof result.result === 'string' && result.result) acc.result = result.result
    if (result.isError) sawError = true
    if (result.log && obj['type'] !== 'result') lastText = result.log
    let usageChanged = false
    if (result.costUsd != null) { acc.costUsd = result.costUsd; usageChanged = true }
    if (result.tokensIn != null) { acc.tokensIn = result.tokensIn; usageChanged = true }
    if (result.tokensOut != null) { acc.tokensOut = result.tokensOut; usageChanged = true }
    if (result.steps != null) { acc.steps = result.steps; usageChanged = true }
    // Stream telemetry as it accrues so the live pane fills in before the run
    // ends, instead of only surfacing usage in the terminal result.
    if (usageChanged) {
      lifecycle.usage({
        costUsd: acc.costUsd,
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        steps: acc.steps
      })
    }
  }

  const done = new Promise<HeadlessResult>((resolve) => { resolveDone = resolve })

  void resolveLaunch(launch.command, launch.args)
    .then((resolved) => {
      if (settled || stopStatus) return
      lifecycle.phase('starting-process')
      try {
        child = spawn(resolved.file, resolved.args, { cwd: opts.workingDir, env: { ...process.env } as Record<string, string>, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        currentPid = child.pid
        lifecycle.phase('running')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emitLine(line(C.red, `Spawn fehlgeschlagen: ${message}`)); finish('failed', message, message); return
      }
      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString(); const parts = stdoutBuf.split(/\r?\n/); stdoutBuf = parts.pop() ?? ''; for (const part of parts) handleLine(part)
      })
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim(); if (!text) return; stderrTail = (stderrTail + text + '\n').slice(-4000); emitLine(line(C.red, text), 'stderr')
      })
      child.on('error', (err) => {
        const message = err.message
        if (stopStatus) { finish(stopStatus, stoppedText()); return }
        emitLine(line(C.red, `Spawn fehlgeschlagen: ${message}`)); finish('failed', message, message)
      })
      child.on('close', (code) => {
        if (settled) return
        if (stdoutBuf.trim()) handleLine(stdoutBuf)
        if (lastMsgFile) {
          try { const fileResult = readFileSync(lastMsgFile, 'utf8').trim(); if (fileResult) acc.result = fileResult } catch { /* stream fallback */ }
        }
        if (!acc.result) acc.result = (lastText || rawTail || stderrTail).trim()
        if (stopStatus) {
          emitLine(line(C.yellow, 'Task gestoppt'))
          finish(stopStatus, stoppedText()); return
        }
        const failed = sawError || code !== 0
        if (failed) {
          const detail = code == null ? 'Prozess ohne Exit-Code beendet' : `Prozess beendet (exit ${code})`
          emitLine(line(C.red, `✗ fehlgeschlagen${code != null ? ` (exit ${code})` : ''}`)); finish('failed', detail, detail)
        } else { emitLine(line(C.green, '✓ fertig')); finish('succeeded') }
      })
    })
    .catch((err: unknown) => {
      if (settled || stopStatus) return
      const message = err instanceof Error ? err.message : String(err)
      emitLine(line(C.red, `Command-Auflösung fehlgeschlagen: ${message}`)); finish('failed', message, message)
    })

  return { get pid() { return child?.pid }, done, kill() { requestStop() } }
}
