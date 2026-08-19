/**
 * Test-only doubles for the workspace layer. Nothing in `src/main` imports this
 * at runtime — it exists so Workspace and WorkspaceManager can be exercised
 * end-to-end without a process, a window or an Electron runtime.
 */
import type { AgentRegistry, RegisteredAgent } from '@main/ipc'
import type { PtyExitInfo, PtySpawnOptions } from '@main/agents/PtyAgent'
import type { AgentLaunchInput, AgentPty, ResolvedLaunch, SpawnedAgent } from '@main/agents/spawn'
import type { SeedWithReadyOptions } from '@main/agents/interactiveReady'
import { worktreePathFor } from '@main/agents/worktree'
import { profileSchema, type Profile, type ProfileInput } from '@shared/schema/profile'
import { providerPresets } from '@main/providers/presets'
import type { ProviderConfig } from '@shared/schema/provider'
import type { WorkspaceWindows } from './Workspace'

/** A PTY that records instead of spawning, and can be made to die on cue. */
export class FakePty implements AgentPty {
  pid: number | undefined = 1234
  isAlive = true
  cols = 100
  rows = 30
  killed = 0
  disposed = 0
  readonly written: string[] = []
  spawnOptions: PtySpawnOptions | undefined
  private buffer = ''
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(info: PtyExitInfo) => void>()

  constructor(banner = 'ready> ') {
    this.buffer = banner
  }

  spawn(options: PtySpawnOptions): void {
    this.spawnOptions = options
  }

  write(data: string): void {
    this.written.push(data)
    // Interactive CLIs echo; the seed handshake watches for exactly that.
    this.emit(data)
  }

  /** Everything typed in, without the trailing carriage returns. */
  get typed(): string[] {
    return this.written.map((entry) => entry.replace(/\r$/, ''))
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: (info: PtyExitInfo) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  snapshot(): string {
    return this.buffer
  }

  tail(chars: number): string {
    return this.buffer.slice(-chars)
  }

  push(data: string): void {
    this.emit(data)
  }

  /** Feed output as the real process would. */
  emit(data: string): void {
    this.buffer += data
    for (const listener of [...this.dataListeners]) listener(data)
  }

  /** The process dies on its own — crash, /exit, OOM kill. */
  exit(info: PtyExitInfo = { exitCode: 1 }): void {
    if (!this.isAlive) return
    this.isAlive = false
    for (const listener of [...this.exitListeners]) listener(info)
  }

  kill(): void {
    this.killed += 1
    this.exit({ exitCode: 0, signal: 15 })
  }

  dispose(): void {
    this.disposed += 1
    this.dataListeners.clear()
    this.exitListeners.clear()
  }
}

/** An {@link AgentRegistry} that only records — no IPC, no windows. */
export class FakeRegistry implements AgentRegistry {
  readonly registered: RegisteredAgent[] = []
  readonly removed: string[] = []
  readonly detached: string[] = []
  readonly tasks = new Map<string, string | undefined>()
  private readonly agents = new Map<string, RegisteredAgent>()

  registerAgent(entry: RegisteredAgent): void {
    this.registered.push(entry)
    this.agents.set(entry.meta.agentId, entry)
  }
  getAgent(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId)
  }
  removeAgent(agentId: string): void {
    this.removed.push(agentId)
    this.agents.delete(agentId)
  }
  listAgents(): RegisteredAgent[] {
    return [...this.agents.values()]
  }
  markDetached(agentId: string): void {
    this.detached.push(agentId)
  }
  setAgentTask(agentId: string, task: string | undefined): void {
    this.tasks.set(agentId, task)
  }
  terminals(): import('@main/ipc').TerminalDirectory {
    const agents = this.agents
    return {
      list: () =>
        [...agents.values()].map((entry) => ({ agentId: entry.meta.agentId, meta: entry.meta, exit: null })),
      get: (agentId) => {
        const entry = agents.get(agentId)
        return entry ? { agentId, meta: entry.meta, exit: null } : undefined
      },
      attach: (agentId, sink) => {
        const entry = agents.get(agentId)
        if (!entry) return undefined
        const offData = entry.pty.onData((data) => sink.onData(data))
        const offExit = entry.pty.onExit((info) => sink.onExit(info))
        return {
          snapshot: entry.pty.snapshot(),
          cols: entry.pty.cols,
          rows: entry.pty.rows,
          meta: entry.meta,
          exit: null,
          detach: () => {
            offData()
            offExit()
          }
        }
      },
      write: (agentId, data) => {
        const entry = agents.get(agentId)
        if (!entry || !data) return false
        entry.pty.write(data)
        return true
      },
      resize: (agentId, cols, rows) => {
        const entry = agents.get(agentId)
        if (!entry) return false
        entry.pty.resize(cols, rows)
        return true
      }
    }
  }
  dispose(): void {
    this.agents.clear()
  }
}

export interface WindowCall {
  agentId: string
  title?: string
  roleColor?: string
}

