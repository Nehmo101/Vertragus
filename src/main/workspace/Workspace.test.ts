import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRACKETED_PASTE_ON, PASTE_BEGIN, PASTE_END } from '@main/agents/interactiveReady'
import { buildAgentArgv } from '@main/agents/spawn'
import { slugifyRef, worktreePathFor } from '@main/agents/worktree'
import { EventQueue } from '@main/mcp/eventQueue'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import { buildReminderSuffix } from '@shared/prompts/contract'
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ROLE_ID, roleColor } from '@shared/prompts/roles'
import {
  ORCHESTRATOR_IDLE_MS,
  PTY_ONLY_IDLE_HINT_MS,
  snapshotCommitMessage,
  Workspace,
  type WorkspaceDeps
} from './Workspace'
import {
  FakeRegistry,
  FakeWindows,
  fakeSeed,
  fakeSpawn,
  fakeWorktrees,
  sequentialIds,
  testProfile,
  testProviders,
  type RecordedSpawn,
  type RecordedWorktree
} from './testing'

interface Harness {
  workspace: Workspace
  registry: FakeRegistry
  windows: FakeWindows
  spawns: RecordedSpawn[]
  worktrees: RecordedWorktree[]
  prompts: string[]
  seedOptions: Array<import('@main/agents/interactiveReady').SeedWithReadyOptions | undefined>
  now: { value: number }
  questions: PendingQuestions
}

function harness(
  overrides: {
    deps?: Partial<WorkspaceDeps>
    profile?: ReturnType<typeof testProfile>
    ptySystemPrompt?: boolean
    banner?: string
  } = {}
): Harness {
  const registry = new FakeRegistry()
  const windows = new FakeWindows()
  const spawner = fakeSpawn({
    ptySystemPrompt: overrides.ptySystemPrompt,
    ...(overrides.banner !== undefined ? { banner: overrides.banner } : {})
  })
  const seeder = fakeSeed()
  const worktrees = fakeWorktrees()
  const now = { value: 1_000_000 }
  const questions = new PendingQuestions(sequentialIds('q'), () => now.value)

  const workspace = new Workspace(
    { profile: overrides.profile ?? testProfile(), name: 'Paradiso' },
    {
      registry,
      windows,
      configDir: '/config',
      providers: testProviders(),
      spawn: spawner.spawn as unknown as WorkspaceDeps['spawn'],
      createWorktree: worktrees.createWorktree as unknown as WorkspaceDeps['createWorktree'],
      seed: seeder.seed as unknown as WorkspaceDeps['seed'],
      now: () => now.value,
      newId: sequentialIds('a'),
      ...overrides.deps
    }
  )
  workspace.attachMcp({
    orchestratorUrl: 'http://127.0.0.1:1/mcp?ws=w&token=orch',
    subagentUrl: (agentId) => `http://127.0.0.1:1/mcp?ws=w&agent=${agentId}&token=sub`,
    leadUrl: (agentId) => `http://127.0.0.1:1/mcp?ws=w&lead=${agentId}&token=lead`
  })
  workspace.attachQuestions(questions)

  return {
    workspace,
    registry,
    windows,
    spawns: spawner.calls,
    worktrees: worktrees.calls,
    prompts: seeder.prompts,
    seedOptions: seeder.options,
    now,
    questions
  }
}

function cannedGit(): NonNullable<NonNullable<WorkspaceDeps['worktreeDeps']>['git']> {
  return async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { stdout: 'vertragus/paradiso/caronte\n', stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' }
    }
    if (args[0] === 'status') return { stdout: ' M src/a.ts\n', stderr: '' }
    if (args[0] === 'diff' && args.includes('--stat')) {
      return { stdout: ' src/a.ts | 2 +-\n', stderr: '' }
    }
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.ts\n', stderr: '' }
    if (args[0] === 'log') return { stdout: 'aaaaaaaa fixture\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

async function waitForDone(workspace: Workspace, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(workspace.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(count)
  })
}

describe('startAgent', () => {
  it('spawns a named subagent in its own worktree, registers it and opens its window', async () => {
    const { workspace, registry, windows, spawns } = harness()

    const started = await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })

    expect(started.role).toBe('worker')
    expect(started.name).toMatch(/\S/)
    expect(started.worktreePath).toBe(worktreePathFor('/repo', started.agentId))

    const launch = spawns[0]!.input
    expect(launch.kind).toBe('subagent')
    expect(launch.cwd).toBe(started.worktreePath)
    expect(launch.mcpUrl).toContain(`agent=${started.agentId}`)
    // Slot blueprint: role → provider + model.
    expect(launch.provider.id).toBe('claude')
    expect(launch.model).toBe('sonnet')

    const meta = registry.registered[0]!.meta
    expect(meta).toMatchObject({
      agentId: started.agentId,
      name: started.name,
      role: 'worker',
      roleColor: roleColor('worker', 0),
      provider: 'claude',
      model: 'sonnet'
    })
    expect(windows.opened).toEqual([
      {
        agentId: started.agentId,
        title: started.name,
        roleColor: roleColor('worker', 0),
        // The window layer turns this into bounds (zone, else auto-tiling).
        placement: { roleId: 'worker' }
      }
    ])
  })

  it('hands the profile zone layout to the window layer', async () => {
    const zones = {
      zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
    }
    const { workspace, windows } = harness({ profile: testProfile({ zones }) })
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(windows.opened).toEqual([
      {
        agentId: started.agentId,
        title: started.name,
        roleColor: roleColor('worker', 0),
        placement: { roleId: 'worker', zones }
      }
    ])
  })

  it('types the assignment in — exactly as the MCP layer composed it', async () => {
    const { workspace, prompts } = harness()
    await workspace.startAgent({ role: 'worker', task: 'Task text\n\n--- Contract ---' })
    // The host adds nothing: contract composition belongs to start_agent.
    expect(prompts).toEqual(['Task text\n\n--- Contract ---'])
  })

  it('delivers the role prompt through the provider, not through the task', async () => {
    const { workspace, spawns } = harness()
    await workspace.startAgent({ role: 'reviewer', task: 'Review it.' })
    expect(spawns[0]!.input.systemPrompt).toContain('You are a Reviewer')
  })

  it('prepends the role prompt to the seed when the provider has no prompt flag', async () => {
    const { workspace, prompts } = harness({ ptySystemPrompt: true })
    await workspace.startAgent({ role: 'worker', task: 'Task text' })
    expect(prompts[0]).toContain('You are a Worker')
    expect(prompts[0]!.endsWith('Task text')).toBe(true)
  })

  it('lets the orchestrator override the slot model', async () => {
    const { workspace, spawns } = harness()
    await workspace.startAgent({ role: 'worker', task: 'x', model: 'haiku' })
    expect(spawns[0]!.input.model).toBe('haiku')
  })

  it('runs subagents in yolo unless the master switch is off', async () => {
    const on = harness()
    await on.workspace.startAgent({ role: 'worker', task: 'x' })
    expect(on.spawns[0]!.input.yolo).toBe(true)

    const off = harness({ deps: { yoloMaster: false } })
    await off.workspace.startAgent({ role: 'worker', task: 'x' })
    expect(off.spawns[0]!.input.yolo).toBe(false)
  })

  it('D4: only the ask-user tier takes the yolo flags away from subagents', async () => {
    // The tier wins over the boolean — a stale yoloMaster cannot override it.
    const askUser = harness({ deps: { agentPolicy: 'ask-user', yoloMaster: true } })
    await askUser.workspace.startAgent({ role: 'worker', task: 'x' })
    expect(askUser.spawns[0]!.input.yolo).toBe(false)

    // ask-orchestrator keeps CLI autonomy; the gate lives in the contract.
    const askOrch = harness({ deps: { agentPolicy: 'ask-orchestrator', yoloMaster: false } })
    await askOrch.workspace.startAgent({ role: 'worker', task: 'x' })
    expect(askOrch.spawns[0]!.input.yolo).toBe(true)

    const yolo = harness({ deps: { agentPolicy: 'yolo' } })
    await yolo.workspace.startAgent({ role: 'worker', task: 'x' })
    expect(yolo.spawns[0]!.input.yolo).toBe(true)
  })

  it('D4: the mcp context carries the effective tier for the contract layer', () => {
    expect(harness({ deps: { agentPolicy: 'ask-orchestrator' } }).workspace.mcpContext().agentPolicy).toBe(
      'ask-orchestrator'
    )
    expect(harness().workspace.mcpContext().agentPolicy).toBe('yolo')
    expect(harness({ deps: { yoloMaster: false } }).workspace.mcpContext().agentPolicy).toBe(
      'ask-user'
    )
  })

  it('refuses a role the profile has no slot for', async () => {
    const { workspace, registry, windows } = harness()
    await expect(workspace.startAgent({ role: 'tester', task: 'x' })).rejects.toThrow(
      /No slot configured for role "tester"/
    )
    expect(registry.registered).toHaveLength(0)
    expect(windows.opened).toHaveLength(0)
  })

  it('refuses to start before the workspace is registered with the MCP server', async () => {
    const unregistered = new Workspace(
      { profile: testProfile(), name: 'Inferno' },
      {
        registry: new FakeRegistry(),
        windows: new FakeWindows(),
        configDir: '/config',
        providers: testProviders()
      }
    )
    await expect(unregistered.startAgent({ role: 'worker', task: 'x' })).rejects.toThrow(
      /not registered with the MCP server/
    )
  })

  it('releases name, window and process when the seed never lands', async () => {
    const { workspace, windows, registry, spawns } = harness({
      deps: { seed: (async () => false) as unknown as WorkspaceDeps['seed'] }
    })

    await expect(workspace.startAgent({ role: 'worker', task: 'x' })).rejects.toThrow(
      /never became ready/
    )
    expect(workspace.listAgents()).toHaveLength(0)
    expect(spawns[0]!.pty.killed).toBe(1)
    expect(registry.removed).toHaveLength(1)
    expect(windows.closed).toHaveLength(1)
  })

  it('gives every live agent its own Commedia name', async () => {
    const { workspace } = harness()
    const first = await workspace.startAgent({ role: 'worker', task: 'x' })
    const second = await workspace.startAgent({ role: 'reviewer', task: 'y' })
    expect(first.name).not.toBe(second.name)
  })
})

