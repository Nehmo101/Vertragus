import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentArgv } from '@main/agents/spawn'
import { slugifyRef } from '@main/agents/worktree'
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ROLE_ID, roleColor } from '@shared/prompts/roles'
import { PTY_ONLY_IDLE_HINT_MS, Workspace, type WorkspaceDeps } from './Workspace'
import {
  FakeRegistry,
  FakeWindows,
  fakeSeed,
  fakeSpawn,
  sequentialIds,
  testProfile,
  testProviders,
  type RecordedSpawn
} from './testing'

interface Harness {
  workspace: Workspace
  registry: FakeRegistry
  windows: FakeWindows
  spawns: RecordedSpawn[]
  prompts: string[]
  seedOptions: Array<import('@main/agents/interactiveReady').SeedWithReadyOptions | undefined>
  now: { value: number }
}

function harness(
  overrides: {
    deps?: Partial<WorkspaceDeps>
    profile?: ReturnType<typeof testProfile>
    ptySystemPrompt?: boolean
  } = {}
): Harness {
  const registry = new FakeRegistry()
  const windows = new FakeWindows()
  const spawner = fakeSpawn({ ptySystemPrompt: overrides.ptySystemPrompt })
  const seeder = fakeSeed()
  const now = { value: 1_000_000 }

  const workspace = new Workspace(
    { profile: overrides.profile ?? testProfile(), name: 'Paradiso' },
    {
      registry,
      windows,
      configDir: '/config',
      providers: testProviders(),
      spawn: spawner.spawn as unknown as WorkspaceDeps['spawn'],
      seed: seeder.seed as unknown as WorkspaceDeps['seed'],
      now: () => now.value,
      newId: sequentialIds('a'),
      ...overrides.deps
    }
  )
  workspace.attachMcp({
    orchestratorUrl: 'http://127.0.0.1:1/mcp?ws=w&token=orch',
    subagentUrl: (agentId) => `http://127.0.0.1:1/mcp?ws=w&agent=${agentId}&token=sub`
  })

  return {
    workspace,
    registry,
    windows,
    spawns: spawner.calls,
    prompts: seeder.prompts,
    seedOptions: seeder.options,
    now
  }
}

describe('startAgent', () => {
  it('spawns a named subagent in the repo, registers it and opens its window', async () => {
    const { workspace, registry, windows, spawns } = harness()

    const started = await workspace.startAgent({ role: 'worker', task: 'Do the thing.' })

    expect(started.role).toBe('worker')
    expect(started.name).toMatch(/\S/)
    expect(started.worktreePath).toBeUndefined()

    const launch = spawns[0]!.input
    expect(launch.kind).toBe('subagent')
    expect(launch.cwd).toBe('/repo')
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
  it('creates one on request and runs the agent inside it', async () => {
    const createWorktree = vi.fn(async () => ({ path: '/repo/.vertragus/worktrees/a-1', branch: 'b' }))
    const { workspace, spawns } = harness({ deps: { createWorktree } })

    const started = await workspace.startAgent({ role: 'worker', task: 'x', worktree: true })

    expect(createWorktree).toHaveBeenCalledWith(
      '/repo',
      started.agentId,
      `vertragus/paradiso/${slugifyRef(started.name)}`,
      undefined
    )
    expect(spawns[0]!.input.cwd).toBe('/repo/.vertragus/worktrees/a-1')
    expect(started.worktreePath).toBe('/repo/.vertragus/worktrees/a-1')
    expect(workspace.listAgents()[0]!.worktreePath).toBe('/repo/.vertragus/worktrees/a-1')
  })

  it('does not leave a half-started agent behind when git fails', async () => {
    const createWorktree = vi.fn(async () => {
      throw new Error('git worktree add failed')
    })
    const { workspace } = harness({ deps: { createWorktree } })
    await expect(
      workspace.startAgent({ role: 'worker', task: 'x', worktree: true })
    ).rejects.toThrow(/git worktree add failed/)
    expect(workspace.listAgents()).toHaveLength(0)
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

  it('stays silent for the orchestrator, which is the reader of the queue', async () => {
    const { workspace, spawns } = harness()
    await workspace.startOrchestrator()
    spawns[0]!.pty.exit({ exitCode: 1 })
    expect(workspace.events.all()).toHaveLength(0)
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
    expect(launch.cwd).toBe('/repo')
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
      ready: { idleMs: 5, pollMs: 1, minChars: 1, timeoutMs: 500 },
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
