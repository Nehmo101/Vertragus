import { describe, expect, it, vi } from 'vitest'
import type { McpServerHandle, RegisteredWorkspace } from '@main/mcp/server'
import type { WorkspaceMcpContext } from '@main/mcp/types'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import { createWorkspaceManager, type WorkspaceManagerDeps } from './WorkspaceManager'
import type { WorkspaceDeps, WorkspaceWindows } from './Workspace'
import {
  FakeRegistry,
  fakeSeed,
  fakeSpawn,
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

  constructor(private readonly log: string[] = []) {}

  registerWorkspace(ctx: WorkspaceMcpContext): RegisteredWorkspace {
    this.contexts.push(ctx)
    this.log.push(`register:${ctx.workspaceName}`)
    const runtime = { ctx, questions: new PendingQuestions() }
    this.runtimes.set(ctx.workspaceId, runtime)
    this.lastQuestions = runtime.questions
    return {
      runtime,
      orchestratorUrl: `http://127.0.0.1:${this.port}/mcp?ws=${ctx.workspaceId}&token=${ctx.orchToken}`,
      subagentUrl: (agentId: string) =>
        `http://127.0.0.1:${this.port}/mcp?ws=${ctx.workspaceId}&agent=${agentId}&token=${ctx.subToken}`
    }
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
  workspaceTask(workspaceId: string): string | undefined {
    return this.runtimes.get(workspaceId)?.latestTask
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
    const { manager, spawns } = harness({ providers, roleTemplates, yoloMaster })

    await manager.startWorkspace(testProfile())
    await manager.startWorkspace(testProfile())

    expect(providers).toHaveBeenCalledTimes(2)
    expect(roleTemplates).toHaveBeenCalledTimes(2)
    expect(yoloMaster).toHaveBeenCalledTimes(2)
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
