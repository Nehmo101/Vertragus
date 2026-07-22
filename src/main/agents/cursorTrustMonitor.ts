/**
 * Stateful retry/watchdog layer for Cursor's interactive workspace-trust
 * prompt, extracted from AgentManager (audit A2). The pure prompt detection
 * stays in cursorWorkspaceTrust.ts; this module owns the per-agent timers and
 * flags. All process access goes through the narrow host interface, and every
 * timer callback re-checks isPresent/hasPty — the reassign path swaps an
 * agent's pty while a watchdog may still be pending.
 */
import { cursorWorkspaceTrustPrompt } from '@main/agents/cursorWorkspaceTrust'
import { stripAnsi } from '@main/agents/limitSignals'

const CURSOR_TRUST_SCAN_CHARS = 8_000
const CURSOR_TRUST_RETRY_DELAY_MS = 150
const CURSOR_TRUST_MAX_RETRIES = 3
const CURSOR_TRUST_WATCHDOG_MS = 8_000

export interface CursorTrustAgentView {
  name: string
  provider: string
  workingDir: string
  worktree?: string
  interactiveUsed: boolean
}

export interface CursorTrustHost {
  isPresent(id: string): boolean
  hasPty(id: string): boolean
  writePty(id: string, data: string): void
  bufferTail(id: string, chars: number): string
  trustView(id: string): CursorTrustAgentView | undefined
  emitEvent(id: string, text: string, tone: 'dispatch' | 'warn' | 'error'): void
  /** Watchdog terminal-failure path: terminate + mark error + notify (host-owned). */
  failTrustStuckAgent(id: string, message: string): void
}

interface TrustState {
  handled?: boolean
  retry?: ReturnType<typeof setTimeout>
  retryCount: number
  watchdog?: ReturnType<typeof setTimeout>
  nudged?: boolean
}

export class CursorTrustMonitor {
  private readonly states = new Map<string, TrustState>()

  constructor(private readonly host: CursorTrustHost) {}

  private state(id: string): TrustState {
    let state = this.states.get(id)
    if (!state) {
      state = { retryCount: 0 }
      this.states.set(id, state)
    }
    return state
  }

  /** Cancel pending retry/watchdog timers (agent gone, reassigned or used). */
  clear(id: string): void {
    const state = this.states.get(id)
    if (!state) return
    if (state.retry) {
      clearTimeout(state.retry)
      state.retry = undefined
    }
    if (state.watchdog) {
      clearTimeout(state.watchdog)
      state.watchdog = undefined
    }
  }

  /** Drop all per-agent state (terminal removal). */
  dispose(id: string): void {
    this.clear(id)
    this.states.delete(id)
  }

  private progressVisible(id: string): boolean {
    const tail = stripAnsi(this.host.bufferTail(id, 800)).replace(/\r/g, '\n').trimEnd()
    return /Trusting workspace(?:\.{3})?\s*$/i.test(tail)
  }

  /** Called on every output chunk of a cursor agent after autoTrust. */
  monitor(id: string): void {
    const state = this.states.get(id)
    const view = this.host.trustView(id)
    if (!state?.handled || !this.host.hasPty(id) || view?.provider !== 'cursor') return
    if (!this.progressVisible(id)) {
      if (state.watchdog) this.clear(id)
      return
    }
    if (state.watchdog) return
    state.watchdog = setTimeout(() => {
      state.watchdog = undefined
      if (!this.host.isPresent(id) || !this.host.hasPty(id) || !this.progressVisible(id)) return
      const name = this.host.trustView(id)?.name ?? id
      if (!state.nudged) {
        state.nudged = true
        this.host.writePty(id, '\r')
        this.host.emitEvent(id, `${name} - Cursor-Trust reagiert nicht; Enter wird erneut gesendet.`, 'warn')
        this.monitor(id)
        return
      }
      this.host.failTrustStuckAgent(id, `${name} - Cursor Workspace-Trust fehlgeschlagen`)
    }, CURSOR_TRUST_WATCHDOG_MS)
  }

  private retryLater(id: string): void {
    const state = this.state(id)
    if (state.retry || state.handled || state.retryCount >= CURSOR_TRUST_MAX_RETRIES) return
    state.retryCount += 1
    state.retry = setTimeout(() => {
      state.retry = undefined
      if (!this.host.isPresent(id) || !this.host.hasPty(id)) return
      this.autoTrust(id)
    }, CURSOR_TRUST_RETRY_DELAY_MS)
  }

  /** Auto-confirm the trust dialog for Vertragus-managed worktrees. */
  autoTrust(id: string): void {
    const view = this.host.trustView(id)
    if (view?.provider !== 'cursor' || !this.host.hasPty(id)) return
    const state = this.state(id)
    const prompt = cursorWorkspaceTrustPrompt({
      output: this.host.bufferTail(id, CURSOR_TRUST_SCAN_CHARS),
      workingDir: view.workingDir,
      worktree: view.worktree,
      alreadyHandled: Boolean(state.handled),
      interactiveUsed: view.interactiveUsed
    })
    if (prompt === 'none') return
    if (prompt === 'partial') {
      this.retryLater(id)
      return
    }

    this.clear(id)
    state.handled = true
    this.host.writePty(id, 'a\r')
    this.host.emitEvent(id, `${view.name} · Cursor-Trust für Vertragus-Worktree bestätigt (a gesendet)`, 'dispatch')
  }
}
