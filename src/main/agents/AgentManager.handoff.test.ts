import { beforeEach, describe, expect, it, vi } from 'vitest'

type ExitHandler = (event: { exitCode: number; signal?: number }) => void

const mocks = vi.hoisted(() => ({
  ptySpawn: vi.fn(),
  seed: vi.fn().mockResolvedValue(true),
  closePaneWindows: vi.fn(),
  execFile: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => process.env['TEMP'] ?? '.' }
}))
vi.mock('@lydell/node-pty', () => ({ spawn: mocks.ptySpawn }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('@main/windows', () => ({ closePaneWindows: mocks.closePaneWindows }))
vi.mock('@main/config/store', () => ({
  getProfile: () => undefined,
  getSetting: () => undefined,
  listMcpServers: () => []
}))
vi.mock('@main/agents/worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
  currentBranch: vi.fn().mockResolvedValue('orca/test'),
  rollbackWorktree: vi.fn().mockResolvedValue(true)
}))
vi.mock('@main/agents/resolveCommand', () => ({
  resolveLaunch: vi.fn(async (command: string, args: string[]) => ({ file: command, args }))
}))
vi.mock('@main/agents/interactiveReady', () => ({
  seedWithReadyHandshake: mocks.seed
}))
vi.mock('@main/agents/providerCapacity', () => ({
  providerCapacity: {
    tryAcquire: vi.fn(),
    release: vi.fn()
  }
}))

import { AgentManager } from './AgentManager'

interface FakePty {
  pid: number
  emitExit(event: { exitCode: number; signal?: number }): void
  write: ReturnType<typeof vi.fn>
}

function promptChallenge(): { handoffId: string; receiptToken: string } {
  const prompt = String(mocks.seed.mock.calls.at(-1)?.[2] ?? '')
  const handoffId = prompt.match(/handoffId=([0-9a-f-]{36})/)?.[1]
  const receiptToken = prompt.match(/receiptToken=([a-f0-9]{64})/)?.[1]
  if (!handoffId || !receiptToken) throw new Error('Handoff challenge missing from seed prompt.')
  return { handoffId, receiptToken }
}

async function spawnSource(manager: AgentManager, kind: 'orchestrator' | 'sub' = 'orchestrator') {
  return manager.spawn({
    provider: 'codex',
    model: '',
    kind,
    workingDir: '.',
    profileId: 'profile-1',
    workspaceSessionId: 'session-1',
    engineId: 'engine-1'
  })
}