/** Records window opens and closes in call order. */
export class FakeWindows implements WorkspaceWindows {
  readonly opened: WindowCall[] = []
  readonly closed: string[] = []
  /** Every call in order, so "orchestrator last" is provable. */
  readonly calls: Array<{ kind: 'open' | 'close'; agentId: string }> = []

  open(agentId: string, options: { title: string; roleColor: string }): void {
    this.opened.push({ agentId, ...options })
    this.calls.push({ kind: 'open', agentId })
  }
  close(agentId: string): void {
    this.closed.push(agentId)
    this.calls.push({ kind: 'close', agentId })
  }
}

export interface RecordedSpawn {
  input: AgentLaunchInput
  pty: FakePty
  launch: ResolvedLaunch
}

/**
 * A spawn function that hands out {@link FakePty}s and records every launch
 * input — which is how the tests inspect argv decisions without a process.
 */
export function fakeSpawn(
  options: {
    ptySystemPrompt?: boolean
    error?: Error
    /** Boot output every spawned {@link FakePty} starts with — a TUI's DECSET
     * 2004 announcement belongs here, since that is what the seed handshake
     * reads to decide whether it may send a real bracketed paste. */
    banner?: string
  } = {}
): {
  spawn: (input: AgentLaunchInput) => Promise<SpawnedAgent>
  calls: RecordedSpawn[]
} {
  const calls: RecordedSpawn[] = []
  return {
    calls,
    spawn: async (input: AgentLaunchInput): Promise<SpawnedAgent> => {
      if (options.error) throw options.error
      const pty = options.banner === undefined ? new FakePty() : new FakePty(options.banner)
      const launch: ResolvedLaunch = {
        file: `/resolved/${input.provider.command}`,
        args: ['--fake'],
        command: input.provider.command,
        argv: ['--fake'],
        cwd: input.cwd,
        ...(options.ptySystemPrompt && input.systemPrompt
          ? { ptySystemPrompt: input.systemPrompt }
          : {})
      }
      calls.push({ input, pty, launch })
      return { pty, launch }
    }
  }
}

/**
 * A seed that always succeeds immediately and records what was typed.
 *
 * It also mirrors the real handshake's two writes — text, then the submitting
 * Enter, and only when `autoSubmit` is on — so a test can prove the profile
 * switch reaches the PTY and not merely the options object.
 */
export function fakeSeed(): {
  seed: (
    write: (text: string) => void,
    snapshot: unknown,
    prompt: string,
    options?: SeedWithReadyOptions
  ) => Promise<boolean>
  prompts: string[]
  /** The options each seed call received, in call order. */
  options: Array<SeedWithReadyOptions | undefined>
} {
  const prompts: string[] = []
  const options: Array<SeedWithReadyOptions | undefined> = []
  return {
    prompts,
    options,
    seed: async (write, _snapshot, prompt, seedOptions) => {
      prompts.push(prompt)
      options.push(seedOptions)
      write(prompt)
      if (seedOptions?.autoSubmit ?? true) write('\r')
      return true
    }
  }
}

export interface RecordedWorktree {
  repoPath: string
  agentId: string
  branchName: string
  /** The baseBranch the caller asked for, when it asked for one. */
  startPoint?: string
}

/**
 * A `createWorktree` that records instead of running git. Every agent start
 * needs a worktree, so every Workspace test needs this (or its own override).
 */
export function fakeWorktrees(): {
  createWorktree: (
    repoPath: string,
    agentId: string,
    branchName: string,
    options?: { startPoint?: string }
  ) => Promise<{ path: string; branch: string }>
  calls: RecordedWorktree[]
} {
  const calls: RecordedWorktree[] = []
  return {
    calls,
    createWorktree: async (repoPath, agentId, branchName, options) => {
      calls.push({ repoPath, agentId, branchName, ...(options?.startPoint ? { startPoint: options.startPoint } : {}) })
      // Same convention as production `createWorktree` / `beginAgent`, including
      // Windows separators. A POSIX-only string here makes spawn cwd disagree
      // with `worktreePathFor` and fails CI on windows-latest.
      return { path: worktreePathFor(repoPath, agentId), branch: branchName }
    }
  }
}

export const testProviders = (): ProviderConfig[] => providerPresets()

/** A profile with a worker and a reviewer slot on Claude. */
export function testProfile(overrides: Partial<ProfileInput> = {}): Profile {
  return profileSchema.parse({
    id: 'profile-1',
    name: 'Test profile',
    repoPath: '/repo',
    orchestrator: { providerId: 'claude', model: 'opus' },
    slots: [
      { id: 'slot-worker', roleId: 'worker', providerId: 'claude', model: 'sonnet', maxCount: 2 },
      { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
    ],
    maxSubagents: 3,
    ...overrides
  })
}

/** Deterministic ids so assertions can name an agent. */
export function sequentialIds(prefix = 'id'): () => string {
  let counter = 0
  return () => `${prefix}-${++counter}`
}
