/**
 * AgentManager — owns the lifecycle of every running agent instance.
 *
 * Each agent is a real PTY process (@lydell/node-pty, prebuilt N-API) running
 * the provider's interactive CLI. Output is broadcast to every renderer
 * window; a ring buffer allows late-mounting terminals (pop-outs, reloads)
 * to replay scrollback.
 */
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import type { AgentInstanceInfo, OrcaEvent, SpawnAgentRequest } from '@shared/agents'
import { buildInteractiveLaunch } from '@main/providers/types'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { createWorktree } from '@main/agents/worktree'
import { getSetting } from '@main/config/store'

const BUFFER_LIMIT = 200_000 // chars of scrollback kept per agent

interface Managed {
  info: AgentInstanceInfo
  pty?: pty.IPty
  buffer: string
  seq: number
}

export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, Managed>()
  private seq = 0

  list(): AgentInstanceInfo[] {
    return [...this.agents.values()].map((m) => m.info)
  }

  buffer(id: string): { data: string; seq: number } {
    const m = this.agents.get(id)
    return { data: m?.buffer ?? '', seq: m?.seq ?? 0 }
  }

  private emitEvent(text: string, tone: OrcaEvent['tone'] = 'info'): void {
    const evt: OrcaEvent = { time: Date.now(), text, tone }
    this.emit('event', evt)
  }

  private changed(): void {
    this.emit('changed', this.list())
  }

  private nextId(kind: string): string {
    this.seq += 1
    return `${kind === 'orchestrator' ? 'orch' : 'sub'}-${String(this.seq).padStart(2, '0')}`
  }

  async spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo> {
    const kind = req.kind ?? 'sub'
    const id = this.nextId(kind)
    const yolo = req.yolo ?? false
    let workingDir = req.workingDir?.trim() || homedir()
    let worktree: string | undefined

    // Worktree isolation (default ON): only when the dir is inside a git repo.
    const isolate = getSetting<boolean>('worktreeIsolation') ?? true
    if (isolate) {
      const wt = await createWorktree(workingDir, id)
      if (wt) {
        workingDir = wt.path
        worktree = wt.path
        this.emitEvent(`${id} worktree ${wt.branch} @ ${wt.path}`, 'muted')
      }
    }

    const launch = buildInteractiveLaunch(req.provider, {
      model: req.model,
      workingDir,
      yolo
    })
    const resolved = await resolveLaunch(launch.command, launch.args)

    const info: AgentInstanceInfo = {
      id,
      provider: req.provider,
      model: req.model,
      role: req.role ?? (kind === 'orchestrator' ? 'Orchestrator · plant & verteilt' : 'Subagent'),
      kind,
      yolo,
      workingDir,
      worktree,
      status: 'running',
      startedAt: Date.now()
    }
    const managed: Managed = { info, buffer: '', seq: 0 }
    this.agents.set(id, managed)

    try {
      const proc = pty.spawn(resolved.file, resolved.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: workingDir,
        env: { ...process.env } as Record<string, string>
      })
      managed.pty = proc
      info.pid = proc.pid

      proc.onData((data) => {
        managed.buffer = (managed.buffer + data).slice(-BUFFER_LIMIT)
        managed.seq += 1
        this.emit('data', { id, data, seq: managed.seq })
      })
      proc.onExit(({ exitCode }) => {
        managed.pty = undefined
        if (!this.agents.has(id)) return // killed & removed explicitly
        info.exitCode = exitCode
        info.status = exitCode === 0 ? 'stopped' : 'error'
        this.emitEvent(
          exitCode === 0 ? `${id} beendet` : `${id} Fehler · exit ${exitCode}`,
          exitCode === 0 ? 'muted' : 'error'
        )
        this.changed()
      })

      this.emitEvent(
        `${kind === 'orchestrator' ? 'ORCH' : id} gestartet · ${req.provider}/${req.model}${yolo ? ' [YOLO]' : ''}`,
        yolo ? 'yolo' : 'dispatch'
      )
    } catch (err) {
      info.status = 'error'
      const msg = err instanceof Error ? err.message : String(err)
      managed.buffer = `Spawn fehlgeschlagen: ${msg}\r\n`
      this.emitEvent(`${id} Spawn fehlgeschlagen: ${msg}`, 'error')
    }

    this.changed()
    return info
  }

  write(id: string, data: string): void {
    this.agents.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.agents.get(id)?.pty?.resize(cols, rows)
  }

  private terminate(managed: Managed): void {
    const proc = managed.pty
    if (!proc) return
    if (process.platform === 'win32' && proc.pid) {
      // Kill the whole tree — agent CLIs spawn children (shells, node, git).
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      proc.kill()
    }
  }

  async kill(id: string): Promise<void> {
    const managed = this.agents.get(id)
    if (!managed) return
    this.terminate(managed)
    managed.info.status = 'stopped'
    this.agents.delete(id)
    this.emitEvent(`${id} geschlossen`, 'muted')
    this.changed()
  }

  async killAll(): Promise<void> {
    const running = [...this.agents.values()].filter((m) => m.pty)
    for (const m of running) {
      this.terminate(m)
      m.info.status = 'stopped'
    }
    this.emitEvent(`⛔ ALLE AGENTS GESTOPPT · ${running.length} beendet`, 'error')
    this.changed()
  }

  /** True while at least one PTY is alive. */
  anyRunning(): boolean {
    return [...this.agents.values()].some((m) => m.pty)
  }

  /** Remove exited agents from the list (panes closed in the UI). */
  prune(id: string): void {
    const managed = this.agents.get(id)
    if (managed && !managed.pty) {
      this.agents.delete(id)
      this.changed()
    }
  }
}

export const agentManager = new AgentManager()