describe('worktrees', () => {
  it('creates one for every subagent, unasked, and runs the agent inside it', async () => {
    const { workspace, spawns, worktrees } = harness()

    const started = await workspace.startAgent({ role: 'worker', task: 'x' })

    expect(worktrees).toEqual([
      {
        repoPath: '/repo',
        agentId: started.agentId,
        branchName: `vertragus/paradiso/${slugifyRef(started.name)}`
      }
    ])
    expect(spawns[0]!.input.cwd).toBe(worktreePathFor('/repo', started.agentId))
    expect(started.worktreePath).toBe(worktreePathFor('/repo', started.agentId))
    expect(workspace.listAgents()[0]!.worktreePath).toBe(started.worktreePath)
  })

  it('reports the agent’s branch so the orchestrator can chain work onto it', async () => {
    const { workspace } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(started.branch).toBe(`vertragus/paradiso/${slugifyRef(started.name)}`)
    expect(workspace.listAgents()[0]!.branch).toBe(started.branch)
  })

  it('forks the worktree branch from baseBranch when the orchestrator passes one', async () => {
    const { workspace, worktrees } = harness()
    const worker = await workspace.startAgent({ role: 'worker', task: 'build it' })
    await workspace.startAgent({
      role: 'reviewer',
      task: 'review it',
      baseBranch: worker.branch
    })

    expect(worktrees[0]!.startPoint).toBeUndefined()
    expect(worktrees[1]!.startPoint).toBe(worker.branch)
  })

  it('gives each agent its own worktree — never a shared checkout', async () => {
    const { workspace, spawns } = harness()
    const first = await workspace.startAgent({ role: 'worker', task: 'x' })
    const second = await workspace.startAgent({ role: 'reviewer', task: 'y' })

    expect(first.worktreePath).not.toBe(second.worktreePath)
    expect(spawns.map((spawn) => spawn.input.cwd)).toEqual([
      first.worktreePath,
      second.worktreePath
    ])
  })

  it('isolates the orchestrator too', async () => {
    const { workspace, spawns, worktrees } = harness()
    const orchestrator = await workspace.startOrchestrator()

    expect(orchestrator.worktreePath).toBe(worktreePathFor('/repo', orchestrator.agentId))
    expect(spawns[0]!.input.cwd).toBe(orchestrator.worktreePath)
    expect(worktrees[0]!.branchName).toBe(`vertragus/paradiso/${slugifyRef(orchestrator.name)}`)
    expect(workspace.orchestrator?.worktreePath).toBe(orchestrator.worktreePath)
  })

  it('reports live worktrees — the paths the cleanup view must not offer', async () => {
    const { workspace, spawns } = harness()
    const orchestrator = await workspace.startOrchestrator()
    const worker = await workspace.startAgent({ role: 'worker', task: 'x' })
    const reviewer = await workspace.startAgent({ role: 'reviewer', task: 'y' })

    expect(workspace.activeWorktreePaths().sort()).toEqual(
      [orchestrator.worktreePath, worker.worktreePath, reviewer.worktreePath].sort()
    )

    // A dead or stopped agent's worktree becomes cleanup material.
    spawns[1]!.pty.exit({ exitCode: 0 })
    await workspace.stopAgent(reviewer.agentId)
    expect(workspace.activeWorktreePaths()).toEqual([orchestrator.worktreePath])
  })

  it('does not leave a half-started agent behind when git fails', async () => {
    const createWorktree = vi.fn(async () => {
      throw new Error('git worktree add failed')
    })
    const { workspace } = harness({ deps: { createWorktree } })
    await expect(workspace.startAgent({ role: 'worker', task: 'x' })).rejects.toThrow(
      /git worktree add failed/
    )
    expect(workspace.listAgents()).toHaveLength(0)
  })

  it('does not leave a half-started orchestrator behind when git fails', async () => {
    const createWorktree = vi.fn(async () => {
      throw new Error('git worktree add failed')
    })
    const { workspace } = harness({ deps: { createWorktree } })
    await expect(workspace.startOrchestrator()).rejects.toThrow(/git worktree add failed/)
    expect(workspace.orchestrator).toBeUndefined()
  })
})

describe('listAgents', () => {
  it('reports starting → working → exited and the output age', async () => {
    const { workspace, spawns, now } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(workspace.listAgents()[0]!.status).toBe('working')

    now.value += 30_000
    expect(workspace.listAgents()[0]!.lastOutputAgeSec).toBe(30)

    spawns[0]!.pty.emit('still here')
    expect(workspace.listAgents()[0]!.lastOutputAgeSec).toBe(0)

    spawns[0]!.pty.exit({ exitCode: 0 })
    const row = workspace.listAgents()[0]!
    expect(row.status).toBe('exited')
    expect(row.agentId).toBe(started.agentId)
  })

  it('never lists the orchestrator — it must not eat one of its own slots', async () => {
    const { workspace } = harness()
    await workspace.startOrchestrator()
    expect(workspace.listAgents()).toHaveLength(0)
    await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(workspace.listAgents()).toHaveLength(1)
  })

  it('leaves pendingQuestion to the MCP layer', async () => {
    // summarizeAgents() enriches these rows; the host cannot see questions.
    const { workspace } = harness()
    await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(workspace.listAgents()[0]!.pendingQuestion).toBeUndefined()
    expect(workspace.listAgents()[0]!.reporting).toBe('mcp')
    expect(workspace.reportingMode('worker')).toBe('mcp')
  })
})

describe('beginAgent — synchronous reservation', () => {
  const oneWorkerSlot = () =>
    testProfile({
      slots: [{ id: 'slot-worker', roleId: 'worker', providerId: 'claude', maxCount: 1 }],
      maxSubagents: 3
    })

  it('claims the slot before anything is awaited — two rapid starts cannot both pass a cap of one', async () => {
    const { workspace } = harness({ profile: oneWorkerSlot() })
    const first = workspace.beginAgent({ role: 'worker', task: 'a' })
    // No await in between — this is exactly the TOCTOU the reservation closes.
    expect(() => workspace.beginAgent({ role: 'worker', task: 'b' })).toThrow(/at its limit/)
    await first.ready
  })

  it('lists a reserved agent as starting, so the MCP limit check counts it', async () => {
    const { workspace } = harness({ profile: oneWorkerSlot() })
    const begun = workspace.beginAgent({ role: 'worker', task: 'a' })
    const listed = workspace.listAgents()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ agentId: begun.agentId, status: 'starting' })
    // The reservation already knows worktree and branch — by convention, not
    // by asking git.
    expect(begun.worktreePath).toBe(worktreePathFor('/repo', begun.agentId))
    await begun.ready
    expect(workspace.listAgents()[0]).toMatchObject({ status: 'working' })
  })

  it('releases the reservation when the start fails, freeing the slot', async () => {
    const { workspace } = harness({
      profile: oneWorkerSlot(),
      deps: {
        spawn: (() => {
          throw new Error('pty refused')
        }) as unknown as WorkspaceDeps['spawn']
      }
    })
    const begun = workspace.beginAgent({ role: 'worker', task: 'a' })
    await expect(begun.ready).rejects.toThrow('pty refused')
    expect(workspace.listAgents()).toHaveLength(0)
    // The slot is free again — the retry passes the reservation stage (and
    // fails later in the same broken spawn, which is this harness's nature).
    const retry = workspace.beginAgent({ role: 'worker', task: 'b' })
    await expect(retry.ready).rejects.toThrow('pty refused')
  })

  it('refuses messages to an agent that has not accepted its task yet', async () => {
    const { workspace } = harness({ profile: oneWorkerSlot() })
    const begun = workspace.beginAgent({ role: 'worker', task: 'a' })
    await expect(workspace.sendToAgent(begun.agentId, 'too early')).rejects.toThrow(
      /still starting/
    )
    await begun.ready
    await expect(workspace.sendToAgent(begun.agentId, 'now fine')).resolves.toBeUndefined()
  })

  it('overflows to the next slot of the role once the first is full', async () => {
    const profile = testProfile({
      slots: [
        { id: 'slot-a', roleId: 'worker', providerId: 'claude', model: 'sonnet', maxCount: 1 },
        { id: 'slot-b', roleId: 'worker', providerId: 'claude', model: 'haiku', maxCount: 1 }
      ],
      maxSubagents: 4
    })
    const { workspace, spawns } = harness({ profile })

    await workspace.startAgent({ role: 'worker', task: 'first' })
    await workspace.startAgent({ role: 'worker', task: 'second' })

    // Not both on slot-a's model: the second agent belongs to the overflow slot.
    expect(spawns.map((spawn) => spawn.input.model)).toEqual(['sonnet', 'haiku'])
    expect(() => workspace.beginAgent({ role: 'worker', task: 'third' })).toThrow(/at its limit/)
  })

  it('frees a slot when its agent is stopped', async () => {
    const { workspace } = harness({ profile: oneWorkerSlot() })
    const first = await workspace.startAgent({ role: 'worker', task: 'a' })
    await workspace.stopAgent(first.agentId)
    await expect(workspace.startAgent({ role: 'worker', task: 'b' })).resolves.toBeTruthy()
  })
})

