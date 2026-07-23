/**
 * Headless task runner: spawns a provider CLI non-interactively, parses its
 * stream-json (claude/kimi/cursor) or JSONL + last-message file (codex), extracts
 * the final result, and emits pretty ANSI log lines for live pane display.
 *
 * Used by the orchestrator's dispatch_subagent tool — each dispatched task is
 * one headless run whose textual result flows back to the orchestrator.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerHeadlessDef, type AgentProviderId } from '@shared/providers'
import { buildHeadlessLaunch, type HeadlessOpts } from '@main/providers/types'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { runOllamaChat } from '@main/agents/ollamaHeadless'
import {
  PROCESS_TERMINATION_GRACE_MS,
  shouldCreateProcessGroup,
  terminateProcessTreeWithEscalation
} from '@main/agents/processTermination'
import {
  CODEX_RUNTIME_DIR_NAME,
  codexSingleRootEnvironment,
  codexSingleRootSandboxArgs
} from '@main/agents/codexSandbox'

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
export type HeadlessFailureKind = 'provider-auth' | 'sandbox' | 'stalled' | 'provider'


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
  /** Abort a spawned worker only after this long without meaningful provider progress; 0 disables it. */
  stallTimeoutMs?: number
}

export interface HeadlessResult {
  result: string
  isError: boolean
  /** Actual provider-process exit code when one was observed. */
  exitCode?: number
  /** Explicit terminal reason; optional for compatibility with provider adapters. */
  status?: HeadlessStatus
  error?: string
  costUsd?: number
  /** Machine-readable cause used by the orchestrator's recovery policy. */
  failureKind?: HeadlessFailureKind
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

const DEFAULT_HEARTBEAT_INTERVAL_MS = 45_000
const DEFAULT_STALL_TIMEOUT_MS = 15 * 60_000
const STALL_CHECK_INTERVAL_MS = 30_000
const MIN_HEARTBEAT_INTERVAL_MS = 30_000
const MAX_HEARTBEAT_INTERVAL_MS = 60_000

/**
 * The worker contract line, tolerant of Markdown decoration the models like to
 * add ("**ERGEBNIS: ERFOLG**", "> ERGEBNIS : BLOCKER", "## ERGEBNIS: ERFOLG").
 * The verdict must still start its own line so prose mentions never match.
 */
function resultMarker(verdict: 'ERFOLG' | 'BLOCKER'): RegExp {
  const space = '[^\\S\\n]*'
  const decoration = '(?:[*_`#>-]+' + space + ')*'
  return new RegExp(
    '(?:^|\\n)' + space + decoration + 'ERGEBNIS' + space + ':' + space + decoration + verdict + '\\b',
    'i'
  )
}

const WORKER_SUCCESS_MARKER = resultMarker('ERFOLG')
const WORKER_BLOCKER_MARKER = resultMarker('BLOCKER')

export function hasExplicitWorkerSuccess(text: string): boolean {
  return WORKER_SUCCESS_MARKER.test(text)
}

export function hasExplicitWorkerBlocker(text: string): boolean {
  return WORKER_BLOCKER_MARKER.test(text)
}

export interface FatalProviderFailure {
  kind: Extract<HeadlessFailureKind, 'provider-auth' | 'sandbox'>
  message: string
}

const FATAL_AUTH_PATTERN =
  /token_revoked|invalidated oauth token|oauth token[^\n]*(?:revoked|invalid|expired)|authentication token[^\n]*(?:revoked|invalid|expired)/i
const FATAL_SANDBOX_PATTERN =
  /failed to prepare[^\n]*sandbox|cannot enforce split writable root sets|createrestrictedtoken failed|windows sandbox wrapper[^\n]*(?:failed|refus)/i

/** Convert terminal stderr conditions into immediate, actionable failures. */
export function classifyFatalProviderStderr(
  provider: AgentProviderId,
  text: string
): FatalProviderFailure | undefined {
  const detail = text.trim().slice(-1_200)
  if (!detail) return undefined
  if (FATAL_AUTH_PATTERN.test(detail)) {
    return {
      kind: 'provider-auth',
      message: `${provider}: Anmeldung ist abgelaufen oder widerrufen. Provider-Login erneuern. Details: ${detail}`
    }
  }
  if (provider === 'codex' && FATAL_SANDBOX_PATTERN.test(detail)) {
    return {
      kind: 'sandbox',
      message: `Codex-Sandbox konnte nicht initialisiert werden. Worker nicht unsandboxed fortgesetzt. Details: ${detail}`
    }
  }
  return undefined
}

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
      if (source !== 'stderr') activity()
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

/** claude, kimi & cursor share the Anthropic-style stream-json envelope. */
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
function interpretCodex(
  obj: Record<string, unknown>,
  activeCommands: Map<string, number>
): LineInterpretation {
  const type = String(obj['type'] ?? '')
  const item = obj['item'] as
    | { id?: string; type?: string; text?: string; command?: string; message?: string; status?: string; exit_code?: number }
    | undefined
  if (type === 'item.started') {
    if (item?.type === 'command_execution' && item.command) {
      const key = item.id ?? item.command
      activeCommands.set(key, (activeCommands.get(key) ?? 0) + 1)
      return { log: line(C.cyan, `$ ${item.command}`) }
    }
    if (item?.type === 'reasoning') return { log: line(C.grey, '  - denkt nach ...') }
    return {}
  }
  if (type === 'item.completed') {
    if (item?.type === 'agent_message' && item.text) {
      return { log: line(C.reset, item.text.trim()), result: item.text.trim() }
    }
    if (item?.type === 'command_execution' && item.command) {
      const key = item.id ?? item.command
      const activeCount = activeCommands.get(key) ?? 0
      if (activeCount > 0) {
        if (activeCount === 1) activeCommands.delete(key)
        else activeCommands.set(key, activeCount - 1)
        const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)
        return failed ? { log: line(C.red, `  command exit ${item.exit_code ?? 'failed'}`) } : {}
      }
      return { log: line(C.cyan, `$ ${item.command}`) }
    }
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
  // Every non-codex agent uses the Anthropic-style envelope (see ProviderDef.
  // headless.streamFormat); codex has its own event shapes.
  if (providerHeadlessDef(id)?.streamFormat !== 'codex') return interpretClaudeStyle
  const activeCommands = new Map<string, number>()
  return (event) => interpretCodex(event, activeCommands)
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
  let runtimeRoot: string | undefined
  const extraArgs = [...(opts.extraArgs ?? [])]
  // Claude Code and the Kimi CLI that mirrors it emit the full stream-json
  // envelope only under --verbose (see ProviderDef.headless.verbose).
  if (providerHeadlessDef(id)?.verbose) extraArgs.push('--verbose')
  if (id === 'codex') {
    if (!extraArgs.includes('--skip-git-repo-check')) {
      extraArgs.push('--skip-git-repo-check')
    }
    const useSingleRootSandbox = process.platform === 'win32' && !opts.yolo
    if (useSingleRootSandbox) {
      runtimeRoot = join(opts.workingDir, CODEX_RUNTIME_DIR_NAME)
      mkdirSync(runtimeRoot, { recursive: true })
      extraArgs.push(...codexSingleRootSandboxArgs())
    }
    tmpDir = mkdtempSync(join(runtimeRoot ?? tmpdir(), 'vertragus-codex-'))
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
  let finalProviderResultIsError: boolean | undefined
  let settled = false
  let stopStatus: Extract<HeadlessStatus, 'cancelled'> | undefined
  let stopFallback: NodeJS.Timeout | undefined
  let cancelTerminationEscalation: (() => void) | undefined
  let childExited = false
  let stallWatchdog: NodeJS.Timeout | undefined
  let lastMeaningfulProgressAt = Date.now()
  let fatalFailure:
    | { kind: Exclude<HeadlessFailureKind, 'provider'>; message: string }
    | undefined
  const configuredStallTimeout = lifecycleOptions?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  const stallTimeoutMs =
    Number.isFinite(configuredStallTimeout) && configuredStallTimeout > 0 ? configuredStallTimeout : 0
  let resolveDone!: (result: HeadlessResult) => void

  lifecycle.phase('resolving-command')

  const cleanup = (): void => {
    if (stopFallback) clearTimeout(stopFallback)
    cancelTerminationEscalation?.()
    if (stallWatchdog) clearInterval(stallWatchdog)
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined }
    if (runtimeRoot) {
      try { rmdirSync(runtimeRoot) } catch { /* another run or stale diagnostics still use it */ }
      runtimeRoot = undefined
    }
  }
  const finish = (
    status: HeadlessStatus,
    fallback = '',
    error?: string,
    failureKind?: HeadlessFailureKind
  ): void => {
    if (settled) return
    settled = true
    cleanup()
    const result: HeadlessResult = {
      ...acc,
      result: acc.result || fallback,
      status,
      isError: status !== 'succeeded',
      error,
      failureKind: status === 'failed' ? failureKind ?? 'provider' : undefined
    }
    lifecycle.finish(status, result)
    resolveDone(result)
  }
  const stoppedText = (): string => 'Task abgebrochen'
  const terminateChild = (): void => {
    const target = child
    if (!target) return
    cancelTerminationEscalation?.()
    const ownsProcessGroup = shouldCreateProcessGroup()
    cancelTerminationEscalation = terminateProcessTreeWithEscalation(
      target.pid,
      (signal) => target.kill(signal),
      (expectedPid) => child === target && !childExited && target.pid === expectedPid,
      process.platform,
      ownsProcessGroup
    )
  }
  const requestFailure = (failure: {
    kind: Exclude<HeadlessFailureKind, 'provider'>
    message: string
  }): void => {
    if (settled || stopStatus || fatalFailure) return
    fatalFailure = failure
    sawError = true
    acc.result = failure.message
    lifecycle.phase('stopping')
    emitLine(line(C.red, `Fataler Workerfehler: ${failure.message}`))
    if (!child) {
      finish('failed', failure.message, failure.message, failure.kind)
      return
    }
    terminateChild()
    stopFallback = setTimeout(() => {
      finish('failed', failure.message, failure.message, failure.kind)
    }, PROCESS_TERMINATION_GRACE_MS)
    stopFallback.unref()
  }
  const startStallWatchdog = (): void => {
    if (stallTimeoutMs <= 0 || stallWatchdog) return
    lastMeaningfulProgressAt = Date.now()
    stallWatchdog = setInterval(() => {
      const idleMs = Date.now() - lastMeaningfulProgressAt
      if (idleMs < stallTimeoutMs) return
      requestFailure({
        kind: 'stalled',
        message: `Worker ohne sinnvollen Provider-Fortschritt seit ${Math.round(idleMs / 1_000)} Sekunden.`
      })
    }, Math.min(STALL_CHECK_INTERVAL_MS, stallTimeoutMs))
    stallWatchdog.unref()
  }
  const requestStop = (): void => {
    if (settled || stopStatus || fatalFailure) return
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
    }, PROCESS_TERMINATION_GRACE_MS)
    stopFallback.unref()
  }
  const handleLine = (raw: string): void => {
    const trimmed = raw.trim()
    if (!trimmed) return
    rawTail = (rawTail + trimmed + '\n').slice(-4000)
    lastMeaningfulProgressAt = Date.now()
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
    if (obj['type'] === 'result' && typeof result.isError === 'boolean') {
      finalProviderResultIsError = result.isError
    }
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

  // Every headless CLI launch carries the model-generated task prompt (and for
  // claude/kimi the system prompt) as an argument, and the appended execution
  // contract makes it always multiline. On Windows the CLIs are typically npm
  // .cmd shims; a cmd.exe wrapper would truncate the prompt at the first
  // newline and make shell metacharacters executable. resolveLaunch therefore
  // must rewrite the shim to a direct Node/exe entrypoint for ALL providers —
  // failing loudly beats silently corrupting the prompt.
  void resolveLaunch(launch.command, launch.args, { requireFaithfulArgs: true })
    .then((resolved) => {
      if (settled || stopStatus) return
      lifecycle.phase('starting-process')
      try {
        const env = id === 'codex' && tmpDir && process.platform === 'win32' && !opts.yolo
          ? codexSingleRootEnvironment(tmpDir)
          : { ...process.env }
        child = spawn(resolved.file, resolved.args, {
          cwd: opts.workingDir,
          env,
          detached: shouldCreateProcessGroup(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        childExited = false
        currentPid = child.pid
        lifecycle.phase('running')
        startStallWatchdog()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emitLine(line(C.red, `Spawn fehlgeschlagen: ${message}`)); finish('failed', message, message, 'provider'); return
      }
      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString(); const parts = stdoutBuf.split(/\r?\n/); stdoutBuf = parts.pop() ?? ''; for (const part of parts) handleLine(part)
      })
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim()
        if (!text) return
        stderrTail = (stderrTail + text + '\n').slice(-4000)
        emitLine(line(C.red, text), 'stderr')
        const failure = classifyFatalProviderStderr(id, stderrTail)
        if (failure) requestFailure(failure)
      })
      child.on('error', (err) => {
        const message = err.message
        if (fatalFailure) {
          acc.result = fatalFailure.message
          finish('failed', fatalFailure.message, fatalFailure.message, fatalFailure.kind)
          return
        }
        if (stopStatus) { finish(stopStatus, stoppedText()); return }
        emitLine(line(C.red, `Spawn fehlgeschlagen: ${message}`)); finish('failed', message, message, 'provider')
      })
      child.once('exit', () => {
        childExited = true
        cancelTerminationEscalation?.()
        cancelTerminationEscalation = undefined
      })
      child.on('close', (code) => {
        if (settled) return
        if (stdoutBuf.trim()) handleLine(stdoutBuf)
        if (lastMsgFile) {
          try { const fileResult = readFileSync(lastMsgFile, 'utf8').trim(); if (fileResult) acc.result = fileResult } catch { /* stream fallback */ }
        }
        if (!acc.result) acc.result = (lastText || rawTail || stderrTail).trim()
        if (code != null) acc.exitCode = code
        if (stopStatus) {
          emitLine(line(C.yellow, 'Task gestoppt'))
          finish(stopStatus, stoppedText()); return
        }
        if (fatalFailure) {
          acc.result = fatalFailure.message
          finish('failed', fatalFailure.message, fatalFailure.message, fatalFailure.kind)
          return
        }
        const explicitSuccess = code === 0 && hasExplicitWorkerSuccess(acc.result)
        const explicitBlocker = hasExplicitWorkerBlocker(acc.result)
        const failed = code !== 0 || explicitBlocker ||
          ((finalProviderResultIsError ?? sawError) && !explicitSuccess)
        if (failed) {
          const processDetail = code == null
            ? 'Prozess ohne Exit-Code beendet'
            : `Prozess beendet (exit ${code})`
          const providerDetail = id === 'codex' ? stderrTail.trim() : ''
          const detail = providerDetail ? `${processDetail}: ${providerDetail}` : processDetail
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
