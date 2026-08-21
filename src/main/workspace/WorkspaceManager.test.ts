import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildAgentArgv } from '@main/agents/spawn'
import type { McpServerHandle, RegisteredWorkspace } from '@main/mcp/server'
import type { WorkspaceMcpContext } from '@main/mcp/types'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import { memoryTaskBoard } from '@main/mcp/testing'
import { buildHandoffPackage } from '@shared/schema/handoff'
import { createWorkspaceManager, type WorkspaceManagerDeps } from './WorkspaceManager'
import type { WorkspaceDeps, WorkspaceWindows } from './Workspace'
import {
  FakeRegistry,
  fakeSeed,
  fakeSpawn,
  fakeWorktrees,
  sequentialIds,
  testProfile,
  testProviders,
  type RecordedSpawn
} from './testing'

/** Records the calls the manager makes, in the order it makes them. */
class FakeMcp implements McpServerHandle {
  port = 4711
  readonly contexts: WorkspaceMcpContext[] = []
  readonly unregistered: string[] = []
  private readonly runtimes = new Map<string, RegisteredWorkspace['runtime']>()
  /** Last questions registry minted at registerWorkspace — for attachQuestions checks. */
  lastQuestions: PendingQuestions | undefined
  /** Last runtime minted at registerWorkspace — for taskBoard wiring checks (S4). */
  lastRuntime: RegisteredWorkspace['runtime'] | undefined

  constructor(private readonly log: string[] = []) {}

  registerWorkspace(ctx: WorkspaceMcpContext): RegisteredWorkspace {
    this.contexts.push(ctx)
    this.log.push(`register:${ctx.workspaceName}`)
    const runtime = {
      ctx,
      questions: new PendingQuestions(),
      agentTasks: new Map<string, string>(),
      leads: new Map(),
      parentOf: new Map(),
      resultSchemas: new Map(),
      // Mirrors the real registration: the runtime's board IS the host's, so
      // one assignment wires the tools AND the succession package.
      get taskBoard() {
        return ctx.host.attachedTaskBoard?.()
      },
      set taskBoard(board) {
        if (board) ctx.host.attachTaskBoard?.(board)
      }
    } as RegisteredWorkspace['runtime']
    this.runtimes.set(ctx.workspaceId, runtime)
    this.lastQuestions = runtime.questions
    this.lastRuntime = runtime
    return {
      runtime,
      orchestratorUrl: `http://127.0.0.1:${this.port}/mcp?ws=${ctx.workspaceId}&token=${ctx.orchToken}`,
      subagentUrl: (agentId: string) =>
        `http://127.0.0.1:${this.port}/mcp?ws=${ctx.workspaceId}&agent=${agentId}&token=${ctx.subToken}`,
      leadUrl: (agentId: string) =>
        `http://127.0.0.1:${this.port}/mcp?ws=${ctx.workspaceId}&lead=${agentId}&token=lead`,
      rotateOrchestratorToken: () => this.rotateOrchestratorToken(ctx.workspaceId),
      applyOrchestratorToken: (token) => this.applyOrchestratorToken(ctx.workspaceId, token)
    }
  }

  rotateOrchestratorToken(workspaceId: string): {
    previousToken: string
    orchToken: string
    orchestratorUrl: string
  } {
    const runtime = this.runtimes.get(workspaceId)
    if (!runtime) throw new Error(`Unknown MCP workspace: ${workspaceId}`)
    const previousToken = runtime.ctx.orchToken
    const orchToken = `${previousToken}-next`
    runtime.ctx.orchToken = orchToken
    return {
      previousToken,
      orchToken,
      orchestratorUrl: `http://127.0.0.1:${this.port}/mcp?ws=${workspaceId}&token=${orchToken}`
    }
  }

  applyOrchestratorToken(workspaceId: string, orchToken: string): { orchestratorUrl: string } {
    const runtime = this.runtimes.get(workspaceId)
    if (!runtime) throw new Error(`Unknown MCP workspace: ${workspaceId}`)
    runtime.ctx.orchToken = orchToken
    return { orchestratorUrl: `http://127.0.0.1:${this.port}/mcp?ws=${workspaceId}&token=${orchToken}` }
  }