describe('agent_exited — the one event the host owns', () => {
  it('is unconfirmed when the process dies without reporting', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })

    spawns[0]!.pty.exit({ exitCode: 137 })

    expect(workspace.events.all()).toEqual([
      expect.objectContaining({
        type: 'agent_exited',
        agentId: started.agentId,
        name: started.name,
        roleId: 'worker',
        exitCode: 137,
        confirmed: false
      })
    ])
  })

  it('is confirmed when the agent reported done for its current assignment', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })

    // What report_done does — the MCP layer owns this event.
    workspace.events.push({
      type: 'agent_done',
      agentId: started.agentId,
      name: started.name,
      roleId: 'worker',
      summary: 'done',
      status: 'success'
    })
    spawns[0]!.pty.exit({ exitCode: 0 })

    const exited = workspace.events.all().find((event) => event.type === 'agent_exited')
    expect(exited).toMatchObject({ confirmed: true })
  })

  it('becomes unconfirmed again after a follow-up task', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    workspace.events.push({
      type: 'agent_done',
      agentId: started.agentId,
      name: started.name,
      roleId: 'worker',
      summary: 'first task done',
      status: 'success'
    })

    await workspace.sendToAgent(started.agentId, 'Now do the second thing.')
    spawns[0]!.pty.exit({ exitCode: 1 })

    const exited = workspace.events.all().find((event) => event.type === 'agent_exited')
    expect(exited).toMatchObject({ confirmed: false })
  })

  it('stays silent for an agent we killed ourselves — stop_agent owns that event', async () => {
    const { workspace } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    await workspace.stopAgent(started.agentId)
    expect(workspace.events.all()).toHaveLength(0)
  })

  it('pushes orchestrator_exited when the orchestrator dies unasked', async () => {
    const { workspace, spawns } = harness()
    const orchestrator = await workspace.startOrchestrator()
    expect(workspace.orchestratorAlive).toBe(true)

    spawns[0]!.pty.exit({ exitCode: 1 })

    // Not agent_exited — the orchestrator is no subagent, and its death flips
    // the workspace to inactive instead of freeing a slot.
    expect(workspace.events.all()).toEqual([
      expect.objectContaining({
        type: 'orchestrator_exited',
        agentId: orchestrator.agentId,
        name: orchestrator.name,
        exitCode: 1
      })
    ])
    expect(workspace.orchestratorAlive).toBe(false)
    // The record stays — the window keeps showing the death output and
    // stopWorkspace still closes it.
    expect(workspace.orchestrator?.agentId).toBe(orchestrator.agentId)
  })

  it('stays silent when the orchestrator is stopped by stopAll — that is an asked death', async () => {
    const { workspace } = harness()
    await workspace.startOrchestrator()
    await workspace.stopAll()
    expect(workspace.events.all()).toHaveLength(0)
    expect(workspace.orchestratorAlive).toBe(false)
  })
})

