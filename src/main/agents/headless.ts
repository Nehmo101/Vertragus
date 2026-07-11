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

export interface HeadlessResult {
  result: string
  isError: boolean
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  steps?: number
}

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
      costUsd: typeof obj['total_cost_usd'] === 'number' ? (obj['total_cost_usd'] as number) : undefined,
      tokensIn: usage?.input_tokens,
      tokensOut: usage?.output_tokens,
      steps: typeof obj['num_turns'] === 'number' ? (obj['num_turns'] as number) : undefined
    }
  }
  if (type === 'system') return {} // init noise
  return {}
}

/** codex exec --json emits its own event shapes. */
function interpretCodex(obj: Record<string, unknown>): LineInterpretation {
  const type = String(obj['type'] ?? '')
  const item = obj['item'] as { type?: string; text?: string; command?: string } | undefined
  if (type === 'item.completed' || type === 'item.started') {
    if (item?.type === 'agent_message' && item.text) return { log: line(C.reset, item.text.trim()) }
    if (item?.type === 'command_execution' && item.command)
      return { log: line(C.cyan, `$ ${item.command}`) }
    if (item?.type === 'reasoning') return { log: line(C.grey, '  · denkt nach …') }
    return {}
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
  onLine: (chunk: string) => void
): HeadlessHandle {
  if (id === 'ollama') {
    return runOllamaChat(prompt, opts, onLine)
  }

  let lastMsgFile: string | undefined
  let tmpDir: string | undefined
  const extraArgs = [...(opts.extraArgs ?? [])]

  if (id === 'claude') {
    extraArgs.push('--verbose') // required for stream-json in -p mode
  }
  if (id === 'codex') {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-codex-'))
    lastMsgFile = join(tmpDir, 'last.txt')
    extraArgs.push('--json', '-o', lastMsgFile)
  }

  const launch = buildHeadlessLaunch(id, prompt, { ...opts, extraArgs })
  const interpret = interpreterFor(id)

  let child: ChildProcess | undefined
  let killed = false

  const done = new Promise<HeadlessResult>((resolve) => {
    void resolveLaunch(launch.command, launch.args).then((resolved) => {
      child = spawn(resolved.file, resolved.args, {
        cwd: opts.workingDir,
        env: { ...process.env } as Record<string, string>,
        windowsHide: true
      })

      const acc: HeadlessResult = { result: '', isError: false }
      let lastText = ''
      let stdoutBuf = ''
      let rawTail = ''

      const handleLine = (raw: string): void => {
        const trimmed = raw.trim()
        if (!trimmed) return
        rawTail = (rawTail + trimmed + '\n').slice(-4000)
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          onLine(line(C.grey, trimmed)) // non-JSON line — show raw
          return
        }
        const r = interpret(obj)
        if (r.log) onLine(r.log)
        if (typeof r.result === 'string' && r.result) {
          acc.result = r.result
        }
        if (r.log && obj['type'] !== 'result') lastText = r.log
        if (r.costUsd != null) acc.costUsd = r.costUsd
        if (r.tokensIn != null) acc.tokensIn = r.tokensIn
        if (r.tokensOut != null) acc.tokensOut = r.tokensOut
        if (r.steps != null) acc.steps = r.steps
      }

      child.stdout?.on('data', (d: Buffer) => {
        stdoutBuf += d.toString()
        const parts = stdoutBuf.split(/\r?\n/)
        stdoutBuf = parts.pop() ?? ''
        for (const p of parts) handleLine(p)
      })
      child.stderr?.on('data', (d: Buffer) => {
        const t = d.toString().trim()
        if (t) onLine(line(C.red, t))
      })

      child.on('error', (err) => {
        onLine(line(C.red, `Spawn fehlgeschlagen: ${err.message}`))
        acc.isError = true
        resolve(acc)
      })

      child.on('close', (code) => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf)
        // codex: prefer the last-message file for a clean result.
        if (lastMsgFile) {
          try {
            const fileResult = readFileSync(lastMsgFile, 'utf8').trim()
            if (fileResult) acc.result = fileResult
          } catch {
            /* ignore */
          }
          if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
        }
        if (!acc.result) acc.result = (lastText || rawTail).trim()
        acc.isError = killed || (code != null && code !== 0 && !acc.result)
        if (code === 0) onLine(line(C.green, '✓ fertig'))
        else if (killed) onLine(line(C.yellow, '— gestoppt —'))
        else onLine(line(C.red, `✗ exit ${code}`))
        resolve(acc)
      })
    })
  })

  return {
    get pid() {
      return child?.pid
    },
    done,
    kill() {
      killed = true
      if (child?.pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGTERM')
        }
      }
    }
  }
}