  unregisterWorkspace(workspaceId: string): void {
    this.unregistered.push(workspaceId)
    this.runtimes.delete(workspaceId)
    this.log.push('unregister')
  }

  orchestratorUrl(): string {
    return ''
  }
  subagentUrl(): string {
    return ''
  }
  pendingQuestion(workspaceId: string, agentId: string): string | undefined {
    return this.runtimes.get(workspaceId)?.questions.openForAgent(agentId)?.question
  }
  openQuestion(
    workspaceId: string,
    agentId: string
  ): { questionId: string; question: string } | undefined {
    const open = this.runtimes.get(workspaceId)?.questions.openForAgent(agentId)
    return open ? { questionId: open.questionId, question: open.question } : undefined
  }
  async answerQuestion(
    workspaceId: string,
    _agentId: string,
    questionId: string,
    text: string
  ): ReturnType<McpServerHandle['answerQuestion']> {
    const runtime = this.runtimes.get(workspaceId)
    if (!runtime) return { ok: false as const, error: 'unknown_workspace' as const, questionId }
    runtime.questions.answer(questionId, text)
    return { ok: true as const, agentId: _agentId, questionId }
  }
  workspaceTask(workspaceId: string): string | undefined {
    return this.runtimes.get(workspaceId)?.latestTask
  }
  agentTask(workspaceId: string, agentId: string): string | undefined {
    return this.runtimes.get(workspaceId)?.agentTasks.get(agentId)
  }
  agentParent(workspaceId: string, agentId: string): string | undefined {
    return this.runtimes.get(workspaceId)?.parentOf.get(agentId)
  }
  async close(): Promise<void> {}
}

interface Harness {
  manager: ReturnType<typeof createWorkspaceManager>
  mcp: FakeMcp
  log: string[]
  spawns: RecordedSpawn[]
}

function harness(overrides: Partial<WorkspaceManagerDeps> = {}): Harness {
  const log: string[] = []
  const mcp = new FakeMcp(log)
  const spawner = fakeSpawn()
  const seeder = fakeSeed()
  const windows: WorkspaceWindows = {
    open: (agentId) => log.push(`open:${agentId}`),
    close: (agentId) => log.push(`close:${agentId}`)
  }

  const manager = createWorkspaceManager({
    mcp,
    registry: new FakeRegistry(),
    windows,
    configDir: '/config',
    providers: () => testProviders(),
    spawn: (async (input) => {
      log.push(`spawn:${input.kind}`)
      return spawner.spawn(input)
    }) as unknown as WorkspaceDeps['spawn'],
    createWorktree: fakeWorktrees().createWorktree as unknown as WorkspaceDeps['createWorktree'],
    seed: seeder.seed as unknown as WorkspaceDeps['seed'],
    newId: sequentialIds('id'),
    ...overrides
  })

  return { manager, mcp, log, spawns: spawner.calls }
}