describe('close with awaitExitMs — the quit path', () => {
  it('resolves only once the killed processes have actually exited', async () => {
    const { workspace, spawns } = harness()
    await workspace.startAgent({ role: 'worker', task: 'x' })
    const pty = spawns[0]!.pty
    // A real kill is fire-and-forget (taskkill / SIGTERM): the process dies
    // later. The fake normally dies synchronously — detach that so the close
    // has something to wait for.
    pty.kill = () => {
      pty.killed += 1
    }

    let closed = false
    const closing = workspace.close({ awaitExitMs: 5_000 }).then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(pty.killed).toBe(1)
    expect(closed).toBe(false)

    pty.exit({ exitCode: 0, signal: 15 })
    await closing
    expect(closed).toBe(true)
  })

  it('gives up after the deadline instead of wedging the quit', async () => {
    vi.useFakeTimers()
    try {
      const { workspace, spawns } = harness()
      await workspace.startAgent({ role: 'worker', task: 'x' })
      const pty = spawns[0]!.pty
      pty.kill = () => {
        pty.killed += 1
      }

      let closed = false
      const closing = workspace.close({ awaitExitMs: 1_000 }).then(() => {
        closed = true
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(closed).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      await closing
      expect(closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sendToAgent', () => {
  it('types the message into a running agent', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    await workspace.sendToAgent(started.agentId, 'follow-up')
    expect(spawns[0]!.pty.typed).toContain('follow-up')
  })

  it('refuses a dead agent instead of writing into the void', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    spawns[0]!.pty.exit({ exitCode: 1 })
    await expect(workspace.sendToAgent(started.agentId, 'hello')).rejects.toThrow(
      /no longer running/
    )
  })

  it('refuses an unknown agent', async () => {
    const { workspace } = harness()
    await expect(workspace.sendToAgent('nope', 'hello')).rejects.toThrow(/Unknown agent/)
  })
})

describe('stopAgent', () => {
  it('kills the process, closes the window and frees the name', async () => {
    const { workspace, registry, windows, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })

    await expect(workspace.stopAgent(started.agentId)).resolves.toBe(true)

    expect(spawns[0]!.pty.killed).toBe(1)
    expect(registry.removed).toEqual([started.agentId])
    expect(windows.closed).toEqual([started.agentId])
    expect(workspace.listAgents()[0]!.status).toBe('stopped')
  })

  it('reopens a still-listed agent’s window after the user closed it', async () => {
    const { workspace, windows } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(windows.opened.map((entry) => entry.agentId)).toEqual([started.agentId])

    expect(workspace.showAgentWindow(started.agentId)).toBe(true)
    expect(windows.opened.map((entry) => entry.agentId)).toEqual([started.agentId, started.agentId])
    expect(workspace.showAgentWindow('ghost')).toBe(false)
  })

  it('keeps the scrollback readable after the stop', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    spawns[0]!.pty.emit('\u001b[32mchanged three files\u001b[0m\n')
    await workspace.stopAgent(started.agentId)
    await expect(workspace.readOutput(started.agentId, 5)).resolves.toContain('changed three files')
  })

  it('reports false when there was nothing left to kill', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    spawns[0]!.pty.exit({ exitCode: 0 })
    await expect(workspace.stopAgent(started.agentId)).resolves.toBe(false)
    await expect(workspace.stopAgent('unknown')).resolves.toBe(false)
  })
})

describe('readOutput', () => {
  it('returns an ANSI-free tail of the requested length', async () => {
    const { workspace, spawns } = harness()
    const started = await workspace.startAgent({ role: 'worker', task: 'x' })
    spawns[0]!.pty.emit('\u001b[31mone\u001b[0m\ntwo\nthree\n')

    const output = await workspace.readOutput(started.agentId, 2)
    expect(output).toBe('two\nthree')
    expect(output).not.toContain('\u001b')
  })
})

describe('startOrchestrator', () => {
  it('starts a bronze, never-yolo orchestrator with its system prompt', async () => {
    const { workspace, registry, windows, spawns } = harness()

    const orchestrator = await workspace.startOrchestrator()

    const launch = spawns[0]!.input
    expect(launch.kind).toBe('orchestrator')
    expect(launch.yolo).toBe(false)
    // Its own worktree, like every agent — never the shared checkout.
    expect(launch.cwd).toBe(worktreePathFor('/repo', orchestrator.agentId))
    expect(launch.model).toBe('opus')
    expect(launch.mcpUrl).toContain('token=orch')
    expect(launch.systemPrompt).toContain('Paradiso')
    expect(launch.systemPrompt).toContain('/repo')
    // Roles and caps come from the profile's slots.
    expect(launch.systemPrompt).toContain('worker (max 2 at a time)')
    expect(launch.systemPrompt).toContain('reviewer (no limit)')
    expect(launch.systemPrompt).toContain('at most 3 agents')

    expect(registry.registered[0]!.meta.roleColor).toBe(ORCHESTRATOR_COLOR)
    expect(windows.opened[0]).toMatchObject({
      agentId: orchestrator.agentId,
      roleColor: ORCHESTRATOR_COLOR,
      // The orchestrator is placed by its own role key, not by a slot role.
      placement: { roleId: ORCHESTRATOR_ROLE_ID }
    })
    expect(workspace.orchestrator).toMatchObject({ name: orchestrator.name })
  })

  it('types the prompt in when the provider has no system-prompt flag', async () => {
    const { workspace, prompts } = harness({ ptySystemPrompt: true })
    await workspace.startOrchestrator()
    expect(prompts[0]).toContain('You are the orchestrator of the Vertragus workspace')
  })

  it('refuses a second orchestrator', async () => {
    const { workspace } = harness()
    await workspace.startOrchestrator()
    await expect(workspace.startOrchestrator()).rejects.toThrow(/already has an orchestrator/)
  })

  it('refuses an unknown or disabled provider', async () => {
    const unknown = harness({ profile: testProfile({ orchestrator: { providerId: 'nope' } }) })
    await expect(unknown.workspace.startOrchestrator()).rejects.toThrow(/Unknown provider "nope"/)

    const disabled = harness({
      deps: { providers: testProviders().map((p) => ({ ...p, enabled: false })) }
    })
    await expect(disabled.workspace.startOrchestrator()).rejects.toThrow(/is disabled/)
  })
})

describe('stopAll / close', () => {
  it('stops subagents first and the orchestrator last', async () => {
    const { workspace, windows } = harness()
    const orchestrator = await workspace.startOrchestrator()
    const worker = await workspace.startAgent({ role: 'worker', task: 'x' })
    const reviewer = await workspace.startAgent({ role: 'reviewer', task: 'y' })

    await workspace.close()

    expect(windows.closed).toEqual([worker.agentId, reviewer.agentId, orchestrator.agentId])
  })

  it('leaves the EventQueue to the MCP layer, which owns unregistration', async () => {
    const { workspace } = harness()
    await workspace.startOrchestrator()
    await workspace.close()
    expect(workspace.events.isClosed).toBe(false)
  })

  it('refuses to start anything after close', async () => {
    const { workspace } = harness()
    await workspace.close()
    await expect(workspace.startAgent({ role: 'worker', task: 'x' })).rejects.toThrow(/is closed/)
  })
})

describe('mcpContext', () => {
  it('reports the limits the profile declares — enforcement is the MCP layer', async () => {
    const { workspace } = harness()
    const ctx = workspace.mcpContext()

    expect(ctx.workspaceName).toBe('Paradiso')
    expect(ctx.repoPath).toBe('/repo')
    expect(ctx.roles).toEqual(['worker', 'reviewer'])
    expect(ctx.limits.maxTotal).toBe(3)
    expect(ctx.limits.perRole.get('worker')).toBe(2)
    // A slot without maxCount means "no per-role cap"; only maxSubagents binds.
    expect(ctx.limits.perRole.get('reviewer')).toBeUndefined()
    expect(ctx.host).toBe(workspace)
    expect(ctx.events).toBe(workspace.events)
    expect(ctx.orchToken).not.toBe(ctx.subToken)
  })
})

describe('the real seed handshake', () => {
  const realSeed = {
    seed: undefined,
    seedOptions: {
      ready: { idleMs: 5, pollMs: 1, minChars: 1, timeoutMs: 500, keyboardMs: 50 },
      maxAttempts: 1,
      submitDelayMs: 5,
      submitRetries: 1
    }
  }

  it('types the task and then presses Enter as a separate write', async () => {
    const { workspace, spawns } = harness({ deps: realSeed })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })

    expect(started.agentId).toBeTruthy()
    // Two writes, in this order. Glued together as "Do the thing.\r" the
    // carriage return is swallowed as a newline of the paste and the task
    // never leaves the composer — the first real run died exactly there.
    expect(spawns[0]!.pty.written).toEqual(['Do the thing.', '\r'])
  })

  it('leaves the task in the input field when the profile says so', async () => {
    const { workspace, spawns } = harness({
      profile: testProfile({ autoSubmitTasks: false }),
      deps: realSeed
    })
    await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })

    expect(spawns[0]!.pty.written).toEqual(['Do the thing.'])
  })

  it('sends a multi-line assignment as a real paste to a TUI that asked for one', async () => {
    // The Cursor bug that outlived the timing fix: raw, the block below is a
    // keystroke stream, and the PTY is free to split it so that `\n` arrives
    // alone — decoded as Enter, submitting "Do this." on its own and leaving
    // the rest in the composer. Framed, none of its bytes can be read as keys.
    const task = ['Do this.', 'Then that.'].join('\n')
    const { workspace, spawns } = harness({
      banner: `cursor-agent ready${BRACKETED_PASTE_ON}`,
      deps: realSeed
    })
    await workspace.startAgent({ role: 'worker', task })

    expect(spawns[0]!.pty.written).toEqual([`${PASTE_BEGIN}${task}${PASTE_END}`, '\r'])
  })

  it('says so in the agent’s own scrollback when the Enter was never accepted', async () => {
    // A FakePty echoes and then goes quiet — exactly the swallowed-Enter shape.
    // Reporting that as a clean delivery is what made a silent Cursor agent
    // indistinguishable from a working one.
    const { workspace, spawns } = harness({ deps: realSeed })
    await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })

    expect(spawns[0]!.pty.snapshot()).toContain('never reacted to the submitting Enter')
    // A warning, not a failure: the agent keeps its window and its process.
    expect(workspace.listAgents()).toHaveLength(1)
  })
})

describe('autoSubmitTasks', () => {
  it('presses Enter for assignments by default', async () => {
    const { workspace, seedOptions } = harness()
    await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })
    expect(seedOptions.at(-1)?.autoSubmit).toBe(true)
  })

  it('forwards the provider seed tuning into the handshake options', async () => {
    const { workspace, seedOptions } = harness({
      profile: testProfile({
        slots: [
          { id: 'slot-worker', roleId: 'worker', providerId: 'cursor' },
          { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
        ]
      })
    })
    await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })
    expect(seedOptions.at(-1)?.submitDelayMs).toBe(750)
    // cursor-agent redraws even after swallowing Enter, so its preset opts out
    // of buffer-based acceptance — the field must survive the trip end-to-end.
    expect(seedOptions.at(-1)?.submitAcceptance).toBe('sustained-activity')
    expect(seedOptions.at(-1)?.bracketedPaste).toBe('auto')
  })

  it('is honoured for a follow-up sent to a running agent', async () => {
    const { workspace, spawns, seedOptions } = harness({
      profile: testProfile({ autoSubmitTasks: false })
    })
    const started = await workspace.startAgent({ role: 'worker', task: 'First.' })
    await workspace.sendToAgent(started.agentId, 'And now this.')

    // Both the initial assignment and the follow-up obey the switch: a user who
    // wants to redact what an agent is told means every message, not the first.
    expect(seedOptions.map((options) => options?.autoSubmit)).toEqual([false, false])
    expect(spawns[0]!.pty.written).toEqual(['First.', 'And now this.'])
  })

  it('never withholds the orchestrator system prompt — that is plumbing, not a task', async () => {
    const { workspace, seedOptions } = harness({
      profile: testProfile({ autoSubmitTasks: false }),
      // A provider without a system-prompt flag types its prompt in instead.
      ptySystemPrompt: true
    })
    await workspace.startOrchestrator()
    expect(seedOptions.at(-1)?.autoSubmit).toBe(true)
  })
})

describe('assignGoal — H2, the goal rides the assignment handshake', () => {
  it('types the goal into the orchestrator PTY and records it as goalText', async () => {
    const { workspace, spawns, prompts, seedOptions } = harness()
    await workspace.startOrchestrator()
    expect(workspace.goalText).toBeUndefined()

    await workspace.assignGoal('Fix the login bug')

    expect(prompts.at(-1)).toBe('Fix the login bug')
    expect(spawns[0]!.pty.written).toContain('Fix the login bug')
    expect(workspace.goalText).toBe('Fix the login bug')
    // The goal comes straight from the user — always submitted, even when the
    // profile withholds Enter for assignments the orchestrator hands out.
    expect(seedOptions.at(-1)?.autoSubmit).toBe(true)
  })

  it('always submits, autoSubmitTasks off included', async () => {
    const { workspace, seedOptions } = harness({
      profile: testProfile({ autoSubmitTasks: false })
    })
    await workspace.startOrchestrator()
    await workspace.assignGoal('Goal.')
    expect(seedOptions.at(-1)?.autoSubmit).toBe(true)
  })

  it('refuses without an orchestrator and leaves goalText unset', async () => {
    const { workspace } = harness()
    await expect(workspace.assignGoal('Goal.')).rejects.toThrow(/no orchestrator/)
    expect(workspace.goalText).toBeUndefined()
  })

  it('does not record a goal the CLI never accepted', async () => {
    const seedOk = { value: true }
    const { workspace } = harness({
      deps: {
        seed: (async (write: (text: string) => void, _s: unknown, prompt: string) => {
          if (seedOk.value) write(prompt)
          return seedOk.value
        }) as unknown as WorkspaceDeps['seed']
      }
    })
    await workspace.startOrchestrator()
    seedOk.value = false
    await expect(workspace.assignGoal('Goal.')).rejects.toThrow(/did not accept the goal/)
    expect(workspace.goalText).toBeUndefined()
  })
})