describe('AgentManager orchestrator handoff lifecycle', () => {
  const processes: FakePty[] = []

  beforeEach(() => {
    processes.length = 0
    mocks.ptySpawn.mockReset()
    mocks.seed.mockClear()
    mocks.seed.mockResolvedValue(true)
    mocks.closePaneWindows.mockReset()
    mocks.execFile.mockReset()
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback?: () => void) => callback?.()
    )
    mocks.ptySpawn.mockImplementation(() => {
      const exitHandlers: ExitHandler[] = []
      const emitExit = (event: { exitCode: number; signal?: number }): void => {
        for (const handler of exitHandlers) handler(event)
      }
      const process = {
        pid: 100 + processes.length,
        onData: vi.fn(),
        onExit: vi.fn((handler: ExitHandler) => {
          exitHandlers.push(handler)
        }),
        kill: vi.fn(() => emitExit({ exitCode: 0 })),
        resize: vi.fn(),
        write: vi.fn(),
        emitExit
      }
      processes.push({
        pid: process.pid,
        write: process.write,
        emitExit: (event) => process.emitExit(event)
      })
      return process
    })
  })

  it('keeps the old orchestrator until the correlated knowledge acknowledgement succeeds', async () => {
    const manager = new AgentManager()
    const source = await spawnSource(manager)
    const target = await manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })
    const challenge = promptChallenge()
    const identity = manager.orchestratorClientIdentity(target.id)
    expect(identity).toBeDefined()

    expect(manager.list().map((agent) => agent.id)).toEqual([source.id, target.id])
    const context = manager.readOrchestratorHandoffContext(
      challenge,
      identity!,
      { snapshot: { engineId: 'engine-1' }, tasks: [] }
    )
    expect(context.ok).toBe(true)
    if (!context.ok) throw new Error(context.message)

    await expect(
      manager.acknowledgeOrchestratorHandoff(
        {
          ...challenge,
          knowledgeDigest: context.knowledgeDigest,
          summary: 'Ich übernehme das aktive Ziel und den vollständigen Engine-Zustand.'
        },
        identity!
      )
    ).resolves.toMatchObject({ ok: true, duplicate: false })

    expect(manager.list().map((agent) => agent.id)).toEqual([target.id])
    expect(manager.list()[0]?.handoffFrom?.handshake?.phase).toBe('completed')
    expect(mocks.closePaneWindows).toHaveBeenCalledWith(source.id)
  })

  it('does not stop the source when the target process exits before acknowledgement', async () => {
    const manager = new AgentManager()
    const source = await spawnSource(manager)
    const target = await manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })
    const challenge = promptChallenge()
    const identity = manager.orchestratorClientIdentity(target.id)!
    const context = manager.readOrchestratorHandoffContext(challenge, identity, {})
    expect(context.ok).toBe(true)
    if (!context.ok) throw new Error(context.message)

    const targetProcess = processes[1]
    targetProcess?.emitExit({ exitCode: 1 })
    await expect(
      manager.acknowledgeOrchestratorHandoff(
        {
          ...challenge,
          knowledgeDigest: context.knowledgeDigest,
          summary: 'Diese Bestätigung kommt von einem bereits beendeten Zielprozess.'
        },
        identity
      )
    ).resolves.toMatchObject({ ok: false, code: 'handoff-failed' })

    expect(manager.list().find((agent) => agent.id === source.id)?.status).toBe('running')
    expect(mocks.closePaneWindows).not.toHaveBeenCalledWith(source.id)
  })

  it('keeps the source alive when spawning the replacement fails', async () => {
    const manager = new AgentManager()
    const source = await spawnSource(manager)
    mocks.ptySpawn.mockImplementationOnce(() => {
      throw new Error('replacement spawn failed')
    })

    await expect(
      manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })
    ).rejects.toThrow('konnte nicht arbeitsfähig gestartet werden')
    expect(manager.list().find((agent) => agent.id === source.id)?.status).toBe('running')
  })

  it('keeps the source and cleans up a replacement that never becomes interactive-ready', async () => {
    const manager = new AgentManager()
    const source = await spawnSource(manager)
    mocks.seed.mockResolvedValueOnce(false)

    await expect(
      manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })
    ).rejects.toThrow('nicht rechtzeitig arbeitsfähig')
    expect(manager.list().map((agent) => agent.id)).toEqual([source.id])
    expect(manager.list()[0]?.handoffTo?.handshake?.phase).toBe('failed')
  })

  it('rejects concurrent replacement starts for the same orchestrator', async () => {
    const manager = new AgentManager()
    const source = await spawnSource(manager)

    const first = manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })
    await expect(
      manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })
    ).rejects.toThrow('bereits eine Orchestrator-Übergabe gestartet')
    const target = await first

    expect(manager.list().map((agent) => agent.id)).toEqual([source.id, target.id])
  })

  it('preserves the backward-compatible manual subagent behavior', async () => {
    const manager = new AgentManager()
    const source = await spawnSource(manager, 'sub')
    const target = await manager.handoff({ sourceId: source.id, provider: 'codex', model: '' })

    expect(target.kind).toBe('sub')
    expect(source.handoffTo?.handshake).toBeUndefined()
    expect(manager.list().map((agent) => agent.id)).toEqual([source.id, target.id])
  })
})