describe('startWorkspace', () => {
  it('walks the Commedia place names per profile', async () => {
    const { manager } = harness()
    const profile = testProfile()
    const other = testProfile({ id: 'profile-2' })

    const first = await manager.startWorkspace(profile)
    const second = await manager.startWorkspace(profile)
    const otherFirst = await manager.startWorkspace(other)

    expect(first.workspace.name).toBe('Paradiso')
    expect(second.workspace.name).toBe('Purgatorio')
    // A second profile starts its own sequence.
    expect(otherFirst.workspace.name).toBe('Paradiso')
  })

  it('E3: a resume start writes meta and briefs the orchestrator on the old run', async () => {
    const appended: unknown[] = []
    const metas: unknown[] = []
    const { manager, spawns } = harness({
      journal: () => ({
        path: '/repo/.vertragus/runs/x/events.jsonl',
        append: (event) => appended.push(event),
        writeMeta: (meta) => metas.push(meta)
      })
    })

    await manager.startWorkspace(testProfile(), {
      goal: 'continue the parser work',
      resume: { briefing: 'Old run left branch vertragus/a1.', fromWorkspaceId: 'ws-old' }
    })

    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({
      profileId: testProfile().id,
      goal: 'continue the parser work',
      resumedFrom: 'ws-old'
    })
    const prompt = spawns[0]!.input.systemPrompt!
    expect(prompt).toContain('--- resumed run ---')
    expect(prompt).toContain('branch vertragus/a1')
  })

  it('C6: an unconsumed succession package brief REPLACES the journal briefing', async () => {
    const { manager, spawns } = harness()

    await manager.startWorkspace(testProfile(), {
      resume: {
        briefing: 'Old run left branch vertragus/a1.',
        fromWorkspaceId: 'ws-old',
        succession: buildHandoffPackage({
          workspaceId: 'ws-old',
          workspaceName: 'Inferno',
          profileId: testProfile().id,
          createdAt: 1,
          reason: 'context_full',
          predecessor: { agentId: 'o1', name: 'Virgilio', providerId: 'claude' },
          successorAgentId: 'o2',
          eventCursor: 12,
          agents: [],
          openQuestions: [],
          recentEvents: [],
          decisions: ['Parser stays hand-written']
        })
      }
    })

    const prompt = spawns[0]!.input.systemPrompt!
    expect(prompt).toContain('recovering the run of Virgilio')
    expect(prompt).toContain('Parser stays hand-written')
    // Two accounts of one dead run would only compete for attention.
    expect(prompt).not.toContain('--- resumed run ---')
  })

  it('S4: installs the task board on the MCP runtime and seeds it on resume', async () => {
    const board = memoryTaskBoard()
    const factory = vi.fn(() => board)
    const { manager, mcp } = harness({ taskBoard: factory })

    const running = await manager.startWorkspace(testProfile(), {
      resume: {
        briefing: 'old run',
        fromWorkspaceId: 'ws-old',
        tasks: {
          schemaVersion: 1,
          nextTaskNumber: 3,
          tasks: [
            {
              taskId: 'task-2',
              revision: 4,
              subject: 'Carry me over',
              description: '',
              status: 'pending',
              blockedBy: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        }
      }
    })

    expect(factory).toHaveBeenCalledWith(testProfile().repoPath, running.workspace.workspaceId)
    // The MCP tool layer reads the board off the runtime — it must be there.
    expect(mcp.lastRuntime?.taskBoard).toBe(board)
    // And the succession package reads the HOST's, which is the same object:
    // one wiring seam, no way to end up with tools and a package disagreeing.
    expect(running.workspace.attachedTaskBoard()).toBe(board)
    expect(board.get('task-2')).toMatchObject({ subject: 'Carry me over', revision: 4 })
    // New ids continue after the seeded numbering — no collisions.
    expect(board.create({ subject: 'fresh' })).toMatchObject({ ok: true, task: { taskId: 'task-3' } })
  })

  it('registers with the MCP server BEFORE the orchestrator is spawned', async () => {
    const { manager, log } = harness()
    await manager.startWorkspace(testProfile())
    // The launch args carry the MCP URL — there is no window in which an agent
    // exists without an attachment.
    expect(log.indexOf('register:Paradiso')).toBeLessThan(log.indexOf('spawn:orchestrator'))
  })

  it('hands the minted URLs to the workspace', async () => {
    const { manager, spawns } = harness()
    const running = await manager.startWorkspace(testProfile())

    expect(spawns[0]!.input.mcpUrl).toBe(running.urls.orchestratorUrl)
    expect(spawns[0]!.input.mcpUrl).toContain(`ws=${running.workspace.workspaceId}`)
    expect(running.orchestrator.name).toBeTruthy()
  })

  it('attaches the MCP PendingQuestions registry to the workspace', async () => {
    const { manager, mcp, spawns } = harness()
    const profile = testProfile({
      slots: [
        { id: 'slot-worker', roleId: 'worker', providerId: 'ollama' },
        { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
      ]
    })
    const running = await manager.startWorkspace(profile)
    // Subagent spawn is index 1 (0 = orchestrator). Feed a sentinel ASK.
    await running.workspace.startAgent({ role: 'worker', task: 'Ask something.' })
    const sub = spawns.find((spawn) => spawn.input.kind === 'subagent')
    sub!.pty.emit(`@@VERTRAGUS:ASK@@${JSON.stringify({ question: 'shared registry?' })}@@END@@`)

    expect(mcp.lastQuestions?.openCount).toBe(1)
    expect(mcp.lastQuestions?.openForAgent(running.workspace.listAgents()[0]!.agentId)?.question).toBe(
      'shared registry?'
    )
  })

  it('seeds a goal into the orchestrator after start (H2) and records it', async () => {
    const { manager, spawns } = harness()
    const running = await manager.startWorkspace(testProfile(), { goal: '  Fix the login bug  ' })

    expect(running.workspace.goalText).toBe('Fix the login bug')
    expect(spawns[0]!.pty.written).toContain('Fix the login bug')
    expect(spawns[0]!.input.initialPrompt).toBeUndefined()
  })

  it('delivers a grok start-goal as a trailing positional argv, without PTY-seeding it', async () => {
    const { manager, spawns } = harness()
    const running = await manager.startWorkspace(
      testProfile({ orchestrator: { providerId: 'grok' } }),
      { goal: '  Fix the login bug  ' }
    )

    expect(running.workspace.goalText).toBe('Fix the login bug')
    expect(spawns[0]!.input.initialPrompt).toBe('Fix the login bug')
    expect(spawns[0]!.pty.written).not.toContain('Fix the login bug')

    const cwd = mkdtempSync(join(tmpdir(), 'vertragus-ws-grok-goal-'))
    try {
      const { argv } = buildAgentArgv({ ...spawns[0]!.input, cwd })
      expect(argv.at(-1)).toBe('Fix the login bug')
      expect(argv).not.toContain('-p')
      expect(argv).not.toContain('--single')
      expect(argv).not.toContain('--max-turns')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('a bare start stays a bare start — no goal, no seed, no crash', async () => {
    const { manager, spawns } = harness()
    const running = await manager.startWorkspace(testProfile())
    expect(running.workspace.goalText).toBeUndefined()
    // Nothing was typed into the orchestrator (fake launch has no ptySystemPrompt).
    expect(spawns[0]!.pty.written).toEqual([])
    expect(spawns[0]!.input.initialPrompt).toBeUndefined()

    const blank = await manager.startWorkspace(testProfile(), { goal: '   ' })
    expect(blank.workspace.goalText).toBeUndefined()
  })

  it('a grok start without a goal does not add a positional prompt', async () => {
    const { manager, spawns } = harness()
    const running = await manager.startWorkspace(
      testProfile({ orchestrator: { providerId: 'grok' } })
    )
    expect(running.workspace.goalText).toBeUndefined()
    expect(spawns[0]!.input.initialPrompt).toBeUndefined()
    expect(spawns[0]!.pty.written).toEqual([])

    const blank = await manager.startWorkspace(
      testProfile({ orchestrator: { providerId: 'grok' } }),
      { goal: '   ' }
    )
    expect(blank.workspace.goalText).toBeUndefined()
    expect(spawns[1]!.input.initialPrompt).toBeUndefined()
  })

  it('a failed goal delivery surfaces the error but keeps the workspace running', async () => {
    let orchestratorSeeded = false
    const { manager } = harness({
      seed: (async (write: (text: string) => void, _s: unknown, prompt: string) => {
        // First seed call would be the goal (fake launch has no ptySystemPrompt).
        if (!orchestratorSeeded) {
          orchestratorSeeded = true
          return false
        }
        write(prompt)
        return true
      }) as unknown as WorkspaceDeps['seed']
    })

    await expect(
      manager.startWorkspace(testProfile(), { goal: 'Goal.' })
    ).rejects.toThrow(/did not accept the goal/)
    // The orchestrator lives on; the workspace stays listed and stoppable.
    expect(manager.list()).toHaveLength(1)
    expect(manager.list()[0]!.orchestratorAlive).toBe(true)
    expect(manager.list()[0]!.goalText).toBeUndefined()
  })

  it('passes the profile limits and roles into the MCP context', async () => {
    const { manager, mcp } = harness()
    await manager.startWorkspace(testProfile())

    const ctx = mcp.contexts[0]!
    expect(ctx.roles).toEqual(['worker', 'reviewer'])
    expect(ctx.limits.maxTotal).toBe(3)
    expect(ctx.limits.perRole.get('worker')).toBe(2)
  })

  it('reads providers, role templates and yolo fresh on every start', async () => {
    const providers = vi.fn(() => testProviders())
    const roleTemplates = vi.fn(() => [])
    const yoloMaster = vi.fn(() => false)
    const agentPolicy = vi.fn(() => 'ask-orchestrator' as const)
    const { manager, spawns, mcp } = harness({ providers, roleTemplates, yoloMaster, agentPolicy })

    await manager.startWorkspace(testProfile())
    await manager.startWorkspace(testProfile())

    expect(providers).toHaveBeenCalledTimes(2)
    expect(roleTemplates).toHaveBeenCalledTimes(2)
    expect(yoloMaster).toHaveBeenCalledTimes(2)
    // D4: the tier is read fresh too, and it reaches the MCP context.
    expect(agentPolicy).toHaveBeenCalledTimes(2)
    expect(mcp.contexts[0]!.agentPolicy).toBe('ask-orchestrator')
    expect(spawns).toHaveLength(2)
  })

  it('refuses a profile without a repository path', async () => {
    const { manager, mcp } = harness()
    await expect(manager.startWorkspace(testProfile({ repoPath: '' }))).rejects.toThrow(
      /no repository path/
    )
    expect(mcp.contexts).toHaveLength(0)
  })

  it('unregisters again when the orchestrator fails to start', async () => {
    const { manager, mcp } = harness({
      spawn: (async () => {
        throw new Error('spawn claude ENOENT')
      }) as unknown as WorkspaceDeps['spawn']
    })

    await expect(manager.startWorkspace(testProfile())).rejects.toThrow('spawn claude ENOENT')
    expect(mcp.unregistered).toHaveLength(1)
    expect(manager.list()).toHaveLength(0)
  })
})

describe('stopWorkspace', () => {
  it('stops every agent before it unregisters — the queue closes last', async () => {
    const { manager, log } = harness()
    const running = await manager.startWorkspace(testProfile())
    const worker = await running.workspace.startAgent({ role: 'worker', task: 'x' })

    await expect(manager.stopWorkspace(running.workspace.workspaceId)).resolves.toBe(true)

    const closeWorker = log.indexOf(`close:${worker.agentId}`)
    const closeOrchestrator = log.indexOf(`close:${running.orchestrator.agentId}`)
    const unregister = log.indexOf('unregister')
    expect(closeWorker).toBeGreaterThanOrEqual(0)
    // Subagents, then the orchestrator, then the MCP registration.
    expect(closeWorker).toBeLessThan(closeOrchestrator)
    expect(closeOrchestrator).toBeLessThan(unregister)
    expect(manager.list()).toHaveLength(0)
  })

  it('reports false for an unknown workspace', async () => {
    const { manager } = harness()
    await expect(manager.stopWorkspace('nope')).resolves.toBe(false)
  })

  it('stops all workspaces at once', async () => {
    const { manager, mcp } = harness()
    await manager.startWorkspace(testProfile())
    await manager.startWorkspace(testProfile({ id: 'profile-2' }))

    await manager.stopAll()

    expect(mcp.unregistered).toHaveLength(2)
    expect(manager.list()).toHaveLength(0)
  })
})

describe('lookup', () => {
  it('finds workspaces by id and groups them per profile', async () => {
    const { manager } = harness()
    const first = await manager.startWorkspace(testProfile())
    const second = await manager.startWorkspace(testProfile())
    await manager.startWorkspace(testProfile({ id: 'profile-2' }))

    expect(manager.get(first.workspace.workspaceId)).toBe(first.workspace)
    expect(manager.get('nope')).toBeUndefined()
    expect(manager.listForProfile('profile-1')).toEqual([first.workspace, second.workspace])
    expect(manager.listForProfile('profile-2')).toHaveLength(1)
  })
})

describe('retro finalization', () => {
  function fakeRetroSink(log: string[] = []): {
    sink: import('./retroSink').RetroSink
    finalized: import('./retroSink').FinalizeRunInput[]
  } {
    const finalized: import('./retroSink').FinalizeRunInput[] = []
    return {
      finalized,
      sink: {
        recordLearnings: () => ({ applied: 0 }),
        knowledge: () => [],
        repoNotes: () => [],
        recordRepoNotes: () => ({ applied: 0 }),
        finalizeRun: (input) => {
          log.push('finalize')
          finalized.push(input)
          return undefined
        }
      }
    }
  }

  it('finalizes the run from the tapped events before unregistering', async () => {
    const log: string[] = []
    const { sink, finalized } = fakeRetroSink(log)
    const { manager, log: harnessLog } = harness({ retro: sink })
    // The harness log and our log are separate arrays; splice them via mcp log ordering below.
    const running = await manager.startWorkspace(testProfile())
    running.workspace.events.push({
      type: 'agent_started',
      agentId: 'a1',
      name: 'Marco',
      roleId: 'worker',
      providerId: 'claude',
      model: 'sonnet'
    })
    running.workspace.events.push({
      type: 'agent_done',
      agentId: 'a1',
      name: 'Marco',
      roleId: 'worker',
      summary: 'ok',
      status: 'success'
    })
    running.workspace.pendingRetroSummary = 'Sauberer Lauf.'

    await manager.stopWorkspace(running.workspace.workspaceId)

    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({
      workspaceId: running.workspace.workspaceId,
      workspaceName: 'Paradiso',
      profileId: 'profile-1',
      summary: 'Sauberer Lauf.'
    })
    expect(finalized[0]!.events.map((event) => event.type)).toEqual([
      'agent_started',
      'agent_done'
    ])
    // Finalize happens before the MCP registration (and its queue) is torn down.
    expect(log).toEqual(['finalize'])
    expect(harnessLog.indexOf('unregister')).toBeGreaterThan(-1)
  })

  it('exposes the record_retro port on the MCP context and stashes the summary', async () => {
    const { sink } = fakeRetroSink()
    const applied: unknown[] = []
    sink.recordLearnings = (profile, learnings) => {
      applied.push([profile.id, learnings])
      return { applied: learnings.length }
    }
    const { manager, mcp } = harness({ retro: sink })
    const running = await manager.startWorkspace(testProfile())

    const port = mcp.contexts[0]!.retro
    expect(port).toBeDefined()
    port!.recordSummary('Fazit.')
    const result = port!.recordLearnings([
      { role: 'worker', kind: 'strength', insight: 'stark bei UI' }
    ])
    expect(result.applied).toBe(1)
    expect(applied[0]).toEqual(['profile-1', [{ role: 'worker', kind: 'strength', insight: 'stark bei UI' }]])
    expect(running.workspace.pendingRetroSummary).toBe('Fazit.')
  })

  it('a finalize failure never blocks the stop', async () => {
    const { sink } = fakeRetroSink()
    sink.finalizeRun = () => {
      throw new Error('store on fire')
    }
    const { manager, mcp } = harness({ retro: sink })
    const running = await manager.startWorkspace(testProfile())

    await expect(manager.stopWorkspace(running.workspace.workspaceId)).resolves.toBe(true)
    expect(mcp.unregistered).toHaveLength(1)
  })

  it('registers no MCP retro port and no tap without a sink', async () => {
    const { manager, mcp } = harness()
    const running = await manager.startWorkspace(testProfile())
    expect(mcp.contexts[0]!.retro).toBeUndefined()
    await expect(manager.stopWorkspace(running.workspace.workspaceId)).resolves.toBe(true)
  })
})

describe('onChange — the push channel that replaced the panel poll', () => {
  it('fires on start, agent events, question mutations and stop, collapsing same-tick bursts', async () => {
    const { manager, mcp } = harness()
    let fired = 0
    const off = manager.onChange(() => {
      fired += 1
    })

    const running = await manager.startWorkspace(testProfile())
    await Promise.resolve()
    expect(fired).toBeGreaterThan(0)

    const beforeBurst = fired
    const identity = { agentId: 'a1', name: 'Caronte', roleId: 'worker' } as const
    running.workspace.events.push({ type: 'agent_progress', ...identity, note: 'one' })
    running.workspace.events.push({ type: 'agent_progress', ...identity, note: 'two' })
    await Promise.resolve()
    // Two pushes in one tick, one notification — the panel repaints once.
    expect(fired).toBe(beforeBurst + 1)

    // Question answered: no event exists for this, only the registry mutation —
    // exactly the case that kept a stale badge lit for up to 4 s under polling.
    const questions = mcp.lastQuestions!
    const created = questions.create('a1', 'which path?')
    await Promise.resolve()
    const afterCreate = fired
    questions.answer(created.questionId, 'left')
    await Promise.resolve()
    expect(fired).toBe(afterCreate + 1)

    const beforeStop = fired
    await manager.stopWorkspace(running.workspace.workspaceId)
    await Promise.resolve()
    expect(fired).toBeGreaterThan(beforeStop)

    off()
    const afterOff = fired
    running.workspace.events.push({ type: 'agent_progress', ...identity, note: 'ignored' })
    await Promise.resolve()
    expect(fired).toBe(afterOff)
  })

  it('fires when the first orchestrator CLI submit lands as goalText', async () => {
    const { manager } = harness()
    const running = await manager.startWorkspace(testProfile())
    let fired = 0
    const off = manager.onChange(() => {
      fired += 1
    })

    expect(running.workspace.goalText).toBeUndefined()
    expect(manager.noteOrchestratorGoal(running.orchestrator.agentId, 'Fix the panel\r')).toBe(true)
    await Promise.resolve()
    expect(fired).toBe(1)
    expect(running.workspace.goalText).toBe('Fix the panel')
    expect(running.workspace.orchestratorTaskText).toBe('Fix the panel')

    const after = fired
    expect(manager.noteOrchestratorGoal(running.orchestrator.agentId, 'later steering\r')).toBe(true)
    await Promise.resolve()
    expect(fired).toBe(after + 1)
    expect(running.workspace.goalText).toBe('Fix the panel')
    expect(running.workspace.orchestratorTaskText).toBe('later steering')

    off()
  })

  it('S4: a board mutation reaches the feed too — the card carries the plan now', async () => {
    const board = memoryTaskBoard()
    const { manager, mcp } = harness({ taskBoard: () => board })
    const running = await manager.startWorkspace(testProfile())
    let fired = 0
    const off = manager.onChange(() => {
      fired += 1
    })

    // What the task tools call after an accepted create/update. No second feed
    // exists on purpose: the board rides the assignment channel, and that one
    // is already bound to ev:workspaces.
    board.create({ subject: 'Fix the parser' })
    mcp.lastRuntime!.onTasksChanged!()
    await Promise.resolve()
    expect(fired).toBe(1)
    // And the plan is on the summary the panel renders from.
    expect(running.workspace.listTasks()).toMatchObject([{ taskId: 'task-1', ready: true }])

    off()
  })
})

describe('noteOrchestratorGoal — CLI capture without clobbering start-with-goal', () => {
  it('looks up the workspace by orchestrator.agentId, not a subagent', async () => {
    const { manager } = harness()
    const running = await manager.startWorkspace(testProfile())
    await running.workspace.startAgent({ role: 'worker', task: 'Do a thing.' })
    const sub = running.workspace.listAgents()[0]
    expect(sub).toBeDefined()

    expect(manager.noteOrchestratorGoal(sub!.agentId, 'not the goal\r')).toBe(false)
    expect(running.workspace.goalText).toBeUndefined()
    expect(manager.noteOrchestratorGoal('ghost', 'nope\r')).toBe(false)

    expect(manager.noteOrchestratorGoal(running.orchestrator.agentId, 'Fix the panel\r')).toBe(true)
    expect(running.workspace.goalText).toBe('Fix the panel')
    expect(running.workspace.orchestratorTaskText).toBe('Fix the panel')
  })

  it('does not overwrite a start-with-goal already on goalText', async () => {
    const { manager } = harness()
    const running = await manager.startWorkspace(testProfile(), { goal: 'Fix the login bug' })
    expect(running.workspace.goalText).toBe('Fix the login bug')
    expect(manager.noteOrchestratorGoal(running.orchestrator.agentId, 'later steering\r')).toBe(
      true
    )
    expect(running.workspace.goalText).toBe('Fix the login bug')
    expect(running.workspace.orchestratorTaskText).toBe('later steering')
  })

  it('does not overwrite a grok argv-delivered start-with-goal', async () => {
    const { manager } = harness()
    const running = await manager.startWorkspace(
      testProfile({ orchestrator: { providerId: 'grok' } }),
      { goal: 'Fix the login bug' }
    )
    expect(running.workspace.goalText).toBe('Fix the login bug')
    expect(manager.noteOrchestratorGoal(running.orchestrator.agentId, 'later steering\r')).toBe(
      true
    )
    expect(running.workspace.goalText).toBe('Fix the login bug')
    expect(running.workspace.orchestratorTaskText).toBe('later steering')
  })

  it('drops the assembler on stop so a reused run does not inherit', async () => {
    const { manager } = harness()
    const first = await manager.startWorkspace(testProfile())
    expect(manager.noteOrchestratorGoal(first.orchestrator.agentId, 'leftover partial')).toBe(false)
    await manager.stopWorkspace(first.workspace.workspaceId)

    const again = await manager.startWorkspace(testProfile())
    expect(again.workspace.goalText).toBeUndefined()
    expect(manager.noteOrchestratorGoal(again.orchestrator.agentId, 'new assignment\r')).toBe(true)
    expect(again.workspace.goalText).toBe('new assignment')
  })

  it('lets a re-started workspace capture a new goal after a committed one', async () => {
    const { manager } = harness()
    const first = await manager.startWorkspace(testProfile())
    expect(manager.noteOrchestratorGoal(first.orchestrator.agentId, 'first goal\r')).toBe(true)
    expect(first.workspace.goalText).toBe('first goal')
    await manager.stopWorkspace(first.workspace.workspaceId)

    const again = await manager.startWorkspace(testProfile())
    expect(again.workspace.goalText).toBeUndefined()
    expect(manager.noteOrchestratorGoal(again.orchestrator.agentId, 'second goal\r')).toBe(true)
    expect(again.workspace.goalText).toBe('second goal')
  })

  it('leaves start_agent latestTask as the delegated assignment, not the user goal', async () => {
    const { manager, mcp } = harness()
    const running = await manager.startWorkspace(testProfile())
    expect(manager.noteOrchestratorGoal(running.orchestrator.agentId, 'User goal\r')).toBe(true)
    mcp.lastRuntime!.latestTask = 'handed to a worker'
    expect(running.workspace.goalText).toBe('User goal')
    expect(running.workspace.orchestratorTaskText).toBe('User goal')
    expect(mcp.workspaceTask(running.workspace.workspaceId)).toBe('handed to a worker')
  })
})