/**
 * Ollama runs `mcp: none` on purpose — no verified attach surface, so declaring
 * one would kill the launch. The price is an agent that cannot report anything,
 * and the orchestrator has no way to tell "thinking" from "dead". These tests
 * pin the one thing the host CAN say about such a worker.
 *
 * Cursor used to live here too; it now attaches via `cursor-project` and leaves
 * the idle-hint regime (asserted below).
 */
describe('PTY-only silence hint', () => {
  /** A profile whose worker slot runs on Ollama (mcp: none). */
  const ptyOnlyProfile = (): ReturnType<typeof testProfile> =>
    testProfile({
      slots: [
        { id: 'slot-worker', roleId: 'worker', providerId: 'ollama' },
        { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
      ]
    })

  /** Move the workspace clock and the timer wheel together. */
  function advance(h: Harness, ms: number): void {
    h.now.value += ms
    vi.advanceTimersByTime(ms)
  }

  function hints(h: Harness): string[] {
    return h.workspace.events
      .all()
      .filter((event) => event.type === 'agent_progress')
      .map((event) => (event as { note: string }).note)
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tells the orchestrator once, after two minutes of silence', async () => {
    const h = harness({ profile: ptyOnlyProfile() })
    const started = await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })

    advance(h, PTY_ONLY_IDLE_HINT_MS - 1)
    expect(hints(h)).toEqual([])

    advance(h, 1)
    expect(hints(h)).toHaveLength(1)
    expect(hints(h)[0]).toContain(started.name)
    expect(hints(h)[0]).toContain('PTY-only')
    expect(hints(h)[0]).toContain('120 s ohne Ausgabe')
    expect(hints(h)[0]).toContain('read_output')

    // Not a drip: the same silence must not keep firing.
    advance(h, PTY_ONLY_IDLE_HINT_MS * 3)
    expect(hints(h)).toHaveLength(1)
  })

  it('resets on output and reports the NEXT silence phase', async () => {
    const h = harness({ profile: ptyOnlyProfile() })
    await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })
    const pty = h.spawns[0]!.pty

    advance(h, PTY_ONLY_IDLE_HINT_MS - 5_000)
    pty.emit('still here\r\n')
    advance(h, PTY_ONLY_IDLE_HINT_MS - 5_000)
    // The clock passed 120 s since start, but not since the last output.
    expect(hints(h)).toEqual([])

    advance(h, 5_000)
    expect(hints(h)).toHaveLength(1)

    // A second silence phase after new output earns a second hint.
    pty.emit('back\r\n')
    advance(h, PTY_ONLY_IDLE_HINT_MS)
    expect(hints(h)).toHaveLength(2)
  })

  it('says nothing about an agent that can report for itself', async () => {
    const h = harness()
    await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })
    advance(h, PTY_ONLY_IDLE_HINT_MS * 2)
    expect(hints(h)).toEqual([])
  })

  it('says nothing about an agent that already ended', async () => {
    const h = harness({ profile: ptyOnlyProfile() })
    await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })
    h.spawns[0]!.pty.exit({ exitCode: 0 })

    advance(h, PTY_ONLY_IDLE_HINT_MS * 2)
    // agent_exited is the event for a dead process; a silence hint on top of it
    // would send the orchestrator looking for a live agent that is gone.
    expect(hints(h)).toEqual([])
  })

  it('says nothing about a stopped agent', async () => {
    const h = harness({ profile: ptyOnlyProfile() })
    const started = await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })
    await h.workspace.stopAgent(started.agentId)

    advance(h, PTY_ONLY_IDLE_HINT_MS * 2)
    expect(hints(h)).toEqual([])
  })

  it('never nags about the orchestrator — it is the reader, not the subject', async () => {
    const h = harness({
      profile: testProfile({ orchestrator: { providerId: 'ollama' } }),
      ptySystemPrompt: true
    })
    await h.workspace.startOrchestrator()

    advance(h, PTY_ONLY_IDLE_HINT_MS * 2)
    expect(hints(h)).toEqual([])
  })
})

describe('Cursor MCP attach leaves the idle-hint regime', () => {
  it('does not emit a PTY-only silence hint for a cursor worker', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({
        profile: testProfile({
          slots: [
            { id: 'slot-worker', roleId: 'worker', providerId: 'cursor' },
            { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
          ]
        }),
        ptySystemPrompt: true
      })
      await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })

      h.now.value += PTY_ONLY_IDLE_HINT_MS * 2
      vi.advanceTimersByTime(PTY_ONLY_IDLE_HINT_MS * 2)

      const notes = h.workspace.events
        .all()
        .filter((event) => event.type === 'agent_progress')
        .map((event) => (event as { note: string }).note)
      expect(notes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawns cursor with --trust and --approve-mcps in argv order', async () => {
    const h = harness({
      profile: testProfile({
        slots: [
          { id: 'slot-worker', roleId: 'worker', providerId: 'cursor', model: 'gpt-5.6' },
          { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
        ]
      }),
      ptySystemPrompt: true
    })
    await h.workspace.startAgent({ role: 'worker', task: 'Do it.' })

    // fakeSpawn records the launch input but not the real argv; compose it here
    // against a real temp cwd so the project-file writer can run.
    const cwd = mkdtempSync(join(tmpdir(), 'vertragus-ws-cursor-'))
    try {
      const input = h.spawns[0]!.input
      expect(input.provider.mcp).toEqual({ kind: 'cursor-project' })
      expect(input.provider.args).toEqual(['--trust'])
      const { argv } = buildAgentArgv({
        ...input,
        cwd,
        yolo: true
      })
      expect(argv).toEqual(['--trust', '--model', 'gpt-5.6', '--yolo', '--approve-mcps'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('sentinel reporting (mcp: none / Ollama)', () => {
  const ollamaProfile = (): ReturnType<typeof testProfile> =>
    testProfile({
      slots: [
        { id: 'slot-worker', roleId: 'worker', providerId: 'ollama' },
        { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
      ]
    })

  it('exposes sentinel reportingMode for ollama slots', async () => {
    const { workspace } = harness({ profile: ollamaProfile(), ptySystemPrompt: true })
    expect(workspace.reportingMode('worker')).toBe('sentinel')
    expect(workspace.reportingMode('reviewer')).toBe('mcp')
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    expect(workspace.listAgents().find((row) => row.agentId === started.agentId)?.reporting).toBe(
      'sentinel'
    )
  })

  it('pushes agent_done from a DONE sentinel and confirms the exit', async () => {
    const { workspace, spawns } = harness({ profile: ollamaProfile(), ptySystemPrompt: true })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    const line = `@@VERTRAGUS:DONE@@${JSON.stringify({ summary: 'shipped', status: 'success' })}@@END@@`
    spawns[0]!.pty.emit(line)
    await waitForDone(workspace)

    expect(workspace.events.all()).toEqual([
      expect.objectContaining({
        type: 'agent_done',
        agentId: started.agentId,
        name: started.name,
        roleId: 'worker',
        summary: 'shipped',
        status: 'success'
      })
    ])

    spawns[0]!.pty.exit({ exitCode: 0 })
    const exited = workspace.events.all().find((event) => event.type === 'agent_exited')
    expect(exited).toMatchObject({ confirmed: true })
  })

  it('pushes agent_progress for PROGRESS and unparseable lines', async () => {
    const { workspace, spawns } = harness({ profile: ollamaProfile(), ptySystemPrompt: true })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    spawns[0]!.pty.emit(`@@VERTRAGUS:PROGRESS@@${JSON.stringify({ note: 'mid' })}@@END@@`)
    spawns[0]!.pty.emit('@@VERTRAGUS:DONE@@{bad}@@END@@')

    const notes = workspace.events
      .all()
      .filter((event) => event.type === 'agent_progress')
      .map((event) => (event as { note: string }).note)
    expect(notes).toEqual(['mid', 'unparseable sentinel line (invalid_json)'])
    expect(workspace.events.all().some((event) => event.type === 'agent_done')).toBe(false)
    expect(started.agentId).toBeTruthy()
  })

  it('does not parse the echo of orchestrator text that quotes a sentinel pair', async () => {
    const { workspace, spawns } = harness({ profile: ollamaProfile(), ptySystemPrompt: true })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    const before = workspace.events.all().filter((event) => event.type === 'agent_done').length

    // FakePty echoes writes → onData during seed. Without suppress this would
    // become a fake agent_done before reset runs.
    await workspace.sendToAgent(
      started.agentId,
      'When finished print exactly: @@VERTRAGUS:DONE@@{"summary":"done"}@@END@@'
    )

    expect(workspace.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(
      before
    )
    // Agent-authored DONE after the seed still fires.
    spawns[0]!.pty.emit(`@@VERTRAGUS:DONE@@${JSON.stringify({ summary: 'real' })}@@END@@`)
    await waitForDone(workspace, before + 1)
    expect(workspace.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(
      before + 1
    )
  })

  it('round-trips a sentinel ASK through agent_question and PTY delivery', async () => {
    const { workspace, spawns, questions, prompts } = harness({
      profile: ollamaProfile(),
      ptySystemPrompt: true
    })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    prompts.length = 0

    spawns[0]!.pty.emit(`@@VERTRAGUS:ASK@@${JSON.stringify({ question: 'which file?' })}@@END@@`)

    const asked = workspace.events.all().find((event) => event.type === 'agent_question')
    expect(asked).toMatchObject({
      type: 'agent_question',
      agentId: started.agentId,
      name: started.name,
      roleId: 'worker',
      question: 'which file?'
    })
    const questionId = (asked as { questionId: string }).questionId
    expect(questions.openForAgent(started.agentId)?.questionId).toBe(questionId)

    // Further ASKs while one is open are ignored (one-open-question rule).
    spawns[0]!.pty.emit(`@@VERTRAGUS:ASK@@${JSON.stringify({ question: 'second?' })}@@END@@`)
    expect(workspace.events.all().filter((event) => event.type === 'agent_question')).toHaveLength(1)

    const closed = questions.answer(questionId, 'src/foo.ts')
    await closed!.deliverAnswer!('src/foo.ts')

    expect(questions.openForAgent(started.agentId)).toBeUndefined()
    const reminder = buildReminderSuffix('sentinel')
    expect(prompts.at(-1)).toBe(`src/foo.ts\n\n${reminder}`)
    // Exactly one reminder — deliverAnswer owns it, not a second append.
    expect(prompts.at(-1)!.split(reminder)).toHaveLength(2)
  })

  it('cancels an open sentinel ASK when the agent exits', async () => {
    const { workspace, spawns, questions } = harness({
      profile: ollamaProfile(),
      ptySystemPrompt: true
    })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    spawns[0]!.pty.emit(`@@VERTRAGUS:ASK@@${JSON.stringify({ question: 'blocked?' })}@@END@@`)
    expect(questions.openForAgent(started.agentId)).toBeTruthy()

    spawns[0]!.pty.exit({ exitCode: 1 })
    expect(questions.openForAgent(started.agentId)).toBeUndefined()
    expect(questions.openCount).toBe(0)
  })

  it('cancels an open ASK on stopAgent even though onExit is unsubscribed first', async () => {
    const { workspace, spawns, questions } = harness({
      profile: ollamaProfile(),
      ptySystemPrompt: true
    })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    spawns[0]!.pty.emit(`@@VERTRAGUS:ASK@@${JSON.stringify({ question: 'still?' })}@@END@@`)
    expect(questions.openForAgent(started.agentId)).toBeTruthy()

    await workspace.stopAgent(started.agentId)
    expect(questions.openForAgent(started.agentId)).toBeUndefined()
    expect(questions.openCount).toBe(0)
  })

  it('allows the same DONE after sendToAgent resets the parser', async () => {
    const { workspace, spawns } = harness({ profile: ollamaProfile(), ptySystemPrompt: true })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    const line = `@@VERTRAGUS:DONE@@${JSON.stringify({ summary: 'same' })}@@END@@`
    spawns[0]!.pty.emit(line)
    await waitForDone(workspace, 1)
    expect(workspace.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(1)

    await workspace.sendToAgent(started.agentId, 'follow-up')
    spawns[0]!.pty.emit(line)
    await waitForDone(workspace, 2)
    expect(workspace.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(2)
  })

  it('attaches worktree facts to a sentinel agent_done when git answers', async () => {
    const { workspace, spawns } = harness({
      profile: ollamaProfile(),
      ptySystemPrompt: true,
      deps: { worktreeDeps: { git: cannedGit() } }
    })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    spawns[0]!.pty.emit(
      `@@VERTRAGUS:DONE@@${JSON.stringify({ summary: 'shipped', status: 'success' })}@@END@@`
    )
    await waitForDone(workspace)
    expect(workspace.events.all()[0]).toMatchObject({
      type: 'agent_done',
      uncommitted: true,
      changedFiles: ['src/a.ts'],
      branch: 'vertragus/paradiso/caronte',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    })
    expect(started.agentId).toBeTruthy()
  })

  it('confirms the exit even when the worktree snapshot has not landed yet', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const git = async () => {
      await gate
      return { stdout: 'main\n', stderr: '' }
    }
    const { workspace, spawns } = harness({
      profile: ollamaProfile(),
      ptySystemPrompt: true,
      deps: { worktreeDeps: { git } }
    })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    spawns[0]!.pty.emit(
      `@@VERTRAGUS:DONE@@${JSON.stringify({ summary: 'shipped', status: 'success' })}@@END@@`
    )
    spawns[0]!.pty.exit({ exitCode: 0 })
    const exited = workspace.events.all().find((event) => event.type === 'agent_exited')
    expect(exited).toMatchObject({ confirmed: true, type: 'agent_exited' })
    expect(workspace.events.all().some((event) => event.type === 'agent_done')).toBe(false)

    release()
    await waitForDone(workspace)
    expect(started.agentId).toBeTruthy()
  })
})

describe('inspectAgent', () => {
  it('refuses an agent that is still starting', async () => {
    const { workspace } = harness({
      profile: testProfile({
        slots: [{ id: 'slot-worker', roleId: 'worker', providerId: 'claude', maxCount: 1 }]
      })
    })
    const begun = workspace.beginAgent({ role: 'worker', task: 'a' })
    await expect(workspace.inspectAgent(begun.agentId, { view: 'status' })).rejects.toThrow(
      /still starting/
    )
    await begun.ready
  })

  it('refuses an unknown agent', async () => {
    const { workspace } = harness()
    await expect(workspace.inspectAgent('ghost', { view: 'status' })).rejects.toThrow(/Unknown agent/)
  })

  it('reads status, diff and log from the agent worktree', async () => {
    const { workspace } = harness({ deps: { worktreeDeps: { git: cannedGit() } } })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })

    const status = await workspace.inspectAgent(started.agentId, { view: 'status' })
    expect(status.uncommitted).toBe(true)
    expect(status.changedFiles).toEqual(['src/a.ts'])
    expect(status.body).toMatch(/uncommitted: yes/)

    const diff = await workspace.inspectAgent(started.agentId, { view: 'diff' })
    expect(diff.body).toMatch(/diff --git/)

    const log = await workspace.inspectAgent(started.agentId, { view: 'log', lines: 5 })
    expect(log.body).toMatch(/fixture/)
  })

  it('still inspects a stopped agent — the worktree survives stop_agent', async () => {
    const { workspace } = harness({ deps: { worktreeDeps: { git: cannedGit() } } })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    await workspace.stopAgent(started.agentId)
    const status = await workspace.inspectAgent(started.agentId, { view: 'status' })
    expect(status.branch).toBe('vertragus/paradiso/caronte')
  })
})

describe('snapshotDone — C3 snapshot commit at done-time', () => {
  /** A stateful git fake: dirty until a commit lands, then clean with a new HEAD. */
  function statefulGit(options: { dirty?: boolean; commitError?: string } = {}): {
    calls: string[][]
    git: NonNullable<NonNullable<WorkspaceDeps['worktreeDeps']>['git']>
  } {
    const state = { dirty: options.dirty ?? true }
    const calls: string[][] = []
    return {
      calls,
      git: async (args) => {
        calls.push(args)
        if (args.includes('commit')) {
          if (options.commitError) throw new Error(options.commitError)
          state.dirty = false
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'add') return { stdout: '', stderr: '' }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { stdout: 'vertragus/paradiso/caronte\n', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return { stdout: state.dirty ? 'a'.repeat(40) + '\n' : 'b'.repeat(40) + '\n', stderr: '' }
        }
        if (args[0] === 'status') return { stdout: state.dirty ? ' M src/a.ts\n' : '', stderr: '' }
        if (args[0] === 'diff') return { stdout: state.dirty ? ' src/a.ts | 2 +-\n' : '', stderr: '' }
        return { stdout: '', stderr: '' }
      }
    }
  }

  it('commits a dirty worktree and keeps the change set on the facts', async () => {
    const fake = statefulGit()
    const { workspace } = harness({ deps: { worktreeDeps: { git: fake.git } } })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })

    const facts = await workspace.snapshotDone(started.agentId, 'Parser fixed.\nDetails below.')

    const commit = fake.calls.find((args) => args.includes('commit'))!
    expect(commit).toBeDefined()
    expect(commit[commit.indexOf('-m') + 1]).toBe(
      `vertragus: ${started.name} / worker — Parser fixed.`
    )
    // No push, no --force — ever.
    expect(fake.calls.some((args) => args[0] === 'push' || args.includes('--force'))).toBe(false)
    expect(facts.uncommitted).toBe(false)
    expect(facts.headSha).toBe('b'.repeat(40))
    // The done's own change set survives the commit on the event facts.
    expect(facts.changedFiles).toEqual(['src/a.ts'])
    expect(facts.diffStat).toContain('src/a.ts')
  })

  it('does not commit a clean worktree', async () => {
    const fake = statefulGit({ dirty: false })
    const { workspace } = harness({ deps: { worktreeDeps: { git: fake.git } } })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })

    const facts = await workspace.snapshotDone(started.agentId, 'Nothing to do.')
    expect(fake.calls.some((args) => args.includes('commit') || args[0] === 'add')).toBe(false)
    expect(facts.uncommitted).toBe(false)
  })

  it('falls back to the dirty snapshot when the commit fails — done facts stay truthful', async () => {
    const fake = statefulGit({ commitError: 'index.lock held' })
    const { workspace } = harness({ deps: { worktreeDeps: { git: fake.git } } })
    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })

    const facts = await workspace.snapshotDone(started.agentId, 'Tried.')
    expect(facts.uncommitted).toBe(true)
    expect(facts.changedFiles).toEqual(['src/a.ts'])
  })

  it('a sentinel DONE runs the snapshot commit and still emits agent_done on failure', async () => {
    const fake = statefulGit()
    const { workspace, spawns } = harness({
      profile: testProfile({
        slots: [
          { id: 'slot-worker', roleId: 'worker', providerId: 'ollama' },
          { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
        ]
      }),
      ptySystemPrompt: true,
      deps: { worktreeDeps: { git: fake.git } }
    })
    await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    spawns[0]!.pty.emit(`@@VERTRAGUS:DONE@@${JSON.stringify({ summary: 'shipped' })}@@END@@`)
    await waitForDone(workspace)

    expect(fake.calls.some((args) => args.includes('commit'))).toBe(true)
    expect(workspace.events.all().at(-1)).toMatchObject({
      type: 'agent_done',
      summary: 'shipped',
      uncommitted: false,
      changedFiles: ['src/a.ts']
    })
  })
})

describe('snapshotCommitMessage', () => {
  it('uses the first non-empty summary line and caps it', () => {
    expect(snapshotCommitMessage('Caronte', 'worker', '\n  Fixed it.  \nMore.')).toBe(
      'vertragus: Caronte / worker — Fixed it.'
    )
    expect(snapshotCommitMessage('Caronte', 'worker', 'x'.repeat(400))).toHaveLength(
      'vertragus: Caronte / worker — '.length + 120
    )
    expect(snapshotCommitMessage('Caronte', 'worker', '   ')).toBe('vertragus: Caronte / worker')
  })
})

describe('orchestrator idle watchdog — C5', () => {
  function advance(h: Harness, ms: number): void {
    h.now.value += ms
    vi.advanceTimersByTime(ms)
  }

  function idleEvents(h: Harness): Array<{ idleSec: number }> {
    return h.workspace.events
      .all()
      .filter((event) => event.type === 'orchestrator_idle') as Array<{ idleSec: number }>
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports one orchestrator_idle after the window and writes one reminder line', async () => {
    const h = harness()
    await h.workspace.startOrchestrator()
    expect(h.workspace.orchestratorIdle).toBe(false)

    advance(h, ORCHESTRATOR_IDLE_MS - 1)
    expect(idleEvents(h)).toEqual([])

    advance(h, 1)
    expect(idleEvents(h)).toHaveLength(1)
    expect(idleEvents(h)[0]!.idleSec).toBe(Math.round(ORCHESTRATOR_IDLE_MS / 1_000))
    expect(h.workspace.orchestratorIdle).toBe(true)
    // Display-only reminder into the orchestrator terminal — never typed input.
    expect(h.spawns[0]!.pty.snapshot()).toContain('the loop looks idle')
    expect(h.spawns[0]!.pty.written.some((entry) => entry.includes('idle'))).toBe(false)

    // One event per silence phase, not a drip.
    advance(h, ORCHESTRATOR_IDLE_MS * 3)
    expect(idleEvents(h)).toHaveLength(1)
  })

  it('no false positives while the loop long-polls — every tool call resets the clock', async () => {
    const h = harness()
    await h.workspace.startOrchestrator()

    // A live await_events loop touches at least every ~55 s (call start + end).
    for (let i = 0; i < 10; i += 1) {
      advance(h, 55_000)
      h.workspace.noteOrchestratorActivity()
    }
    expect(idleEvents(h)).toEqual([])
    expect(h.workspace.orchestratorIdle).toBe(false)
  })

  it('a tool call ends the reported phase; the NEXT silence earns its own event', async () => {
    const h = harness()
    await h.workspace.startOrchestrator()

    advance(h, ORCHESTRATOR_IDLE_MS)
    expect(idleEvents(h)).toHaveLength(1)
    expect(h.workspace.orchestratorIdle).toBe(true)

    h.workspace.noteOrchestratorActivity()
    expect(h.workspace.orchestratorIdle).toBe(false)

    advance(h, ORCHESTRATOR_IDLE_MS)
    expect(idleEvents(h)).toHaveLength(2)
  })

  it('stays quiet after the orchestrator exited — idle and exited are distinct', async () => {
    const h = harness()
    await h.workspace.startOrchestrator()
    h.spawns[0]!.pty.exit({ exitCode: 1 })

    advance(h, ORCHESTRATOR_IDLE_MS * 2)
    expect(idleEvents(h)).toEqual([])
    expect(h.workspace.orchestratorIdle).toBe(false)
    expect(
      h.workspace.events.all().filter((event) => event.type === 'orchestrator_exited')
    ).toHaveLength(1)
  })
})

describe('postUserMessage — D2', () => {
  it('shows the text in the orchestrator terminal (display only) and pushes user_message', async () => {
    const { workspace, spawns } = harness()
    await workspace.startOrchestrator()

    workspace.postUserMessage('Focus on the parser first.')

    // Visible in the scrollback, but never typed into the CLI's stdin — a
    // typed line would start a second turn beside the MCP loop.
    expect(spawns[0]!.pty.snapshot()).toContain('Focus on the parser first.')
    expect(spawns[0]!.pty.written).toEqual([])
    expect(workspace.events.all().at(-1)).toMatchObject({
      type: 'user_message',
      text: 'Focus on the parser first.'
    })
  })

  it('wakes a parked await_events-style waiter immediately', async () => {
    const { workspace } = harness()
    await workspace.startOrchestrator()
    const cursor = workspace.events.cursor
    const parked = workspace.events.wait(cursor, 5_000)

    workspace.postUserMessage('steer')

    const events = await parked
    expect(events.map((event) => event.type)).toEqual(['user_message'])
  })

  it('refuses without a running orchestrator', async () => {
    const { workspace } = harness()
    expect(() => workspace.postUserMessage('x')).toThrow(/no running orchestrator/)
  })
})

describe('slot/provider choice at start_agent — Track 4', () => {
  /** A worker role with two slots on different providers. */
  const twoProviderProfile = (): ReturnType<typeof testProfile> =>
    testProfile({
      slots: [
        { id: 'slot-claude', roleId: 'worker', providerId: 'claude', model: 'sonnet', maxCount: 2 },
        { id: 'slot-codex', roleId: 'worker', providerId: 'codex', maxCount: 1 },
        { id: 'slot-reviewer', roleId: 'reviewer', providerId: 'claude' }
      ]
    })

  it('providerId picks the matching slot even though the first slot has room', async () => {
    const { workspace, spawns } = harness({ profile: twoProviderProfile() })
    const started = await workspace.startAgent({
      role: 'worker',
      task: 'x',
      providerId: 'codex'
    })
    expect(started.providerId).toBe('codex')
    expect(spawns[0]!.input.provider.id).toBe('codex')
  })

  it('slotId picks exactly that slot; a provider mismatch on top is an error', async () => {
    const { workspace } = harness({ profile: twoProviderProfile() })
    const started = await workspace.startAgent({ role: 'worker', task: 'x', slotId: 'slot-codex' })
    expect(started.providerId).toBe('codex')

    await expect(
      workspace.startAgent({ role: 'worker', task: 'x', slotId: 'slot-claude', providerId: 'codex' })
    ).rejects.toThrow(/runs provider "claude"/)
  })

  it('unknown slotId / unconfigured providerId are clear errors, never silent fallbacks', async () => {
    const { workspace } = harness({ profile: twoProviderProfile() })
    await expect(
      workspace.startAgent({ role: 'worker', task: 'x', slotId: 'ghost' })
    ).rejects.toThrow(/Unknown slotId "ghost".*slot-claude, slot-codex/)
    await expect(
      workspace.startAgent({ role: 'worker', task: 'x', providerId: 'ollama' })
    ).rejects.toThrow(/No slot of role "worker" runs provider "ollama"/)
    expect(workspace.listAgents()).toEqual([])
  })

  it('an explicitly chosen full slot refuses instead of overflowing — caps stay race-free', async () => {
    const { workspace } = harness({ profile: twoProviderProfile() })
    await workspace.startAgent({ role: 'worker', task: 'x', providerId: 'codex' })

    // The codex slot (maxCount 1) is taken; the claude slot has room, but an
    // explicit choice must not land there.
    await expect(
      workspace.startAgent({ role: 'worker', task: 'x', providerId: 'codex' })
    ).rejects.toThrow(/codex.*at its limit/)
    await expect(
      workspace.startAgent({ role: 'worker', task: 'x', slotId: 'slot-codex' })
    ).rejects.toThrow(/at its limit/)

    // Reservations count: a begun-but-unfinished start blocks the slot too.
    const begun = workspace.beginAgent({ role: 'worker', task: 'x', providerId: 'claude' })
    expect(() =>
      workspace.beginAgent({ role: 'worker', task: 'x', slotId: 'slot-claude' })
    ).not.toThrow() // second claude seat (maxCount 2)
    expect(() =>
      workspace.beginAgent({ role: 'worker', task: 'x', providerId: 'claude' })
    ).toThrow(/at its limit/)
    await begun.ready
  })

  it('without a choice the old "first slot with room" behaviour stands', async () => {
    const { workspace, spawns } = harness({ profile: twoProviderProfile() })
    await workspace.startAgent({ role: 'worker', task: 'x' })
    expect(spawns[0]!.input.provider.id).toBe('claude')
  })

  it('renders each role’s slots into the orchestrator prompt', () => {
    const { workspace } = harness({ profile: twoProviderProfile() })
    const roles = workspace.rolesWithLimits()
    expect(roles.find((role) => role.id === 'worker')?.slots).toEqual([
      { id: 'slot-claude', providerId: 'claude', model: 'sonnet' },
      { id: 'slot-codex', providerId: 'codex' }
    ])
  })
})

describe('beginLead — F', () => {
  it('spawns a lead: orchestrator provider, lead prompt, no yolo, lead URL, darker bronze', async () => {
    const { workspace, spawns, windows, prompts } = harness()
    await workspace.startOrchestrator()

    const lead = await workspace.startLead({
      area: 'payments',
      task: 'Own the payments rework.',
      maxSubagents: 2
    })

    expect(lead.role).toBe('lead')
    const launch = spawns[1]!.input
    expect(launch.kind).toBe('lead')
    // The profile's orchestrator blueprint, not a slot.
    expect(launch.provider.id).toBe('claude')
    expect(launch.model).toBe('opus')
    expect(launch.yolo).toBe(false)
    expect(launch.mcpUrl).toContain(`lead=${lead.agentId}`)
    expect(launch.systemPrompt).toContain('LEAD orchestrator')
    expect(launch.systemPrompt).toContain('payments')
    expect(launch.systemPrompt).toContain('budget is 2 agents')
    // Darker bronze, and the task seeded through the normal handshake.
    expect(windows.opened.at(-1)).toMatchObject({ agentId: lead.agentId })
    expect(prompts.at(-1)).toBe('Own the payments rework.')
    // Listed like a subagent, flagged as lead.
    const row = workspace.listAgents().find((agent) => agent.agentId === lead.agentId)
    expect(row?.kind).toBe('lead')
    expect(row?.status).toBe('working')
  })

  it('model override wins over the profile orchestrator model', async () => {
    const { workspace, spawns } = harness()
    await workspace.startLead({ area: 'x', task: 't', model: 'sonnet' })
    expect(spawns[0]!.input.model).toBe('sonnet')
  })

  it('a lead occupies no profile slot — worker capacity stays untouched', async () => {
    const { workspace } = harness()
    await workspace.startLead({ area: 'x', task: 't' })
    // Both worker seats (maxCount 2) are still free.
    await workspace.startAgent({ role: 'worker', task: 't' })
    await workspace.startAgent({ role: 'worker', task: 't' })
  })
})

describe('event router — F', () => {
  it('routes host events about a routed agent into the queue the router names', async () => {
    const { workspace, spawns } = harness()
    const leadQueue = new EventQueue()
    const routed = new Set<string>()
    workspace.attachEventRouter((agentId) =>
      routed.has(agentId) ? leadQueue : workspace.events
    )

    const started = await workspace.startAgent({ role: 'worker', task: 'Do it.' })
    routed.add(started.agentId)
    spawns[0]!.pty.exit({ exitCode: 1 })

    expect(
      leadQueue.all().filter((event) => event.type === 'agent_exited' && event.agentId === started.agentId)
    ).toHaveLength(1)
    expect(workspace.events.all().filter((event) => event.type === 'agent_exited')).toEqual([])
  })
})

describe('budget — E4 wall clock', () => {
  it('sums agent-seconds (orchestrator excluded) and flags exhaustion', async () => {
    const { workspace, now, spawns } = harness({
      profile: testProfile({ maxRuntimeMin: 1 })
    })
    await workspace.startOrchestrator()
    expect(workspace.budget()).toMatchObject({ usedSec: 0, limitSec: 60, exhausted: false })

    await workspace.startAgent({ role: 'worker', task: 't' })
    now.value += 30_000
    expect(workspace.budget()).toMatchObject({ usedSec: 30, exhausted: false })

    // A second agent doubles the burn rate.
    await workspace.startAgent({ role: 'worker', task: 't' })
    now.value += 20_000
    expect(workspace.budget()).toMatchObject({ usedSec: 70, exhausted: true })

    // A stopped agent stops burning.
    spawns[1]!.pty.exit({ exitCode: 0 })
    const frozen = workspace.budget().usedSec
    now.value += 60_000
    expect(workspace.budget().usedSec).toBe(frozen + 60)
  })

  it('no maxRuntimeMin → unbounded, never exhausted', async () => {
    const { workspace, now } = harness()
    await workspace.startAgent({ role: 'worker', task: 't' })
    now.value += 10_000_000
    expect(workspace.budget()).toMatchObject({ exhausted: false })
    expect(workspace.budget().limitSec).toBeUndefined()
  })
})

describe('promoteAgentBranch — E1 user click', () => {
  function gitWithMainState(options: { mainDirty: boolean }): {
    calls: Array<{ args: string[]; cwd: string }>
    git: NonNullable<NonNullable<WorkspaceDeps['worktreeDeps']>['git']>
  } {
    const calls: Array<{ args: string[]; cwd: string }> = []
    return {
      calls,
      git: async (args, cwd) => {
        calls.push({ args, cwd })
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { stdout: 'main\n', stderr: '' }
        }
        if (args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) + '\n', stderr: '' }
        if (args[0] === 'status') {
          return { stdout: cwd === '/repo' && options.mainDirty ? ' M src/x.ts\n' : '', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
    }
  }

  it('merges the agent branch into the MAIN checkout when it is clean', async () => {
    const fake = gitWithMainState({ mainDirty: false })
    const { workspace } = harness({ deps: { worktreeDeps: { git: fake.git } } })
    const started = await workspace.startAgent({ role: 'worker', task: 't' })

    const outcome = await workspace.promoteAgentBranch(started.agentId)
    expect(outcome.ok).toBe(true)
    const merge = fake.calls.find((call) => call.args.includes('merge'))!
    expect(merge.cwd).toBe('/repo')
    expect(merge.args).toContain(started.branch)
  })

  it('refuses a dirty main checkout — no push, no silent overwrite', async () => {
    const fake = gitWithMainState({ mainDirty: true })
    const { workspace } = harness({ deps: { worktreeDeps: { git: fake.git } } })
    const started = await workspace.startAgent({ role: 'worker', task: 't' })

    await expect(workspace.promoteAgentBranch(started.agentId)).rejects.toThrow(
      /uncommitted changes/
    )
    expect(fake.calls.some((call) => call.args.includes('merge'))).toBe(false)
  })
})

describe('orchestrator briefing — E2', () => {
  it('feeds the last commits and stored repo notes into the orchestrator prompt', async () => {
    const { workspace, spawns } = harness({
      deps: {
        worktreeDeps: { git: cannedGit() },
        retro: {
          recordLearnings: () => ({ applied: 0 }),
          knowledge: () => [],
          repoNotes: () => ['tests need pnpm run ci'],
          recordRepoNotes: () => ({ applied: 0 })
        }
      }
    })
    await workspace.startOrchestrator()

    const prompt = spawns[0]!.input.systemPrompt!
    expect(prompt).toContain('Repository briefing')
    expect(prompt).toContain('last commits')
    expect(prompt).toContain('aaaaaaaa fixture')
    expect(prompt).toContain('tests need pnpm run ci')
  })

  it('a repo without docs, notes or history still boots — no briefing block', async () => {
    const { workspace, spawns } = harness()
    await workspace.startOrchestrator()
    expect(spawns[0]!.input.systemPrompt).not.toContain('Repository briefing')
  })
})
